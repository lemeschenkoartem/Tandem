'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeServer, createInvitation, parseTarget } = require('../app/network.js');
test('invitations carry the correct network and VPN server without account secrets', () => {
  for (const server of ['ws://100.90.80.70:8787', 'ws://26.12.34.56:8787', 'wss://relay.example.com']) {
    const target = { id: '12345678', server, network: 'a'.repeat(32), password: 'must-not-be-exported' };
    const invitation = createInvitation(target);
    assert.deepEqual(parseTarget(invitation), { id: target.id, server, network: target.network });
    assert.ok(!atob(invitation.split('/').pop().replace(/-/g, '+').replace(/_/g, '/')).includes('password'));
  }
  assert.deepEqual(parseTarget('1234 5678'), { id: '12345678' });
  assert.equal(normalizeServer('ws://26.1.2.3:8787/'), 'ws://26.1.2.3:8787');
});
test('invitation parsing rejects executable URLs, public unencrypted servers and malformed identities', () => {
  for (const server of ['javascript:alert(1)', 'https://example.com', 'ws://example.com:8787', 'wss://user:password@example.com', 'wss://example.com/other']) assert.throws(() => normalizeServer(server));
  for (const input of ['1234567', 'tandem://connect/bad', 'tandem://connect/' + btoa(JSON.stringify({ v: 1, id: '12345678', network: 'bad', server: 'ws://26.1.2.3:8787' }))]) assert.throws(() => parseTarget(input));
});
