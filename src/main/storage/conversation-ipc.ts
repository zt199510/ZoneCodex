import { ipcMain } from 'electron'
import { getIpcWindow } from '../ipc-source'
import { createConversationStore } from './conversation-store'
import { parseLibrary } from '../../shared/conversation-library'
import {
  configureImageStorage,
  captureImageSaveCheckpoint,
  persistConversationImages,
  rememberConversationImages
} from '../project/image-access'

export function registerConversationStorage(directory: string): void {
  // 创建会话存储器
  const conversationStore = createConversationStore(directory)
  configureImageStorage(directory)
  // 注册会话存储接口
  ipcMain.handle('conversation:load', async (event) => {
    const owner = getIpcWindow(event, '不支持的读取来源')
    const result = await conversationStore.load()
    if (result.ok) rememberConversationImages(owner.id, result.snapshot)
    return result
  })
  // 注册会话存储接口
  ipcMain.handle('conversation:save', async (event, snapshot: unknown) => {
    const owner = getIpcWindow(event, '不支持的保存来源')
    const checkpoint = captureImageSaveCheckpoint(owner.id)
    const result = await conversationStore.save(snapshot, (checked) =>
      persistConversationImages(owner.id, checked)
    )
    if (result.ok) {
      const checked = parseLibrary(snapshot)
      if (checked) rememberConversationImages(owner.id, checked, checkpoint)
    }
    return result
  })
}
