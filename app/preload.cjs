'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('tandem', {
  environment: () => ipcRenderer.invoke('environment'),
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
