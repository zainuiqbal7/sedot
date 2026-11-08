'use strict';
// Jembatan aman antara UI dan proses utama: UI hanya bisa memanggil fungsi di bawah ini.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sedot', {
  state: () => ipcRenderer.invoke('state'),
  categories: () => ipcRenderer.invoke('categories'),
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
  add: (urls, dir) => ipcRenderer.invoke('add', { urls, dir }),
  pause: (gids) => ipcRenderer.invoke('pause', gids),
  resume: (gids) => ipcRenderer.invoke('resume', gids),
  pauseAll: () => ipcRenderer.invoke('pauseAll'),
  resumeAll: () => ipcRenderer.invoke('resumeAll'),
  remove: (gids, deleteFiles) => ipcRenderer.invoke('remove', { gids, deleteFiles }),
  open: (gid) => ipcRenderer.invoke('open', gid),
  reveal: (gid) => ipcRenderer.invoke('reveal', gid),
  getSettings: () => ipcRenderer.invoke('getSettings'),
  setSettings: (s) => ipcRenderer.invoke('setSettings', s),
  chooseDir: () => ipcRenderer.invoke('chooseDir'),
});
