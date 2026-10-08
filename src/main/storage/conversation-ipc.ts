import { ipcMain } from 'electron'
import { getIpcWindow } from '../ipc-source'
import { createConversationStore } from './conversation-store'
import { parseLibrary } from '../../shared/conversation-library'
import { hasSettingsMutation } from '../settings/settings-ipc'
import {
  configureImageStorage,
  captureImageSaveCheckpoint,
  persistConversationImages,
  rememberConversationImages
} from '../project/image-access'
import {
  checkConversationDirectorySave,
  commitConversationDirectorySave,
  configureConversationDirectoryLookup,
  restoreConversationDirectories
} from '../settings/conversation-directory'

const saves = new Map<number, number>()

export function hasConversationSave(windowId: number): boolean {
  return (saves.get(windowId) ?? 0) > 0
}

export function registerConversationStorage(directory: string): void {
  // 创建会话存储器
  const conversationStore = createConversationStore(directory)
  configureConversationDirectoryLookup(async (conversationId) => {
    const result = await conversationStore.load()
    if (!result.ok) throw new Error(result.error)
    return (
      result.snapshot.conversations.find((conversation) => conversation.id === conversationId)
        ?.defaultDirectory ?? null
    )
  })
  configureImageStorage(directory)
  // 注册会话存储接口
  ipcMain.handle('conversation:load', async (event) => {
    const owner = getIpcWindow(event, '不支持的读取来源', {
      windowMustBeLive: true,
      senderMustBeLive: true
    })
    const result = await conversationStore.load()
    if (result.ok) {
      try {
        await restoreConversationDirectories(
          owner.id,
          result.snapshot,
          () =>
            !owner.isDestroyed() &&
            !event.sender.isDestroyed() &&
            event.senderFrame === event.sender.mainFrame
        )
        rememberConversationImages(owner.id, result.snapshot)
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : '会话任务目录恢复失败' }
      }
    }
    return result
  })
  // 注册会话存储接口
  ipcMain.handle('conversation:save', async (event, snapshot: unknown) => {
    const owner = getIpcWindow(event, '不支持的保存来源', {
      windowMustBeLive: true,
      senderMustBeLive: true
    })
    if (hasSettingsMutation()) return { ok: false, error: '正在修改设置，请稍后保存会话' }
    saves.set(owner.id, (saves.get(owner.id) ?? 0) + 1)
    try {
      const checkpoint = captureImageSaveCheckpoint(owner.id)
      const result = await conversationStore.save(snapshot, async (checked) => {
        await checkConversationDirectorySave(owner.id, checked)
        await persistConversationImages(owner.id, checked)
        await checkConversationDirectorySave(owner.id, checked)
        if (
          owner.isDestroyed() ||
          event.sender.isDestroyed() ||
          event.senderFrame !== event.sender.mainFrame
        )
          throw new Error('会话保存来源已失效')
      })
      if (result.ok) {
        const checked = parseLibrary(snapshot)
        if (
          checked &&
          !owner.isDestroyed() &&
          !event.sender.isDestroyed() &&
          event.senderFrame === event.sender.mainFrame
        ) {
          commitConversationDirectorySave(owner.id, checked)
          rememberConversationImages(owner.id, checked, checkpoint)
        }
      }
      return result
    } finally {
      const remaining = (saves.get(owner.id) ?? 1) - 1
      if (remaining > 0) saves.set(owner.id, remaining)
      else saves.delete(owner.id)
    }
  })
}
