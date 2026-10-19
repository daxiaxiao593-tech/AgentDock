const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agentDock', {
  selectWorkingDirectory: () => ipcRenderer.invoke('agentdock:select-working-directory')
});
