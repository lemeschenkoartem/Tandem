'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Accounts } = require('../server/accounts.cjs');
const { SessionStore } = require('../app/session-store.cjs');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createCipheriv, createDecipheriv, randomBytes } = require('node:crypto');
test('persistent authentication tokens are hashed, survive restart and are revocable and expiring', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-session-')), filename = path.join(dir, 'db');
  let accounts = new Accounts(filename);
  try {
    const user = await accounts.register('player', 'password-for-player');
    const session = accounts.createSession(user.name);
    assert.equal(accounts.resume(session.token).account.id, user.id);
    assert.notEqual(accounts.db.prepare('SELECT hash FROM sessions').get().hash, session.token);
    accounts.close(); accounts = new Accounts(filename); assert.equal(accounts.resume(session.token).account.id, user.id);
    accounts.revokeSession(accounts.sessionHash(session.token)); assert.equal(accounts.resume(session.token), null);
    const expired = accounts.createSession(user.name); accounts.db.prepare('UPDATE sessions SET expires=0').run(); assert.equal(accounts.resume(expired.token), null);
  } finally { accounts.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
test('credential store encrypts tokens and never falls back to plaintext storage', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-store-')), filename = path.join(dir, 'sessions.enc'), key = randomBytes(32);
  const crypto = {
    isEncryptionAvailable: () => true,
    encryptString: text => { const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key, iv); const data = Buffer.concat([c.update(text, 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), data]); },
    decryptString: value => { const d = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); d.setAuthTag(value.subarray(12, 28)); return Buffer.concat([d.update(value.subarray(28)), d.final()]).toString(); }
  };
  try {
    const store = new SessionStore(filename, crypto), network = 'a'.repeat(32), token = 'b'.repeat(43);
    assert.equal(store.set(network, token, 'ws://26.1.2.3:8787'), true); assert.equal(new SessionStore(filename, crypto).get(network), token);
    assert.ok(!fs.readFileSync(filename).includes(Buffer.from(token)));
    assert.deepEqual(new SessionStore(filename, crypto).last(), { network, server: 'ws://26.1.2.3:8787' });
    store.clear(network); assert.equal(store.last(), null); assert.equal(store.get(network), null);
    const unavailable = new SessionStore(filename, { isEncryptionAvailable: () => false }); assert.equal(unavailable.set(network, token), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
