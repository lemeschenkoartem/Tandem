'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateInput } = require('../shared/input.cjs');
test('input boundary rejects unknown keys, nonfinite numbers, unsupported buttons and arbitrary commands', () => {
  for (const input of [null, 'cmd', { kind: 'shell', command: 'bad' }, { kind: 'key', code: 'MetaLeft', down: true }, { kind: 'key', code: '__proto__', down: true }, { kind: 'key', code: 'KeyW', down: 'true' }, { kind: 'relative', dx: Infinity, dy: 0 }, { kind: 'button', button: 5, down: true }]) assert.equal(validateInput(input), null);
});
test('input boundary clamps coordinates, motion and scroll, and maps physical WASD', () => {
  assert.deepEqual(validateInput({ kind: 'move', x: -10, y: 99 }), { kind: 'move', x: 0, y: 1 });
  assert.deepEqual(validateInput({ kind: 'relative', dx: -1e6, dy: 2.6 }), { kind: 'relative', dx: -1000, dy: 3 });
  assert.deepEqual(validateInput({ kind: 'key', code: 'KeyW', down: true }), { kind: 'key', scan: 0x11, down: true });
});
