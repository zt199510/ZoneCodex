import { ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type { AppAPI } from '../shared/api'
import { parseWindowState } from '../shared/window'

export const windowAPI: Pick<
  AppAPI,
  | 'controlWindow'
  | 'getWindowState'
  | 'onWindowStateChanged'
  | 'onCloseRequested'
  | 'finishClose'
  | 'openExternal'
> = {
  controlWindow: async (action) => {
    await ipcRenderer.invoke('window:command', action)
  },
  getWindowState: async () => {
    const state = parseWindowState(await ipcRenderer.invoke('window:state'))
    if (!state) throw new Error('窗口状态格式不正确')
    return state
  },
  onWindowStateChanged: (listener) => {
    const handler = (_event: IpcRendererEvent, value: unknown): void => {
      const state = parseWindowState(value)
      if (state) listener(state)
    }
    ipcRenderer.on('window:state-changed', handler)
    return () => {
      ipcRenderer.removeListener('window:state-changed', handler)
    }
  },
  onCloseRequested: (listener) => {
    const handler = (_event: IpcRendererEvent, requestId: unknown): void => {
      if (typeof requestId === 'string' && requestId.length > 0 && requestId.length <= 80) {
        listener(requestId)
      }
    }
    ipcRenderer.on('window:close-requested', handler)
    return () => {
      ipcRenderer.removeListener('window:close-requested', handler)
    }
  },
  finishClose: async (requestId, allow) => {
    const result: unknown = await ipcRenderer.invoke('window:finish-close', requestId, allow)
    if (typeof result !== 'boolean') throw new Error('关闭确认结果格式不正确')
    return result
  },
  openExternal: async (url) => {
    if (typeof url !== 'string' || url.length === 0 || url.length > 8192) {
      return false
    }
    const result: unknown = await ipcRenderer.invoke('external:open', url)
    if (typeof result !== 'boolean') throw new Error('外部链接结果格式不正确')
    return result
  }
}
