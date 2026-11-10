'use strict';
(() => {
  const resolutions = ['1280x720', '1920x1080', '2560x1440', '3840x2160'];
  function profile(value) {
    if (!value || !resolutions.includes(value.resolution) || ![60, 90, 120, 144, 165, 240].includes(Number(value.fps)) || !Number.isFinite(Number(value.bitrate)) || Number(value.bitrate) < 5 || Number(value.bitrate) > 250 || !['H264', 'H265', 'VP9', 'AV1', 'auto'].includes(value.codec) || (value.qualityMode != null && !['adaptive', 'manual'].includes(value.qualityMode)) || (value.minResolution != null && !['1280x720', '1920x1080'].includes(value.minResolution))) throw new Error('Неверный профиль трансляции.');
    return { resolution: value.resolution, fps: Number(value.fps), bitrate: Number(value.bitrate), codec: value.codec, qualityMode: value.qualityMode || 'adaptive', minResolution: value.minResolution || '1920x1080' };
  }
  function videoBox(rect, width, height) {
    const ratio = width > 0 && height > 0 ? width / height : 16 / 9;
    let w = rect.width, h = w / ratio;
    if (h > rect.height) { h = rect.height; w = h * ratio; }
    return { left: rect.left + (rect.width - w) / 2, top: rect.top + (rect.height - h) / 2, width: w, height: h };
  }
  function point(box, x, y) {
    const nx = (x - box.left) / box.width, ny = (y - box.top) / box.height;
    return nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1 ? { kind: 'move', x: nx, y: ny } : null;
  }
  // Chromium supports an initial bandwidth hint; congestion control remains enabled.
  // Deliberately do not force a minimum rate: that can queue frames on a slow link.
  function startBitrate(sdp, mbps) {
    const start = Math.min(12000, Math.round(mbps * 1000 * 0.6));
    const ids = [...sdp.matchAll(/^a=rtpmap:(\d+) (?:H264|H265|VP8|VP9|AV1)\//gm)].map(m => m[1]);
    for (const id of ids) {
      const expression = new RegExp(`^a=fmtp:${id} ([^\\r\\n]*)`, 'm');
      if (expression.test(sdp)) sdp = sdp.replace(expression, (_, params) => `a=fmtp:${id} ${params.replace(/;?x-google-start-bitrate=\d+/g, '')};x-google-start-bitrate=${start}`);
      else sdp = sdp.replace(new RegExp(`(^a=rtpmap:${id} [^\\r\\n]+)(\\r?\\n)`, 'm'), `$1$2a=fmtp:${id} x-google-start-bitrate=${start}$2`);
    }
    return sdp;
  }
  const exported = { profile, videoBox, point, startBitrate };
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  else globalThis.TandemQuality = exported;
})();
