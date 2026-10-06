import { getIpcWindow } from '../ipc-source'
import { BrowserWindow, ipcMain } from 'electron'
import { parsePreviewChangeRequest, type PreviewChangeResult } from '../../shared/change-preview'
import { captureProjectAccess } from '../project/attachment-access'
import { buildChangePreview } from '../tools/change-preview'

function ownerOf(event: Electron.IpcMainInvokeEvent): BrowserWindow {
  return getIpcWindow(event, '不支持的修改预览来源', { windowMustBeLive: true })
}

function resultError(error: string): PreviewChangeResult {
  return { status: 'error', error: error.slice(0, 500) }
}

export function registerChangePreview(isBusy: (windowId: number) => boolean = () => false): void {
  ipcMain.handle('preview:change', (event, value: unknown): PreviewChangeResult => {
    const owner = ownerOf(event)
    const request = parsePreviewChangeRequest(value)
    if (!request) return resultError('修改预览请求格式不正确')

    const windowId = owner.id
    if (isBusy(windowId)) {
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
