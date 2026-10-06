import { contextBridge } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { AppAPI } from '../shared/api'
import { conversationAPI } from './conversation-api'
import { agentAPI } from './agent-api'
import { projectAPI } from './project-api'
import { windowAPI } from './window-api'
import { terminalAPI } from './terminal-api'

// 分组实现同一个平铺业务接口，页面不直接使用 Node API。
const api: AppAPI = {
  ...conversationAPI,
  ...agentAPI,
  ...projectAPI,
  ...windowAPI,
  ...terminalAPI
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
