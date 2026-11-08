'use strict';
// Jembatan untuk jendela "Unduh video".
const { contextBridge, ipcRenderer } = require('electron');

const id = new URLSearchParams(location.search).get('id');

contextBridge.exposeInMainWorld('vid', {
  get: () => ipcRenderer.invoke('video:get', id),
  onUpdate: (cb) => ipcRenderer.on('video:update', (_e, info) => cb(info)),
  retry: () => ipcRenderer.invoke('video:retry', id),
  chooseDir: (current) => ipcRenderer.invoke('video:chooseDir', { id, current }),
  decide: (d) => ipcRenderer.invoke('video:decide', { ...d, id }),
  resize: (h) => ipcRenderer.invoke('video:resize', { id, h }),
});
