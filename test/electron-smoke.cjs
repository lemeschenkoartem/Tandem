'use strict';
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const directory = path.resolve(__dirname, '../../electron-smoke');
fs.mkdirSync(directory, { recursive: true });
app.setPath('userData', directory);
const timer = setTimeout(() => { console.error('Electron smoke timed out'); app.exit(1); }, 20000);
app.on('browser-window-created', (_, window) => {
  window.webContents.on('console-message', (_event, details) => { if (details.level === 'error') console.error('Renderer:', details.message); });
  window.webContents.once('did-finish-load', async () => {
    try {
      const result = await window.webContents.executeJavaScript(`(async () => {
        const env = await window.tandem.environment();
        window.testNativeExitCount = 0; window.tandem.onExitFullscreen(() => { window.testNativeExitCount++; });
        const reportPath = await window.tandem.savePerformanceReport(['Tandem — отчёт об отклике и качестве','Проверка IPC'].join(String.fromCharCode(10)));
        if (env.platform !== 'win32' && (await window.tandem.probeTailscale('100.90.1.2')).available !== false) throw new Error('Unexpected native Tailscale probe');
        await window.tandem.logEvent('action', { action: 'Проверка настоящего IPC журнала' });
        await window.tandem.loadSession('a'.repeat(32));
        await window.tandem.saveSettings({ resolution: '1920x1080', fps: 120, bitrate: 60, codec: 'auto', qualityMode: 'adaptive', audio: false, ice: [] });
        if ((await window.tandem.loadSettings()).qualityMode !== 'adaptive') throw new Error('Native settings JSON roundtrip failed');
        await window.tandem.saveContacts('a'.repeat(32), '12345678', { friends: [{ id: '87654321', name: 'friend', online: true }], incoming: [], outgoing: [] });
        if ((await window.tandem.loadContacts('a'.repeat(32), '12345678')).friends[0].id !== '87654321') throw new Error('Native friends JSON roundtrip failed');
        await window.tandem.startRelay('ws://127.0.0.1:8787');
        const account = await new Promise((resolve, reject) => {
          const ws = new WebSocket('ws://127.0.0.1:8787');
          ws.onopen = () => ws.send(JSON.stringify({ type:'register', name:'smoke_'+Date.now().toString().slice(-8), password:'smoke-password-123' }));
          ws.onmessage = event => { const data = JSON.parse(event.data); if (data.type === 'hello') return; ws.close(); data.type === 'authenticated' ? resolve(data.account) : reject(new Error(data.message)); };
          ws.onerror = () => reject(new Error('websocket failed'));
        });
        return { reportPath, title: document.title, bridge: typeof window.tandem.input, version: env.version, account, status: document.getElementById('status').textContent };
      })()`);
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'F12', modifiers: ['control'] });
      await new Promise(resolve => setTimeout(resolve, 100));
      result.nativeFullscreenShortcut = await window.webContents.executeJavaScript('window.testNativeExitCount > 0');
      if (!fs.readFileSync(result.reportPath, 'utf8').includes('Проверка IPC')) throw new Error('Native performance report IPC failed');
      if (!result.nativeFullscreenShortcut) throw new Error('Native Ctrl+F12 shortcut did not reach renderer');
      if (!/^[0-9]{8}$/.test(result.account.id)) throw new Error('Invalid account ID');
      if (!fs.existsSync(path.join(directory, 'logs', 'tandem.log'))) { await new Promise(resolve => setTimeout(resolve, 300)); }
      if (!fs.readFileSync(path.join(directory, 'logs', 'tandem.log'), 'utf8').includes('Проверка настоящего IPC журнала')) throw new Error('Native logging IPC did not write the file');
      console.log('ELECTRON_SMOKE_OK ' + JSON.stringify(result));
      clearTimeout(timer); app.quit();
    } catch (error) { console.error(error); clearTimeout(timer); app.exit(1); }
  });
});
require('../app/main.cjs');
