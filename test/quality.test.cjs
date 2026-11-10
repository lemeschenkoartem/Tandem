'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const q = require('../app/quality.js');
test('desktop coordinates use the whole contained video rectangle, including both edges', () => {
  const box = q.videoBox({ left: 0, top: 0, width: 2560, height: 1080 }, 1920, 1080);
  assert.equal(box.left, 320); assert.equal(box.width, 1920);
  assert.deepEqual(q.point(box, 320, 0), { kind: 'move', x: 0, y: 0 });
  assert.deepEqual(q.point(box, 2240, 1080), { kind: 'move', x: 1, y: 1 });
  assert.equal(q.point(box, 319, 500), null);
});
test('HD and AV1 profiles validate and initial bitrate hints preserve valid SDP line endings', () => {
  assert.equal(q.profile({ resolution: '1280x720', fps: 120, bitrate: 20, codec: 'AV1' }).resolution, '1280x720');
  const sdp = 'v=0\r\na=rtpmap:102 H264/90000\r\na=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1\r\na=rtpmap:96 VP8/90000\r\n';
  const result = q.startBitrate(sdp, 60);
  assert.match(result, /packetization-mode=1;x-google-start-bitrate=12000\r\n/);
  assert.match(result, /a=fmtp:96 x-google-start-bitrate=12000\r\n/);
  assert.ok(!result.includes('\r;'));
});
