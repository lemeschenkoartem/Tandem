'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { mkdtempSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');
const { createRelay } = require('../server/relay.cjs');
function channel(url) {
  const socket = new WebSocket(url), queued = [], waiting = [];
  let hello;
  socket.on('message', data => { const msg = JSON.parse(data); if (msg.type === 'hello') { hello = msg; return; } waiting.length ? waiting.shift()(msg) : queued.push(msg); });
  return { socket, get hello() { return hello; }, send: msg => socket.send(JSON.stringify(msg)), next: () => queued.length ? Promise.resolve(queued.shift()) : new Promise(resolve => waiting.push(resolve)) };
}
test('registration assigns unique persistent eight-digit IDs and hashes passwords', async () => {
  const { Accounts } = require('../server/accounts.cjs');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tandem-accounts-'));
  let accounts = new Accounts(path.join(dir, 'accounts.sqlite'));
  try {
    const network = accounts.networkId;
    const owner = await accounts.register('owner', 'a-good-passphrase');
    const friend = await accounts.register('friend', 'another-password');
    assert.match(owner.id, /^[0-9]{8}$/); assert.match(friend.id, /^[0-9]{8}$/); assert.notEqual(owner.id, friend.id);
    assert.equal((await accounts.login('friend', 'another-password')).id, friend.id);
    await assert.rejects(accounts.login('friend', 'wrong-password'), /Неверный/);
    await assert.rejects(accounts.register('friend', 'a-good-passphrase'), /используется/);
    const stored = accounts.db.prepare('SELECT * FROM accounts WHERE name=?').get('friend');
    assert.equal(stored.hash.length, 128); assert.notEqual(stored.hash, 'another-password');
    accounts.close(); accounts = new Accounts(path.join(dir, 'accounts.sqlite'));
    assert.equal(accounts.networkId, network);
    assert.equal((await accounts.login('friend', 'another-password')).id, friend.id);
    assert.equal(accounts.find(friend.id).name, 'friend');
  } finally { accounts.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('failed lookup, rejection and leaving a room preserve authentication and allow retry on the same socket', async () => {
  const relay = createRelay({ port: 0, host: '127.0.0.1' });
  const address = await relay.listen(), url = `ws://127.0.0.1:${address.port}`;
  const owner = channel(url), guest = channel(url);
  try {
    await Promise.all([owner, guest].map(c => once(c.socket, 'open')));
    owner.send({ type: 'register', name: 'owner', password: 'owner-password-123' });
    const identity = (await owner.next()).account;
    guest.send({ type: 'register', name: 'friend', password: 'friend-password-123' }); await guest.next();
    assert.equal(owner.hello.protocol, 2); assert.equal(owner.hello.network, guest.hello.network);
    guest.send({ type: 'find', id: '00000000' });
    const failure = await guest.next(); assert.equal(failure.code, 'ID_NOT_FOUND'); assert.equal(failure.request, 'find');
    owner.send({ type: 'create' }); await owner.next();
    guest.send({ type: 'find', id: identity.id }); assert.equal((await guest.next()).online, true);
    guest.send({ type: 'join-id', id: identity.id }); await guest.next(); await owner.next();
    owner.send({ type: 'reject-peer' }); assert.equal((await guest.next()).type, 'rejected');
    guest.send({ type: 'join-id', id: identity.id }); await guest.next(); await owner.next();
    owner.send({ type: 'accept-peer' }); await guest.next(); await owner.next();
    owner.send({ type: 'leave' }); assert.equal((await owner.next()).type, 'left'); assert.equal((await guest.next()).type, 'ended');
    assert.equal(owner.socket.readyState, WebSocket.OPEN); assert.equal(guest.socket.readyState, WebSocket.OPEN);
    owner.send({ type: 'create' }); assert.equal((await owner.next()).id, identity.id);
    guest.send({ type: 'find', id: identity.id }); assert.equal((await guest.next()).online, true);
    guest.send({ type: 'leave' }); assert.equal((await guest.next()).type, 'left');
    guest.send({ type: 'find', id: identity.id }); assert.equal((await guest.next()).online, true);
  } finally { owner.socket.terminate(); guest.socket.terminate(); await relay.close(); }
});
test('ID search requires authentication; host approval gates media and duplicate joins; roles can switch', async () => {
  const relay = createRelay({ port: 0, host: '127.0.0.1' });
  const address = await relay.listen(), url = `ws://127.0.0.1:${address.port}`;
  const owner = channel(url), guest = channel(url), intruder = channel(url);
  try {
    await Promise.all([owner, guest, intruder].map(c => once(c.socket, 'open')));
    intruder.send({ type: 'find', id: '12345678' }); assert.equal((await intruder.next()).type, 'error');
    const accounts = [];
    for (const [client, name] of [[owner, 'owner'], [guest, 'friend'], [intruder, 'intruder']]) {
      client.send({ type: 'register', name, password: `${name}-password-123` }); const response = await client.next();
      assert.equal(response.type, 'authenticated'); accounts.push(response.account);
    }
    guest.send({ type: 'find', id: accounts[0].id }); assert.equal((await guest.next()).online, false);
    owner.send({ type: 'create' }); assert.equal((await owner.next()).id, accounts[0].id);
    guest.send({ type: 'find', id: accounts[0].id }); const found = await guest.next(); assert.equal(found.online, true); assert.equal(found.account.name, 'owner');
    guest.send({ type: 'join-id', id: accounts[0].id }); assert.equal((await guest.next()).type, 'join-pending');
    assert.equal((await owner.next()).type, 'join-request');
    guest.send({ type: 'signal', data: { kind: 'offer', sdp: 'early' } }); assert.equal((await guest.next()).type, 'error');
    owner.send({ type: 'reject-peer' }); assert.equal((await guest.next()).type, 'rejected');
    guest.send({ type: 'join-id', id: accounts[0].id }); assert.equal((await guest.next()).type, 'join-pending'); await owner.next();
    owner.send({ type: 'accept-peer' }); assert.equal((await guest.next()).type, 'joined'); assert.equal((await owner.next()).type, 'peer-joined');
    owner.send({ type: 'signal', data: { kind: 'offer', sdp: 'example' } }); assert.equal((await guest.next()).data.sdp, 'example');
    guest.send({ type: 'signal', data: { kind: 'offer', sdp: 'role-swap' } }); assert.equal((await owner.next()).data.sdp, 'role-swap');
    intruder.send({ type: 'join-id', id: accounts[0].id }); assert.equal((await intruder.next()).type, 'error');
    owner.socket.close(); assert.equal((await guest.next()).type, 'ended');
  } finally { for (const c of [owner, guest, intruder]) c.socket.terminate(); await relay.close(); }
});
