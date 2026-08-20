const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('desktopStorage', {
  selectDirectory: () => ipcRenderer.invoke('select-save-directory'),
})
