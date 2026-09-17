import { BrowserWindow, ipcMain } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { parsePreviewChangeRequest, type PreviewChangeResult } from '../../shared/change-preview'
import { hasAgentJob } from './agent-ipc'
import { captureProjectAccess, hasProjectSelection } from './project-access'
import { buildChangePreview } from '../tools/change-preview'

function ownerOf(event: IpcMainInvokeEvent): BrowserWindow {
  const owner = BrowserWindow.fromWebContents(event.sender)
  if (!owner || owner.isDestroyed() || event.senderFrame !== event.sender.mainFrame) {
    throw new Error('不支持的修改预览来源')
  }
  return owner
}

function resultError(error: string): PreviewChangeResult {
  return { status: 'error', error: error.slice(0, 500) }
}

export function registerChangePreview(): void {
  ipcMain.handle('preview:change', (event, value: unknown): PreviewChangeResult => {
    const owner = ownerOf(event)
    const request = parsePreviewChangeRequest(value)
    if (!request) return resultError('修改预览请求格式不正确')

    const windowId = owner.id
    if (hasAgentJob(windowId) || hasProjectSelection(windowId)) {
      return resultError('请先完成当前操作')
    }

    const snapshot = captureProjectAccess(windowId, request.conversationId, request.snapshotId)
    if (!snapshot) return resultError('项目快照授权已失效')

    try {
      return { status: 'ready', preview: buildChangePreview(request, snapshot) }
    } catch (error) {
      return resultError(error instanceof Error ? error.message : '无法生成修改预览')
    }
  })
}
