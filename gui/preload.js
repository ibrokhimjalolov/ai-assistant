'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('api', {
  getSnapshot: () => ipcRenderer.invoke('getSnapshot'),
});
