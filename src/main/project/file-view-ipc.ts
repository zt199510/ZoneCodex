import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import {
  isAbsoluteFilePath,
  parseFileViewRequest,
  type FileViewResult
} from '../../shared/file-view'
import { getIpcWindow } from '../ipc-source'
import {
  executionStillCurrent,
  localPermission,
  resolveExecutionContext
} from '../execution/execution-context'
import { captureWorkspaceAccess } from './workspace-access'
import { captureProjectAccess } from './attachment-access'
import { fileViewError, readLocalFileView, readSnapshotFileView } from '../tools/file-view'

const windowSessions = new Map<number, symbol>()

export function attachFileViewCleanup(window: BrowserWindow): void {
  window.webContents.on('did-start-loading', () => windowSessions.delete(window.id))
  window.on('closed', () => windowSessions.delete(window.id))
}

export function registerFileView(): void {
  ipcMain.handle(
    'project:read-file-view',
    async (event, value: unknown): Promise<FileViewResult> => {
      const window = getIpcWindow(event, '不支持的文件查看来源', {
        windowMustBeLive: true,
        senderMustBeLive: true
      })
      const request = parseFileViewRequest(value)
      if (!request) throw new Error('文件查看请求格式不正确')
      const session = windowSessions.get(window.id) ?? Symbol()
      windowSessions.set(window.id, session)
      const assertWindow = (): void => {
        if (
          window.isDestroyed() ||
          event.sender.isDestroyed() ||
          event.senderFrame !== event.sender.mainFrame ||
          windowSessions.get(window.id) !== session
        )
          throw new Error('当前页面已变化，请重新打开文件')
      }
      try {
        assertWindow()
        const source = request.source
        if (source.kind === 'snapshot') {
          const snapshot = captureProjectAccess(
            window.id,
            request.conversationId,
            source.snapshotId
          )
          if (!snapshot) throw new Error('已选文件快照已失效，请重新选择文件')
          const content = readSnapshotFileView(snapshot, request.reference.path)
          assertWindow()
          if (
            captureProjectAccess(window.id, request.conversationId, source.snapshotId) !== snapshot
          )
            throw new Error('已选文件快照已变化，请重新打开')
          return { ...request, status: 'ready', ...content }
        }
        // Omitting a currently selected workspace must not reinterpret relative paths in the default cwd.
        const workspace = captureWorkspaceAccess(window.id, request.conversationId)
        if ((workspace?.workspaceId ?? undefined) !== source.workspaceId)
          throw new Error('工作区上下文已变化，请重新打开文件')
        const context = {
          conversationId: request.conversationId,
          mode: 'plan' as const,
          ...(source.workspaceId ? { workspaceId: source.workspaceId } : {})
        }
        const execution = await resolveExecutionContext(window.id, context)
        assertWindow()
        if (
          !isAbsoluteFilePath(request.reference.path) &&
          source.executionId !== execution.info.scopeId
        )
          throw new Error('此相对路径的运行上下文已失效，无法定位文件')
        const assertAccess = (target?: string): void => {
          assertWindow()
          if (
            !executionStillCurrent(window.id, context, execution) ||
            (captureWorkspaceAccess(window.id, request.conversationId)?.workspaceId ??
              undefined) !== source.workspaceId
          )
            throw new Error('运行上下文已变化，请重新打开文件')
          if (target && localPermission(execution, 'read', target) !== 'allow')
            throw new Error('当前读取权限无法查看此文件')
        }
        const content = await readLocalFileView(
          execution.info.cwd,
          request.reference.path,
          assertAccess
        )
        assertAccess(content.path)
        return { ...request, status: 'ready', ...content }
      } catch (error) {
        return { ...request, status: 'error', error: fileViewError(error) }
      }
    }
  )
}
