'use strict';
const $ = id => document.getElementById(id);
const api = window.tandem;
let env, ws, account, owner = false, role = 'sender', peerName = '', pc, stream, pendingStream;
let reliable, pointer, controlling = false, remoteControl = false, invite = '', roomReady = false, peerReady = false;
let authResolve, authReject, sourceResolve, sourceReject, confirmResolve, authBusy = false;
let incomingIce = [], signalQueue = Promise.resolve(), statsTimer, heartbeatTimer, lastStats, disconnectTimer;
let settings, busy = false, toastTimer, pendingPointer, pointerFrame = 0, lastRtt;
let remoteMedia = new MediaStream();
let player, directState = null, resumePending = null, reconnectTimer, reconnectAttempts = 0, connectionGoal = null, diagnostics = {}, hostTelemetry = null, activeCodec = null, motionTimer = null, lastMotion = 0;
let serverIdentity = null, foundFriend = null, pendingLookup = null, endingSession = null;
let runtimeProfile = null, adaptive = null, receiverStats = null, receiverStatsAt = 0, qualityEpoch = '', statsBusy = false, qualityBusy = false, remoteCodecs = null, codecProbeAttempted = false;
const sourceLimits = new WeakMap();
let adaptiveRetryAt = 0, qualityChanges = [];
let metricLogAt = 0, hostTelemetryAt = 0, latestSample = null, routeProbe = null, routeProbeTarget = null, frameCallback = null;
const performanceWindow = new TandemPerformance.Window();
let contacts = { friends: [], incoming: [], outgoing: [] }, contactsOwner = null;
const { normalizeServer: validateServer, createDirectPacket, parseDirectPacket, filterCandidates } = globalThis.TandemNetwork;
const defaults = { resolution: '1920x1080', fps: 120, bitrate: 60, codec: 'auto', qualityMode: 'adaptive', minResolution: '1920x1080', transport: 'auto', allowVPN: true, audio: true, embedded: false, mouseMode: 'game', hideCursor: true, ice: [{ urls: 'stun:stun.l.google.com:19302' }] };

function logEvent(event, data = {}) { api?.logEvent?.(event, data)?.catch(() => {}); }
function reportError(error) { const reason = TandemLog.error(error); logEvent('error', { reason, code: error?.code || error?.name || 'Error' }); toast(reason); }
function toast(message, persist = false) {
  $('toast').textContent = String(message).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
  $('toast').hidden = false; clearTimeout(toastTimer);
  if (!persist) toastTimer = setTimeout(() => { $('toast').hidden = true; }, 7000);
}
function run(fn) { return (...args) => Promise.resolve().then(() => fn(...args)).catch(reportError); }
function status(text, active = false) { $('status').textContent = text; $('status-dot').classList.toggle('live', active); }
function view(name) {
  logEvent('view', { section: ({session:'Игра и экран',friends:'Друзья',settings:'Качество и сеть',accounts:'Мой аккаунт',guide:'Как играть'})[name] || 'Другой раздел' });
  document.querySelectorAll('.view').forEach(el => { el.hidden = el.id !== `view-${name}`; });
  document.querySelectorAll('[data-view]').forEach(el => el.classList.toggle('active', el.dataset.view === name));
}
function refreshProfile() {
  const names = { '1280x720': 'HD', '1920x1080': '1080p', '2560x1440': '1440p', '3840x2160': '4K' };
  $('profile-title').textContent = `${settings.qualityMode === 'adaptive' ? 'Авто · ' : ''}${names[settings.resolution]} / ${settings.fps} FPS`;
}
function readSettings() {
  let ice; try { ice = JSON.parse($('ice').value); } catch { throw new Error('В поле ICE-серверов неверный JSON. Вставьте массив iceServers целиком, включая квадратные скобки.'); }
  TandemNetwork.iceConfiguration(ice, $('transport').value);
  if (!Array.isArray(ice) || ice.length > 8 || ice.some(s => !s || typeof s !== 'object' || !(typeof s.urls === 'string' || Array.isArray(s.urls)))) throw new Error('ICE-серверы: ожидается массив объектов с полем urls.');
  const bitrate = Number($('bitrate').value), fps = Number($('fps').value), resolution = $('resolution').value;
  if (!Number.isFinite(bitrate) || bitrate < 5 || bitrate > 250) throw new Error('Битрейт: от 5 до 250 Мбит/с.');
  if (![60, 90, 120, 144, 165, 240].includes(fps) || !['1280x720', '1920x1080', '2560x1440', '3840x2160'].includes(resolution)) throw new Error('Некорректный профиль.');
  return { ...TandemQuality.profile({ resolution, fps, bitrate, codec: $('codec').value, qualityMode: $('quality-mode').value, minResolution: $('min-resolution').value }), audio: $('audio').checked, embedded: false, mouseMode: $('mouse-mode').value, hideCursor: $('hide-cursor').checked, server: settings.server, transport: $('transport').value, allowVPN: $('allow-vpn').checked, ice };
}
async function persistSettings() {
  const safe = { ...settings, ice: settings.ice.filter(s => !s.credential && !s.username) };
  if (api?.saveSettings) await api.saveSettings(safe);
  else localStorage.setItem('tandem-settings-v1', JSON.stringify(safe));
  refreshProfile(); refreshAccount();
}
async function commitSettings() {
  const next = readSettings();
  if (roomReady && ws && next.server !== validateServer(ws.url)) throw new Error('Сначала завершите подключение, затем меняйте сервер сети.');
  settings = next; await persistSettings();
  logEvent('settings', { resolution: next.resolution, fps: next.fps, bitrate: next.bitrate, codec: next.codec, mode: next.qualityMode === 'adaptive' ? 'Автоподбор' : 'Ручной', route: next.transport === 'relay' ? 'Только TURN' : 'Авто', count: next.ice.length });
  $('settings-result').textContent = 'Настройки сохранены.'; player?.refresh();
}
async function saveSettings() {
  const next = readSettings();
  const approved = await confirmation('Сохранить настройки?', `${next.qualityMode === 'adaptive' ? 'Автоподбор, верхние пределы' : 'Ручной профиль'}: ${next.resolution} · ${next.fps} FPS · до ${next.bitrate} Мбит/с · ${next.codec}. ${peerReady ? (role === 'sender' ? 'Применить к текущей трансляции.' : 'Отправить хосту запрос на этот профиль.') : 'Применить при следующей трансляции.'}`, 'Сохранить');
  if (!approved) return;
  const changed = JSON.stringify(TandemQuality.profile(settings)) !== JSON.stringify(TandemQuality.profile(next));
  await commitSettings();
  if (changed && peerReady && pc?.connectionState === 'connected') {
    if (role === 'sender') await applyQuality(settings);
    else { dataSend({ type: 'quality-request', profile: TandemQuality.profile(settings) }); $('settings-result').textContent = 'Сохранено. Запрос на изменение потока отправлен хосту.'; }
  }
  toast('Настройки сохранены.');
}
async function applyQuality(value) {
  if (role !== 'sender' || !stream || !pc) return;
  const next = TandemQuality.profile(value);
  Object.assign(settings, next); showSettings(); await persistSettings();
  resetQuality(); await applyRuntime(runtimeProfile, true);
  dataSend({ type: 'quality-applied', profile: next });
  $('settings-result').textContent = `Применено к потоку: ${next.resolution}, ${next.fps} FPS, лимит ${next.bitrate} Мбит/с. Фактический битрейт зависит от сети и сцены.`;
}
function resetQuality(media = stream) {
  performanceWindow.reset();
  const ceiling = TandemQuality.profile(settings);
  adaptive = ceiling.qualityMode === 'adaptive' ? new TandemAdaptive.Controller(ceiling, performance.now(), sourceLimits.get(media) || {}) : null;
  runtimeProfile = adaptive ? { ...adaptive.current } : { ...ceiling, codec: ceiling.codec === 'auto' ? 'H264' : ceiling.codec };
  adaptiveRetryAt = 0; qualityChanges = [];
  receiverStats = null; receiverStatsAt = 0; qualityEpoch = crypto.randomUUID(); codecProbeAttempted = false;
}
async function applyRuntime(next, force = false) {
  if (qualityBusy || role !== 'sender' || !stream || !pc) return false;
  if (next.codec !== activeCodec && pc.signalingState !== 'stable') return false;
  qualityBusy = true;
  const current = pc, media = stream, previous = runtimeProfile;
  try {
    const [width, height] = next.resolution.split('x').map(Number);
    if (force || !previous || next.resolution !== previous.resolution || next.fps !== previous.fps || media.getVideoTracks()[0].getSettings().width !== width)
      await media.getVideoTracks()[0].applyConstraints({ width: { ideal: width, max: width }, height: { ideal: height, max: height }, frameRate: { ideal: next.fps, max: next.fps }, cursor: settings.hideCursor === false ? 'always' : 'never' });
    if (pc !== current || stream !== media || role !== 'sender') return false;
    runtimeProfile = { ...next };
    if (activeCodec !== next.codec && pc.signalingState === 'stable') await makeOffer(); else await configureSenders();
    return true;
  } catch (error) {
    runtimeProfile = previous;
    if (previous && stream === media) {
      const [width, height] = previous.resolution.split('x').map(Number);
      await media.getVideoTracks()[0].applyConstraints({ width: { ideal: width, max: width }, height: { ideal: height, max: height }, frameRate: { ideal: previous.fps, max: previous.fps } }).catch(() => {});
      if (pc === current) await configureSenders().catch(() => {});
    }
    throw error;
  } finally { qualityBusy = false; }
}
async function codecCapabilities() {
  const [width, height] = settings.resolution.split('x').map(Number), result = {};
  for (const codec of ['H264', 'H265', 'AV1']) {
    const mime = `video/${codec}`, configuration = { type: 'webrtc', video: { contentType: mime, width, height, bitrate: settings.bitrate * 1e6, framerate: settings.fps } };
    const entry = { encode: false, decode: false };
    for (const [action, rtc, method] of [['encode', RTCRtpSender, 'encodingInfo'], ['decode', RTCRtpReceiver, 'decodingInfo']]) {
      if (!rtc.getCapabilities('video')?.codecs.some(c => c.mimeType.toLowerCase() === mime.toLowerCase())) continue;
      try { const value = await navigator.mediaCapabilities?.[method](configuration); entry[action] = value?.supported === true && value.smooth === true && value.powerEfficient === true; } catch {}
    }
    result[codec] = entry;
  }
  return result;
}
async function sendCodecCapabilities() { const current = pc, capabilities = await codecCapabilities(); if (pc === current) dataSend({ type: 'codec-capabilities', capabilities }); }
async function automaticCodec() {
  if (!adaptive || settings.codec !== 'auto' || !remoteCodecs || codecProbeAttempted || qualityBusy || pc?.signalingState !== 'stable') return;
  codecProbeAttempted = true;
  const current = pc, capabilities = await codecCapabilities();
  if (pc !== current || role !== 'sender' || !adaptive) return;
  const codec = ['H265', 'AV1'].find(c => capabilities[c]?.encode === true && remoteCodecs[c]?.decode === true);
  if (!codec || runtimeProfile.codec === codec) return;
  const change = { profile: { ...runtimeProfile, codec }, reason: `Пробуем ${codec}: оба ПК сообщили аппаратную поддержку; проверяем время обработки`, at: performance.now() };
  if (await applyRuntime(change.profile)) adaptive.commit(change);
}
function refreshAccount() {
  const connected = account && ws?.readyState === WebSocket.OPEN;
  $('account-label').textContent = connected ? `${account.name} · ${account.id}` : 'Вы не вошли';
  $('own-id').textContent = connected ? account.id : '—';
  $('account-login').hidden = Boolean(connected);
  for (const id of ['copy-own-id', 'copy-account-invite', 'account-logout']) $(id).hidden = !connected;
  $('connection-server').textContent = connected ? `В сети · ${account.name} · ID ${account.id}` : settings?.server ? 'Войдите, чтобы найти друзей по ID' : 'Общая служба ещё не подключена к этой сборке. Доступен обмен прямыми приглашениями.';
  $('own-id-hint').textContent = connected ? `${account.name} · ваш постоянный ID. Друзья смогут отправить заявку по этому номеру.` : 'Войдите или создайте аккаунт. Адрес ПК друга вводить не требуется.';
  renderContacts();
}
function idleStatus() { status(account ? `Вы вошли · ID ${account.id}` : 'Готов к подключению', Boolean(account)); }
function renderContacts() {
  const online = Boolean(account && ws?.readyState === WebSocket.OPEN);
  const container = $('friends-list');
  if (!container) return;
  container.replaceChildren(); $('requests-list').replaceChildren(); $('outgoing-list').replaceChildren();
  const button = (label, action, enabled = online) => { const value = document.createElement('button'); value.className = 'button secondary'; value.textContent = label; value.disabled = !enabled; value.onclick = run(action); return value; };
  function card(person, target, actions, label) {
    const row = document.createElement('div'); row.className = 'friend-card';
    const info = document.createElement('div'), name = document.createElement('strong'), detail = document.createElement('small');
    name.textContent = person.name; detail.textContent = `ID ${person.id} · ${label}`; info.append(name, detail); row.append(info);
    const controls = document.createElement('div'); controls.className = 'friend-actions'; for (const action of actions) controls.append(action); row.append(controls); $(target).append(row);
  }
  for (const person of contacts.friends) card(person, 'friends-list', [
    button('Подключиться', () => watchFriend(person.id), online && person.online && !person.busy && !roomReady),
    button('Удалить', async () => { if (await confirmation('Удалить из друзей?', `${person.name} исчезнет из списка друзей.`, 'Удалить')) send({ type: 'friend-remove', id: person.id }); }),
  ], !online ? 'сохранён на этом ПК' : !person.online ? 'не в сети' : person.busy ? 'занят' : 'в сети');
  for (const person of contacts.incoming) card(person, 'requests-list', [button('Принять', () => send({ type: 'friend-accept', id: person.id })), button('Отклонить', () => send({ type: 'friend-decline', id: person.id }))], 'заявка в друзья');
  for (const person of contacts.outgoing) card(person, 'outgoing-list', [button('Отменить', () => send({ type: 'friend-remove', id: person.id }))], 'ожидаем ответа');
  $('friends-empty').hidden = contacts.friends.length > 0;
  $('requests-empty').hidden = contacts.incoming.length > 0;
  $('outgoing-empty').hidden = contacts.outgoing.length > 0;
  $('friends-state').textContent = online ? `В сети · друзей: ${contacts.friends.length}` : contactsOwner ? 'Локальная копия списка · войдите для обновления статуса' : 'Войдите, чтобы найти друзей и отправить заявку';
}
async function receiveContacts(message) {
  if (!account || !serverIdentity) return;
  const ownerKey = `${serverIdentity}:${account.id}`, clean = {};
  for (const list of ['friends', 'incoming', 'outgoing']) {
    if (!Array.isArray(message[list]) || message[list].length > 150) return;
    clean[list] = message[list].filter(p => p && /^[0-9]{8}$/.test(p.id) && /^[a-z0-9_]{3,24}$/.test(p.name)).map(p => ({ id: p.id, name: p.name, online: p.online === true, busy: p.busy === true }));
  }
  contacts = clean; contactsOwner = ownerKey; renderContacts();
  await api.saveContacts?.(serverIdentity, account.id, clean);
}
async function watchFriend(id) {
  if (busy || roomReady) throw new Error('Сначала завершите текущее подключение.');
  if (!account || ws?.readyState !== WebSocket.OPEN) throw new Error('Сначала войдите в аккаунт.');
  owner = false; role = 'viewer'; busy = true; buttonsBusy(true); view('session');
  send({ type: 'watch', id });
}
async function searchFriend(value) {
  if (!/^[0-9]{8}$/.test(value)) throw new Error('Введите ID друга из 8 цифр.');
  await ensureAuth(settings.server);
  foundFriend = null; pendingLookup = value; $('friend-result').textContent = 'Ищем аккаунт…';
  $('connect-friend').hidden = $('add-friend').hidden = true;
  send({ type: 'find', id: value });
}
async function copyInvitation() {
  if (!account || !serverIdentity || ws?.readyState !== WebSocket.OPEN) throw new Error('Сначала войдите в аккаунт на сервере вашей сети.');
  await api.copy(account.id);
  toast('Ваш ID скопирован. Друг может отправить заявку в друзья.');
}
function showSettings() {
  for (const id of ['resolution', 'fps', 'bitrate', 'codec']) $(id).value = settings[id];
  $('transport').value = settings.transport || 'auto'; $('allow-vpn').checked = settings.allowVPN !== false;
  $('quality-mode').value = settings.qualityMode; $('min-resolution').value = settings.minResolution;
  $('mouse-mode').value = settings.mouseMode || 'game'; $('hide-cursor').checked = settings.hideCursor !== false;
  $('audio').checked = settings.audio; $('ice').value = JSON.stringify(settings.ice, null, 2); refreshProfile();
}
function send(message) { if (message.type !== 'signal') logEvent('action', { action: 'Отправлен запрос службе аккаунтов', kind: ({register:'Регистрация',login:'Вход',resume:'Восстановление входа','friend-request':'Заявка в друзья','friend-accept':'Принятие дружбы','friend-decline':'Отклонение дружбы','friend-remove':'Удаление друга',watch:'Запрос просмотра','contacts-sync':'Обновление друзей',logout:'Выход',leave:'Завершение сессии'})[message.type] || 'Служебное обновление' }); if (ws?.readyState !== WebSocket.OPEN) throw new Error('Нет соединения с сервером.'); ws.send(JSON.stringify(message)); }
function dataSend(message, channel = reliable) {
  if (channel?.readyState === 'open' && channel.bufferedAmount < 65536) channel.send(JSON.stringify(message));
}
function confirmation(title, description, accept = 'Разрешить') {
  if (confirmResolve) return Promise.resolve(false);
  $('confirm-title').textContent = title; $('confirm-description').textContent = description; $('confirm-yes').textContent = accept;
  $('confirm-dialog').showModal(); return new Promise(resolve => { confirmResolve = resolve; });
}
function finishConfirmation(value) { logEvent('consent', { action: $('confirm-title').textContent, result: value ? 'Разрешено' : 'Отклонено' }); $('confirm-dialog').close(); const resolve = confirmResolve; confirmResolve = null; resolve?.(value); }
function cancelSource() { $('source-dialog').close(); sourceReject?.(new Error('Выбор экрана отменён.')); sourceReject = sourceResolve = null; }
async function chooseCapture() {
  logEvent('action', { action: 'Открыт выбор монитора' });
  const sources = await api.sources();
  if (!sources.length) throw new Error('Не найдено доступных мониторов.');
  $('source-list').replaceChildren();
  for (const source of sources) {
    const button = document.createElement('button'); button.className = 'source-choice';
    const image = document.createElement('img'); image.src = source.thumbnail; image.alt = source.name;
    const name = document.createElement('span'); name.textContent = source.name; button.append(image, name);
    button.onclick = () => { $('source-dialog').close(); sourceResolve?.(source.id); sourceReject = sourceResolve = null; };
    $('source-list').append(button);
  }
  $('source-dialog').showModal();
  const sourceId = await new Promise((resolve, reject) => { sourceResolve = resolve; sourceReject = reject; });
  await api.selectSource(sourceId);
  const source = sources.find(s => s.id === sourceId), startup = settings.qualityMode === 'adaptive' ? new TandemAdaptive.Controller(TandemQuality.profile(settings), performance.now(), source).current : settings;
  const [width, height] = startup.resolution.split('x').map(Number);
  const options = { video: { width: { ideal: width, max: width }, height: { ideal: height, max: height }, frameRate: { ideal: startup.fps, max: startup.fps }, cursor: settings.hideCursor === false ? 'always' : 'never' }, audio: settings.audio };
  let captured;
  try { captured = await navigator.mediaDevices.getDisplayMedia(options); }
  catch (error) {
    if (!settings.audio) throw error;
    captured = await navigator.mediaDevices.getDisplayMedia({ ...options, audio: false });
    toast('Звук недоступен: начата трансляция без звука.');
  }
  const track = captured.getVideoTracks()[0]; track.contentHint = 'motion';
  sourceLimits.set(captured, { width: source.width, height: source.height, fps: source.fps });
  try { await track.applyConstraints(options.video); } catch { toast('Захват использует ближайший доступный режим. Проверьте фактические параметры.'); }
  track.onended = () => { if (stream === captured) run(endSession)('Трансляция экрана завершена.'); };
  if (settings.audio && !captured.getAudioTracks().length) toast('Источник не предоставил системный звук.');
  logEvent('capture', { resolution: `${track.getSettings().width}x${track.getSettings().height}`, fps: track.getSettings().frameRate, result: captured.getAudioTracks().length ? 'Со звуком' : 'Без звука' });
  return captured;
}
function showVideo(media, local) {
  const video = $('video'); video.srcObject = media; video.muted = local; video.hidden = false;
  $('stage-idle').hidden = true; $('stream-overlay').hidden = false;
  $('stream-role').textContent = local ? 'Вы транслируете весь монитор' : `Экран · ${peerName || 'друг'}`;
  $('sound').hidden = local; $('sound').textContent = 'Звук: вкл.';
  video.play().catch(() => { if (video.srcObject === media) toast('Нажмите на экран, чтобы включить воспроизведение.'); });
}
function updateControls() {
  const connected = peerReady && pc?.connectionState === 'connected' && reliable?.readyState === 'open';
  $('request-control').hidden = role !== 'viewer' || !connected;
  $('request-control').textContent = controlling ? 'Вернуть управление' : 'Запросить управление';
  $('revoke-control').hidden = role !== 'sender' || !remoteControl;
  $('share-screen').hidden = role !== 'viewer' || !connected;
  $('mouse-lock').hidden = !controlling;
  $('control-status').textContent = controlling ? 'Вы управляете компьютером друга' : remoteControl ? 'Друг управляет вашим компьютером' : 'Управление у владельца';
  $('stage').classList.toggle('control-active', controlling); player?.refresh();
  $('stream-caption').textContent = controlling ? 'Кликните по видео для ввода. Esc — освободить мышь. Ctrl+Alt+F12 у владельца — отозвать доступ.' : 'Ctrl+Alt+F12 на компьютере владельца — вернуть управление';
}
async function revokeControl(notify = true) {
  remoteControl = controlling = false; clearInterval(heartbeatTimer);
  player?.unlock();
  await api.revokeControl();
  if (notify) dataSend({ type: 'control-revoked' });
  updateControls();
}
function configureChannel(channel) {
  if (channel.label === 'pointer') pointer = channel;
  else if (channel.label === 'control') reliable = channel;
  else { channel.close(); return; }
  channel.onmessage = event => {
    if (typeof event.data === 'string' && event.data.length <= 262144) {
      let message; try { message = JSON.parse(event.data); } catch { return; }
      run(handleData)(message);
    }
  };
  channel.onopen = () => { if (directState) { directState.connected = true; $('direct-exchange').hidden = true; } if (channel.label === 'control') run(sendCodecCapabilities)(); updateControls(); };
  channel.onclose = () => { run(revokeControl)(false); };
}
async function handleData(message) {
  if (!message || typeof message !== 'object') return;
  if (['control-request','control-granted','control-denied','control-revoked','swap-request','swap-accepted','swap-rejected'].includes(message.type)) logEvent(message.type.startsWith('swap') ? 'swap' : 'control', { result: ({'control-request':'Друг запросил управление','control-granted':'Владелец разрешил управление','control-denied':'Владелец отклонил управление','control-revoked':'Управление возвращено владельцу','swap-request':'Друг предложил сменить роли','swap-accepted':'Смена ролей разрешена','swap-rejected':'Смена ролей отклонена'})[message.type] });
  if (message.type === 'signal' && peerReady) { signalQueue = signalQueue.then(() => handleSignal(message.data)).catch(error => run(endSession)(error.message)); return; }
  if (message.type === 'end' && peerReady) { await endSession('Друг завершил сессию.'); return; }
  if (message.type === 'cursor-state') { player?.hostCursor(message.visible); return; }
  if (message.type === 'host-telemetry') { hostTelemetry = message.data; hostTelemetryAt = performance.now(); return; }
  if (message.type === 'receiver-stats' && role === 'sender' && message.epoch === qualityEpoch) { receiverStats = TandemAdaptive.receiverFeedback(message.data); receiverStatsAt = performance.now(); return; }
  if (message.type === 'codec-capabilities') { remoteCodecs = message.capabilities; if (role === 'sender') await automaticCodec(); return; }
  if (message.type === 'quality-request' && role === 'sender') {
    const next = TandemQuality.profile(message.profile);
    if (await confirmation('Изменить качество потока?', `Друг просит ${next.resolution} · ${next.fps} FPS · ${next.bitrate} Мбит/с · ${next.codec}. Применить сейчас?`, 'Применить')) await applyQuality(next);
    else dataSend({ type: 'quality-denied' });
    return;
  }
  if (message.type === 'quality-applied') { toast(`Хост применил ${message.profile.resolution} · ${message.profile.fps} FPS · лимит ${message.profile.bitrate} Мбит/с.`); return; }
  if (message.type === 'quality-denied') { toast('Хост оставил текущий профиль трансляции.'); return; }
  if (message.type === 'input' && role === 'sender' && remoteControl) {
    api.input(message.event);
  } else if (message.type === 'pointer' && role === 'sender' && remoteControl && ['move', 'relative'].includes(message.event?.kind)) {
    api.input(message.event);
  } else if (message.type === 'control-request' && role === 'sender') {
    const approved = await confirmation('Передать управление?', `${peerName || 'Друг'} получит доступ к клавиатуре и мыши всего компьютера. Вернуть управление: Ctrl+Alt+F12.`, 'Передать управление');
    if (approved && pc?.connectionState === 'connected' && role === 'sender') {
      await api.grantControl(); remoteControl = true; dataSend({ type: 'control-granted' }); updateControls();
    } else dataSend({ type: 'control-denied' });
  } else if (message.type === 'control-granted' && role === 'viewer') {
    controlling = true; dataSend({ type: 'input', event: { kind: 'heartbeat' } });
    clearInterval(heartbeatTimer); heartbeatTimer = setInterval(() => dataSend({ type: 'input', event: { kind: 'heartbeat' } }), 750);
    updateControls(); $('stage').focus(); toast('Управление получено. Кликните по видео, чтобы играть.');
  } else if (message.type === 'control-denied') toast('Друг отклонил запрос управления.');
  else if (message.type === 'control-revoked') { await revokeControl(false); toast('Управление возвращено владельцу.'); }
  else if (message.type === 'ping') dataSend({ type: 'pong', time: message.time });
  else if (message.type === 'pong' && Number.isFinite(message.time)) lastRtt = Math.max(0, Math.round(performance.now() - message.time));
  else if (message.type === 'swap-request' && role === 'sender') {
    const approved = await confirmation('Посмотреть экран друга?', `${peerName || 'Друг'} хочет стать ведущим. Ваша трансляция остановится, и вы увидите его монитор.`, 'Сменить роли');
    if (!approved) { dataSend({ type: 'swap-rejected' }); return; }
    view('session');
    await revokeControl();
    for (const sender of pc.getSenders()) if (sender.track) await sender.replaceTrack(null);
    stopStream(stream); stream = null; role = 'viewer'; lastStats = null; adaptive = runtimeProfile = receiverStats = null; hostTelemetry = null;
    $('video').srcObject = null; $('video').hidden = true; $('stage-idle').hidden = false; $('stage-message').textContent = 'Друг начинает трансляцию…';
    if (remoteMedia.getTracks().length) showVideo(remoteMedia, false);
    dataSend({ type: 'swap-accepted' }); updateControls();
  } else if (message.type === 'swap-accepted' && pendingStream) {
    view('session');
    await revokeControl(false); stream = pendingStream; pendingStream = null; role = 'sender'; lastStats = null; resetQuality();
    showVideo(stream, true); await makeOffer(); updateControls();
  } else if (message.type === 'swap-rejected') { stopStream(pendingStream); pendingStream = null; toast('Друг пока продолжает свою трансляцию.'); }
}
function makePeer() {
  pc = new RTCPeerConnection(TandemNetwork.iceConfiguration(settings.ice, settings.transport || 'auto'));
  logEvent('action', { action: 'Создано соединение WebRTC', mode: settings.transport === 'relay' ? 'Только TURN' : 'Авто', count: settings.ice.length });
  const current = pc;
  pc.onicecandidateerror = event => logEvent('ice_error', { code: event.errorCode, reason: TandemLog.iceError(event.errorCode), server: safeIceUrl(event.url) });
  pc.oniceconnectionstatechange = () => { if (pc === current) logEvent('ice_state', { state: connectionState(current.iceConnectionState) }); };
  pc.onicegatheringstatechange = () => { if (pc === current) logEvent('ice_state', { state: ({new:'Поиск маршрутов ещё не начался',gathering:'Идёт поиск маршрутов',complete:'Поиск маршрутов завершён'})[current.iceGatheringState] }); };
  pc.onicecandidate = event => { if (event.candidate && pc === current) { logCandidate(event.candidate); try { sendSignal({ kind: 'ice', candidate: event.candidate.toJSON() }); } catch {} } };
  pc.ondatachannel = event => configureChannel(event.channel);
  pc.ontrack = event => {
    if (!remoteMedia.getTracks().some(t => t.id === event.track.id)) remoteMedia.addTrack(event.track);
    if (role === 'viewer') {
      showVideo(remoteMedia, false);
      if ('playoutDelayHint' in event.receiver) event.receiver.playoutDelayHint = 0;
      if ('jitterBufferTarget' in event.receiver) event.receiver.jitterBufferTarget = 0;
      $('stage-message').textContent = '';
    }
  };
  pc.onconnectionstatechange = () => {
    if (pc !== current) return;
    logEvent('peer_state', { state: connectionState(pc.connectionState) });
    if (['connected', 'failed', 'disconnected'].includes(pc.connectionState)) clearTimeout(disconnectTimer);
    if (pc.connectionState === 'connected') { logEvent('connected', { mode: settings.transport === 'relay' ? 'Только TURN' : 'Авто' }); status(directState ? 'Сессия по приглашению установлена' : 'Вы в одной сети', true); startStats(); }
    else if (pc.connectionState === 'failed') {
      const reason = directState && owner && !pc.remoteDescription ? 'Ответ друга ещё не применён. Создайте новое приглашение и завершите обмен ответом.' : directState && !owner ? 'Связь не установилась. Проверьте, что владелец применил ваш ответ, и проверьте TURN на обоих ПК.' : 'Сетевой маршрут не установился. Проверьте TURN на обоих ПК и откройте журнал.';
      logEvent('error', { phase: directState ? 'Прямое приглашение' : 'Соединение с другом', reason }); run(endSession)(reason);
    }
    else if (pc.connectionState === 'disconnected') {
      run(revokeControl)(false); status('Соединение прервано…');
      disconnectTimer = setTimeout(() => run(endSession)('Соединение потеряно. Подключитесь заново.'), 8000);
    }
    updateControls();
  };
  if (owner) {
    configureChannel(pc.createDataChannel('control', { ordered: true }));
    configureChannel(pc.createDataChannel('pointer', { ordered: false, maxRetransmits: 0 }));
  }
  connectionTimeout(current, directState ? 15 * 60 * 1000 : 25000, Boolean(directState));
  return pc;
}
function safeIceUrl(value) {
  const match = typeof value === 'string' && value.match(/^(stuns?|turns?):(?:\[[0-9a-f:]+\]|[a-z0-9.-]+)(?::\d+)?/i);
  return match ? match[0] : 'Настроенный ICE-сервер';
}
function connectionState(value) {
  return ({ new: 'Ожидаем начала соединения', checking: 'Проверяем доступные маршруты', connecting: 'Устанавливаем защищённое соединение', connected: 'Связь установлена', completed: 'Рабочий маршрут выбран', disconnected: 'Связь временно прервалась', failed: 'Рабочий маршрут установить не удалось', closed: 'Соединение закрыто' })[value] || 'Обновление состояния';
}
function logCandidate(candidate) {
  logEvent('ice_candidate', { kind: ({ host: 'Локальный маршрут', srflx: 'Внешний маршрут через STUN', prflx: 'Маршрут, обнаруженный вторым участником', relay: 'Маршрут через TURN' })[candidate.type] || 'Сетевой маршрут', mode: candidate.protocol || 'Транспорт не сообщён' });
}
function connectionTimeout(peer, delay, exchange) {
  clearTimeout(disconnectTimer);
  disconnectTimer = setTimeout(() => {
    if (pc !== peer || peer.connectionState === 'connected') return;
    const message = exchange ? 'Истекло время обмена приглашением и ответом. Создайте новые файлы и примените ответ у владельца. Причину NAT на этом этапе определить нельзя.' : 'Ответ применён, но связь не установилась. Проверьте TURN кнопкой «Проверить TURN» и откройте журнал.';
    logEvent(exchange ? 'wait_expired' : 'connect_timeout', { phase: exchange ? 'Обмен файлами' : 'Установка соединения', reason: message });
    run(endSession)(message);
  }, delay);
}
function updateJoinLabel() { $('join').textContent = $('invite-input').value.trim().startsWith('tandem://direct/') ? 'Применить прямое приглашение' : 'Найти аккаунт'; }
async function testTurn() {
  if ($('test-turn').disabled) return;
  let ice;
  try { ice = JSON.parse($('ice').value); } catch { throw new Error('В поле ICE-серверов неверный JSON. Вставьте массив из панели провайдера.'); }
  const config = TandemNetwork.iceConfiguration(ice, 'relay');
  const probe = new RTCPeerConnection(config), failures = []; let candidates = 0, finish, timer;
  $('test-turn').disabled = true; $('turn-result').textContent = 'Проверяем, может ли TURN выделить маршрут…'; logEvent('turn_start', { count: ice.length });
  try {
    const done = new Promise(resolve => { finish = resolve; timer = setTimeout(resolve, 15000); });
    probe.onicecandidate = event => { if (event.candidate?.type === 'relay') { candidates++; logCandidate(event.candidate); finish(); } else if (!event.candidate) finish(); };
    probe.onicecandidateerror = event => { failures.push(event.errorCode); logEvent('ice_error', { code: event.errorCode, reason: TandemLog.iceError(event.errorCode), server: safeIceUrl(event.url) }); };
    probe.onicegatheringstatechange = () => { if (probe.iceGatheringState === 'complete') finish(); };
    probe.createDataChannel('turn-check'); await probe.setLocalDescription(await probe.createOffer()); await done;
    const reason = candidates ? 'TURN доступен: сервер выделил маршрут. Теперь сохраните настройки и создайте новое приглашение и новый ответ. Это проверка доступа к серверу, не измерение задержки игры.' : failures.length ? TandemLog.iceError(failures.at(-1)) : 'За 15 секунд TURN не выделил маршрут. Проверьте адрес, порт, username и credential.';
    $('turn-result').textContent = reason; logEvent(candidates ? 'turn_ok' : 'turn_failed', { count: candidates, reason });
  } finally { clearTimeout(timer); probe.close(); $('test-turn').disabled = false; }
}
async function attachTracks() {
  for (const track of stream.getTracks()) {
    let transceiver = pc.getTransceivers().find(t => t.receiver.track.kind === track.kind && !t.stopped);
    if (transceiver) { await transceiver.sender.replaceTrack(track); transceiver.direction = 'sendrecv'; transceiver.sender.setStreams(stream); }
    else { const sender = pc.addTrack(track, stream); transceiver = pc.getTransceivers().find(t => t.sender === sender); }
    if (track.kind === 'video') {
      const caps = RTCRtpSender.getCapabilities('video');
      const preferredCodec = runtimeProfile?.codec || 'H264';
      if (caps && transceiver.setCodecPreferences) {
        const preferred = caps.codecs.filter(c => c.mimeType.toLowerCase() === `video/${preferredCodec.toLowerCase()}`);
        if (preferred.length) transceiver.setCodecPreferences([...preferred, ...caps.codecs.filter(c => !preferred.includes(c))]);
        else toast(`Кодек ${preferredCodec} недоступен. WebRTC выберет другой.`);
      }
    }
  }
}
async function configureSenders() {
  for (const sender of pc.getSenders()) {
    if (sender.track?.kind !== 'video') continue;
    const params = sender.getParameters();
    if (!params.encodings?.length) continue;
    const profile = runtimeProfile || settings;
    params.encodings[0].maxBitrate = Math.round(profile.bitrate * 1000000); params.encodings[0].maxFramerate = profile.fps;
    params.degradationPreference = 'maintain-resolution';
    await sender.setParameters(params);
  }
}
async function makeOffer(manual = false) {
  if (!pc) makePeer();
  if (!runtimeProfile) resetQuality();
  await attachTracks();
  const offer = await pc.createOffer(); offer.sdp = TandemQuality.startBitrate(offer.sdp, runtimeProfile.bitrate);
  await pc.setLocalDescription(offer); await configureSenders(); activeCodec = runtimeProfile.codec;
  if (!manual) sendSignal({ kind: 'offer', sdp: pc.localDescription.sdp });
}
function filterSdp(sdp) { return filterCandidates(sdp, { allowVPN: settings.allowVPN !== false, transport: settings.transport || 'auto' }); }
async function handleSignal(data) {
  if (!peerReady) return;
  if (!pc) makePeer();
  if (data.kind === 'ice') {
    if (!filterSdp('a=' + data.candidate?.candidate + '\r\n').trim()) return;
    if (pc.remoteDescription) await pc.addIceCandidate(data.candidate); else incomingIce.push(data.candidate);
    return;
  }
  if (!['offer', 'answer'].includes(data.kind) || typeof data.sdp !== 'string') return;
  await pc.setRemoteDescription({ type: data.kind, sdp: filterSdp(data.sdp) });
  for (const candidate of incomingIce.splice(0)) await pc.addIceCandidate(candidate);
  if (data.kind === 'offer') {
    await pc.setLocalDescription(await pc.createAnswer());
    sendSignal({ kind: 'answer', sdp: pc.localDescription.sdp });
  }
}
function sendSignal(data) {
  if (data.kind === 'ice' && data.candidate && !filterSdp('a=' + data.candidate.candidate + '\r\n').trim()) return;
  if (data.sdp) data = { ...data, sdp: filterSdp(data.sdp) };
  if (reliable?.readyState === 'open') { dataSend({ type: 'signal', data }); return; }
  if (directState) {
    if (reliable?.readyState === 'open') dataSend({ type: 'signal', data });
  } else send({ type: 'signal', data });
}
function waitIce(peer) {
  if (peer.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); peer.removeEventListener('icegatheringstatechange', check); resolve(); };
    const check = () => { if (peer.iceGatheringState === 'complete') done(); };
    const timer = setTimeout(done, 10000); peer.addEventListener('icegatheringstatechange', check);
  });
}
function directOutput(kind) {
  const packet = createDirectPacket({ kind, session: directState.session, name: account?.name || (owner ? 'Владелец' : 'Друг'), sdp: filterSdp(pc.localDescription.sdp) });
  logEvent(kind === 'offer' ? 'direct_offer' : 'direct_answer');
  $('direct-output').value = packet; $('direct-exchange').hidden = false;
  $('direct-help').textContent = kind === 'offer' ? 'Отправьте приглашение другу (для мессенджера удобнее файл). Друг создаст ответ; вставьте его ниже или откройте файл ответа.' : 'Отправьте этот ответ владельцу. Он применит ответ и подтвердит подключение. VPN и общий сервер не нужны; при сложном NAT понадобится TURN.';
  for (const id of ['direct-response', 'direct-apply', 'direct-open-response']) $(id).hidden = kind !== 'offer';
}
async function createDirect() {
  if (busy || roomReady) return;
  busy = true; buttonsBusy(true); owner = true; role = 'sender';
  try { await commitSettings(); } catch (error) { busy = false; buttonsBusy(false); throw error; }
  directState = { session: Array.from(crypto.getRandomValues(new Uint8Array(16)), x => x.toString(16).padStart(2, '0')).join(''), connected: false };
  try {
    stream = await chooseCapture(); showVideo(stream, true); await makeOffer(true); await waitIce(pc);
    roomReady = true; activeUI(); directOutput('offer'); status('Передайте прямое приглашение другу');
  } catch (error) { await endSession(); throw error; }
  finally { busy = false; buttonsBusy(false); }
}
async function importDirect(text) {
  const packet = parseDirectPacket(text);
  if (packet.kind === 'answer') return applyDirectAnswer(packet);
  if (roomReady || busy) throw new Error('Сначала завершите текущее подключение.');
  logEvent('direct_received', { kind: packet.kind === 'offer' ? 'Предложение просмотра' : 'Ответ' });
  busy = true; buttonsBusy(true); owner = false; role = 'viewer';
  try { await commitSettings(); } catch (error) { busy = false; buttonsBusy(false); throw error; }
  directState = { session: packet.session, connected: false }; peerReady = true; peerName = packet.name;
  try {
    makePeer(); await pc.setRemoteDescription({ type: 'offer', sdp: filterSdp(packet.sdp) });
    await pc.setLocalDescription(await pc.createAnswer()); await waitIce(pc);
    roomReady = true; activeUI(); directOutput('answer'); status('Отправьте ответ владельцу и дождитесь принятия');
  } catch (error) { await endSession(); throw error; }
  finally { busy = false; buttonsBusy(false); }
}
async function applyDirectAnswer(packet) {
  if (!directState || !owner || packet.kind !== 'answer' || packet.session !== directState.session) throw new Error('Этот ответ относится к другому приглашению. Создайте новую прямую сессию.');
  if (!await confirmation('Принять прямое подключение?', `Ответ от «${packet.name}». После принятия он увидит выбранный монитор. Управление разрешается отдельно.`, 'Принять')) return;
  peerName = packet.name; peerReady = true;
  await pc.setRemoteDescription({ type: 'answer', sdp: filterSdp(packet.sdp) });
  logEvent('direct_applied'); connectionTimeout(pc, 45000, false);
  $('peer-label').textContent = `Прямое соединение · ${peerName}`; updateControls();
}
async function tryResume() {
  const token = await api.loadSession?.(serverIdentity);
  if (!token) return false;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { resumePending = null; reject(new Error('Восстановление входа не ответило. Повторите подключение.')); }, 10000);
    resumePending = { resolve: value => { clearTimeout(timer); resumePending = null; resolve(value); }, reject: error => { clearTimeout(timer); resumePending = null; reject(error); } };
    send({ type: 'resume', token });
  });
}
function reconnect(goal) {
  clearTimeout(reconnectTimer);
  if (!goal || directState) return;
  status('Связь с сервером прервана · восстанавливаем вход…');
  reconnectTimer = setTimeout(async () => {
    try {
      await connect(goal.server, goal.network);
      if (await tryResume()) { reconnectAttempts = 0; if (peerReady) { status('Сессия установлена', true); toast('Служба друзей восстановлена. Игра продолжается.'); } else { idleStatus(); toast('Вход восстановлен.'); } }
      else { connectionGoal = null; idleStatus(); toast('Сохранённый вход недоступен. Войдите заново.'); }
    } catch { reconnectAttempts++; reconnect(goal); }
  }, Math.min(15000, 1000 * 2 ** reconnectAttempts));
}
async function connect(url, expectedNetwork) {
  if (!url) throw new Error('Общая служба Tandem ещё не размещена. Пока можно подключиться через прямое приглашение.');
  url = validateServer(url);
  if (ws?.readyState === WebSocket.OPEN && validateServer(ws.url) === url && serverIdentity) {
    if (expectedNetwork && serverIdentity !== expectedNetwork) throw new Error('По этому адресу находится другая база аккаунтов. Служба использует другую базу аккаунтов; войдите заново в выбранную службу.');
    return;
  }
  if (account && ws?.readyState === WebSocket.OPEN && validateServer(ws.url) !== url) {
    const accepted = await confirmation('Перейти в другую сеть?', `Текущий аккаунт находится на ${validateServer(ws.url)}. Вы выбрали ${url}. В другой сети отдельные аккаунты и ID: потребуется войти или зарегистрироваться там.`, 'Перейти');
    if (!accepted) throw new Error('Смена сети отменена. Вы остались в текущем аккаунте.');
  }
  if (roomReady && pc?.connectionState !== 'connected') throw new Error('Сначала завершите текущее подключение.');
  if (ws) await endSession(undefined, { disconnect: true });
  clearTimeout(reconnectTimer);
  account = null; serverIdentity = null; refreshAccount();
  logEvent('server_state', { state: 'Подключаемся к общей службе' });
  const socket = new WebSocket(url); ws = socket;
  await new Promise((resolve, reject) => {
    let ready = false;
    const fail = error => {
      clearTimeout(timer); socket.onclose = null;
      if (ws === socket) { ws = null; account = null; serverIdentity = null; refreshAccount(); idleStatus(); }
      socket.close(); reject(error);
    };
    const timer = setTimeout(() => fail(new Error('Служба Tandem не отвечает. Проверьте интернет и повторите подключение.')), 10000);
    socket.onerror = () => { if (!ready) fail(new Error('Не удалось подключиться к службе Tandem. Проверьте интернет.')); else socket.close(); };
    socket.onmessage = event => {
      if (ws !== socket) return;
      let msg; try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.type === 'hello') {
        if (msg.protocol !== 4 || !/^[a-f0-9]{32}$/.test(msg.network)) { fail(new Error('Общая служба использует несовместимую версию протокола. Требуется сервер Tandem 0.3.0.')); return; }
        if (expectedNetwork && msg.network !== expectedNetwork) { fail(new Error('Приглашение относится к другой базе аккаунтов. Проверьте конфигурацию общей службы.')); return; }
        serverIdentity = msg.network; ready = true; clearTimeout(timer); refreshAccount(); resolve(); return;
      }
      if (!ready) return;
      if (msg.type === 'signal') signalQueue = signalQueue.then(() => handleSignal(msg.data)).catch(error => run(endSession)(`Ошибка видеосоединения: ${error.message}`));
      else run(handleServer)(msg);
    };
    socket.onclose = () => {
      clearTimeout(timer); if (ws !== socket) return;
      logEvent('server_state', { state: 'Соединение со службой закрыто; готовый P2P-поток может продолжаться' });
      const goal = connectionGoal; ws = null; account = null; serverIdentity = null; refreshAccount();
      resumePending?.reject(new Error('Сервер отключился.'));
      reject(new Error('Соединение с сервером закрыто.'));
      if (directState) return;
      if (authReject) cancelAuth('Сервер отключился.');
      if (pc?.connectionState === 'connected' && reliable?.readyState === 'open') status('Игра продолжается · восстанавливаем службу друзей');
      else if (roomReady || stream || busy) run(endSession)('Связь со службой Tandem прервана.', { notifyServer: false });
      else idleStatus();
      if (goal) reconnect(goal); else toast('Соединение с сервером закрыто.');
    };
  });
}
async function ensureAuth(url, expectedNetwork) {
  await connect(url, expectedNetwork);
  if (account || await tryResume()) return;
  $('auth-server').textContent = 'Аккаунт Tandem · вход сохранится на этом компьютере';
  $('auth-result').textContent = 'При регистрации получите ID из 8 цифр. Пароль не сохраняется в файле настроек.';
  $('auth-dialog').showModal();
  return new Promise((resolve, reject) => { authResolve = resolve; authReject = reject; });
}
function cancelAuth(message = 'Вход отменён.') {
  $('auth-dialog').close(); authReject?.(new Error(message)); authReject = authResolve = null; setAuthBusy(false);
}
function setAuthBusy(value) { authBusy = value; for (const id of ['auth-register', 'auth-login']) $(id).disabled = value; }
async function submitAuth(register) {
  if (authBusy || !$('auth-form').reportValidity()) return;
  setAuthBusy(true);
  const credentials = { name: $('login-name').value.trim(), password: $('login-password').value };
  try {
    send({ type: register ? 'register' : 'login', ...credentials });
  } catch (error) { setAuthBusy(false); $('auth-result').textContent = error.message; }
}
async function handleServer(msg) {
  if (!['contacts', 'signal'].includes(msg.type)) logEvent(msg.type === 'error' ? 'error' : msg.type === 'authenticated' ? 'authenticated' : 'server_event', { result: ({found:'Аккаунт найден',created:'Сессия создана','join-pending':'Запрос отправлен владельцу','watch-request':'Друг запросил просмотр','peer-joined':'Друг присоединился',joined:'Просмотр разрешён',rejected:'Просмотр отклонён','peer-left':'Друг отключился',ended:'Сессия закрыта службой'})[msg.type] || 'Служебный ответ', code: msg.code, reason: msg.type === 'error' ? TandemLog.error(msg.message) : undefined });
  if (msg.type === 'contacts') { await receiveContacts(msg); return; }
  if (msg.type === 'watch-request') {
    if (busy || roomReady || directState || stream) { send({ type: 'reject-peer' }); return; }
    owner = true; role = 'sender'; roomReady = true; busy = true; view('session');
    try {
      const accepted = await confirmation('Показать экран другу?', `${msg.name} · ID ${msg.id} просит посмотреть ваш монитор. Управление потребует отдельного разрешения.`, 'Выбрать монитор');
      if (!accepted || !roomReady) { if (ws?.readyState === WebSocket.OPEN) send({ type: 'reject-peer' }); await endSession(); return; }
      const media = await chooseCapture();
      if (!roomReady || ws?.readyState !== WebSocket.OPEN) { stopStream(media); return; }
      stream = media; showVideo(stream, true); busy = false;
      send({ type: 'accept-peer' });
    } catch (error) { if (ws?.readyState === WebSocket.OPEN) send({ type: 'reject-peer' }); await endSession(); toast(error.message); }
    return;
  }
  if (msg.type === 'error') {
    if (msg.request === 'resume' && resumePending) {
      if (msg.code === 'SESSION_EXPIRED') { await api.clearSession?.(serverIdentity); resumePending.resolve(false); }
      else resumePending.reject(new Error(msg.message));
      return;
    }
    if ($('auth-dialog').open) { $('auth-result').textContent = msg.message; setAuthBusy(false); }
    else {
      busy = false; buttonsBusy(false);
      if (msg.code === 'AUTH_REQUIRED') { account = null; refreshAccount(); }
      if (msg.request === 'find' || msg.request === 'join-id') {
        foundFriend = null; pendingLookup = null; $('connect-friend').hidden = true;
        $('friend-result').textContent = msg.message;
        idleStatus();
      } else if (msg.request === 'create') await endSession();
      toast(msg.message);
    }
  } else if (msg.type === 'authenticated') {
    const sourceSocket = ws, endpoint = validateServer(ws.url);
    account = msg.account; serverIdentity = msg.network; connectionGoal = { server: endpoint, network: msg.network };
    contactsOwner = `${msg.network}:${account.id}`;
    contacts = await api.loadContacts?.(msg.network, account.id) || { friends: [], incoming: [], outgoing: [] };
    await api.saveAccount?.(msg.network, account);
    if (msg.token) { try { const saved = await api.saveSession?.(msg.network, msg.token, endpoint); if (saved === false) toast('Windows не предоставила защищённое хранилище: вход сохранён только до закрытия приложения.'); } catch { toast('Не удалось сохранить ключ в Windows. В текущей сессии вход выполнен.'); } }
    if (ws !== sourceSocket || ws?.readyState !== WebSocket.OPEN) return;
    localStorage.setItem('tandem-last-network', msg.network); connectionGoal = { server: endpoint, network: msg.network }; reconnectAttempts = 0;
    resumePending?.resolve(true); setAuthBusy(false); refreshAccount(); idleStatus();
    $('login-password').value = ''; $('auth-dialog').close(); authResolve?.(); authReject = authResolve = null;
    send({ type: 'contacts-sync' });
    if (peerReady) send({ type: 'presence', busy: true });
  } else if (msg.type === 'found') {
    busy = false; buttonsBusy(false);
    if (msg.account.id !== pendingLookup) return;
    foundFriend = { ...msg.account, server: validateServer(ws.url), friend: msg.friend }; idleStatus();
    $('friend-result').textContent = `${msg.account.name} · ${msg.account.id} · ${!msg.online ? 'Не в сети' : msg.busy ? 'Сейчас занят' : 'В сети'}${msg.friend ? ' · ваш друг' : ''}`;
    $('connect-friend').hidden = !msg.friend || !msg.online || msg.busy;
    $('add-friend').hidden = msg.friend || contacts.outgoing.some(p => p.id === msg.account.id) || contacts.incoming.some(p => p.id === msg.account.id);
  } else if (msg.type === 'left') {
    if (!roomReady && !busy) idleStatus();
  } else if (msg.type === 'created') {
    invite = msg.id;
    $('invite-output').value = invite; roomReady = true; activeUI(); status('Сеть создана · ожидаем друга', true); busy = false; buttonsBusy(false);
  } else if (msg.type === 'join-pending') {
    roomReady = true; activeUI(); status('Владелец подтверждает подключение…'); busy = false; buttonsBusy(false);
    $('stage-message').textContent = 'Запрос отправлен. Ждём согласия владельца.';
  } else if (msg.type === 'join-request') {
    const accepted = await confirmation('Друг хочет подключиться', `Аккаунт ${msg.name} · ID ${msg.id} просит показать ваш монитор целиком. Управление пока останется у вас.`, 'Принять подключение');
    if (ws?.readyState === WebSocket.OPEN) send({ type: accepted ? 'accept-peer' : 'reject-peer' });
  } else if (msg.type === 'request-cancelled') { if (confirmResolve) finishConfirmation(false); if (sourceReject) cancelSource(); await endSession('Друг отменил запрос.'); }
  else if (msg.type === 'peer-joined' || msg.type === 'joined') {
    peerReady = true; peerName = msg.name; roomReady = true; activeUI(); status('Устанавливаем прямое соединение…');
    $('peer-label').textContent = `В сети · ${peerName}`;
    if (owner) await makeOffer(); else makePeer();
  } else if (msg.type === 'peer-left' || msg.type === 'ended') { if (pc?.connectionState !== 'connected' || reliable?.readyState !== 'open') await endSession('Друг отключился.'); }
  else if (msg.type === 'rejected') await endSession('Владелец отклонил подключение.');
}
function activeUI() {
  $('connection-idle').hidden = true; $('connection-active').hidden = false; $('invitation-box').hidden = !owner || Boolean(directState);
  $('direct-exchange').hidden = !directState || directState.connected;
  $('network-title').textContent = directState ? 'Связь по приглашению' : 'Сессия с другом'; updateControls(); renderContacts();
}
function buttonsBusy(value) { $('create').disabled = $('join').disabled = value; }
async function createNetwork() {
  if (!api) throw new Error('Откройте настольное приложение Tandem.');
  return createDirect();
}
async function joinNetwork() {
  if (!api) throw new Error('Откройте настольное приложение Tandem.');
  if (busy || roomReady) return;
  if ($('invite-input').value.trim().startsWith('tandem://direct/')) return importDirect($('invite-input').value.trim());
  return searchFriend($('invite-input').value.trim());

}
function stopStream(value) { value?.getTracks().forEach(t => { t.onended = null; t.stop(); }); }
function endSession(message, options = {}) {
  if (endingSession) return endingSession;
  endingSession = resetSession(message, options).finally(() => { endingSession = null; });
  return endingSession;
}
async function resetSession(message, { disconnect = false, notifyServer = true } = {}) {
  logEvent('ended', { reason: message ? TandemLog.error(message) : 'Завершено пользователем или выполнен сброс сессии' });
  dataSend({ type: 'end' });
  directState = null; $('direct-exchange').hidden = true; $('direct-output').value = ''; $('direct-response').value = '';
  roomReady = peerReady = false; busy = false; controlling = remoteControl = false; hostTelemetry = null;
  performanceWindow.reset(); latestSample = routeProbe = routeProbeTarget = null; $('performance-advice').textContent = 'Показатели появятся во время трансляции.';
  runtimeProfile = adaptive = receiverStats = remoteCodecs = activeCodec = null; codecProbeAttempted = false; qualityEpoch = '';
  player?.unlock();
  clearInterval(statsTimer); clearInterval(heartbeatTimer); clearTimeout(disconnectTimer);
  if (pointerFrame) cancelAnimationFrame(pointerFrame); clearTimeout(motionTimer); motionTimer = null; pointerFrame = 0; pendingPointer = null;
  if (confirmResolve) finishConfirmation(false);
  if (sourceReject) cancelSource();
  await revokeControl(false); await api?.endSession();
  const current = pc; pc = null; if (current) { current.onconnectionstatechange = null; current.close(); }
  reliable = pointer = null; incomingIce = []; lastStats = lastRtt = null; remoteMedia = new MediaStream();
  stopStream(stream); stopStream(pendingStream); stream = pendingStream = null;
  if (ws?.readyState === WebSocket.OPEN && notifyServer) ws.send(JSON.stringify({ type: 'leave' }));
  if (ws?.readyState === WebSocket.OPEN) send({ type: 'presence', busy: false });
  if (disconnect) { clearTimeout(reconnectTimer); connectionGoal = null; }
  if (disconnect && ws) { const socket = ws; ws = null; socket.onclose = null; socket.close(); account = null; serverIdentity = null; }
  refreshAccount();
  $('video').srcObject = null; $('video').hidden = true; $('stage-idle').hidden = false; $('stream-overlay').hidden = true;
  $('sound').hidden = $('mouse-lock').hidden = true; $('connection-idle').hidden = false; $('connection-active').hidden = true;
  $('stage-message').textContent = 'Выберите друга и запросите подключение'; $('peer-label').textContent = 'Ожидаем друга';
  $('invite-output').value = ''; invite = ''; foundFriend = null; pendingLookup = null; $('friend-result').textContent = ''; $('connect-friend').hidden = true; buttonsBusy(false); idleStatus();
  for (const id of ['rtt', 'fps', 'bitrate', 'loss']) $(`stat-${id}`).firstChild.textContent = '—';
  $('metrics-detail').textContent = 'Показатели появятся после подключения. RTT — время туда и обратно, не полная задержка управления.';
  if (message) toast(message, true);
  if (!ws && connectionGoal && !disconnect) reconnect(connectionGoal);
}
function metric(id, value) { $(`stat-${id}`).firstChild.textContent = value == null ? '—' : String(value); }
function performanceContext() {
  const vpn = routeProbe && Date.now()-Date.parse(routeProbe.at)>120000 ? { ...routeProbe, path:'unknown', reason:'Проверка пути выполнена более двух минут назад. Повторите её для текущего состояния.' } : routeProbe;
  return { summary: performanceWindow.snapshot(performance.now()), role, sample: latestSample, host: performance.now()-hostTelemetryAt<3500 ? hostTelemetry : null, vpn, profile: runtimeProfile || hostTelemetry?.profile || settings };
}
function monitorFrames() {
  const video = $('video');
  if (!video.requestVideoFrameCallback) return;
  const sample = (now, metadata) => {
    if (role==='viewer' && peerReady) performanceWindow.frame(metadata, now);
    frameCallback = video.requestVideoFrameCallback(sample);
  };
  frameCallback = video.requestVideoFrameCallback(sample);
}
async function probeRoute() {
  if ($('probe-route').disabled) return;
  if (!pc || latestSample?.path?.network!=='tailscale' || !latestSample.path.peerAddress) throw new Error('Для проверки запустите трансляцию с маршрутом Tailscale. Выбранный поток пока не подтверждает адрес Tailscale.');
  if (!api.probeTailscale) throw new Error('Проверка пути доступна в обновлённом настольном клиенте.');
  const current = pc, ip = latestSample.path.peerAddress;
  $('probe-route').disabled = true; $('route-result').textContent = 'Проверяем путь Tailscale и несколько сетевых пингов…';
  try {
    const result = await api.probeTailscale(ip);
    if (pc!==current || latestSample?.path?.peerAddress!==ip) { $('route-result').textContent='За время проверки маршрут изменился. Повторите проверку для нового потока.'; return; }
    routeProbe = { ...result, at:result.at || new Date().toISOString() }; routeProbeTarget = ip;
    $('route-result').textContent = `${result.reason}${result.region ? ` Регион DERP: ${result.region}.` : ''}${result.ping?.count ? ` RTT Tailscale: медиана ${result.ping.medianMs} мс, p95 ${result.ping.p95Ms} мс.` : ''}`;
    $('performance-advice').textContent = TandemPerformance.advice(performanceContext()).join('\n\n');
  } finally { $('probe-route').disabled = false; }
}
function startStats() {
  clearInterval(statsTimer); lastStats = null;
  statsTimer = setInterval(run(async () => {
    if (!pc || statsBusy) return;
    statsBusy = true;
    const current = pc, currentRole = role;
    try {
      dataSend({ type: 'ping', time: performance.now() });
      const reports = await current.getStats();
      if (pc !== current || role !== currentRole) return;
      const measured = TandemAdaptive.measure(reports, role, lastStats);
      if (!measured) return;
      lastStats = measured.snapshot;
      const value = measured.sample, now = performance.now();
      latestSample = value;
      if (routeProbeTarget && routeProbeTarget !== value.path.peerAddress) routeProbe = routeProbeTarget = null;
      performanceWindow.observe(value, role, now - hostTelemetryAt < 3500 ? hostTelemetry : null, now);
      metric('rtt', value.rttMs === null ? lastRtt : Math.round(value.rttMs));
      metric('fps', value.fps === null ? null : Math.round(value.fps));
      metric('bitrate', value.actualMbps === null ? null : value.actualMbps.toFixed(1));
      metric('loss', value.lossPct === null ? null : value.lossPct.toFixed(1));
      const actual = `${value.width || '—'} × ${value.height || '—'} · ${value.fps === null ? '—' : Math.round(value.fps)} FPS`;
      $('stream-mode').textContent = `${actual} · ${value.codec || '—'}`;
      const processing = value.processingMs === null ? '' : ` · ${role === 'sender' ? 'кодирование' : 'декодирование'} ${value.processingMs.toFixed(1)} мс`;
      const jitter = value.jitterMs === null ? '' : ` · буфер ${value.jitterMs.toFixed(1)} мс`;
      if (role === 'sender' && adaptive && !qualityBusy && now >= adaptiveRetryAt) {
        const change = adaptive.update(value, now - receiverStatsAt < 3500 ? receiverStats : null, now);
        if (change) {
          try {
            if (await applyRuntime(change.profile) && pc === current && role === currentRole) {
              adaptive.commit(change); logEvent('quality', { reason: change.reason, resolution: change.profile.resolution, fps: change.profile.fps, bitrate: change.profile.bitrate, codec: change.profile.codec }); qualityChanges.push({ ...change, at: Math.round(now) }); qualityChanges = qualityChanges.slice(-20);
            }
          } catch (error) { adaptiveRetryAt = now + 15000; adaptive.reason = 'Режим не поддержан захватом; сохраняем предыдущий профиль'; logEvent('warning', { reason: TandemLog.error(error), action: 'Автоподбор сохранил предыдущий режим' }); }
        }
        if (pc !== current || role !== currentRole) return;
        if (remoteCodecs && !codecProbeAttempted) await automaticCodec();
      }
      if (pc !== current || role !== currentRole) return;
      const target = runtimeProfile || settings;
      const telemetry = { codec: value.codec || '—', implementation: value.implementation || 'не сообщён', hardware: value.hardware, limitation: value.limitation, targetMbps: target.bitrate, ceilingMbps: settings.bitrate, actualMbps: Number((value.actualMbps || 0).toFixed(1)), fps: Math.round(value.fps || 0), resolution: `${value.width}x${value.height}`, processing, processingMs: value.processingMs, route: value.route, epoch: qualityEpoch, adaptive: Boolean(adaptive), autoReason: adaptive?.reason || 'Ручной профиль', profile: target };
      if (now - metricLogAt >= 10000) { metricLogAt = now; logEvent('metrics', { role: role === 'sender' ? 'Передача' : 'Просмотр', route: value.route, codec: value.codec, resolution: `${value.width}x${value.height}`, fps: Math.round(value.fps || 0), bitrate: Number((value.actualMbps || 0).toFixed(1)), rtt: value.rttMs, encode: role === 'sender' ? value.processingMs : hostTelemetry?.processingMs, decode: role === 'viewer' ? value.processingMs : receiverStats?.decodeMs, buffer: value.jitterMs, qp: value.qp, loss: value.lossPct }); }
      diagnostics = { role, rttMs: value.rttMs, local: value, host: role === 'sender' ? telemetry : hostTelemetry, autoChanges: qualityChanges, receiverFeedbackAgeMs: receiverStats ? Math.round(now - receiverStatsAt) : null, gpu: env.gpu || {}, mouseLocked: Boolean(document.pointerLockElement) };
      if (role === 'sender') {
        dataSend({ type: 'host-telemetry', data: telemetry });
        const visible = await api.cursorState?.(); if (typeof visible === 'boolean' && pc === current) dataSend({ type: 'cursor-state', visible });
      } else if (value.valid && hostTelemetry?.epoch) dataSend({ type: 'receiver-stats', epoch: hostTelemetry.epoch, data: value });
      const host = role === 'sender' ? telemetry : hostTelemetry;
      $('encoder-status').textContent = host ? `Хост: ${host.resolution} · ${host.fps} FPS · ${host.codec}\nКодировщик: ${host.implementation} · аппаратный: ${host.hardware === true ? 'да' : host.hardware === false ? 'нет / не подтверждён' : 'браузер не сообщил'}\nБитрейт: ${host.actualMbps} Мбит/с, текущий лимит ${host.targetMbps}, максимум ${host.ceilingMbps}. ${host.processing || ''}` : 'Ожидаем диагностику хоста…';
      $('auto-status').textContent = host ? `${host.adaptive ? 'АВТО' : 'ВРУЧНУЮ'} · ${host.profile.resolution} · ${host.profile.fps} FPS · до ${host.targetMbps} Мбит/с. ${host.autoReason}` : 'Автоподбор начнётся после подключения';
      $('performance-advice').textContent = TandemPerformance.advice(performanceContext()).join('\n\n');
      $('metrics-detail').textContent = `${actual} · ${value.codec || '—'} · ${value.route}${processing}${jitter}. RTT — сеть туда и обратно; полная задержка управления здесь не измеряется.`;
    } finally { statsBusy = false; }
  }), 1000);
}
function inputEvent(event) { dataSend({ type: 'input', event }); }
function releaseKeys() { player?.release(); }
function motionEvent(value) {
  if (value.kind === 'relative' && pendingPointer?.kind === 'relative') { pendingPointer.dx += value.dx; pendingPointer.dy += value.dy; }
  else pendingPointer = value;
  const flush = () => { motionTimer = null; if (pendingPointer && controlling) { dataSend({ type: 'pointer', event: pendingPointer }, pointer); lastMotion = performance.now(); } pendingPointer = null; };
  if (!motionTimer) { const remaining = 4 - (performance.now() - lastMotion); if (remaining <= 0) flush(); else motionTimer = setTimeout(flush, remaining); }
}
document.querySelectorAll('[data-view]').forEach(button => button.onclick = () => view(button.dataset.view));
$('source-summary').onclick = () => view('settings');
$('save-settings').onclick = run(saveSettings);
$('create').onclick = run(createNetwork); $('join').onclick = run(joinNetwork); $('leave').onclick = run(() => endSession());
$('copy').onclick = run(copyInvitation);
$('auth-form').onsubmit = event => { event.preventDefault(); run(submitAuth)(false); };
$('auth-register').onclick = run(() => submitAuth(true)); $('auth-cancel').onclick = () => cancelAuth();
$('auth-dialog').addEventListener('cancel', event => { event.preventDefault(); cancelAuth(); });
$('source-cancel').onclick = cancelSource; $('source-dialog').addEventListener('cancel', event => { event.preventDefault(); cancelSource(); });
$('confirm-no').onclick = () => finishConfirmation(false); $('confirm-yes').onclick = () => finishConfirmation(true);
$('confirm-dialog').addEventListener('cancel', event => { event.preventDefault(); finishConfirmation(false); });
$('request-control').onclick = run(async () => {
  if (controlling) await revokeControl(); else { dataSend({ type: 'control-request' }); toast('Запрос управления отправлен.'); }
});
$('revoke-control').onclick = run(() => revokeControl());
$('share-screen').onclick = run(async () => {
  if (pendingStream) return;
  pendingStream = await chooseCapture(); dataSend({ type: 'swap-request' }); toast('Запрос на смену ролей отправлен.');
});
$('mouse-lock').onclick = run(() => player.lock());
$('fullscreen').onclick = run(() => player.fullscreen());
$('sound').onclick = () => { $('video').muted = !$('video').muted; $('sound').textContent = $('video').muted ? 'Звук: выкл.' : 'Звук: вкл.'; };
$('invite-input').addEventListener('input', () => { updateJoinLabel(); foundFriend = null; pendingLookup = null; $('connect-friend').hidden = $('add-friend').hidden = true; $('friend-result').textContent = ''; });
$('connect-friend').onclick = run(async () => {
  if (!foundFriend?.friend) throw new Error('Сначала добавьте пользователя в друзья.');
  await watchFriend(foundFriend.id);
});
$('add-friend').onclick = run(() => { if (foundFriend) { send({ type: 'friend-request', id: foundFriend.id }); $('add-friend').hidden = true; toast('Заявка отправлена. Друг может принять её в разделе «Друзья».'); } });
$('open-friends').onclick = () => view('friends');
$('find-account').onclick = run(async () => { const id = $('friend-id').value.trim(); view('session'); $('invite-input').value = id; await searchFriend(id); });
$('refresh-friends').onclick = run(async () => { await ensureAuth(settings.server); send({ type: 'contacts-sync' }); });
$('probe-route').onclick = run(probeRoute);
$('copy-performance').onclick = run(async () => { await api.copy(TandemPerformance.report(performanceContext())); toast('Текстовый отчёт скопирован.'); });
$('save-performance').onclick = run(async () => { if (api.savePerformanceReport) { const filename = await api.savePerformanceReport(TandemPerformance.report(performanceContext())); toast('Отчёт сохранён: ' + filename); } });
$('open-log').onclick = run(() => api.openLog?.());
$('test-turn').onclick = run(testTurn);
$('open-data-directory').onclick = run(() => api.openDataDirectory?.());
$('account-login').onclick = run(async () => {
  if (roomReady) return;
  await commitSettings(); await ensureAuth(settings.server);
});
$('copy-own-id').onclick = run(async () => { if (account) { await api.copy(account.id); toast('Ваш ID скопирован.'); } });
$('copy-account-invite').onclick = run(copyInvitation);
$('account-logout').onclick = run(async () => { clearTimeout(reconnectTimer); connectionGoal = null; if (serverIdentity) await api.clearSession?.(serverIdentity); localStorage.removeItem('tandem-last-network'); contacts = { friends: [], incoming: [], outgoing: [] }; contactsOwner = null; if (ws?.readyState === WebSocket.OPEN) send({ type: 'logout' }); await endSession(undefined, { disconnect: true }); });
$('direct-copy').onclick = run(async () => { await api.copy($('direct-output').value); toast('Скопировано. Длинное приглашение удобнее отправить файлом.'); });
$('direct-save').onclick = run(() => api.savePacket($('direct-output').value));
$('direct-apply').onclick = run(() => importDirect($('direct-response').value.trim()));
let responseFile = false;
$('import-packet').onclick = () => { responseFile = false; $('packet-file').click(); };
$('direct-open-response').onclick = () => { responseFile = true; $('packet-file').click(); };
$('packet-file').onchange = run(async () => { const file = $('packet-file').files[0]; if (!file) return; if (file.size > 262144) throw new Error('Слишком большой файл приглашения.'); const text = (await file.text()).trim(); parseDirectPacket(text); if (responseFile) $('direct-response').value = text; else { $('invite-input').value = text; } $('packet-file').value = ''; logEvent('action', { action: 'Файл приглашения или ответа открыт', kind: responseFile ? 'Ответ' : 'Приглашение' }); updateJoinLabel(); });
$('copy-diagnostics').onclick = run(async () => { await api.copy(JSON.stringify(diagnostics, null, 2)); toast('Диагностика скопирована.'); });
for (const button of document.querySelectorAll('[data-preset]')) button.onclick = () => {
  const presets = { hd: ['1280x720', 120, 20, 'H264'], clear: ['1920x1080', 60, 45, 'H264'], fast: ['1920x1080', 120, 65, 'H264'], av1: ['1920x1080', 120, 45, 'AV1'] };
  const values = presets[button.dataset.preset]; ['resolution', 'fps', 'bitrate', 'codec'].forEach((id, i) => { $(id).value = values[i]; });
  $('settings-result').textContent = 'Профиль выбран. Нажмите «Сохранить настройки», чтобы применить.';
};
player = TandemPlayer.create({ state: () => ({ controlling, mode: settings?.mouseMode || 'game', hideCursor: settings?.hideCursor !== false }), input: inputEvent, motion: motionEvent, error: reportError, nativeExit: () => api.exitFullscreen?.() });
window.addEventListener('beforeunload', () => { if (frameCallback !== null) $('video').cancelVideoFrameCallback?.(frameCallback); releaseKeys(); stopStream(stream); stopStream(pendingStream); });
document.addEventListener('click', event => {
  const button = event.target.closest?.('button, summary');
  if (button) logEvent('action', { action: button.classList.contains('source-choice') ? 'Выбор монитора' : button.textContent.trim().replace(/\s+/g, ' ').slice(0, 100) });
});
window.addEventListener('error', event => logEvent('crash', { reason: TandemLog.error(event.error), code: event.error?.name || 'RendererError' }));
window.addEventListener('unhandledrejection', event => logEvent('crash', { reason: TandemLog.error(event.reason), code: event.reason?.name || 'PromiseRejected' }));
run(async () => {
  env = api ? await api.environment() : { defaultServer: 'ws://127.0.0.1:8787', platform: 'browser' };
  let saved = await api?.loadSettings?.();
  if (!saved) { try { saved = JSON.parse(localStorage.getItem('tandem-settings-v1') || '{}'); } catch { saved = {}; } }
  const remembered = await api?.lastSession?.();
  settings = { ...defaults, ...saved, server: env.defaultServer, embedded: false };
  try { Object.assign(settings, TandemQuality.profile(settings)); } catch { Object.assign(settings, TandemQuality.profile(defaults)); }
  showSettings(); refreshAccount();
  $('log-path').textContent = env.logPath || (env.logError ? 'Не удалось открыть журнал. Код: ' + env.logError : 'Журнал настольного клиента: logs/tandem.log');
  monitorFrames();
  logEvent('action', { action: 'Интерфейс готов', version: env.version });
  $('data-directory').textContent = env.dataDirectory || 'Локальная папка данных настольного клиента';
  if (env.lastAccount && api?.loadContacts) { contactsOwner = `${env.lastAccount.network}:${env.lastAccount.id}`; contacts = await api.loadContacts(env.lastAccount.network, env.lastAccount.id); renderContacts(); }
  if (!api) { status('Откройте настольный клиент для подключения'); return; }
  $('platform-label').textContent = env.platform === 'win32' ? 'Windows · клиент готов' : 'Предпросмотр · ввод только Windows';
  api.onRevoke(() => run(async () => { await revokeControl(); toast('Управление отозвано владельцем.'); })());
  api.onError(message => { logEvent('error', { reason: TandemLog.error(message) }); toast(TandemLog.error(message), true); }); api.onExitFullscreen?.(() => run(() => player.exitFullscreen())());
  const network = remembered ? (remembered.server === settings.server ? remembered.network : null) : localStorage.getItem('tandem-last-network');
  if (network && await api.loadSession?.(network)) {
    try { await connect(settings.server, network); await tryResume(); } catch (error) { toast('Автовход: ' + error.message); }
  }

})();
