import { dialog, ipcMain } from 'electron'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { lstat, realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { getIpcWindow } from '../ipc-source'
import { isAgentId } from '../../shared/agent'
import { isAbsoluteLocalDirectory, parseSettingsChange } from '../../shared/settings'
import type { TaskRootSelection } from '../../shared/settings'
import { appSettingsService, getAppSettings } from './settings-service'
import { bindConversationDirectory, clearConversationDirectories } from './conversation-directory'

type Mutation = { windowId: number; current: boolean }
let mutation: Mutation | null = null

export function hasSettingsMutation(): boolean {
  return mutation !== null
}

function ownerOf(event: IpcMainInvokeEvent): BrowserWindow {
  return getIpcWindow(event, '不支持的设置来源', { windowMustBeLive: true, senderMustBeLive: true })
}

function isCurrent(event: IpcMainInvokeEvent, window: BrowserWindow): boolean {
  return (
    !window.isDestroyed() &&
    !event.sender.isDestroyed() &&
    event.sender.mainFrame === event.senderFrame
  )
}

export function attachSettingsCleanup(window: BrowserWindow): void {
  const cleanup = (): void => {
    if (mutation?.windowId === window.id) mutation.current = false
    clearConversationDirectories(window.id)
  }
  window.webContents.on('did-start-loading', cleanup)
  window.webContents.on('render-process-gone', cleanup)
  window.webContents.once('destroyed', cleanup)
  window.once('closed', cleanup)
}

export function registerSettings(isBusy: (windowId: number) => boolean): void {
  const begin = (window: BrowserWindow): Mutation => {
    getAppSettings()
    if (mutation || isBusy(window.id)) throw new Error('当前操作进行中，请结束后再修改设置')
    const state: Mutation = { windowId: window.id, current: true }
    mutation = state
    return state
  }
  const assertCurrent = (
    state: Mutation,
    event: IpcMainInvokeEvent,
    window: BrowserWindow
  ): void => {
    if (mutation !== state || !state.current || !isCurrent(event, window))
      throw new Error('设置修改已取消')
    if (isBusy(window.id)) throw new Error('当前操作进行中，请结束后再修改设置')
  }
  ipcMain.handle('settings:get', (event) => {
    ownerOf(event)
    return getAppSettings()
  })
  ipcMain.handle('settings:update', async (event, value: unknown) => {
    const owner = ownerOf(event)
    const change = parseSettingsChange(value)
    if (!change) throw new Error('设置修改参数无效')
    const state = begin(owner)
    try {
      return await appSettingsService().update(change, () => assertCurrent(state, event, owner))
    } finally {
      if (mutation === state) mutation = null
    }
  })
  ipcMain.handle('settings:select-task-root', async (event): Promise<TaskRootSelection> => {
    const owner = ownerOf(event)
    const state = begin(owner)
    try {
      const picked = await dialog.showOpenDialog(owner, {
        title: '选择无项目任务文件夹',
        defaultPath: getAppSettings().taskRoot,
        properties: ['openDirectory', 'dontAddToRecent']
      })
      if (!state.current || !isCurrent(event, owner)) return { status: 'cancelled' }
      if (picked.canceled || !picked.filePaths[0]) return { status: 'cancelled' }
      assertCurrent(state, event, owner)
      if (!isAbsoluteLocalDirectory(picked.filePaths[0]))
        throw new Error('请选择本机磁盘上的文件夹')
      const info = await lstat(picked.filePaths[0])
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error('所选路径不是有效的本地文件夹')
      const root = await realpath(resolve(picked.filePaths[0]))
      if (!isAbsoluteLocalDirectory(root)) throw new Error('所选文件夹实际路径无效')
      assertCurrent(state, event, owner)
      const settings = await appSettingsService().setTaskRoot(root, () =>
        assertCurrent(state, event, owner)
      )
      return { status: 'selected', settings }
    } finally {
      if (mutation === state) mutation = null
    }
  })
  ipcMain.handle('conversation:bind-directory', async (event, value: unknown) => {
    const owner = ownerOf(event)
    if (!isAgentId(value)) throw new Error('会话 ID 无效')
    if (mutation || isBusy(owner.id)) throw new Error('当前操作进行中，请稍后创建会话')
    return bindConversationDirectory(owner.id, value, () => isCurrent(event, owner) && !mutation)
  })
}
