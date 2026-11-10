'use strict';
const { app, BrowserWindow, ipcMain, desktopCapturer, session, screen, globalShortcut, clipboard, powerSaveBlocker } = require('electron');
const path = require('node:path');
const os = require('node:os');
const { createRelay } = require('../server/relay.cjs');
const { validateInput } = require('../shared/input.cjs');
let win, relay, input, selected, granted = false, lastHeartbeat = 0;
let emergencyShortcutAvailable = false;
let powerBlocker;
function revoke(notify = true) {
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
  ipcMain.handle('environment', event => {
    trusted(event);
    const addresses = networkAddresses();
    return { platform: process.platform, version: app.getVersion(), addresses, defaultServer: `ws://${addresses[0] || '127.0.0.1'}:8787`, emergencyShortcutAvailable };
  });
  ipcMain.handle('sources', async event => {
    trusted(event);
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 360, height: 200 } });
    return sources.map(s => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL(), displayId: s.display_id }));
  });
  ipcMain.handle('select-source', async (event, id) => {
    trusted(event); revoke(false);
    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    const source = sources.find(s => s.id === id);
    if (!source) throw new Error('Экран недоступен.');
    const display = screen.getAllDisplays().find(d => String(d.id) === source.display_id);
    if (!display) throw new Error('Не удалось определить монитор.');
    selected = { id, displayId: display.id };
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
    lastHeartbeat = Date.now(); granted = true;
    return true;
  });
  ipcMain.handle('revoke-control', event => { trusted(event); revoke(false); return true; });
  ipcMain.handle('end-session', event => { trusted(event); revoke(false); selected = undefined; if (powerBlocker !== undefined) powerSaveBlocker.stop(powerBlocker); powerBlocker = undefined; return true; });
  ipcMain.handle('copy', (event, value) => { trusted(event); if (typeof value === 'string' && value.length <= 8192) clipboard.writeText(value); });
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
  win.webContents.on('render-process-gone', () => revoke(false));
  win.on('closed', () => { revoke(false); win = null; });
  emergencyShortcutAvailable = globalShortcut.register('CommandOrControl+Alt+F12', () => { revoke(); win?.show(); win?.focus(); });
  registerIPC();
  win.loadFile(path.join(__dirname, 'index.html'));
  const watchdog = setInterval(() => { if (granted && Date.now() - lastHeartbeat > 3000) revoke(); }, 250);
  watchdog.unref();
  screen.on('display-removed', () => revoke());
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { revoke(false); globalShortcut.unregisterAll(); relay?.close(); });
process.on('uncaughtException', error => { revoke(false); console.error(error.message); app.quit(); });
