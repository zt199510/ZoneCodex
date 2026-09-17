// 仅用于隔离 UI 回归测试；正式 preload 不导入此文件。
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  controlWindow: (action) => ipcRenderer.invoke('fixture:window-command', action),
  getWindowState: () => ipcRenderer.invoke('fixture:window-state'),
  onWindowStateChanged: (listener) => {
    const handler = (_event, value) => listener(value)
    ipcRenderer.on('fixture:window-state-changed', handler)
    return () => ipcRenderer.removeListener('fixture:window-state-changed', handler)
  },
  loadConversation: () => ipcRenderer.invoke('fixture:load'),
  saveConversation: (snapshot) => ipcRenderer.invoke('fixture:save', snapshot),
  startModelStream: (requestId, history) => ipcRenderer.invoke('fixture:start', requestId, history),
  cancelModelStream: (requestId) => ipcRenderer.invoke('fixture:cancel', requestId),
  onModelDelta: (listener) => {
    const handler = (_event, value) => listener(value)
    ipcRenderer.on('fixture:delta', handler)
    return () => ipcRenderer.removeListener('fixture:delta', handler)
  }
})
