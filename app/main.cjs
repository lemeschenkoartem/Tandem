'use strict';
const { app, BrowserWindow, ipcMain, desktopCapturer, session, screen, globalShortcut, clipboard, powerSaveBlocker, safeStorage, dialog, net, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createRelay } = require('../server/relay.cjs');
const { validateInput } = require('../shared/input.cjs');
let win, relay, input, selected, granted = false, lastHeartbeat = 0;
let emergencyShortcutAvailable = false;
let powerBlocker;
let sessions;
let local;
let servicePromise;
let logger, logError = null, quitting = false;
let routeProbeBusy = false;
const friendlyError = require('./logging.js').error;
async function serviceConfiguration() {
  if (servicePromise) return servicePromise;
  servicePromise = (async () => {
    const bundled = JSON.parse(fs.readFileSync(path.join(__dirname, 'service.json'), 'utf8'));
    const override = local.read('service.json', {});
    let configured = process.env.TANDEM_SERVICE_URL || override.server || bundled.server;
    if (!configured && bundled.manifest) {
      try {
        const response = await net.fetch(bundled.manifest, { signal: AbortSignal.timeout(4000) });
        if (response.ok) {
          const text = await response.text();
          if (text.length <= 8192) {
            const value = JSON.parse(text);
            if (value.server === null || (typeof value.server === 'string' && value.server.startsWith('wss://'))) {
              configured = value.server; local.write('service-cache.json', { server: configured });
            }
          }
        }
      } catch {}
      configured ??= local.read('service-cache.json', {}).server;
    }
    if (!configured) return null;
    const normalized = require('./network.js').normalizeServer(configured), url = new URL(normalized);
    if (url.protocol !== 'wss:' && !['localhost', '127.0.0.1', '::1'].includes(url.hostname)) throw new Error('Общая служба должна использовать защищённый WSS.');
    return normalized;
  })();
  return servicePromise;
}
function revoke(notify = true) {
  if (granted) logger?.record('control', { result: 'Удалённое управление отозвано; нажатия отпущены' });
  granted = false; input?.release();
  if (notify && win && !win.isDestroyed()) win.webContents.send('control-revoked');
}
function networkAddresses() {
  const interfaces = Object.entries(os.networkInterfaces()).flatMap(([name, entries]) => entries.filter(n => n.family === 'IPv4' && !n.internal).map(n => ({ name, address: n.address })));
  const score = n => /tailscale/i.test(n.name) ? 0 : /radmin/i.test(n.name) ? 1 : /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(n.address) ? 2 : /^26\./.test(n.address) ? 3 : 4;
  return interfaces.sort((a, b) => score(a) - score(b)).map(n => n.address);
}
function trusted(event) {
  if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error('Недопустимый источник IPC.');
}
function registerIPC() {
  ipcMain.handle('environment', async event => {
    trusted(event);
    const addresses = networkAddresses();
    const server = await serviceConfiguration(), cachedAccount = local.read('account.json');
    const lastAccount = cachedAccount && /^[a-f0-9]{32}$/.test(cachedAccount.network) && /^[0-9]{8}$/.test(cachedAccount.id) ? cachedAccount : null;
    return { platform: process.platform, version: app.getVersion(), addresses, defaultServer: server, serviceConfigured: Boolean(server), dataDirectory: app.getPath('userData'), logPath: logger?.filename, logError, lastAccount, emergencyShortcutAvailable, gpu: app.getGPUFeatureStatus() };
  });
  ipcMain.handle('log-event', (event, name, data) => { trusted(event); if (!logger) return false; logger.record(name, data); return true; });
  ipcMain.handle('open-log', async event => {
    trusted(event);
    if (!logger) throw new Error('Журнал недоступен: ' + (logError || 'не удалось создать файл'));
    await logger.flush(); if (logger.error) throw new Error('Не удалось записать журнал. Код: ' + logger.error);
    const result = await shell.openPath(logger.filename); if (result) throw new Error('Не удалось открыть журнал. Откройте файл через папку данных.'); return true;
  });
  ipcMain.handle('probe-tailscale', async (event, ip) => {
    trusted(event);
    if (routeProbeBusy) throw new Error('Проверка маршрута уже выполняется.');
    routeProbeBusy = true;
    try {
      const result = await require('./tailscale.cjs').probe(ip);
      logger?.record('network_probe', { result: result.reason, route: result.path, rtt: result.ping?.medianMs, p95: result.ping?.p95Ms });
      return result;
    } finally { routeProbeBusy = false; }
  });
  ipcMain.handle('save-performance-report', async (event, text) => {
    trusted(event);
    if (typeof text !== 'string' || !text.startsWith('Tandem — отчёт') || Buffer.byteLength(text) > 256 * 1024) throw new Error('Некорректный отчёт.');
    const directory = path.join(app.getPath('userData'), 'reports');
    await fs.promises.mkdir(directory, { recursive: true });
    const filename = path.join(directory, `tandem-performance-${Date.now()}.txt`);
    await fs.promises.writeFile(filename, text, { encoding: 'utf8', mode: 0o600 });
    logger?.record('action', { action: 'Сохранён текстовый отчёт об отклике и качестве' });
    shell.showItemInFolder(filename); return filename;
  });
  ipcMain.handle('load-settings', event => { trusted(event); return local.settings(); });
  ipcMain.handle('save-settings', (event, value) => { trusted(event); return local.settings(value); });
  ipcMain.handle('load-contacts', (event, network, id) => { trusted(event); return local.contacts(network, id); });
  ipcMain.handle('save-contacts', (event, network, id, value) => { trusted(event); return local.contacts(network, id, value); });
  ipcMain.handle('save-account', (event, network, value) => { trusted(event); return local.account(network, value); });
  ipcMain.handle('open-data-directory', async event => { trusted(event); fs.mkdirSync(app.getPath('userData'), { recursive: true }); return shell.openPath(app.getPath('userData')); });
  ipcMain.handle('load-session', (event, network) => { trusted(event); return sessions.get(network); });
  ipcMain.handle('save-session', (event, network, token, server) => { trusted(event); return sessions.set(network, token, server); });
  ipcMain.handle('last-session', event => { trusted(event); return sessions.last(); });
  ipcMain.handle('clear-session', (event, network) => { trusted(event); sessions.clear(network); return true; });
  ipcMain.handle('exit-fullscreen', event => { trusted(event); win.setFullScreen(false); return true; });
  ipcMain.handle('cursor-state', event => {
    trusted(event);
    if (process.platform !== 'win32' || !selected) return null;
    try { input ??= new (require('./windows-input.cjs').WindowsInput)(); return input.cursorVisible(); } catch { return null; }
  });
  ipcMain.handle('save-packet', async (event, packet) => {
    trusted(event);
    if (typeof packet !== 'string' || packet.length > 262144 || !packet.startsWith('tandem://direct/')) throw new Error('Некорректное приглашение.');
    const result = await dialog.showSaveDialog(win, { title: 'Сохранить приглашение прямой связи', defaultPath: 'Tandem-connection.tandem', filters: [{ name: 'Tandem', extensions: ['tandem'] }] });
    if (result.canceled) return false;
    fs.writeFileSync(result.filePath, packet, 'utf8'); logger?.record('action', { action: 'Файл приглашения или ответа сохранён' }); return true;
  });
  ipcMain.handle('sources', async event => {
    trusted(event);
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 360, height: 200 } });
    return sources.map(s => {
      const display = screen.getAllDisplays().find(d => String(d.id) === s.display_id);
      return { id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL(), displayId: s.display_id,
        width: display ? Math.round(display.size.width * display.scaleFactor) : null,
        height: display ? Math.round(display.size.height * display.scaleFactor) : null, fps: display?.displayFrequency || null };
    });
  });
  ipcMain.handle('select-source', async (event, id) => {
    trusted(event); revoke(false);
    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    const source = sources.find(s => s.id === id);
    if (!source) throw new Error('Экран недоступен.');
    const display = screen.getAllDisplays().find(d => String(d.id) === source.display_id);
    if (!display) throw new Error('Не удалось определить монитор.');
    selected = { id, displayId: display.id };
    logger?.record('action', { action: 'Выбран монитор для показа', resolution: `${Math.round(display.size.width * display.scaleFactor)}x${Math.round(display.size.height * display.scaleFactor)}`, fps: display.displayFrequency });
    if (powerBlocker === undefined) powerBlocker = powerSaveBlocker.start('prevent-app-suspension');
    return true;
  });
  ipcMain.handle('start-relay', async (event, serverURL) => {
    trusted(event);
    const url = new URL(serverURL);
    if (url.protocol !== 'ws:' || !['localhost', '127.0.0.1', ...networkAddresses()].includes(url.hostname) || Number(url.port) !== 8787)
      throw new Error('Встроенный сервер: укажите VPN-адрес этого компьютера и порт 8787. Если это адрес ПК друга, отключите встроенный сервер.');
    if (!relay) {
      const candidate = createRelay({ databasePath: path.join(app.getPath('userData'), 'accounts.sqlite') });
      try { await candidate.listen(); relay = candidate; }
      catch (error) { await candidate.close(); throw new Error(error.code === 'EADDRINUSE' ? 'Порт 8787 занят. Отключите встроенный сервер, если уже запущен другой Tandem.' : error.message); }
    }
    return true;
  });
  ipcMain.handle('grant-control', event => {
    trusted(event);
    if (!selected) throw new Error('Сначала выберите экран.');
    if (!emergencyShortcutAvailable) throw new Error('Ctrl+Alt+F12 занята другой программой. Освободите сочетание и перезапустите Tandem.');
    input ??= new (require('./windows-input.cjs').WindowsInput)();
    lastHeartbeat = Date.now(); granted = true; logger?.record('control', { result: 'Владелец разрешил клавиатуру и мышь' });
    return true;
  });
  ipcMain.handle('revoke-control', event => { trusted(event); revoke(false); return true; });
  ipcMain.handle('end-session', event => { trusted(event); revoke(false); selected = undefined; if (powerBlocker !== undefined) powerSaveBlocker.stop(powerBlocker); powerBlocker = undefined; return true; });
  ipcMain.handle('copy', (event, value) => { trusted(event); if (typeof value === 'string' && value.length <= 262144) clipboard.writeText(value); });
  let inputWindow = 0, inputCount = 0;
  ipcMain.on('input', (event, raw) => {
    trusted(event);
    if (!granted || !selected) return;
    const now = Date.now();
    if (now - inputWindow > 1000) { inputWindow = now; inputCount = 0; }
    if (++inputCount > 1000) return;
    const value = validateInput(raw);
    if (!value) return;
    try {
      switch (value.kind) {
        case 'heartbeat': lastHeartbeat = now; break;
        case 'release': input.release(); break;
        case 'key': input.key(value.scan, value.down); break;
        case 'button': input.button(value.button, value.down); break;
        case 'wheel': input.wheel(value.delta); break;
        case 'relative': input.relative(value.dx, value.dy); break;
        case 'move': {
          const display = screen.getAllDisplays().find(d => d.id === selected.displayId);
          if (!display) { revoke(); break; }
          const { x, y, width, height } = display.bounds;
          const point = screen.dipToScreenPoint({ x: Math.round(x + value.x * (width - 1)), y: Math.round(y + value.y * (height - 1)) });
          input.move(point.x, point.y); break;
        }
      }
    } catch (error) { revoke(); win?.webContents.send('native-error', error.message); }
  });
}
app.whenReady().then(() => {
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
  sessions = new (require('./session-store.cjs').SessionStore)(path.join(app.getPath('userData'), 'sessions.enc'), safeStorage);
  local = new (require('./local-store.cjs').LocalStore)(app.getPath('userData'));
  try { logger = new (require('./logger.cjs').Logger)(path.join(app.getPath('userData'), 'logs', 'tandem.log')); logger.record('start', { version: app.getVersion(), platform: process.platform }); }
  catch (error) { logError = error.code || 'LOG_CREATE_FAILED'; }
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => callback(wc === win?.webContents && ['media', 'display-capture', 'fullscreen', 'pointerLock'].includes(permission)));
  session.defaultSession.setPermissionCheckHandler((wc, permission) => wc === win?.webContents && ['media', 'display-capture', 'fullscreen', 'pointerLock'].includes(permission));
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    if (!selected || request.frame !== win?.webContents.mainFrame) { callback({}); return; }
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'] });
      const source = sources.find(s => s.id === selected.id);
      callback(source ? { video: source, ...(request.audioRequested && process.platform === 'win32' ? { audio: 'loopback' } : {}) } : {});
    } catch { callback({}); }
  });
  win = new BrowserWindow({
    width: 1360, height: 900, minWidth: 1000, minHeight: 720,
    title: 'Tandem — играйте вместе', backgroundColor: '#101114', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.on('before-input-event', (event, key) => {
    if (key.type === 'keyDown' && key.control && !key.alt && key.code === 'F12') { event.preventDefault(); win.webContents.send('exit-fullscreen'); }
  });
  win.webContents.on('render-process-gone', (_event, details) => { logger?.record('crash', { reason: 'Закрылся процесс интерфейса', code: details.exitCode }); revoke(false); });
  win.on('closed', () => { revoke(false); win = null; });
  emergencyShortcutAvailable = globalShortcut.register('CommandOrControl+Alt+F12', () => { revoke(); win?.show(); win?.focus(); });
  registerIPC();
  win.loadFile(path.join(__dirname, 'index.html'));
  const watchdog = setInterval(() => { if (granted && Date.now() - lastHeartbeat > 3000) revoke(); }, 250);
  watchdog.unref();
  screen.on('display-removed', () => revoke());
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (quitting) return;
  event.preventDefault(); quitting = true; revoke(false); globalShortcut.unregisterAll(); logger?.record('stop');
  Promise.allSettled([logger?.close(), relay?.close()]).finally(() => app.quit());
});
process.on('uncaughtException', error => { logger?.record('crash', { reason: friendlyError(error), code: error.code || error.name }); revoke(false); console.error(error.message); app.quit(); });
