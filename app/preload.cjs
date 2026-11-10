'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('tandem', {
  environment: () => ipcRenderer.invoke('environment'),
  loadSession: network => ipcRenderer.invoke('load-session', network),
  saveSession: (network, token, server) => ipcRenderer.invoke('save-session', network, token, server),
  lastSession: () => ipcRenderer.invoke('last-session'),
  clearSession: network => ipcRenderer.invoke('clear-session', network),
  exitFullscreen: () => ipcRenderer.invoke('exit-fullscreen'),
  cursorState: () => ipcRenderer.invoke('cursor-state'),
  savePacket: packet => ipcRenderer.invoke('save-packet', packet),
  onExitFullscreen: callback => ipcRenderer.on('exit-fullscreen', () => callback()),
  sources: () => ipcRenderer.invoke('sources'),
  selectSource: id => ipcRenderer.invoke('select-source', id),
  startRelay: url => ipcRenderer.invoke('start-relay', url),
  grantControl: () => ipcRenderer.invoke('grant-control'),
  revokeControl: () => ipcRenderer.invoke('revoke-control'),
  endSession: () => ipcRenderer.invoke('end-session'),
  input: event => ipcRenderer.send('input', event),
  copy: value => ipcRenderer.invoke('copy', value),
  onRevoke: callback => ipcRenderer.on('control-revoked', () => callback()),
  onError: callback => ipcRenderer.on('native-error', (_, message) => callback(message))
});
