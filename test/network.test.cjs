'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeServer, createInvitation, parseTarget } = require('../app/network.js');
const { createDirectPacket, parseDirectPacket, withoutVPN } = require('../app/network.js');
test('direct packets roundtrip UTF-8 identities and reject invalid sessions and VPN candidates', () => {
  const value = { v: 1, kind: 'offer', name: 'Друг', session: 'a'.repeat(32), sdp: 'v=0\r\n' };
  assert.deepEqual(parseDirectPacket(createDirectPacket(value)), value);
  assert.throws(() => createDirectPacket({ ...value, session: 'bad' }));
  const sdp = 'v=0\r\na=candidate:1 1 udp 1 26.1.2.3 5000 typ host\r\na=candidate:2 1 udp 1 100.90.0.1 5001 typ host\r\na=candidate:3 1 udp 1 192.168.1.2 5002 typ host\r\na=candidate:4 1 udp 1 203.0.113.1 5003 typ srflx raddr 26.1.2.3 rport 5000\r\n';
  const result = withoutVPN(sdp);
  assert.ok(!result.includes('26.1.2.3')); assert.ok(!result.includes('100.90.0.1')); assert.ok(result.includes('192.168.1.2'));
});
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
