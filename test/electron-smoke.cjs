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
        await window.tandem.startRelay('ws://127.0.0.1:8787');
        const account = await new Promise((resolve, reject) => {
          const ws = new WebSocket('ws://127.0.0.1:8787');
          ws.onopen = () => ws.send(JSON.stringify({ type:'register', name:'smoke_'+Date.now().toString().slice(-8), password:'smoke-password-123' }));
          ws.onmessage = event => { const data = JSON.parse(event.data); if (data.type === 'hello') return; ws.close(); data.type === 'authenticated' ? resolve(data.account) : reject(new Error(data.message)); };
          ws.onerror = () => reject(new Error('websocket failed'));
        });
        return { title: document.title, bridge: typeof window.tandem.input, version: env.version, account, status: document.getElementById('status').textContent };
      })()`);
      if (!/^[0-9]{8}$/.test(result.account.id)) throw new Error('Invalid account ID');
      console.log('ELECTRON_SMOKE_OK ' + JSON.stringify(result));
      clearTimeout(timer); app.quit();
    } catch (error) { console.error(error); clearTimeout(timer); app.exit(1); }
  });
});
require('../app/main.cjs');
