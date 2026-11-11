'use strict';
const { chromium } = require('playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createRelay } = require('../server/relay.cjs');
const { Logger } = require('../app/logger.cjs');
const { LocalStore } = require('../app/local-store.cjs');
const { validateInput } = require('../shared/input.cjs');
const root = path.join(__dirname, '..');
const inputs = [], errors = [], traces = [], pages = [], loggers = [];
let hostGranted = false, guestGranted = false;
const relay = createRelay({ port: 0, host: '127.0.0.1' });
const dataDirectory = fs.mkdtempSync('/tmp/tandem-browser-');
const staticServer = http.createServer((req, res) => {
  const file = { '/': 'index.html', '/renderer.js': 'renderer.js', '/network.js': 'network.js', '/logging.js': 'logging.js', '/quality.js': 'quality.js', '/adaptive.js': 'adaptive.js', '/performance.js': 'performance.js', '/player.js': 'player.js', '/styles.css': 'styles.css' }[req.url];
  if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  if (!file) { res.writeHead(404); res.end(); return; }
  res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
  res.end(fs.readFileSync(path.join(root, 'app', file)));
});
let browser;
async function setupContext(name, defaultServer) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const savedSessions = new Map(); let lastSaved = null; const local = new LocalStore(path.join(dataDirectory, name)); const logger = new Logger(path.join(dataDirectory, name, 'logs', 'tandem.log')); loggers.push(logger);
  await context.exposeBinding('nativeAction', async (_, action, value) => {
    if (action === 'log') { logger.record(value.event, value.data); return true; }
    if (action === 'open-log') { await logger.flush(); return fs.readFileSync(logger.filename, 'utf8'); }
    if (action === 'load-settings') { const saved = local.settings(); return saved ? { ...saved, ice: JSON.parse(process.env.TANDEM_TEST_ICE || '[]') } : null; }
    if (action === 'save-settings') return local.settings(value);
    if (action === 'load-contacts') return local.contacts(value.network, value.id);
    if (action === 'save-contacts') return local.contacts(value.network, value.id, value.contacts);
    if (action === 'save-account') return local.account(value.network, value.account);
    if (action === 'load-session') return savedSessions.get(value) || null;
    if (action === 'save-session') { savedSessions.set(value.network, value.token); lastSaved = { network: value.network, server: value.server }; return true; }
    if (action === 'clear-session') { savedSessions.delete(value); if (lastSaved?.network === value) lastSaved = null; return true; }
    if (action === 'last-session') return lastSaved;
    if (action === 'grant') { if (name === 'host') hostGranted = true; else guestGranted = true; return true; }
    if (action === 'revoke') { if (name === 'host') hostGranted = false; else guestGranted = false; return true; }
    if (action === 'input' && (name === 'host' ? hostGranted : guestGranted)) { const validated = validateInput(value); if (validated) inputs.push({ name, event: validated }); }
    return true;
  });
  await context.addInitScript(({ name, defaultServer, testIce }) => {
    if (!localStorage.getItem('tandem-settings-v1')) localStorage.setItem('tandem-settings-v1', JSON.stringify({ server: defaultServer, ice: testIce, audio: false, qualityMode: 'manual', codec: 'H264' }));
    const png = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#554477"/></svg>');
    window.tandem = {
      environment: async () => ({ platform: 'win32', version: 'test', addresses: ['127.0.0.1'], defaultServer, emergencyShortcutAvailable: true }),
      probeTailscale: async () => ({ available:true, path:'direct', reason:'Подтверждён прямой путь Tailscale в тесте IPC', ping:{count:5,medianMs:5,p95Ms:6} }),
      savePerformanceReport: async text => { window.savedPerformanceReport = text; return 'test-report.txt'; },
      logEvent: (event, data) => window.nativeAction('log', { event, data }),
      openLog: () => window.nativeAction('open-log'),
      loadSettings: () => window.nativeAction('load-settings'),
      saveSettings: value => window.nativeAction('save-settings', value),
      loadContacts: (network, id) => window.nativeAction('load-contacts', { network, id }),
      saveContacts: (network, id, contacts) => window.nativeAction('save-contacts', { network, id, contacts }),
      saveAccount: (network, account) => window.nativeAction('save-account', { network, account }),
      loadSession: network => window.nativeAction('load-session', network),
      saveSession: (network, token, server) => window.nativeAction('save-session', { network, token, server }),
      lastSession: () => window.nativeAction('last-session'),
      clearSession: network => window.nativeAction('clear-session', network),
      exitFullscreen: async () => true, cursorState: async () => false, savePacket: async () => true,
      onExitFullscreen: callback => { window.triggerFullscreenExit = callback; },
      sources: async () => [{ id: 'test-monitor', name: `Monitor ${name}`, thumbnail: png, width: 1920, height: 1080, fps: 120 }],
      selectSource: async () => true,
      grantControl: () => window.nativeAction('grant'), revokeControl: () => window.nativeAction('revoke'),
      endSession: () => window.nativeAction('revoke'), input: value => window.nativeAction('input', value),
      copy: async value => { window.copiedInvitation = value; },
      onRevoke: callback => { window.triggerNativeRevoke = callback; }, onError: () => {},
    };
    navigator.mediaDevices.getDisplayMedia = async () => {
      const canvas = document.createElement('canvas'); canvas.width = 1920; canvas.height = 1080;
      const ctx = canvas.getContext('2d'); let n = 0;
      const draw = () => {
        ctx.fillStyle = name === 'host' ? '#292036' : '#17332b'; ctx.fillRect(0, 0, 1920, 1080);
        ctx.fillStyle = '#c4b5ff'; ctx.font = '96px sans-serif'; ctx.fillText(`${name} frame ${n++}`, 130, 500);
      };
      draw(); const timer = setInterval(draw, 1000 / 60); const stream = canvas.captureStream(60);
      const track = stream.getVideoTracks()[0], originalApply = track.applyConstraints.bind(track);
      track.applyConstraints = async options => { if (options.width?.max) { canvas.width = Math.min(1920, options.width.max); canvas.height = Math.min(1080, options.height.max); draw(); } await originalApply(options); };
      stream.getVideoTracks()[0].addEventListener('ended', () => clearInterval(timer));
      return stream;
    };
  }, { name, defaultServer, testIce: JSON.parse(process.env.TANDEM_TEST_ICE || '[]') });
  const page = await context.newPage(); pages.push(page);
  page.on('pageerror', error => errors.push(`${name}: ${error.message}`));
  page.on('console', msg => { if (msg.type() === 'error') traces.push(`${name}: ${msg.text()}`); });
  return page;
}
async function register(page, name) {
  await page.locator('#auth-dialog').waitFor({ state: 'visible' });
  await page.fill('#login-name', name); await page.fill('#login-password', `${name}-password-123`);
  await page.click('#auth-register');
  await page.locator('#auth-dialog').waitFor({ state: 'hidden' });
}
async function waitVideo(page) {
  await page.waitForFunction(() => { const v = document.getElementById('video'); return !v.hidden && v.videoWidth >= 1920 && v.currentTime > 0; }, { timeout: 25000 });
}
async function saveProfile(page, { resolution = '1920x1080', fps = '120', bitrate = '60', mode = 'manual', codec = 'H264' } = {}) {
  await page.click('[data-view="settings"]'); await page.selectOption('#resolution', resolution); await page.selectOption('#fps', fps); await page.fill('#bitrate', bitrate); await page.selectOption('#quality-mode', mode); await page.selectOption('#codec', codec);
  await page.click('#save-settings'); await page.locator('#confirm-dialog').waitFor({ state: 'visible' }); await page.click('#confirm-yes');
}
async function connectFriend(guest, host, accept = true) {
  await guest.click('[data-view="friends"]');
  await guest.locator('#friends-list button', { hasText: 'Подключиться' }).click();
  await host.locator('#confirm-dialog').waitFor({ state: 'visible' }); await host.click(accept ? '#confirm-yes' : '#confirm-no');
  if (accept) { await host.locator('.source-choice').click(); await waitVideo(guest); }
  else await guest.locator('#connection-idle').waitFor({ state: 'visible' });
}
(async () => {
  const relayAddress = await relay.listen();
  await new Promise(resolve => staticServer.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  const url = `http://127.0.0.1:${staticServer.address().port}`, defaultServer = `ws://127.0.0.1:${relayAddress.port}`;
  const host = await setupContext('host', defaultServer), guest = await setupContext('guest', defaultServer);
  await Promise.all([host.goto(url), guest.goto(url)]);
  for (const [page, name] of [[host, 'owner'], [guest, 'friend']]) {
    await page.click('[data-view="accounts"]'); await page.click('#account-login'); await register(page, name);
    assert.equal(await page.locator('#server').count(), 0); assert.equal(await page.locator('#embedded').count(), 0);
  }
  const ownerId = await host.textContent('#own-id'), friendId = await guest.textContent('#own-id');
  await guest.click('[data-view="session"]');
  for (let i = 0; i < 2; i++) {
    await guest.fill('#invite-input', '00000000'); await guest.click('#join');
    await guest.waitForFunction(() => document.getElementById('friend-result').textContent.includes('не найден'));
    assert.equal(await guest.textContent('#own-id'), friendId); assert.equal(await guest.locator('#auth-dialog').isVisible(), false);
  }
  await guest.fill('#invite-input', ownerId); await guest.click('#join'); await guest.locator('#add-friend').click();
  await host.click('[data-view="friends"]'); await host.locator('#requests-list button', { hasText: 'Принять' }).click();
  await Promise.all([host.waitForFunction(() => document.getElementById('friends-list').textContent.includes('friend')), guest.waitForFunction(() => document.getElementById('friends-list').textContent.includes('owner'))]);
  // Friend approval persists in actual per-client JSON; it never grants screen access.
  assert.equal(await guest.locator('#video').isVisible(), false);
  const friendFiles = fs.readdirSync(path.join(dataDirectory, 'guest')).filter(name => name.startsWith('friends-'));
  assert.equal(friendFiles.length, 1); assert.equal(JSON.parse(fs.readFileSync(path.join(dataDirectory, 'guest', friendFiles[0]), 'utf8')).friends[0].id, ownerId);
  await guest.reload(); await guest.waitForFunction(id => document.getElementById('own-id').textContent === id, friendId);
  await connectFriend(guest, host, false); assert.equal(await guest.textContent('#own-id'), friendId);
  await connectFriend(guest, host);
  assert.equal(await guest.locator('#auth-dialog').isVisible(), false);
  await guest.click('#request-control'); await host.locator('#confirm-dialog').waitFor({ state: 'visible' }); await host.click('#confirm-yes');
  await guest.waitForFunction(() => document.getElementById('control-status').textContent.includes('Вы управляете'));
  await guest.click('#capture-pointer'); await guest.keyboard.press('w');
  await guest.waitForTimeout(100); assert.ok(inputs.some(i => i.name === 'host' && i.event.kind === 'key' && i.event.scan === 0x11));
  await guest.evaluate(() => document.exitPointerLock()); await guest.click('#fullscreen');
  await guest.waitForFunction(() => Boolean(document.fullscreenElement));
  if (await guest.locator('#capture-pointer').isVisible()) await guest.click('#capture-pointer');
  await guest.waitForFunction(() => document.pointerLockElement?.id === 'video');
  await guest.evaluate(() => document.dispatchEvent(new MouseEvent('mousemove', { movementX: 500, movementY: 2, clientX: 2500, bubbles: true })));
  await guest.waitForTimeout(100); assert.ok(inputs.some(i => i.name === 'host' && i.event.kind === 'relative' && i.event.dx === 500));
  const beforeExit = inputs.length; await guest.keyboard.press('Control+F12'); await guest.waitForFunction(() => !document.fullscreenElement && !document.pointerLockElement);
  assert.ok(!inputs.slice(beforeExit).some(i => i.event.kind === 'key' && i.event.scan === 0x58));
  await host.evaluate(() => window.triggerNativeRevoke()); await guest.waitForFunction(() => document.getElementById('control-status').textContent === 'Управление у владельца'); assert.equal(hostGranted, false);
  await saveProfile(guest, { resolution: '1280x720', fps: '60', bitrate: '20' });
  await host.locator('#confirm-dialog').waitFor({ state: 'visible' }); await host.click('#confirm-yes');
  await guest.waitForFunction(() => document.getElementById('video').videoWidth === 1280);
  assert.equal(await host.evaluate(() => pc.getSenders().find(s => s.track?.kind === 'video').getParameters().encodings[0].maxBitrate), 20000000);
  // Real live sender, deterministic injected congestion statistics (not an Internet latency benchmark).
  await saveProfile(host, { mode: 'adaptive' }); await guest.waitForFunction(() => document.getElementById('video').videoWidth === 1920);
  await host.evaluate(() => {
    const getStats = pc.getStats.bind(pc); window.testCongestion = false;
    pc.getStats = async () => { const original = await getStats(), reports = new Map(); original.forEach(r => reports.set(r.id, { ...r }));
      for (const r of reports.values()) { if (r.type === 'candidate-pair') { r.currentRoundTripTime = window.testCongestion ? 0.1 : 0.005; r.availableOutgoingBitrate = 100000000; } }
      return reports;
    };
  });
  await host.waitForTimeout(3500); const rateBefore = await host.evaluate(() => runtimeProfile.bitrate);
  await host.evaluate(() => { window.testCongestion = true; });
  await host.waitForFunction(before => runtimeProfile.bitrate < before * 0.8, rateBefore, { timeout: 12000 });
  const afterCongestion = await host.evaluate(() => ({ rate: runtimeProfile.bitrate, saved: settings.bitrate, reason: adaptive.reason, senderRate: pc.getSenders().find(s => s.track?.kind === 'video').getParameters().encodings[0].maxBitrate }));
  assert.equal(afterCongestion.saved, 60); assert.equal(afterCongestion.senderRate, Math.round(afterCongestion.rate * 1e6));
  assert.match(afterCongestion.reason, /Канал|Потери/);
  await host.evaluate(() => { window.testCongestion = false; });
  await host.waitForFunction(rate => runtimeProfile.bitrate > rate, afterCongestion.rate, { timeout: 25000 });
  await host.waitForFunction(() => receiverStats !== null);
  await host.click('#copy-performance'); const readableReport = await host.evaluate(() => window.copiedInvitation); assert.match(readableReport, /Сетевая RTT/); assert.match(readableReport, /не складываются/);
  await host.click('#save-performance'); assert.match(await host.evaluate(() => window.savedPerformanceReport), /Tandem — отчёт/);
  await host.evaluate(() => { latestSample.path.network='tailscale'; latestSample.path.peerAddress='100.90.1.2'; }); await host.click('#probe-route'); await host.waitForFunction(() => document.getElementById('route-result').textContent.includes('Подтверждён прямой путь'));
 assert.equal(await guest.locator('#auth-dialog').isVisible(), false);
  // A signaling outage does not interrupt an already established game or role swap.
  await host.evaluate(() => ws.close()); await host.waitForTimeout(250); assert.equal(await guest.evaluate(() => pc?.connectionState), 'connected');
  await host.waitForFunction(id => account?.id === id, ownerId, { timeout: 15000 });
  await guest.click('[data-view="session"]'); await guest.click('#share-screen'); await guest.locator('.source-choice').click();
  await host.locator('#confirm-dialog').waitFor({ state: 'visible' }); await host.click('#confirm-yes');
  await host.waitForFunction(() => role === 'viewer' && document.getElementById('video').videoWidth === 1280 && document.getElementById('video').currentTime > 0);
  await host.click('#request-control'); await guest.locator('#confirm-dialog').waitFor({ state: 'visible' }); await guest.click('#confirm-yes');
  await host.waitForFunction(() => controlling); await host.click('#capture-pointer'); await host.keyboard.press('a'); await host.waitForTimeout(100);
  assert.ok(inputs.some(i => i.name === 'guest' && i.event.kind === 'key' && i.event.scan === 0x1e));
  await host.evaluate(() => document.exitPointerLock());
  fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true }); await host.screenshot({ path: path.join(root, 'artifacts', 'session.png'), fullPage: true });
  await host.click('#leave'); await guest.locator('#connection-idle').waitFor({ state: 'visible' });
  await saveProfile(host, { resolution: '3840x2160', fps: '240' });
  assert.equal(await host.textContent('#profile-title'), '4K / 240 FPS');
  await saveProfile(host); await host.click('[data-view="friends"]'); await host.screenshot({ path: path.join(root, 'artifacts', 'home.png'), fullPage: true });
  // Probe a real TURN allocation, then force the entire fallback session through TURN.
  await host.click('[data-view="settings"]'); await host.selectOption('#transport', 'relay'); await host.click('#test-turn');
  await host.waitForFunction(() => document.getElementById('turn-result').textContent.includes('TURN доступен'), { timeout: 20000 });
  await host.click('#save-settings'); await host.locator('#confirm-dialog').waitFor({ state: 'visible' }); await host.click('#confirm-yes');
  await guest.click('[data-view="settings"]'); await guest.selectOption('#transport', 'relay'); await guest.click('#save-settings'); await guest.locator('#confirm-dialog').waitFor({ state: 'visible' }); await guest.click('#confirm-yes');
  // Fallback direct files work without a guest account, with an explicit owner confirmation.
  await guest.click('[data-view="accounts"]'); await guest.click('#account-logout'); await guest.reload(); assert.equal(await guest.textContent('#own-id'), '—');
  await host.click('[data-view="session"]'); await host.locator('#connection-idle details summary').click(); await host.click('#create'); await host.locator('.source-choice').click();
  await host.waitForFunction(() => document.getElementById('direct-output').value.startsWith('tandem://direct/'));
  const offer = await host.inputValue('#direct-output');
  await guest.click('[data-view="session"]'); await guest.locator('#connection-idle details summary').click();
  const chooser = guest.waitForEvent('filechooser'); await guest.click('#import-packet'); await (await chooser).setFiles({ name: 'offer.tandem', mimeType: 'text/plain', buffer: Buffer.from(offer) }); await guest.click('#join');
  await guest.waitForFunction(() => document.getElementById('direct-output').value.startsWith('tandem://direct/'));
  const answer = await guest.inputValue('#direct-output'); await host.fill('#direct-response', answer); await host.click('#direct-apply'); await host.locator('#confirm-dialog').waitFor({ state: 'visible' }); await host.click('#confirm-yes'); await waitVideo(guest);
  assert.equal(await guest.locator('#auth-dialog').isVisible(), false); await guest.click('#leave'); await host.locator('#connection-idle').waitFor({ state: 'visible' });
  for (const logger of loggers) await logger.flush();
  const logText = fs.readFileSync(loggers[0].filename, 'utf8');
  assert.match(logText, /TURN доступен и выделил маршрут/); assert.match(logText, /Ответ друга применён/);
  assert.ok(!logText.includes('tandem:\/\/direct\/')); assert.ok(!logText.includes('test-local-only')); assert.ok(logText.endsWith('\n'));
  assert.deepEqual(errors, []); assert.deepEqual(traces, []);
  const report = { ok: true, tested: ['no host/IP fields in the normal interface', 'account ID search without repeated login', 'friend request, explicit acceptance and local JSON persistence across restart', 'view request rejection and retry without pre-creating a room', 'actual 1080p video and input after separate owner approvals', 'fullscreen edges, Ctrl+F12 and owner emergency revoke', 'live manual HD/20Mbps update with owner consent', 'adaptive congestion reduction and gradual recovery on a real sender using injected RTT stats', 'auto changes preserve the saved user ceiling', 'fresh decoder feedback over data channel', 'established game survives signaling loss and supports role swap', 'both users can host and control', '4K/240 limits and settings confirmation', 'direct offer/answer file fallback without guest account', 'TURN allocation probe and forced relay policy', 'readable local logs without credentials or full invitations', 'performance report export with real stream statistics', 'Tailscale probe IPC wiring (native command parsing tested separately)'], inputEvents: inputs.length, browserErrors: errors, consoleErrors: traces };
  fs.writeFileSync(path.join(root, 'artifacts', 'browser-test.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
})().catch(async error => { console.error(error); console.error({ errors, traces }); for (const page of pages) { try { console.error(await page.evaluate(() => ({status: document.getElementById('status').textContent, toast: document.getElementById('toast').textContent, role, peerReady, pc: pc?.connectionState, signal: pc?.signalingState, ice: pc?.iceConnectionState, v: {w: document.getElementById('video').videoWidth,h: document.getElementById('video').videoHeight,t: document.getElementById('video').currentTime}, stream: stream?.getTracks().map(t=>t.getSettings()), stats: document.getElementById('metrics-detail').textContent}))); } catch {} } process.exitCode = 1; }).finally(async () => {
  await browser?.close(); await relay.close(); for (const logger of loggers) await logger.close(); fs.rmSync(dataDirectory, { recursive: true, force: true }); await new Promise(resolve => staticServer.close(resolve));
});
