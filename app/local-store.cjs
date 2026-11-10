'use strict';
const fs = require('node:fs');
const path = require('node:path');
class LocalStore {
  constructor(directory) { this.directory = directory; }
  file(name) { return path.join(this.directory, name); }
  read(name, fallback = null) {
    try { const file = this.file(name); if (fs.statSync(file).size > 1024 * 1024) return fallback; return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { return fallback; }
  }
  write(name, value) {
    const text = JSON.stringify(value, null, 2);
    if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('Слишком большой файл настроек.');
    fs.mkdirSync(this.directory, { recursive: true });
    fs.writeFileSync(this.file(name + '.tmp'), text, { mode: 0o600 }); fs.renameSync(this.file(name + '.tmp'), this.file(name)); return true;
  }
  settings(value) {
    if (value === undefined) return this.read('settings.json');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Некорректные настройки.');
    const { profile } = require('./quality.js');
    const safe = { ...profile(value), audio: value.audio !== false, mouseMode: value.mouseMode === 'desktop' ? 'desktop' : 'game', hideCursor: value.hideCursor !== false };
    // TURN credentials, passwords and session tokens never go into this JSON.
    safe.ice = Array.isArray(value.ice) ? value.ice.filter(s => s && !s.username && !s.credential).map(s => ({ urls: s.urls })).slice(0, 8) : [];
    return this.write('settings.json', safe);
  }
  contacts(network, id, value) {
    if (!/^[a-f0-9]{32}$/.test(network) || !/^[0-9]{8}$/.test(id)) throw new Error('Некорректный владелец списка друзей.');
    const name = `friends-${network}-${id}.json`;
    if (value === undefined) return this.read(name, { friends: [], incoming: [], outgoing: [] });
    const clean = {};
    for (const list of ['friends', 'incoming', 'outgoing']) {
      if (!Array.isArray(value?.[list]) || value[list].length > 150) throw new Error('Некорректный список друзей.');
      clean[list] = value[list].filter(p => p && /^[0-9]{8}$/.test(p.id) && /^[a-z0-9_]{3,24}$/.test(p.name)).map(p => ({ id: p.id, name: p.name }));
    }
    return this.write(name, { ...clean, savedAt: Date.now() });
  }
  account(network, account) {
    if (!/^[a-f0-9]{32}$/.test(network) || !/^[0-9]{8}$/.test(account?.id) || !/^[a-z0-9_]{3,24}$/.test(account?.name)) throw new Error('Некорректный аккаунт.');
    return this.write('account.json', { network, id: account.id, name: account.name });
  }
}
module.exports = { LocalStore };
