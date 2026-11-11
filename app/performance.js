'use strict';
(() => {
  const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  function distribution(values) {
    const sorted = values.filter(finite).sort((a,b)=>a-b), n = sorted.length;
    if (!n) return { count:0, median:null, p95:null, min:null, max:null };
    const round = v => Math.round(v*10)/10;
    return { count:n, median:round(sorted[Math.ceil(n*.5)-1]), p95:round(sorted[Math.ceil(n*.95)-1]), min:round(sorted[0]), max:round(sorted[n-1]) };
  }
  class Window {
    constructor() { this.reset(); }
    reset() { this.key = null; this.samples = []; this.frames = []; this.lastFrame = -Infinity; }
    frame(metadata, now) {
      if (now - this.lastFrame < 250) return;
      this.lastFrame = now;
      const receive = metadata.presentationTime - metadata.receiveTime;
      const decode = metadata.processingDuration * 1000;
      this.frames.push({ at:now, receiveToPresentMs:finite(receive) && receive < 10000 ? receive : null, frameDecodeMs:finite(decode) && decode < 10000 ? decode : null });
      this.frames = this.frames.filter(value=>value.at>=now-60000).slice(-240);
    }
    observe(sample, role, host, now) {
      const key = `${role}:${sample.routeId}:${sample.codec}:${sample.width}x${sample.height}`;
      if (key !== this.key) { this.samples = []; this.frames = []; this.key = key; }
      if (!sample.valid) return;
      const extraBuffer = finite(sample.jitterMs) && finite(sample.jitterMinimumMs) ? Math.max(0,sample.jitterMs-sample.jitterMinimumMs) : null;
      this.samples.push({ at:now, ...sample, extraBufferMs:extraBuffer, hostEncodeMs:role==='sender' ? sample.processingMs : host?.processingMs ?? null });
      this.samples = this.samples.filter(value=>value.at>=now-60000).slice(-60);
    }
    snapshot(now) {
      this.samples = this.samples.filter(value=>value.at>=now-60000); this.frames = this.frames.filter(value=>value.at>=now-60000);
      const result = { seconds:this.samples.length ? Math.round((now-this.samples[0].at)/1000) : 0, count:this.samples.length };
      for (const key of ['rttMs','lossPct','fps','actualMbps','hostEncodeMs','processingMs','sendDelayMs','jitterMs','jitterMinimumMs','extraBufferMs','droppedPct','qp','retransmitMbps']) result[key] = distribution(this.samples.map(v=>v[key]));
      result.receiveToPresentMs = distribution(this.frames.map(v=>v.receiveToPresentMs));
      result.freezeCount = this.samples.reduce((sum,v)=>sum+(finite(v.freezeCount)?v.freezeCount:0),0);
      return result;
    }
  }
  function advice({ summary, role, sample, host, vpn, profile }) {
    const notes = [], budget = 1000/(profile?.fps || 60), p95 = key => summary[key]?.p95;
    if (summary.count < 10) notes.push('Накопите хотя бы 10 секунд измерений; для сравнения профилей лучше 30–60 секунд движения в игре.');
    if (sample?.path?.network==='tailscale') {
      if (vpn?.path==='relay') notes.push('Tailscale использует DERP-ретранслятор. Сначала проверьте возможность прямого пути Tailscale; удалённый DERP может добавлять задержку.');
      else if (vpn?.path==='direct') notes.push('Прямой путь Tailscale подтверждён на момент сетевой проверки.');
      else notes.push('У WebRTC выбран адрес Tailscale. Нажмите «Проверить путь Tailscale», чтобы отличить прямую связь от DERP.');
    }
    if (sample?.path?.relay && ['tcp','tls'].includes(sample.path.turnProtocol)) notes.push('Этот клиент подключён к TURN по TCP/TLS. Сравните с TURN по UDP, если он доступен: при потерях TCP может задерживать последующие пакеты.');
    if (finite(p95('rttMs')) && p95('rttMs')>35) notes.push('Сетевая RTT заметна для динамичной игры. Сравните выбранный VPN/TURN-маршрут с прямым; сам битрейт не сокращает расстояние до узлов.');
    if (summary.rttMs?.count>=10 && summary.rttMs.p95-summary.rttMs.median>10) notes.push('RTT нестабильна. Сравните Ethernet с Wi-Fi и повторите тест без параллельных загрузок.');
    if (finite(p95('lossPct')) && p95('lossPct')>1) notes.push('Есть потери пакетов: высокий битрейт может усилить задержки и повреждение картинки. Сначала устраните потери или снизьте нагрузку.');
    if (finite(p95('sendDelayMs')) && p95('sendDelayMs')>20) notes.push('На отправителе накапливается очередь пакетов. Повышать битрейт сейчас не стоит.');
    if (finite(p95('hostEncodeMs')) && p95('hostEncodeMs')>budget*.8) notes.push('Кодирование близко к бюджету кадра или превышает его. Проверьте аппаратный кодировщик; сравните меньший FPS и кодек на обоих ПК.');
    if (role==='viewer' && finite(p95('processingMs')) && p95('processingMs')>budget*.8) notes.push('Декодирование на зрителе не успевает за выбранным FPS. Проверьте аппаратное декодирование и сравните меньший FPS.');
    if (role==='viewer' && finite(p95('extraBufferMs')) && p95('extraBufferMs')>15) notes.push('Часть задержки создаётся буфером воспроизведения сверх сетевого минимума. Для сравнения проверьте поток без системного звука; A/V-синхронизация может увеличивать буфер.');
    if ((sample?.codec || host?.codec || '').toUpperCase()==='H264' && finite(p95('qp')) && p95('qp')>=35) notes.push('QP H.264 указывает на сильное сжатие. При свободной сети сравните больший лимит битрейта; при достигнутом лимите — меньший FPS или аппаратный H.265/AV1. QP не измеряет видимую резкость напрямую.');
    if (summary.freezeCount>0) notes.push(`Браузер зарегистрировал остановки видео: ${summary.freezeCount}. Сопоставьте их с потерями, RTT и скоростью обработки.`);
    if (notes.length===0) notes.push('По доступным показателям явное узкое место не выявлено. Сравните 30–60 секунд движения в одной сцене; отсутствие предупреждения не гарантирует отсутствие задержки или артефактов.');
    return notes;
  }
  function report({ summary, role, sample, host, vpn, profile }) {
    const lines = ['Tandem — отчёт об отклике и качестве',new Date().toLocaleString('ru-RU'),`Роль: ${role==='sender'?'передача':'просмотр'}`,`Маршрут WebRTC: ${sample?.route || 'ещё не выбран'}`,`Кодек: ${sample?.codec || 'неизвестен'}`,`Измерений: ${summary.count}; период: ${summary.seconds} с`, ''];
    const add = (key,label,unit='мс') => { const v=summary[key]; lines.push(`${label}: ${v?.count ? `обычно ${v.median}, p95 ${v.p95} ${unit}` : 'браузер не предоставил данные'}`); };
    add('rttMs','Сетевая RTT'); add('lossPct','Потери пакетов','%'); add('fps','Частота потока','FPS'); add('actualMbps','Фактический битрейт','Мбит/с'); add('hostEncodeMs','Кодирование на хосте');
    add('processingMs',role==='sender'?'Кодирование локально':'Декодирование у зрителя'); add('sendDelayMs','Очередь отправителя'); add('jitterMs','Буфер зрителя'); add('jitterMinimumMs','Оценённый сетевой минимум буфера'); add('extraBufferMs','Дополнительный буфер'); add('receiveToPresentMs','От последнего пакета кадра до передачи кадра композитору'); add('qp','QP текущего кодека','');
    if (vpn) lines.push('',`Проверка Tailscale: ${vpn.reason}`,`Время проверки: ${vpn.at || 'не сообщено'}`,`Регион DERP: ${vpn.region || 'не сообщён / не используется'}`,`Пинги Tailscale: ${vpn.ping?.count || 0}; медиана ${vpn.ping?.medianMs ?? 'нет данных'} мс; p95 ${vpn.ping?.p95Ms ?? 'нет данных'} мс`,vpn.note || '');
    lines.push('','Рекомендации:',...advice({ summary, role, sample, host, vpn, profile }).map(v=>'• '+v),'','p95 — значение, ниже которого лежит 95% имеющихся измерений. Пропущенные метрики не считаются нулевыми.','RTT, очередь, обработка и буфер — отдельные показатели. Они не складываются здесь в выдуманную полную задержку нажатия до изображения.','QP сравнивайте только в рамках одного кодека. Точная видимая пикселизация и полная задержка управления этим отчётом не измеряются.');
    return lines.join('\n')+'\n';
  }
  const exported={ Window, distribution, advice, report };
  if (typeof module!=='undefined'&&module.exports) module.exports=exported; else globalThis.TandemPerformance=exported;
})();
