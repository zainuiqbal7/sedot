'use strict';
// Jembatan untuk jendela "Info unduhan".
const { contextBridge, ipcRenderer } = require('electron');

const id = new URLSearchParams(location.search).get('id');

contextBridge.exposeInMainWorld('job', {
  get: () => ipcRenderer.invoke('job:get', id),
  onUpdate: (cb) => ipcRenderer.on('job:update', (_e, info) => cb(info)),
  chooseDir: (current) => ipcRenderer.invoke('job:chooseDir', { id, current }),
  decide: (d) => ipcRenderer.invoke('job:decide', { ...d, id }),
  reveal: () => ipcRenderer.invoke('job:reveal', id),
  resize: (h) => ipcRenderer.invoke('job:resize', { id, h }),
});
