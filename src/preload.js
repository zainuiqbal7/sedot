'use strict';
// Jembatan aman antara UI dan proses utama: UI hanya bisa memanggil fungsi di bawah ini.
const { contextBridge, ipcRenderer } = require('electron');

const call = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);

contextBridge.exposeInMainWorld('sedot', {
  state: call('state'),
  categories: call('categories'),
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
  add: (urls, dir) => ipcRenderer.invoke('add', { urls, dir }),
  addViaDialog: call('addViaDialog'),
  pause: call('pause'),
  resume: call('resume'),
  pauseAll: call('pauseAll'),
  resumeAll: call('resumeAll'),
  remove: (gids, deleteFiles) => ipcRenderer.invoke('remove', { gids, deleteFiles }),
  open: call('open'),
  reveal: call('reveal'),
  getSettings: call('getSettings'),
  setSettings: call('setSettings'),
  chooseDir: call('chooseDir'),
  version: call('version'),
  installUpdate: call('installUpdate'),
  detail: call('detail'),
  setLimit: (gid, kb) => ipcRenderer.invoke('setLimit', { gid, kb }),
  replaceUrl: (gid, url) => ipcRenderer.invoke('replaceUrl', { gid, url }),
  copyText: call('copyText'),
  contextMenu: call('contextMenu'),
  setAfterAll: call('setAfterAll'),
  cancelCountdown: call('cancelCountdown'),
  acceptOffer: call('acceptOffer'),
  dismissOffer: call('dismissOffer'),
  extensionInfo: call('extensionInfo'),
  openExtensionDir: call('openExtensionDir'),
  openUrl: call('openUrl'),
});
