// Electron preload — narrow, allowlisted bridge to the renderer.
const { contextBridge, ipcRenderer } = require('electron');

const listeners = new Map();

contextBridge.exposeInMainWorld('webstream', {
  isElectron: true,
  platform: process.platform,

  getInfo: () => ipcRenderer.invoke('webstream:info'),

  windowControls: {
    minimize: () => ipcRenderer.send('window:minimize'),
    toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
    close: () => ipcRenderer.send('window:close'),
  },

  onWindowState: (cb) => {
    const handler = (_evt, state) => cb(state);
    ipcRenderer.on('window:state', handler);
    return () => ipcRenderer.removeListener('window:state', handler);
  },

  tunnel: {
    start: () => ipcRenderer.invoke('tunnel:start'),
    stop: () => ipcRenderer.invoke('tunnel:stop'),
    onState: (cb) => {
      const handler = (_evt, state) => cb(state);
      ipcRenderer.on('tunnel:state', handler);
      return () => ipcRenderer.removeListener('tunnel:state', handler);
    },
  },

  capture: {
    setRoom: (room) => ipcRenderer.send('capture:set-room', room),
    toggle: () => ipcRenderer.invoke('capture:toggle'),
    onState: (cb) => {
      const handler = (_evt, state) => cb(state);
      ipcRenderer.on('capture:state', handler);
      return () => ipcRenderer.removeListener('capture:state', handler);
    },
  },
});
