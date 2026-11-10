'use strict';
const fs = require('node:fs');
const path = require('node:path');
class SessionStore {
  constructor(filename, crypto) { this.filename = filename; this.crypto = crypto; }
  available() {
    try { return this.crypto.isEncryptionAvailable() && (process.platform !== 'linux' || this.crypto.getSelectedStorageBackend?.() !== 'basic_text'); }
    catch { return false; }
  }
  read() {
    if (!this.available()) return {};
    try { return JSON.parse(this.crypto.decryptString(fs.readFileSync(this.filename))); } catch { return {}; }
  }
  get(network) { return /^[a-f0-9]{32}$/.test(network) ? this.read()[network] || null : null; }
  set(network, token, server) {
    if (!this.available()) return false;
    if (!/^[a-f0-9]{32}$/.test(network) || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('Некорректный ключ входа.');
    const saved = this.read(); saved[network] = token;
    if (typeof server === 'string' && server.length <= 2048) {
      const normalized = require('./network.js').normalizeServer(server);
      saved.__last = { network, server: normalized };
    }
    this.write(saved); return true;
  }
  last() { const saved = this.read(); return saved.__last && saved[saved.__last.network] ? saved.__last : null; }
  clear(network) { if (!this.available()) return; const saved = this.read(); delete saved[network]; if (saved.__last?.network === network) delete saved.__last; this.write(saved); }
  write(saved) {
    fs.mkdirSync(path.dirname(this.filename), { recursive: true });
    const encrypted = this.crypto.encryptString(JSON.stringify(saved));
    fs.writeFileSync(this.filename + '.tmp', encrypted, { mode: 0o600 });
    fs.renameSync(this.filename + '.tmp', this.filename);
  }
}
module.exports = { SessionStore };
