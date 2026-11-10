'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Controller, measure, receiverFeedback } = require('../app/adaptive.js');
const ceiling = { resolution: '3840x2160', fps: 120, bitrate: 100, codec: 'auto', qualityMode: 'adaptive', minResolution: '1920x1080' };
const good = { valid: true, rttMs: 8, routeId: 'udp', actualMbps: 28, availableMbps: 150, lossPct: 0, processingMs: 2, sendDelayMs: 0, limitation: 'none' };
function feed(controller, sample, from, to, receiver) {
  for (let now = from; now <= to; now += 1000) { const change = controller.update(sample, receiver, now); if (change) controller.commit(change); }
}
test('autopilot warms up, recovers gradually and respects source, user ceilings and resolution floor', () => {
  const controller = new Controller(ceiling, 0, { width: 2560, height: 1440, fps: 60 });
  assert.equal(controller.current.resolution, '1920x1080'); assert.equal(controller.current.fps, 60);
  feed(controller, good, 1000, 120000);
  assert.equal(controller.current.resolution, '2560x1440'); assert.equal(controller.current.fps, 60); assert.ok(controller.current.bitrate <= 100);
  feed(controller, { ...good, lossPct: 12, availableMbps: 8 }, 121000, 180000);
  assert.equal(controller.current.resolution, '1920x1080'); assert.ok(controller.current.bitrate <= 8 * 0.82); assert.ok(controller.current.bitrate >= 2);
});
test('loss and queue growth reduce rate quickly; one mild spike and a static screen do not collapse it', () => {
  const controller = new Controller(ceiling);
  feed(controller, good, 1000, 6000);
  assert.equal(controller.update({ ...good, lossPct: 3 }, null, 7000), null);
  feed(controller, good, 8000, 9000); const before = controller.current.bitrate;
  const change = controller.update({ ...good, rttMs: 80, lossPct: 10 }, null, 10000);
  assert.ok(change.profile.bitrate < before * 0.8); controller.commit(change);
  const lowTraffic = new Controller(ceiling); feed(lowTraffic, { ...good, actualMbps: 0.05, availableMbps: 4 }, 1000, 10000);
  assert.equal(lowTraffic.current.bitrate, 30);
});
test('decoder/encoder pressure reduces FPS and auto codec falls back, without ignoring Full HD floor', () => {
  const controller = new Controller({ ...ceiling, resolution: '1920x1080', minResolution: '1280x720' });
  controller.current = { ...controller.current, fps: 120, codec: 'AV1' };
  feed(controller, good, 1000, 6000, { decodeMs: 20 });
  assert.equal(controller.current.codec, 'H264'); assert.ok(controller.current.fps < 120);
  feed(controller, { ...good, limitation: 'cpu', processingMs: 30 }, 7000, 20000);
  assert.equal(controller.current.resolution, '1280x720'); assert.equal(controller.current.fps, 60);
});
test('unknown and reset counters do not invent loss/latency; interval statistics expire after pauses and SSRC changes', () => {
  const reports = new Map([['v', { id: 'v', type: 'inbound-rtp', kind: 'video', timestamp: 1000, framesDecoded: 60, bytesReceived: 1000000, packetsReceived: 100, packetsLost: 2, totalDecodeTime: 0.12, jitterBufferDelay: 0.3, jitterBufferEmittedCount: 60 }]]);
  const first = measure(reports, 'viewer'); assert.equal(first.sample.valid, false); assert.equal(first.sample.processingMs, null); assert.equal(first.sample.rttMs, null);
  reports.set('v', { ...reports.get('v'), timestamp: 2000, framesDecoded: 120, bytesReceived: 2000000, packetsReceived: 198, packetsLost: 4, totalDecodeTime: 0.36, jitterBufferDelay: 0.9, jitterBufferEmittedCount: 120 });
  const next = measure(reports, 'viewer', first.snapshot); assert.equal(next.sample.lossPct, 2); assert.equal(next.sample.actualMbps, 8); assert.ok(Math.abs(next.sample.processingMs - 4) < 0.01); assert.ok(Math.abs(next.sample.jitterMs - 10) < 0.01);
  reports.get('v').timestamp = 10000; assert.equal(measure(reports, 'viewer', next.snapshot).sample.valid, false);
  reports.get('v').id = 'other'; assert.equal(measure(reports, 'viewer', next.snapshot).sample.valid, false);
  assert.equal(receiverFeedback({ processingMs: Infinity, jitterMs: -2, lossPct: '50' }).decodeMs, null);
});
