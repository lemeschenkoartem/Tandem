'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { LocalStore } = require('../app/local-store.cjs');
test('settings and account-scoped friends survive restart in JSON, with no secrets or stale online flags', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-local-'));
  try {
    const store = new LocalStore(directory), network = 'a'.repeat(32), user = '12345678';
    store.settings({ resolution: '1920x1080', fps: 120, bitrate: 60, codec: 'auto', password: 'secret', token: 'secret', ice: [{ urls: 'stun:example.com' }, { urls: 'turn:example.com', username: 'user', credential: 'secret' }] });
    store.contacts(network, user, { friends: [{ id: '87654321', name: 'friend', online: true }], incoming: [], outgoing: [] });
    const reopened = new LocalStore(directory); assert.equal(reopened.settings().qualityMode, 'adaptive');
    assert.deepEqual(reopened.contacts(network, user).friends, [{ id: '87654321', name: 'friend' }]);
    assert.equal(reopened.contacts(network, '11111111').friends.length, 0);
    assert.ok(!fs.readFileSync(path.join(directory, 'settings.json'), 'utf8').includes('secret'));
    assert.throws(() => store.contacts('../escape', user), /Некорректный/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
