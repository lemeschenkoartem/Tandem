'use strict';
(() => {
  const sizes = ['1280x720', '1920x1080', '2560x1440', '3840x2160'];
  const rates = [60, 90, 120, 144, 165, 240];
  const number = (v, max = 10000) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? v : null;
  const delta = (v, old) => number(v, Number.MAX_SAFE_INTEGER) !== null && number(old, Number.MAX_SAFE_INTEGER) !== null && v >= old ? v - old : null;
  const round = v => Math.round(v * 10) / 10;

  // Interval counters, never lifetime averages. RTP counters restart after track/SSRC changes.
  function measure(reports, role, previous) {
    let video, pair;
    reports.forEach(r => {
      if (r.type === (role === 'sender' ? 'outbound-rtp' : 'inbound-rtp') && r.kind === 'video' && !r.isRemote) video = r;
      if (r.type === 'transport' && r.selectedCandidatePairId) pair = reports.get(r.selectedCandidatePairId);
    });
    if (!video) return null;
    const sending = role === 'sender', frames = sending ? video.framesEncoded : video.framesDecoded;
    const snapshot = { ...video, frames, bytes: sending ? video.bytesSent : video.bytesReceived, processing: sending ? video.totalEncodeTime : video.totalDecodeTime, role };
    const old = previous?.id === video.id && previous.role === role ? previous : null;
    const elapsed = old ? (video.timestamp - old.timestamp) / 1000 : 0;
    const valid = elapsed > 0 && elapsed <= 5 && delta(snapshot.bytes, old?.bytes) !== null && delta(frames, old?.frames) !== null;
    const count = valid ? frames - old.frames : 0;
    const perFrame = (v, before, divisor) => divisor > 0 && delta(v, before) !== null ? 1000 * (v - before) / divisor : null;
    const feedback = video.remoteId && reports.get(video.remoteId);
    let loss = null;
    if (!sending && valid) {
      const lost = delta(video.packetsLost, old.packetsLost), received = delta(video.packetsReceived, old.packetsReceived);
      if (lost !== null && received !== null && lost + received > 0) loss = 100 * lost / (lost + received);
    } else if (sending && feedback && feedback.timestamp !== old?.feedbackTimestamp) loss = number(feedback.fractionLost, 1) === null ? null : feedback.fractionLost * 100;
    snapshot.feedbackTimestamp = feedback?.timestamp;
    const local = pair && reports.get(pair.localCandidateId), remote = pair && reports.get(pair.remoteCandidateId);
    const protocol = local?.protocol || remote?.protocol || 'unknown';
    const relay = local?.candidateType === 'relay' || remote?.candidateType === 'relay';
    const dropped = valid ? delta(video.framesDropped, old.framesDropped) : null;
    const vpn = ip => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip || '') || /^fd7a:115c:a1e0:/i.test(ip || '') ? 'tailscale' : /^26\./.test(ip || '') ? 'radmin' : null;
    const network = vpn(local?.address) || vpn(remote?.address) || 'other';
    const turnProtocol = local?.relayProtocol || remote?.relayProtocol || null;
    return { snapshot, sample: {
      valid, fps: number(video.framesPerSecond, 1000) ?? (valid ? count / elapsed : null),
      actualMbps: valid ? (snapshot.bytes - old.bytes) * 8 / elapsed / 1e6 : null,
      rttMs: number(pair?.currentRoundTripTime, 30) !== null ? pair.currentRoundTripTime * 1000 : number(feedback?.roundTripTime, 30) !== null ? feedback.roundTripTime * 1000 : null,
      availableMbps: number(pair?.availableOutgoingBitrate, 1e12) > 0 ? pair.availableOutgoingBitrate / 1e6 : null,
      lossPct: loss, processingMs: valid ? perFrame(snapshot.processing, old.processing, count) : null,
      jitterMs: !sending && valid ? perFrame(video.jitterBufferDelay, old.jitterBufferDelay, delta(video.jitterBufferEmittedCount, old.jitterBufferEmittedCount)) : null,
      sendDelayMs: sending && valid ? perFrame(video.totalPacketSendDelay, old.totalPacketSendDelay, delta(video.packetsSent, old.packetsSent)) : null,
      qp: valid && count > 0 && delta(video.qpSum, old.qpSum) !== null ? (video.qpSum - old.qpSum) / count : null,
      jitterMinimumMs: !sending && valid ? perFrame(video.jitterBufferMinimumDelay, old.jitterBufferMinimumDelay, delta(video.jitterBufferEmittedCount, old.jitterBufferEmittedCount)) : null,
      jitterTargetMs: !sending && valid ? perFrame(video.jitterBufferTargetDelay, old.jitterBufferTargetDelay, delta(video.jitterBufferEmittedCount, old.jitterBufferEmittedCount)) : null,
      retransmitMbps: sending && valid && delta(video.retransmittedBytesSent, old.retransmittedBytesSent) !== null ? (video.retransmittedBytesSent - old.retransmittedBytesSent) * 8 / elapsed / 1e6 : null,
      freezeCount: !sending && valid ? delta(video.freezeCount, old.freezeCount) : null,
      nackCount: valid ? delta(video.nackCount, old.nackCount) : null,
      droppedPct: dropped !== null && count + dropped > 0 ? 100 * dropped / (count + dropped) : null,
      limitation: video.qualityLimitationReason || 'none', hardware: (sending ? video.powerEfficientEncoder : video.powerEfficientDecoder) ?? null,
      codec: reports.get(video.codecId)?.mimeType?.split('/')[1] || '', implementation: video.encoderImplementation || video.decoderImplementation || '',
      width: video.frameWidth || 0, height: video.frameHeight || 0,
      path: { relay, rtcProtocol: protocol, turnProtocol, network, peerAddress: remote?.address || null },
      routeId: pair?.id || '', route: `${relay ? `TURN · ${turnProtocol || protocol}` : `P2P · ${protocol}`}${network === 'tailscale' ? ' · Tailscale (внешний путь ещё не проверен)' : network === 'radmin' ? ' · Radmin VPN' : ''}`,
    } };
  }
  function receiverFeedback(value) {
    if (!value || typeof value !== 'object') return null;
    return { lossPct: number(value.lossPct, 100), decodeMs: number(value.processingMs), jitterMs: number(value.jitterMs), droppedPct: number(value.droppedPct, 100), fps: number(value.fps, 1000), hardware: typeof value.hardware === 'boolean' ? value.hardware : null };
  }
  function qualityRate(profile) {
    const [w, h] = profile.resolution.split('x').map(Number);
    const efficiency = ['AV1', 'H265'].includes(profile.codec) ? 0.65 : 1;
    return Math.max(5, 25 * w * h / (1920 * 1080) * profile.fps / 60 * efficiency);
  }
  class Controller {
    constructor(ceiling, now = 0, source = {}) {
      this.ceiling = { ...ceiling };
      if (source.width > 0 && source.height > 0) {
        const allowed = sizes.filter(s => { const [w, h] = s.split('x').map(Number); return w <= source.width && h <= source.height; });
        this.ceiling.resolution = sizes[Math.min(sizes.indexOf(ceiling.resolution), Math.max(0, sizes.indexOf(allowed.at(-1))))];
      }
      if (source.fps > 0) this.ceiling.fps = Math.max(60, ...rates.filter(r => r <= Math.min(source.fps + 0.5, ceiling.fps)));
      this.floor = Math.min(sizes.indexOf(ceiling.minResolution || '1920x1080'), sizes.indexOf(this.ceiling.resolution));
      this.current = { ...this.ceiling, resolution: sizes[Math.min(sizes.indexOf(this.ceiling.resolution), Math.max(this.floor, 1))], fps: Math.min(60, this.ceiling.fps), bitrate: Math.min(30, ceiling.bitrate), codec: ceiling.codec === 'auto' ? 'H264' : ceiling.codec };
      this.started = now; this.changed = now; this.formatChanged = now; this.goodSince = null; this.badSince = null;
      this.networkBad = 0; this.hardwareBad = 0; this.baseline = null; this.routeId = null; this.jitterBaseline = null; this.sendBaseline = null;
      this.compressionBad = 0; this.clarityHoldUntil = 0;
      this.reason = 'Проверяем сеть и обработку кадров; затем повышаем качество';
    }
    update(sample, receiver, now) {
      if (!sample?.valid) return null;
      if (sample.routeId !== this.routeId) { this.routeId = sample.routeId; this.baseline = this.jitterBaseline = this.sendBaseline = null; this.goodSince = null; }
      if (sample.rttMs !== null) this.baseline = Math.min(this.baseline ?? sample.rttMs, sample.rttMs);
      if (receiver?.jitterMs != null) this.jitterBaseline = Math.min(this.jitterBaseline ?? receiver.jitterMs, receiver.jitterMs);
      if (sample.sendDelayMs != null) this.sendBaseline = Math.min(this.sendBaseline ?? sample.sendDelayMs, sample.sendDelayMs);
      const inflation = sample.rttMs !== null && this.baseline !== null ? sample.rttMs - this.baseline : 0;
      // A constant browser A/V buffer or normal packet pacing is not congestion.
      const jitterGrowth = receiver?.jitterMs != null && this.jitterBaseline !== null ? receiver.jitterMs - this.jitterBaseline : 0;
      const queueGrowth = sample.sendDelayMs != null && this.sendBaseline !== null ? sample.sendDelayMs - this.sendBaseline : 0;
      const loss = Math.max(sample.lossPct || 0, receiver?.lossPct || 0);
      const frameBudget = 1000 / this.current.fps;
      const encodingSlow = sample.limitation === 'cpu' || sample.processingMs > frameBudget * 0.8;
      const decodingSlow = receiver?.decodeMs > frameBudget * 0.8 || receiver?.droppedPct > 8;
      const bandwidth = sample.availableMbps;
      const networkSlow = loss > 2 || inflation > 18 || queueGrowth > 15 || jitterGrowth > 25 || (bandwidth > 0 && bandwidth < this.current.bitrate * 0.8 && sample.actualMbps > bandwidth * 0.7);
      this.networkBad = networkSlow ? this.networkBad + 1 : 0;
      this.hardwareBad = encodingSlow || decodingSlow ? this.hardwareBad + 1 : 0;
      const compressed = sample.codec?.toUpperCase() === 'H264' && sample.qp >= 35 && sample.fps >= this.current.fps * 0.75;
      this.compressionBad = compressed ? this.compressionBad + 1 : 0;
      const bad = networkSlow || encodingSlow || decodingSlow;
      if (bad) { this.goodSince = null; this.badSince ??= now; } else { this.badSince = null; this.goodSince ??= now; }
      if (now - this.started < 2500 || now - this.changed < 2000) return null;
      const next = { ...this.current };
      let reason;
      if (this.networkBad >= 2 || loss >= 8 || inflation > 45 || queueGrowth > 45) {
        next.bitrate = Math.max(2, Math.min(next.bitrate * (loss >= 8 || inflation > 45 ? 0.7 : 0.83), bandwidth > 0 ? bandwidth * 0.82 : Infinity));
        reason = loss > 2 ? 'Потери пакетов: снижаем битрейт для быстрого отклика' : 'Канал перегружен: освобождаем очередь видео';
        if (now - (this.badSince ?? now) >= 6000 && now - this.formatChanged >= 6000 && next.bitrate < qualityRate(next) * 0.7) {
          if (next.fps > 60) next.fps = rates[rates.indexOf(next.fps) - 1];
          else if (sizes.indexOf(next.resolution) > this.floor) next.resolution = sizes[sizes.indexOf(next.resolution) - 1];
          reason += ' и уменьшаем нагрузку на кадр';
        }
      } else if (this.hardwareBad >= 3) {
        if (next.fps > 60) next.fps = rates[rates.indexOf(next.fps) - 1];
        else if (sizes.indexOf(next.resolution) > this.floor) next.resolution = sizes[sizes.indexOf(next.resolution) - 1];
        reason = decodingSlow ? 'ПК друга не успевает декодировать кадры' : 'Хост не успевает кодировать кадры';
        if (next.codec !== 'H264' && this.ceiling.codec === 'auto') { next.codec = 'H264'; reason += ': возвращаем H.264'; }
        if (next.resolution === this.current.resolution && next.fps === this.current.fps && next.codec === this.current.codec) reason += '; достигнут выбранный минимум разрешения';
      } else if (!bad && this.compressionBad >= 5 && next.fps > 60 && now - this.formatChanged >= 10000 && next.bitrate >= Math.min(this.ceiling.bitrate, bandwidth > 0 ? bandwidth * 0.85 : this.ceiling.bitrate) * 0.9) {
        next.fps = rates[rates.indexOf(next.fps) - 1];
        reason = 'Сильное сжатие H.264: уменьшаем FPS, чтобы сохранить больше деталей в движении';
      } else if (!bad && this.goodSince !== null && now - this.goodSince >= 8000 && now - this.changed >= 3000) {
        const safeRate = Math.min(this.ceiling.bitrate, bandwidth > 0 ? bandwidth * 0.85 : this.ceiling.bitrate);
        if (next.bitrate < safeRate - 0.5) { next.bitrate = Math.min(safeRate, next.bitrate * 1.12 + 0.5); reason = 'Связь стабильна: повышаем чёткость'; }
        if (now - this.formatChanged >= 12000 && now - this.goodSince >= 12000 && now >= this.clarityHoldUntil && !compressed) {
          const candidate = { ...next };
          if (candidate.fps < this.ceiling.fps) candidate.fps = rates[rates.indexOf(candidate.fps) + 1];
          else if (sizes.indexOf(candidate.resolution) < sizes.indexOf(this.ceiling.resolution)) candidate.resolution = sizes[sizes.indexOf(candidate.resolution) + 1];
          if (next.bitrate >= Math.min(this.ceiling.bitrate, qualityRate(candidate)) * 0.9 && safeRate >= qualityRate(candidate) * 0.85) {
            next.fps = candidate.fps; next.resolution = candidate.resolution; reason = 'Есть запас сети и ПК: повышаем плавность или разрешение';
          }
        }
      }
      if (reason) this.reason = reason;
      next.bitrate = round(Math.min(this.ceiling.bitrate, next.bitrate));
      if (next.bitrate === this.current.bitrate && next.fps === this.current.fps && next.resolution === this.current.resolution && next.codec === this.current.codec) return null;
      return { profile: next, reason: this.reason, at: now };
    }
    // Call only after applyConstraints and setParameters succeed.
    commit(change) {
      if (change.reason.startsWith('Сильное сжатие')) this.clarityHoldUntil = change.at + 30000;
      if (change.profile.resolution !== this.current.resolution || change.profile.fps !== this.current.fps) this.formatChanged = change.at;
      this.current = { ...change.profile }; this.changed = change.at; this.reason = change.reason;
    }
  }
  const exported = { Controller, measure, receiverFeedback, qualityRate };
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  else globalThis.TandemAdaptive = exported;
})();
