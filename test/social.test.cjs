'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { once } = require('node:events'); const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const WebSocket = require('ws'); const { createRelay } = require('../server/relay.cjs');
async function connect(url, name, token) {
  const ws = new WebSocket(url), queue = [], waiters = [];
  ws.on('message', raw => { const message = JSON.parse(raw); const i = waiters.findIndex(w => w.type === message.type); if (i < 0) queue.push(message); else { const waiter = waiters.splice(i, 1)[0]; clearTimeout(waiter.timer); waiter.resolve(message); } });
  const client = { ws, send: value => ws.send(JSON.stringify(value)), next(type) { const i = queue.findIndex(m => m.type === type); if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]); return new Promise((resolve, reject) => { const waiter = { type, resolve, timer: setTimeout(() => reject(new Error(`Waiting for ${type}`)), 3000) }; waiters.push(waiter); }); } };
  await once(ws, 'open'); client.send(token ? { type: 'resume', token } : { type: 'register', name, password: `${name}-password-123` });
  client.identity = await client.next('authenticated'); return client;
}
test('offline friend requests persist as JSON; only the recipient accepts; viewing is separately approved', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-social-'));
  const options = { port: 0, host: '127.0.0.1', databasePath: path.join(directory, 'accounts.sqlite') };
  let relay = createRelay(options), clients = [];
  try {
    let address = await relay.listen(), url = `ws://127.0.0.1:${address.port}`;
    const alice = await connect(url, 'alice'), bob = await connect(url, 'bob'), eve = await connect(url, 'eve'); clients.push(alice, bob, eve);
    const a = alice.identity.account.id, b = bob.identity.account.id;
    eve.send({ type: 'watch', id: b }); assert.equal((await eve.next('error')).code, 'FRIEND_REQUIRED');
    bob.ws.close(); await once(bob.ws, 'close');
    alice.send({ type: 'friend-request', id: b }); assert.equal((await alice.next('contacts')).outgoing[0].id, b);
    eve.send({ type: 'friend-accept', id: a }); assert.equal((await eve.next('error')).code, 'SOCIAL_FAILED');
    await relay.close(); clients = [];
    relay = createRelay(options); address = await relay.listen(); url = `ws://127.0.0.1:${address.port}`;
    const restoredA = await connect(url, 'alice', alice.identity.token), restoredB = await connect(url, 'bob', bob.identity.token); clients.push(restoredA, restoredB);
    restoredB.send({ type: 'contacts-sync' }); assert.equal((await restoredB.next('contacts')).incoming[0].id, a);
    restoredB.send({ type: 'friend-accept', id: a }); assert.equal((await restoredB.next('contacts')).friends[0].id, a);
    restoredA.send({ type: 'contacts-sync' }); assert.equal((await restoredA.next('contacts')).friends[0].id, b);
    restoredA.send({ type: 'watch', id: b }); await restoredA.next('join-pending'); const request = await restoredB.next('watch-request'); assert.equal(request.id, a);
    restoredA.send({ type: 'signal', data: { kind: 'offer', sdp: 'before consent' } }); assert.equal((await restoredA.next('error')).type, 'error');
    restoredB.send({ type: 'reject-peer' }); await restoredA.next('rejected'); assert.equal(relay.rooms.size, 0);
    restoredA.send({ type: 'watch', id: b }); await restoredA.next('join-pending'); await restoredB.next('watch-request'); restoredB.send({ type: 'accept-peer' });
    await restoredA.next('joined'); await restoredB.next('peer-joined');
    restoredB.send({ type: 'signal', data: { kind: 'offer', sdp: 'approved' } }); assert.equal((await restoredA.next('signal')).data.sdp, 'approved');
    restoredA.send({ type: 'leave' }); await restoredA.next('left'); await restoredB.next('peer-left');
    // A cancelled request releases both participants instead of leaving a stuck busy room.
    restoredB.send({ type: 'leave' }); await restoredB.next('left');
    restoredA.send({ type: 'watch', id: b }); await restoredA.next('join-pending'); await restoredB.next('watch-request');
    restoredA.send({ type: 'leave' }); await restoredA.next('left'); await restoredB.next('request-cancelled'); assert.equal(relay.rooms.size, 0);
    restoredB.send({ type: 'friend-remove', id: a });
    let update; do { update = await restoredB.next('contacts'); } while (update.friends.length);
    assert.equal(relay.social.areFriends(a, b), false);
    assert.ok(fs.existsSync(path.join(directory, 'contacts.json')));
  } finally { for (const client of clients) client.ws.terminate(); await relay.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});
