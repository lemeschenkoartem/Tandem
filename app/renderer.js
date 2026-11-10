'use strict';
const $ = id => document.getElementById(id);
const api = window.tandem;
let env, ws, account, owner = false, role = 'sender', peerName = '', pc, stream, pendingStream;
let reliable, pointer, controlling = false, remoteControl = false, invite = '', roomReady = false, peerReady = false;
let authResolve, authReject, sourceResolve, sourceReject, confirmResolve, authBusy = false;
let incomingIce = [], signalQueue = Promise.resolve(), statsTimer, heartbeatTimer, lastStats, disconnectTimer;
let settings, busy = false, toastTimer, pendingPointer, pointerFrame = 0, lastRtt;
let remoteMedia = new MediaStream();
let serverIdentity = null, foundFriend = null, pendingLookup = null, endingSession = null;
const { normalizeServer: validateServer, createInvitation, parseTarget } = globalThis.TandemNetwork;
const defaults = { resolution: '1920x1080', fps: 120, bitrate: 35, codec: 'H264', audio: true, embedded: true, ice: [{ urls: 'stun:stun.l.google.com:19302' }] };

function toast(message, persist = false) {
  $('toast').textContent = String(message).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
  $('toast').hidden = false; clearTimeout(toastTimer);
  if (!persist) toastTimer = setTimeout(() => { $('toast').hidden = true; }, 7000);
}
function run(fn) { return (...args) => Promise.resolve().then(() => fn(...args)).catch(error => toast(error.message)); }
function status(text, active = false) { $('status').textContent = text; $('status-dot').classList.toggle('live', active); }
function view(name) {
  document.querySelectorAll('.view').forEach(el => { el.hidden = el.id !== `view-${name}`; });
  document.querySelectorAll('[data-view]').forEach(el => el.classList.toggle('active', el.dataset.view === name));
}
function refreshProfile() {
  const names = { '1920x1080': '1080p', '2560x1440': '1440p', '3840x2160': '4K' };
  $('profile-title').textContent = `${names[settings.resolution]} / ${settings.fps} FPS`;
}
function readSettings() {
  const ice = JSON.parse($('ice').value);
  if (!Array.isArray(ice) || ice.length > 8 || ice.some(s => !s || typeof s !== 'object' || !(typeof s.urls === 'string' || Array.isArray(s.urls)))) throw new Error('ICE-серверы: ожидается массив объектов с полем urls.');
  const bitrate = Number($('bitrate').value), fps = Number($('fps').value), resolution = $('resolution').value;
  if (!Number.isFinite(bitrate) || bitrate < 5 || bitrate > 250) throw new Error('Битрейт: от 5 до 250 Мбит/с.');
  if (![60, 90, 120, 144, 165, 240].includes(fps) || !['1920x1080', '2560x1440', '3840x2160'].includes(resolution)) throw new Error('Некорректный профиль.');
  return { resolution, fps, bitrate, codec: $('codec').value, audio: $('audio').checked, embedded: $('embedded').checked, server: validateServer($('server').value.trim()), ice };
}
function persistSettings() {
  const safe = { ...settings, ice: settings.ice.filter(s => !s.credential && !s.username) };
  localStorage.setItem('tandem-settings-v1', JSON.stringify(safe));
  refreshProfile(); refreshAccount();
}
function saveSettings() {
  const next = readSettings();
  if (roomReady && ws && next.server !== validateServer(ws.url)) throw new Error('Сначала завершите подключение, затем меняйте сервер сети.');
  settings = next; persistSettings();
  $('settings-result').textContent = 'Сохранено. Качество применится к следующей трансляции.';
}
function refreshAccount() {
  const connected = account && ws?.readyState === WebSocket.OPEN;
  $('account-label').textContent = connected ? `${account.name} · ${account.id}` : 'Вы не вошли';
  $('own-id').textContent = connected ? account.id : '—';
  $('account-login').hidden = Boolean(connected);
  for (const id of ['copy-own-id', 'copy-account-invite', 'account-logout']) $(id).hidden = !connected;
  const endpoint = connected ? validateServer(ws.url) : settings?.server || '';
  $('connection-server').textContent = `${connected ? 'Выполнен вход' : 'Выбран сервер'}: ${endpoint}`;
  $('own-id-hint').textContent = connected ? `${account.name} · ${endpoint} · сеть ${serverIdentity?.slice(0, 8) || '—'}. Этот ID действует в этой сети.` : 'Аккаунты и ID хранятся на сервере сети. Вставьте приглашение друга, чтобы выбрать тот же сервер.';
}
function idleStatus() { status(account ? `Вы вошли · ID ${account.id}` : 'Готов к подключению', Boolean(account)); }
async function copyInvitation() {
  if (!account || !serverIdentity || ws?.readyState !== WebSocket.OPEN) throw new Error('Сначала войдите в аккаунт на сервере вашей сети.');
  const invitation = createInvitation({ server: validateServer(ws.url), id: account.id, network: serverIdentity });
  await api.copy(invitation);
  toast('Приглашение скопировано. Друг вставляет его целиком в поле «ID или приглашение».');
}
function showSettings() {
  for (const id of ['resolution', 'fps', 'bitrate', 'codec', 'server']) $(id).value = settings[id];
  $('audio').checked = settings.audio; $('embedded').checked = settings.embedded; $('ice').value = JSON.stringify(settings.ice, null, 2); refreshProfile();
}
function send(message) { if (ws?.readyState !== WebSocket.OPEN) throw new Error('Нет соединения с сервером.'); ws.send(JSON.stringify(message)); }
function dataSend(message, channel = reliable) {
  if (channel?.readyState === 'open' && channel.bufferedAmount < 65536) channel.send(JSON.stringify(message));
}
function confirmation(title, description, accept = 'Разрешить') {
  if (confirmResolve) return Promise.resolve(false);
  $('confirm-title').textContent = title; $('confirm-description').textContent = description; $('confirm-yes').textContent = accept;
  $('confirm-dialog').showModal(); return new Promise(resolve => { confirmResolve = resolve; });
}
function finishConfirmation(value) { $('confirm-dialog').close(); const resolve = confirmResolve; confirmResolve = null; resolve?.(value); }
function cancelSource() { $('source-dialog').close(); sourceReject?.(new Error('Выбор экрана отменён.')); sourceReject = sourceResolve = null; }
async function chooseCapture() {
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
  const [width, height] = settings.resolution.split('x').map(Number);
  const options = { video: { width: { ideal: width, max: width }, height: { ideal: height, max: height }, frameRate: { ideal: settings.fps, max: settings.fps } }, audio: settings.audio };
  let captured;
  try { captured = await navigator.mediaDevices.getDisplayMedia(options); }
  catch (error) {
    if (!settings.audio) throw error;
    captured = await navigator.mediaDevices.getDisplayMedia({ ...options, audio: false });
    toast('Звук недоступен: начата трансляция без звука.');
  }
  const track = captured.getVideoTracks()[0]; track.contentHint = 'motion';
  try { await track.applyConstraints(options.video); } catch { toast('Захват использует ближайший доступный режим. Проверьте фактические параметры.'); }
  track.onended = () => { if (stream === captured) run(endSession)('Трансляция экрана завершена.'); };
  if (settings.audio && !captured.getAudioTracks().length) toast('Источник не предоставил системный звук.');
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
  const connected = peerReady && pc?.connectionState === 'connected';
  $('request-control').hidden = role !== 'viewer' || !connected;
  $('request-control').textContent = controlling ? 'Вернуть управление' : 'Запросить управление';
  $('revoke-control').hidden = role !== 'sender' || !remoteControl;
  $('share-screen').hidden = role !== 'viewer' || !connected;
  $('mouse-lock').hidden = !controlling;
  $('control-status').textContent = controlling ? 'Вы управляете компьютером друга' : remoteControl ? 'Друг управляет вашим компьютером' : 'Управление у владельца';
  $('stage').classList.toggle('control-active', controlling);
  $('stream-caption').textContent = controlling ? 'Кликните по видео для ввода. Esc — освободить мышь. Ctrl+Alt+F12 у владельца — отозвать доступ.' : 'Ctrl+Alt+F12 на компьютере владельца — вернуть управление';
}
async function revokeControl(notify = true) {
  remoteControl = controlling = false; clearInterval(heartbeatTimer);
  if (document.pointerLockElement) document.exitPointerLock();
  await api.revokeControl();
  if (notify) dataSend({ type: 'control-revoked' });
  updateControls();
}
function configureChannel(channel) {
  if (channel.label === 'pointer') pointer = channel;
  else if (channel.label === 'control') reliable = channel;
  else { channel.close(); return; }
  channel.onmessage = event => {
    if (typeof event.data === 'string' && event.data.length <= 8192) {
      let message; try { message = JSON.parse(event.data); } catch { return; }
      run(handleData)(message);
    }
  };
  channel.onclose = () => { run(revokeControl)(false); };
}
async function handleData(message) {
  if (!message || typeof message !== 'object') return;
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
    await revokeControl();
    for (const sender of pc.getSenders()) if (sender.track) await sender.replaceTrack(null);
    stopStream(stream); stream = null; role = 'viewer'; lastStats = null;
    $('video').srcObject = null; $('video').hidden = true; $('stage-idle').hidden = false; $('stage-message').textContent = 'Друг начинает трансляцию…';
    if (remoteMedia.getTracks().length) showVideo(remoteMedia, false);
    dataSend({ type: 'swap-accepted' }); updateControls();
  } else if (message.type === 'swap-accepted' && pendingStream) {
    await revokeControl(false); stream = pendingStream; pendingStream = null; role = 'sender'; lastStats = null;
    showVideo(stream, true); await makeOffer(); updateControls();
  } else if (message.type === 'swap-rejected') { stopStream(pendingStream); pendingStream = null; toast('Друг пока продолжает свою трансляцию.'); }
}
function makePeer() {
  pc = new RTCPeerConnection({ iceServers: settings.ice, bundlePolicy: 'max-bundle' });
  const current = pc;
  pc.onicecandidate = event => { if (event.candidate && pc === current) { try { send({ type: 'signal', data: { kind: 'ice', candidate: event.candidate.toJSON() } }); } catch {} } };
  pc.ondatachannel = event => configureChannel(event.channel);
  pc.ontrack = event => {
    if (!remoteMedia.getTracks().some(t => t.id === event.track.id)) remoteMedia.addTrack(event.track);
    if (role === 'viewer') {
      showVideo(remoteMedia, false);
      if ('playoutDelayHint' in event.receiver && event.track.kind === 'video') event.receiver.playoutDelayHint = 0;
      if ('jitterBufferTarget' in event.receiver && event.track.kind === 'video') event.receiver.jitterBufferTarget = 0;
      $('stage-message').textContent = '';
    }
  };
  pc.onconnectionstatechange = () => {
    if (pc !== current) return;
    clearTimeout(disconnectTimer);
    if (pc.connectionState === 'connected') { status('Вы в одной сети', true); startStats(); }
    else if (pc.connectionState === 'failed') { run(endSession)('Прямое соединение не удалось. Проверьте Tailscale или настройте TURN в разделе «Качество и сеть».'); }
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
  disconnectTimer = setTimeout(() => { if (pc === current && pc.connectionState !== 'connected') run(endSession)('Не удалось установить видеосоединение за 25 секунд. Проверьте сетевой путь и ICE-серверы.'); }, 25000);
  return pc;
}
async function attachTracks() {
  for (const track of stream.getTracks()) {
    let transceiver = pc.getTransceivers().find(t => t.receiver.track.kind === track.kind && !t.stopped);
    if (transceiver) { await transceiver.sender.replaceTrack(track); transceiver.direction = 'sendrecv'; transceiver.sender.setStreams(stream); }
    else { const sender = pc.addTrack(track, stream); transceiver = pc.getTransceivers().find(t => t.sender === sender); }
    if (track.kind === 'video') {
      const caps = RTCRtpSender.getCapabilities('video');
      if (settings.codec !== 'auto' && caps && transceiver.setCodecPreferences) {
        const preferred = caps.codecs.filter(c => c.mimeType.toLowerCase() === `video/${settings.codec.toLowerCase()}`);
        if (preferred.length) transceiver.setCodecPreferences([...preferred, ...caps.codecs.filter(c => !preferred.includes(c))]);
        else toast(`Кодек ${settings.codec} недоступен. WebRTC выберет другой.`);
      }
    }
  }
}
async function configureSenders() {
  for (const sender of pc.getSenders()) {
    if (sender.track?.kind !== 'video') continue;
    const params = sender.getParameters();
    if (!params.encodings?.length) continue;
    params.encodings[0].maxBitrate = settings.bitrate * 1000000; params.encodings[0].maxFramerate = settings.fps;
    params.degradationPreference = 'maintain-resolution';
    await sender.setParameters(params);
  }
}
async function makeOffer() {
  if (!pc) makePeer();
  await attachTracks();
  await pc.setLocalDescription(await pc.createOffer()); await configureSenders();
  send({ type: 'signal', data: { kind: 'offer', sdp: pc.localDescription.sdp } });
}
async function handleSignal(data) {
  if (!peerReady) return;
  if (!pc) makePeer();
  if (data.kind === 'ice') {
    if (pc.remoteDescription) await pc.addIceCandidate(data.candidate); else incomingIce.push(data.candidate);
    return;
  }
  if (!['offer', 'answer'].includes(data.kind) || typeof data.sdp !== 'string') return;
  await pc.setRemoteDescription({ type: data.kind, sdp: data.sdp });
  for (const candidate of incomingIce.splice(0)) await pc.addIceCandidate(candidate);
  if (data.kind === 'offer') {
    await pc.setLocalDescription(await pc.createAnswer());
    send({ type: 'signal', data: { kind: 'answer', sdp: pc.localDescription.sdp } });
  }
}
async function connect(url, expectedNetwork) {
  url = validateServer(url);
  if (ws?.readyState === WebSocket.OPEN && validateServer(ws.url) === url && serverIdentity) {
    if (expectedNetwork && serverIdentity !== expectedNetwork) throw new Error('По этому адресу находится другая база аккаунтов. Проверьте VPN-адрес друга и попросите новое приглашение.');
    return;
  }
  if (account && ws?.readyState === WebSocket.OPEN && validateServer(ws.url) !== url) {
    const accepted = await confirmation('Перейти в другую сеть?', `Текущий аккаунт находится на ${validateServer(ws.url)}. Вы выбрали ${url}. В другой сети отдельные аккаунты и ID: потребуется войти или зарегистрироваться там.`, 'Перейти');
    if (!accepted) throw new Error('Смена сети отменена. Вы остались в текущем аккаунте.');
  }
  if (roomReady) throw new Error('Сначала завершите текущее подключение.');
  if (ws) await endSession(undefined, { disconnect: true });
  account = null; serverIdentity = null; refreshAccount();
  const socket = new WebSocket(url); ws = socket;
  await new Promise((resolve, reject) => {
    let ready = false;
    const fail = error => {
      clearTimeout(timer); socket.onclose = null;
      if (ws === socket) { ws = null; account = null; serverIdentity = null; refreshAccount(); idleStatus(); }
      socket.close(); reject(error);
    };
    const timer = setTimeout(() => fail(new Error('Сервер не отвечает или работает старая версия. Обновите Tandem на обоих ПК; проверьте VPN-адрес и TCP 8787.')), 10000);
    socket.onerror = () => { if (!ready) fail(new Error('Не удалось подключиться к серверу. Проверьте VPN-адрес владельца и брандмауэр.')); else socket.close(); };
    socket.onmessage = event => {
      if (ws !== socket) return;
      let msg; try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.type === 'hello') {
        if (msg.protocol !== 2 || !/^[a-f0-9]{32}$/.test(msg.network)) { fail(new Error('Обновите Tandem на компьютере владельца сети до версии 0.1.1.')); return; }
        if (expectedNetwork && msg.network !== expectedNetwork) { fail(new Error('Приглашение относится к другой базе аккаунтов. Проверьте VPN-адрес друга и получите новое приглашение.')); return; }
        serverIdentity = msg.network; ready = true; clearTimeout(timer); refreshAccount(); resolve(); return;
      }
      if (!ready) return;
      if (msg.type === 'signal') signalQueue = signalQueue.then(() => handleSignal(msg.data)).catch(error => run(endSession)(`Ошибка видеосоединения: ${error.message}`));
      else run(handleServer)(msg);
    };
    socket.onclose = () => {
      clearTimeout(timer); if (ws !== socket) return;
      ws = null; account = null; serverIdentity = null; refreshAccount();
      reject(new Error('Соединение с сервером закрыто.'));
      if (authReject) cancelAuth('Сервер отключился.');
      if (roomReady || stream || busy) run(endSession)('Сервер отключился. Проверьте VPN и запущен ли Tandem у владельца сети.', { notifyServer: false });
      else { idleStatus(); toast('Соединение с сервером закрыто.'); }
    };
  });
}
async function ensureAuth(url, expectedNetwork) {
  await connect(url, expectedNetwork);
  if (account) return;
  $('auth-server').textContent = `Сервер: ${url} · сеть ${serverIdentity.slice(0, 8)}`;
  $('auth-result').textContent = 'У каждого сервера свои аккаунты и ID. Если вы регистрировались на другом ПК-сервере, здесь нужно создать аккаунт. Для одного сервера повторный вход при поиске не нужен.';
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
  if (msg.type === 'error') {
    if ($('auth-dialog').open) { $('auth-result').textContent = msg.message; setAuthBusy(false); }
    else {
      busy = false; buttonsBusy(false);
      if (msg.code === 'AUTH_REQUIRED') { account = null; refreshAccount(); }
      if (msg.request === 'find' || msg.request === 'join-id') {
        foundFriend = null; pendingLookup = null; $('connect-friend').hidden = true;
        $('friend-result').textContent = `${msg.message} Сервер: ${ws ? validateServer(ws.url) : settings.server}`;
        idleStatus();
      } else if (msg.request === 'create') await endSession();
      toast(msg.message);
    }
  } else if (msg.type === 'authenticated') {
    account = msg.account; serverIdentity = msg.network; setAuthBusy(false); refreshAccount(); idleStatus();
    $('login-password').value = ''; $('auth-dialog').close(); authResolve?.(); authReject = authResolve = null;
  } else if (msg.type === 'found') {
    busy = false; buttonsBusy(false);
    if (msg.account.id !== pendingLookup) return;
    foundFriend = { id: msg.account.id, server: validateServer(ws.url) }; idleStatus();
    $('friend-result').textContent = `${msg.account.name} · ${msg.account.id} · ${!msg.online ? 'Не принимает подключения' : msg.busy ? 'Сейчас занят' : 'В сети и готов подключиться'}`;
    $('connect-friend').hidden = !msg.online || msg.busy;
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
  } else if (msg.type === 'request-cancelled') { finishConfirmation(false); toast('Друг отменил запрос.'); }
  else if (msg.type === 'peer-joined' || msg.type === 'joined') {
    peerReady = true; peerName = msg.name; roomReady = true; activeUI(); status('Устанавливаем прямое соединение…');
    $('peer-label').textContent = `В сети · ${peerName}`;
    if (owner) await makeOffer(); else makePeer();
  } else if (msg.type === 'peer-left' || msg.type === 'ended') await endSession('Друг отключился.');
  else if (msg.type === 'rejected') await endSession('Владелец отклонил подключение.');
}
function activeUI() {
  $('connection-idle').hidden = true; $('connection-active').hidden = false; $('invitation-box').hidden = !owner;
  $('network-title').textContent = owner ? 'Ваша закрытая сеть' : 'Сеть друга'; updateControls();
}
function buttonsBusy(value) { $('create').disabled = $('join').disabled = value; }
async function createNetwork() {
  if (!api) throw new Error('Откройте настольное приложение Tandem.');
  if (busy || roomReady) return;
  busy = true; buttonsBusy(true); owner = true; role = 'sender';
  try {
    saveSettings();
    if (settings.embedded) await api.startRelay(settings.server);
    await ensureAuth(settings.server); stream = await chooseCapture(); showVideo(stream, true);
    send({ type: 'create' });
  } catch (error) { await endSession(); throw error; }
}
async function joinNetwork() {
  if (!api) throw new Error('Откройте настольное приложение Tandem.');
  if (busy || roomReady) return;
  const target = parseTarget($('invite-input').value);
  busy = true; buttonsBusy(true); foundFriend = null; $('connect-friend').hidden = true;
  try {
    const next = readSettings();
    const server = target.server || next.server;
    await connect(server, target.network);
    settings = { ...next, server, embedded: target.server ? false : next.embedded }; showSettings(); persistSettings();
    await ensureAuth(server, target.network);
    owner = false; role = 'viewer'; $('invite-input').value = target.id; pendingLookup = target.id;
    send({ type: 'find', id: target.id });
  } catch (error) { busy = false; buttonsBusy(false); idleStatus(); throw error; }
}
function stopStream(value) { value?.getTracks().forEach(t => { t.onended = null; t.stop(); }); }
function endSession(message, options = {}) {
  if (endingSession) return endingSession;
  endingSession = resetSession(message, options).finally(() => { endingSession = null; });
  return endingSession;
}
async function resetSession(message, { disconnect = false, notifyServer = true } = {}) {
  roomReady = peerReady = false; busy = false; controlling = remoteControl = false;
  clearInterval(statsTimer); clearInterval(heartbeatTimer); clearTimeout(disconnectTimer);
  if (pointerFrame) cancelAnimationFrame(pointerFrame); pointerFrame = 0; pendingPointer = null;
  if (confirmResolve) finishConfirmation(false);
  if (sourceReject) cancelSource();
  await revokeControl(false); await api?.endSession();
  const current = pc; pc = null; if (current) { current.onconnectionstatechange = null; current.close(); }
  reliable = pointer = null; incomingIce = []; lastStats = lastRtt = null; remoteMedia = new MediaStream();
  stopStream(stream); stopStream(pendingStream); stream = pendingStream = null;
  if (ws?.readyState === WebSocket.OPEN && notifyServer) ws.send(JSON.stringify({ type: 'leave' }));
  if (disconnect && ws) { const socket = ws; ws = null; socket.onclose = null; socket.close(); account = null; serverIdentity = null; }
  refreshAccount();
  $('video').srcObject = null; $('video').hidden = true; $('stage-idle').hidden = false; $('stream-overlay').hidden = true;
  $('sound').hidden = $('mouse-lock').hidden = true; $('connection-idle').hidden = false; $('connection-active').hidden = true;
  $('stage-message').textContent = 'Создайте сеть, чтобы начать трансляцию'; $('peer-label').textContent = 'Ожидаем друга';
  $('invite-output').value = ''; invite = ''; foundFriend = null; pendingLookup = null; $('friend-result').textContent = ''; $('connect-friend').hidden = true; buttonsBusy(false); idleStatus();
  for (const id of ['rtt', 'fps', 'bitrate', 'loss']) $(`stat-${id}`).firstChild.textContent = '—';
  $('metrics-detail').textContent = 'Показатели появятся после подключения. RTT — время туда и обратно, не полная задержка управления.';
  if (message) toast(message, true);
}
function metric(id, value) { $(`stat-${id}`).firstChild.textContent = value == null ? '—' : String(value); }
function startStats() {
  clearInterval(statsTimer); lastStats = null;
  statsTimer = setInterval(run(async () => {
    if (!pc) return;
    dataSend({ type: 'ping', time: performance.now() });
    const reports = await pc.getStats();
    let video, pair, local, remote;
    reports.forEach(r => {
      if (r.type === (role === 'sender' ? 'outbound-rtp' : 'inbound-rtp') && r.kind === 'video' && !r.isRemote) video = r;
      if (r.type === 'transport' && r.selectedCandidatePairId) pair = reports.get(r.selectedCandidatePairId);
    });
    if (pair) { local = reports.get(pair.localCandidateId); remote = reports.get(pair.remoteCandidateId); }
    metric('rtt', pair?.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : lastRtt);
    if (!video) return;
    const bytes = role === 'sender' ? video.bytesSent : video.bytesReceived;
    const frames = role === 'sender' ? video.framesEncoded : video.framesDecoded;
    const now = video.timestamp, elapsed = lastStats ? (now - lastStats.time) / 1000 : 0;
    const fps = video.framesPerSecond ?? (elapsed > 0 ? (frames - lastStats.frames) / elapsed : null);
    metric('fps', fps == null ? null : Math.round(fps));
    metric('bitrate', elapsed > 0 ? Math.max(0, (bytes - lastStats.bytes) * 8 / elapsed / 1000000).toFixed(1) : null);
    let loss = null;
    if (role === 'viewer' && lastStats && elapsed > 0) {
      const lost = Math.max(0, (video.packetsLost || 0) - lastStats.lost), received = Math.max(0, (video.packetsReceived || 0) - lastStats.received);
      loss = lost + received > 0 ? (100 * lost / (lost + received)).toFixed(1) : '0.0';
    } else if (role === 'sender') {
      const feedback = video.remoteId && reports.get(video.remoteId);
      if (feedback?.fractionLost != null) loss = (100 * feedback.fractionLost).toFixed(1);
    }
    metric('loss', loss);
    const codec = reports.get(video.codecId)?.mimeType?.split('/')[1] || '—';
    const width = video.frameWidth || $('video').videoWidth, height = video.frameHeight || $('video').videoHeight;
    const actual = `${width || '—'} × ${height || '—'} · ${fps == null ? '—' : Math.round(fps)} FPS`;
    $('stream-mode').textContent = `${actual} · ${codec}`;
    let processing = '';
    if (lastStats && elapsed > 0 && frames > lastStats.frames) {
      const duration = role === 'sender' ? video.totalEncodeTime : video.totalDecodeTime;
      if (duration != null && lastStats.processing != null) processing = ` · ${role === 'sender' ? 'кодирование' : 'декодирование'} ${Math.max(0, 1000 * (duration - lastStats.processing) / (frames - lastStats.frames)).toFixed(1)} мс`;
    }
    let jitter = '';
    if (role === 'viewer' && lastStats && video.jitterBufferEmittedCount > lastStats.emitted)
      jitter = ` · буфер ${(1000 * (video.jitterBufferDelay - lastStats.jitter) / (video.jitterBufferEmittedCount - lastStats.emitted)).toFixed(1)} мс`;
    const route = pair ? ((local?.candidateType === 'relay' || remote?.candidateType === 'relay') ? 'TURN' : 'WebRTC без TURN') : 'маршрут определяется';
    const implementation = video.encoderImplementation || video.decoderImplementation;
    $('metrics-detail').textContent = `${actual} · ${codec} · ${route}${processing}${jitter}${implementation ? ` · ${implementation}` : ''}${video.qualityLimitationReason && video.qualityLimitationReason !== 'none' ? ` · ограничение: ${video.qualityLimitationReason}` : ''}. RTT — сеть туда и обратно.`;
    lastStats = { time: now, bytes, frames, lost: video.packetsLost || 0, received: video.packetsReceived || 0, processing: role === 'sender' ? video.totalEncodeTime : video.totalDecodeTime, jitter: video.jitterBufferDelay || 0, emitted: video.jitterBufferEmittedCount || 0 };
  }), 1000);
}
function videoPoint(event) {
  const rect = $('video').getBoundingClientRect(), v = $('video');
  const ratio = v.videoWidth && v.videoHeight ? v.videoWidth / v.videoHeight : 16 / 9;
  let width = rect.width, height = width / ratio;
  if (height > rect.height) { height = rect.height; width = height * ratio; }
  const x = (event.clientX - rect.left - (rect.width - width) / 2) / width;
  const y = (event.clientY - rect.top - (rect.height - height) / 2) / height;
  return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { kind: 'move', x, y } : null;
}
function inputEvent(event) { dataSend({ type: 'input', event }); }
function releaseKeys() { if (controlling) inputEvent({ kind: 'release' }); }
$('video').addEventListener('mousemove', event => {
  if (!controlling || document.activeElement !== $('stage')) return;
  const value = document.pointerLockElement ? { kind: 'relative', dx: event.movementX, dy: event.movementY } : videoPoint(event);
  if (!value) return;
  if (value.kind === 'relative' && pendingPointer?.kind === 'relative') { pendingPointer.dx += value.dx; pendingPointer.dy += value.dy; }
  else pendingPointer = value;
  if (!pointerFrame) pointerFrame = requestAnimationFrame(() => { pointerFrame = 0; if (pendingPointer && controlling) dataSend({ type: 'pointer', event: pendingPointer }, pointer); pendingPointer = null; });
});
$('video').addEventListener('mousedown', event => {
  $('stage').focus();
  if (!controlling || ![0, 1, 2].includes(event.button)) return;
  event.preventDefault();
  if (!document.pointerLockElement) { const point = videoPoint(event); if (!point) return; inputEvent(point); }
  inputEvent({ kind: 'button', button: event.button, down: true });
});
window.addEventListener('mouseup', event => { if (controlling && [0, 1, 2].includes(event.button)) inputEvent({ kind: 'button', button: event.button, down: false }); });
$('video').addEventListener('contextmenu', event => event.preventDefault());
$('video').addEventListener('wheel', event => { if (controlling && document.activeElement === $('stage')) { event.preventDefault(); inputEvent({ kind: 'wheel', delta: -Math.sign(event.deltaY) * 120 }); } }, { passive: false });
for (const type of ['keydown', 'keyup']) $('stage').addEventListener(type, event => {
  if (!controlling || (event.code === 'F12' && event.ctrlKey && event.altKey)) return;
  if (event.code === 'Escape' && document.pointerLockElement) { releaseKeys(); return; }
  event.preventDefault(); if (event.repeat) return;
  inputEvent({ kind: 'key', code: event.code, down: type === 'keydown' });
});
$('stage').addEventListener('blur', releaseKeys); window.addEventListener('blur', releaseKeys);
document.addEventListener('visibilitychange', () => { if (document.hidden) releaseKeys(); });
document.addEventListener('pointerlockchange', () => { if (!document.pointerLockElement) releaseKeys(); $('mouse-lock').textContent = document.pointerLockElement ? 'Мышь захвачена · Esc' : 'Захват мыши'; });
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
$('mouse-lock').onclick = run(async () => { if (controlling) await $('video').requestPointerLock({ unadjustedMovement: true }).catch(() => $('video').requestPointerLock()); });
$('fullscreen').onclick = run(async () => { if (document.fullscreenElement) await document.exitFullscreen(); else await $('stage').requestFullscreen(); });
$('sound').onclick = () => { $('video').muted = !$('video').muted; $('sound').textContent = $('video').muted ? 'Звук: выкл.' : 'Звук: вкл.'; };
$('invite-input').addEventListener('input', () => { foundFriend = null; pendingLookup = null; $('connect-friend').hidden = true; $('friend-result').textContent = ''; });
$('connect-friend').onclick = run(async () => {
  if (!foundFriend || !account || !ws || foundFriend.server !== validateServer(ws.url) || foundFriend.id !== $('invite-input').value.trim()) throw new Error('Сначала найдите друга на текущем сервере.');
  owner = false; role = 'viewer'; send({ type: 'join-id', id: foundFriend.id });
});
$('account-login').onclick = run(async () => {
  if (roomReady) return;
  saveSettings(); owner = settings.embedded;
  if (settings.embedded) await api.startRelay(settings.server);
  await ensureAuth(settings.server);
});
$('copy-own-id').onclick = run(async () => { if (account) { await api.copy(account.id); toast('Ваш ID скопирован.'); } });
$('copy-account-invite').onclick = run(copyInvitation);
$('account-logout').onclick = run(() => endSession(undefined, { disconnect: true }));
window.addEventListener('beforeunload', () => { releaseKeys(); stopStream(stream); stopStream(pendingStream); });
run(async () => {
  env = api ? await api.environment() : { defaultServer: 'ws://127.0.0.1:8787', platform: 'browser' };
  let saved = {}; try { saved = JSON.parse(localStorage.getItem('tandem-settings-v1') || '{}'); } catch {}
  settings = { ...defaults, server: env.defaultServer, ...saved }; showSettings(); refreshAccount();
  if (!api) { status('Откройте настольный клиент для подключения'); return; }
  $('platform-label').textContent = env.platform === 'win32' ? 'Windows · клиент готов' : 'Предпросмотр · ввод только Windows';
  api.onRevoke(() => run(async () => { await revokeControl(); toast('Управление отозвано владельцем.'); })());
  api.onError(message => toast(message, true));

})();
