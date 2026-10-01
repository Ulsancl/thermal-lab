const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('thermalDesktop', {
  isDesktop: true,
  openProject: () => ipcRenderer.invoke('thermal:open-project'),
  saveProject: payload => ipcRenderer.invoke('thermal:save-project', payload),
  setBusy: busy => ipcRenderer.send('thermal:busy', busy === true),
  onCommand: callback => {
    if (typeof callback !== 'function') throw new TypeError('A callback is required');
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('thermal:command', listener);
    return () => ipcRenderer.removeListener('thermal:command', listener);
  },
});
