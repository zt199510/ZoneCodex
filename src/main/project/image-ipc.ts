import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import { isAgentId } from '../../shared/agent'
import { parseImageImportRequest } from '../../shared/image-input'
import { getIpcWindow } from '../ipc-source'
import {
  selectImage,
  importImage,
  readImagePreview,
  prepareImage,
  revokeImage,
  revokeConversationImages,
  cleanupImageAccess
} from './image-access'

export function registerImageAccess(): void {
  const ownerOf = (event: Electron.IpcMainInvokeEvent): BrowserWindow =>
    getIpcWindow(event, '不支持的图片操作来源', { windowMustBeLive: true, senderMustBeLive: true })
  const invalid = (): { status: 'error'; error: string } => ({
    status: 'error',
    error: '图片操作参数无效'
  })
  ipcMain.handle('image:select', (event, conversationId: unknown) => {
    const owner = ownerOf(event)
    return isAgentId(conversationId) ? selectImage(owner, conversationId) : invalid()
  })
  ipcMain.handle('image:import', (event, conversationId: unknown, request: unknown) => {
    const owner = ownerOf(event)
    const checked = parseImageImportRequest(request)
    return isAgentId(conversationId) && checked
      ? importImage(owner, conversationId, checked)
      : invalid()
  })
  ipcMain.handle('image:preview', (event, conversationId: unknown, imageId: unknown) => {
    const owner = ownerOf(event)
    return isAgentId(conversationId) && isAgentId(imageId)
      ? readImagePreview(owner.id, conversationId, imageId)
      : invalid()
  })
  ipcMain.handle('image:prepare', (event, conversationId: unknown, imageId: unknown) => {
    const owner = ownerOf(event)
    return isAgentId(conversationId) && isAgentId(imageId)
      ? prepareImage(owner.id, conversationId, imageId)
      : invalid()
  })
  ipcMain.handle('image:revoke', (event, conversationId: unknown, imageId: unknown) => {
    const owner = ownerOf(event)
    return isAgentId(conversationId) && isAgentId(imageId)
      ? revokeImage(owner.id, conversationId, imageId)
      : false
  })
  ipcMain.handle('image:revoke-conversation', (event, conversationId: unknown) => {
    const owner = ownerOf(event)
    return isAgentId(conversationId) ? revokeConversationImages(owner.id, conversationId) : false
  })
}

export function attachImageAccessCleanup(window: BrowserWindow): void {
  const owner = window.webContents
  const cleanup = (): void => cleanupImageAccess(window.id)
  const remove = (): void => {
    owner.removeListener('did-start-loading', cleanup)
    owner.removeListener('render-process-gone', cleanup)
  }
  owner.on('did-start-loading', cleanup)
  owner.on('render-process-gone', cleanup)
  owner.once('destroyed', () => {
    cleanup()
    remove()
  })
  window.once('closed', () => {
    cleanupImageAccess(window.id, true)
    remove()
  })
}
