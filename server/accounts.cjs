'use strict';
const { DatabaseSync } = require('node:sqlite');
const { scrypt, randomBytes, randomInt, timingSafeEqual, createHash } = require('node:crypto');
const { promisify } = require('node:util');
const derive = promisify(scrypt);
class Accounts {
  constructor(filename = ':memory:') {
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS accounts (
      name TEXT PRIMARY KEY, salt TEXT NOT NULL, hash TEXT NOT NULL,
      id TEXT NOT NULL UNIQUE, created INTEGER NOT NULL
    );`);
    this.db.exec('CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    this.db.prepare('INSERT OR IGNORE INTO metadata VALUES (?,?)').run('network_id', randomBytes(16).toString('hex'));
    this.networkId = this.db.prepare('SELECT value FROM metadata WHERE key=?').get('network_id').value;
    this.db.exec('CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, name TEXT NOT NULL, expires INTEGER NOT NULL)');
  }
  async register(name, password) {
    name = typeof name === 'string' ? name.trim().toLowerCase() : '';
    if (!/^[a-z0-9_]{3,24}$/.test(name)) throw new Error('Логин: 3–24 латинские буквы, цифры или знак _.');
    if (typeof password !== 'string' || password.length < 10 || password.length > 128) throw new Error('Пароль должен содержать 10–128 символов.');
    if (this.db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n >= 1000) throw new Error('Достигнут лимит аккаунтов этого частного сервера.');
    if (this.db.prepare('SELECT 1 FROM accounts WHERE name=?').get(name)) throw new Error('Логин уже используется.');
    const salt = randomBytes(16).toString('hex'), hash = (await derive(password, salt, 64)).toString('hex');
    for (let attempt = 0; attempt < 10; attempt++) {
      const id = String(randomInt(10000000, 100000000));
      try { this.db.prepare('INSERT INTO accounts VALUES (?,?,?,?,?)').run(name, salt, hash, id, Date.now()); return { name, id }; }
      catch (error) { if (this.db.prepare('SELECT 1 FROM accounts WHERE name=?').get(name)) throw new Error('Логин уже используется.'); if (attempt === 9) throw error; }
    }
  }
  async login(name, password) {
    if (typeof name !== 'string' || typeof password !== 'string' || password.length > 128) throw new Error('Неверный логин или пароль.');
    const account = this.db.prepare('SELECT * FROM accounts WHERE name=?').get(name.trim().toLowerCase());
    const hash = await derive(password, account?.salt || '00000000000000000000000000000000', 64);
    if (!account || !timingSafeEqual(hash, Buffer.from(account.hash, 'hex'))) throw new Error('Неверный логин или пароль.');
    return { name: account.name, id: account.id };
  }
  find(id) { if (typeof id !== 'string' || !/^[0-9]{8}$/.test(id)) return null; return this.db.prepare('SELECT name,id FROM accounts WHERE id=?').get(id) || null; }
  sessionHash(token) { return createHash('sha256').update(token).digest('hex'); }
  createSession(name) {
    this.db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
    const token = randomBytes(32).toString('base64url'), expires = Date.now() + 30 * 86400000;
    this.db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(this.sessionHash(token), name, expires);
    return { token, expires };
  }
  resume(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const row = this.db.prepare('SELECT accounts.name, accounts.id, sessions.expires FROM sessions JOIN accounts ON accounts.name=sessions.name WHERE sessions.hash=? AND sessions.expires>?').get(this.sessionHash(token), Date.now());
    return row ? { account: { name: row.name, id: row.id }, expires: row.expires } : null;
  }
  revokeSession(hash) { if (hash) this.db.prepare('DELETE FROM sessions WHERE hash=?').run(hash); }
  close() { this.db.close(); }
}
module.exports = { Accounts };
