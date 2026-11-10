'use strict';
const { chromium } = require('playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createRelay } = require('../server/relay.cjs');
const { validateInput } = require('../shared/input.cjs');
const root = path.join(__dirname, '..');
const inputs = [], errors = [], traces = [], pages = [];
let hostGranted = false, guestGranted = false;
const relay = createRelay({ port: 0, host: '127.0.0.1' });
const otherRelay = createRelay({ port: 0, host: '127.0.0.1' });
const staticServer = http.createServer((req, res) => {
  const file = { '/': 'index.html', '/renderer.js': 'renderer.js', '/network.js': 'network.js', '/quality.js': 'quality.js', '/player.js': 'player.js', '/styles.css': 'styles.css' }[req.url];
  if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  if (!file) { res.writeHead(404); res.end(); return; }
  res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
  res.end(fs.readFileSync(path.join(root, 'app', file)));
});
let browser;
async function setupContext(name, defaultServer) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const savedSessions = new Map(); let lastSaved = null;
  await context.exposeBinding('nativeAction', async (_, action, value) => {
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
    if (!localStorage.getItem('tandem-settings-v1')) localStorage.setItem('tandem-settings-v1', JSON.stringify({ server: defaultServer, ice: testIce, audio: false }));
    const png = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#554477"/></svg>');
    window.tandem = {
      environment: async () => ({ platform: 'win32', version: 'test', addresses: ['127.0.0.1'], defaultServer, emergencyShortcutAvailable: true }),
      startRelay: async () => true,
      loadSession: network => window.nativeAction('load-session', network),
      saveSession: (network, token, server) => window.nativeAction('save-session', { network, token, server }),
      lastSession: () => window.nativeAction('last-session'),
      clearSession: network => window.nativeAction('clear-session', network),
      exitFullscreen: async () => true, cursorState: async () => false, savePacket: async () => true,
      onExitFullscreen: callback => { window.triggerFullscreenExit = callback; },
      sources: async () => [{ id: 'test-monitor', name: `Monitor ${name}`, thumbnail: png }],
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
(async () => {
  const relayAddress = await relay.listen();
  const otherAddress = await otherRelay.listen();
  await new Promise(resolve => staticServer.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  const url = `http://127.0.0.1:${staticServer.address().port}`;
  const defaultServer = `ws://127.0.0.1:${relayAddress.port}`;
  const otherServer = `ws://127.0.0.1:${otherAddress.port}`;
  const host = await setupContext('host', defaultServer), guest = await setupContext('guest', otherServer);
  await Promise.all([host.goto(url), guest.goto(url)]);
  await host.click('#create'); await register(host, 'owner');
  await host.locator('.source-choice').click();
  await host.waitForFunction(() => /^[0-9]{8}$/.test(document.getElementById('invite-output').value));
  const invitation = await host.inputValue('#invite-output');
  await host.click('#copy'); const fullInvitation = await host.evaluate(() => window.copiedInvitation);
  assert.ok(fullInvitation.startsWith('tandem://connect/'));
  // Reproduce two independent local servers: lookup fails without logging out.
  await guest.click('[data-view="accounts"]'); await guest.click('#account-login'); await register(guest, 'friend');
  const oldIdentity = await guest.textContent('#own-id');
  await guest.click('[data-view="session"]'); await guest.fill('#invite-input', invitation); await guest.click('#join');
  await guest.waitForFunction(() => document.getElementById('friend-result').textContent.includes('отсутствует'));
  assert.equal(await guest.textContent('#own-id'), oldIdentity); assert.equal(await guest.locator('#auth-dialog').isVisible(), false);
  // Invitation selects the host's database; a login is needed only for this explicit change.
  await guest.fill('#invite-input', fullInvitation); await guest.click('#join');
  await guest.locator('#confirm-dialog').waitFor({ state: 'visible' }); await guest.click('#confirm-yes'); await register(guest, 'friend');
  await guest.locator('#connect-friend').waitFor({ state: 'visible' });
  const sharedIdentity = await guest.textContent('#own-id');
  assert.equal(await guest.inputValue('#server'), defaultServer); assert.equal(await guest.isChecked('#embedded'), false);
  // Wrong and stale invitations do not clear the shared account or reopen login.
  for (let i = 0; i < 2; i++) {
    await guest.fill('#invite-input', '00000000'); await guest.click('#join');
    await guest.waitForFunction(() => document.getElementById('friend-result').textContent.includes('отсутствует'));
    assert.equal(await guest.textContent('#own-id'), sharedIdentity); assert.equal(await guest.locator('#auth-dialog').isVisible(), false);
  }
  const staleInvitation = await host.evaluate(() => TandemNetwork.createInvitation({ server: ws.url, id: account.id, network: '0'.repeat(32) }));
  await guest.fill('#invite-input', staleInvitation); await guest.click('#join');
  await guest.waitForFunction(() => document.getElementById('toast').textContent.includes('другая база'));
  assert.equal(await guest.textContent('#own-id'), sharedIdentity); assert.equal(await guest.locator('#auth-dialog').isVisible(), false);
  await guest.fill('#invite-input', invitation); await guest.click('#join'); await guest.locator('#connect-friend').waitFor({ state: 'visible' }); await guest.click('#connect-friend');
  // Rejection also keeps login and allows a second request on the same connection.
  await host.locator('#confirm-dialog').waitFor({ state: 'visible' }); await host.click('#confirm-no');
  await guest.locator('#connection-idle').waitFor({ state: 'visible' });
  assert.equal(await guest.textContent('#own-id'), sharedIdentity);
  await guest.fill('#invite-input', invitation); await guest.click('#join'); await guest.locator('#connect-friend').waitFor({ state: 'visible' }); await guest.click('#connect-friend');
  await host.locator('#confirm-dialog').waitFor({ state: 'visible' });
  assert.match(await host.textContent('#confirm-description'), /friend/);
  await host.click('#confirm-yes'); await waitVideo(guest);
  await guest.locator('#request-control').waitFor({ state: 'visible' }); await guest.click('#request-control');
  await host.locator('#confirm-dialog').waitFor({ state: 'visible' }); await host.click('#confirm-yes');
  await guest.waitForFunction(() => document.getElementById('control-status').textContent.includes('Вы управляете'));
  await guest.click('#capture-pointer'); await guest.waitForFunction(() => Boolean(document.pointerLockElement)); await guest.keyboard.down('w'); await guest.keyboard.up('w');
  await guest.waitForTimeout(300);
  assert.ok(inputs.some(i => i.name === 'host' && i.event.kind === 'key' && i.event.scan === 0x11 && i.event.down));
  assert.ok(inputs.some(i => i.name === 'host' && i.event.kind === 'key' && i.event.scan === 0x11 && !i.event.down));
  await host.evaluate(() => window.triggerNativeRevoke());
  await guest.waitForFunction(() => document.getElementById('control-status').textContent === 'Управление у владельца');
  assert.equal(hostGranted, false);
  await guest.click('#share-screen'); await guest.locator('.source-choice').click();
  await host.locator('#confirm-dialog').waitFor({ state: 'visible' }); await host.click('#confirm-yes');
  await waitVideo(host);
  await host.waitForFunction(() => document.getElementById('stream-role').textContent.includes('friend'));
  await host.click('#request-control'); await guest.locator('#confirm-dialog').waitFor({ state: 'visible' }); await guest.click('#confirm-yes');
  await host.waitForFunction(() => document.getElementById('control-status').textContent.includes('Вы управляете'));
  await host.click('#capture-pointer'); await host.waitForFunction(() => Boolean(document.pointerLockElement)); await host.keyboard.press('a');
  await host.waitForTimeout(300); assert.ok(inputs.some(i => i.name === 'guest' && i.event.kind === 'key' && i.event.scan === 0x1e));
  await host.evaluate(() => document.exitPointerLock());
  await host.click('#fullscreen'); await host.waitForFunction(() => Boolean(document.fullscreenElement));
  if (await host.locator('#capture-pointer').isVisible()) await host.click('#capture-pointer');
  await host.waitForFunction(() => document.pointerLockElement?.id === 'video');
  await host.evaluate(() => document.dispatchEvent(new MouseEvent('mousemove', { movementX: 500, movementY: 2, clientX: 2500, bubbles: true })));
  await host.waitForTimeout(100); assert.ok(inputs.some(i => i.name === 'guest' && i.event.kind === 'relative' && i.event.dx === 500));
  const beforeExit = inputs.length;
  await host.keyboard.press('Control+F12'); await host.waitForFunction(() => !document.fullscreenElement && !document.pointerLockElement);
  assert.ok(!inputs.slice(beforeExit).some(i => i.event.kind === 'key' && i.event.scan === 0x58));
  // A live profile request from the viewer reaches the host and changes sender parameters.
  await host.click('[data-view="settings"]'); await host.selectOption('#resolution', '1280x720'); await host.selectOption('#fps', '60'); await host.fill('#bitrate', '20');
  await host.click('#save-settings'); await host.locator('#confirm-dialog').waitFor({ state: 'visible' }); await host.click('#confirm-yes');
  await guest.locator('#confirm-dialog').waitFor({ state: 'visible' }); await guest.click('#confirm-yes');
  await guest.waitForFunction(() => pc.getSenders().some(s => s.track?.kind === 'video' && s.getParameters().encodings[0].maxBitrate === 20000000));
  await host.waitForFunction(() => document.getElementById('video').videoWidth === 1280);
  await host.click('[data-view="session"]');
  await host.waitForFunction(() => document.getElementById('stat-fps').textContent.trim() !== '— FPS');
  fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true });
  await host.screenshot({ path: path.join(root, 'artifacts', 'session.png'), fullPage: true });
  await guest.click('#leave');
  await host.locator('#connection-idle').waitFor({ state: 'visible' }); assert.equal(hostGranted, false); assert.equal(guestGranted, false);
  assert.equal(await guest.textContent('#own-id'), sharedIdentity);
  assert.equal(await host.textContent('#own-id'), invitation);
  await guest.fill('#invite-input', invitation); await guest.click('#join');
  await guest.waitForFunction(() => document.getElementById('friend-result').textContent.includes('Не принимает'));
  assert.equal(await guest.locator('#auth-dialog').isVisible(), false);
  await host.click('#create'); await host.locator('.source-choice').click();
  await host.locator('#connection-active').waitFor({ state: 'visible' });
  assert.equal(await host.locator('#auth-dialog').isVisible(), false);
  await host.click('#leave'); await host.locator('#connection-idle').waitFor({ state: 'visible' });
  await host.click('[data-view="settings"]');
  await host.selectOption('#resolution', '3840x2160'); await host.selectOption('#fps', '240'); await host.click('#save-settings'); await host.locator('#confirm-dialog').waitFor({ state: 'visible' }); await host.click('#confirm-yes');
  await host.click('[data-view="session"]'); assert.equal(await host.textContent('#profile-title'), '4K / 240 FPS');
  await host.click('[data-view="settings"]'); await host.selectOption('#resolution', '1920x1080'); await host.selectOption('#fps', '120'); await host.click('#save-settings'); await host.locator('#confirm-dialog').waitFor({ state: 'visible' }); await host.click('#confirm-yes'); await host.click('[data-view="session"]');
  await host.screenshot({ path: path.join(root, 'artifacts', 'home.png'), fullPage: true });
  // Remembered login survives page/app restart and a lost WebSocket.
  await guest.reload(); await guest.waitForFunction(id => document.getElementById('own-id').textContent === id, sharedIdentity);
  assert.equal(await guest.locator('#auth-dialog').isVisible(), false);
  await guest.evaluate(() => new Promise(resolve => { const old = ws; old.addEventListener('close', () => setTimeout(resolve, 20), { once: true }); old.close(); }));
  await guest.waitForFunction(id => document.getElementById('own-id').textContent === id, sharedIdentity);
  assert.equal(await guest.locator('#auth-dialog').isVisible(), false);
  await guest.click('[data-view="accounts"]'); await guest.click('#account-logout'); await guest.reload();
  assert.equal(await guest.textContent('#own-id'), '—');
  for (const page of [host, guest]) await page.evaluate(ice => { settings.ice = ice; showSettings(); }, JSON.parse(process.env.TANDEM_TEST_ICE || '[]'));
  // Offline/manual signaling: no server login on the guest, full video after owner accepts answer.
  await guest.click('[data-view="session"]');
  await host.selectOption('#connection-mode', 'direct'); await host.click('#create'); await host.locator('.source-choice').click();
  await host.waitForFunction(() => document.getElementById('direct-output').value.startsWith('tandem://direct/'));
  const directOffer = await host.inputValue('#direct-output');
  const offerFile = guest.waitForEvent('filechooser'); await guest.click('#import-packet'); await (await offerFile).setFiles({ name: 'offer.tandem', mimeType: 'text/plain', buffer: Buffer.from(directOffer) });
  await guest.waitForFunction(() => document.getElementById('invite-input').value.startsWith('tandem://direct/')); await guest.click('#join');
  await guest.waitForFunction(() => document.getElementById('direct-output').value.startsWith('tandem://direct/'));
  assert.equal(await guest.locator('#auth-dialog').isVisible(), false);
  const directAnswer = await guest.inputValue('#direct-output');
  const answerFile = host.waitForEvent('filechooser'); await host.click('#direct-open-response'); await (await answerFile).setFiles({ name: 'answer.tandem', mimeType: 'text/plain', buffer: Buffer.from(directAnswer) });
  await host.waitForFunction(() => document.getElementById('direct-response').value.startsWith('tandem://direct/')); await host.click('#direct-apply'); await host.locator('#confirm-dialog').waitFor({ state: 'visible' }); await host.click('#confirm-yes');
  await waitVideo(guest);
  await guest.locator('#request-control').waitFor({ state: 'visible' }); await guest.click('#request-control');
  await host.locator('#confirm-dialog').waitFor({ state: 'visible' }); await host.click('#confirm-yes');
  await guest.waitForFunction(() => document.getElementById('control-status').textContent.includes('Вы управляете'));
  await host.evaluate(() => ws?.close()); await host.waitForTimeout(150); assert.equal(await host.evaluate(() => pc?.connectionState), 'connected');
  await guest.click('#capture-pointer'); await guest.waitForFunction(() => Boolean(document.pointerLockElement)); await guest.keyboard.press('d');
  await guest.evaluate(() => document.exitPointerLock());
  await guest.click('#share-screen'); await guest.locator('.source-choice').click(); await host.locator('#confirm-dialog').waitFor({ state: 'visible' }); await host.click('#confirm-yes');
  await host.waitForFunction(() => role === 'viewer' && document.getElementById('video').videoWidth === 1280 && document.getElementById('video').currentTime > 0);
  await guest.click('#leave'); await host.locator('#connection-idle').waitFor({ state: 'visible' });
  assert.deepEqual(errors, []); assert.deepEqual(traces, []);
  const report = { ok: true, tested: ['two independent servers and unknown ID without logout', 'invitation switches to the correct network', 'repeated failed search preserves login', 'wrong network fingerprint rejected without logout', 'rejected request and retry preserve login', 'actual 1920x1080 WebRTC video', 'keyboard and mouse channel', 'native revoke callback', 'stream role swap', 'control after swap', 'disconnect and new session preserve login', '4K/240 settings', 'fullscreen pointer capture across edges and Ctrl+F12', 'live HD bitrate change with host approval', 'secure session resume after reload and network drop', 'explicit logout revokes remembered login', 'manual direct signaling without VPN or server account', 'direct invitation files and role swap over the established data channel'], inputEvents: inputs.length, browserErrors: errors, consoleErrors: traces };
  fs.writeFileSync(path.join(root, 'artifacts', 'browser-test.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
})().catch(async error => { console.error(error); console.error({ errors, traces }); for (const page of pages) { try { console.error(await page.evaluate(() => ({status: document.getElementById('status').textContent, toast: document.getElementById('toast').textContent, role, peerReady, pc: pc?.connectionState, signal: pc?.signalingState, ice: pc?.iceConnectionState, v: {w: document.getElementById('video').videoWidth,h: document.getElementById('video').videoHeight,t: document.getElementById('video').currentTime}, stream: stream?.getTracks().map(t=>t.getSettings()), stats: document.getElementById('metrics-detail').textContent}))); } catch {} } process.exitCode = 1; }).finally(async () => {
  await browser?.close(); await relay.close(); await otherRelay.close(); await new Promise(resolve => staticServer.close(resolve));
});
