import { ipcRenderer } from 'electron'
import type { WorkbenchAPI } from '../shared/workbench'
export const workbenchAPI: WorkbenchAPI = {
  loadPanelState: (id) => ipcRenderer.invoke('panel:load', id),
  savePanelState: (id, state) => ipcRenderer.invoke('panel:save', id, state),
  removePanelState: (id) => ipcRenderer.invoke('panel:remove', id),
  listPanelDirectory: (context, path, search) =>
    ipcRenderer.invoke('panel:directory', context, path, search),
  readEditorFile: (context, path) => ipcRenderer.invoke('panel:read', context, path),
  saveEditorFile: (context, receipt, fingerprint, text) =>
    ipcRenderer.invoke('panel:write', context, receipt, fingerprint, text),
  releaseEditorFile: (receipt) => ipcRenderer.invoke('panel:release', receipt),
  prepareBrowserTab: (id, tab) => ipcRenderer.invoke('panel:browser', id, tab),
  closeBrowserTab: (id, tab) => ipcRenderer.invoke('panel:browser-close', id, tab),
  onBrowserKey: (listener) => {
    const callback = (
      _event: Electron.IpcRendererEvent,
      data: { key: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }
    ): void => listener(data)
    ipcRenderer.on('panel:browser-key', callback)
    return () => ipcRenderer.removeListener('panel:browser-key', callback)
  },
  onBrowserNewTab: (listener) => {
    const callback = (
      _event: Electron.IpcRendererEvent,
      data: { conversationId: string; url: string }
    ): void => listener(data)
    ipcRenderer.on('panel:browser-new-tab', callback)
    return () => ipcRenderer.removeListener('panel:browser-new-tab', callback)
  }
}
