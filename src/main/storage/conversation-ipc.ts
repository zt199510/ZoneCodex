import { ipcMain } from 'electron'
import { getIpcWindow } from '../ipc-source'
import { createConversationStore } from './conversation-store'

export function registerConversationStorage(directory: string): void {
  // 创建会话存储器
  const conversationStore = createConversationStore(directory)
  // 注册会话存储接口
  ipcMain.handle('conversation:load', (event) => {
    getIpcWindow(event, '不支持的读取来源')
    return conversationStore.load()
  })
  // 注册会话存储接口
  ipcMain.handle('conversation:save', (event, snapshot: unknown) => {
    getIpcWindow(event, '不支持的保存来源')
    return conversationStore.save(snapshot)
  })
}
