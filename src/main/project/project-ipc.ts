import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import { isAgentId } from '../../shared/agent'
import type { WorkspaceInstructionResult, WorkspaceSelectionResult } from '../../shared/project'
import { getIpcWindow } from '../ipc-source'
import { hasImageSelection } from './image-access'
import {
  configureAttachmentAccess,
  hasProjectSelection,
  selectProjectFiles,
  removeProjectFile,
  revokeProjectFiles,
  cleanupAttachmentAccess
} from './attachment-access'
import {
  configureWorkspaceAccess,
  hasWorkspaceSelection,
  selectWorkspace,
  clearWorkspace,
  readWorkspaceInstruction,
  cleanupWorkspaceAccess
} from './workspace-access'

export type ProjectAccessCallbacks = {
  isAgentJobActive: (windowId: number) => boolean
  abortProjectJob: (windowId: number, snapshotId: string) => void
  onAccessChanged?: (windowId: number, snapshotId?: string) => void
}

export function registerProjectAccess(nextCallbacks: ProjectAccessCallbacks): void {
  configureAttachmentAccess({
    ...nextCallbacks,
    hasWorkspaceSelection: (id) => hasWorkspaceSelection(id) || hasImageSelection(id)
  })
  configureWorkspaceAccess({
    isAgentJobActive: nextCallbacks.isAgentJobActive,
    hasProjectSelection: (id) => hasProjectSelection(id) || hasImageSelection(id)
  })
  const ownerOf = (event: Electron.IpcMainInvokeEvent): BrowserWindow =>
    getIpcWindow(event, '不支持的项目选择来源', { windowMustBeLive: true })
  const resultError = (error: string): { status: 'error'; error: string } => ({
    status: 'error',
    error: error.slice(0, 500)
  })
  const workspaceResultError = resultError
  ipcMain.handle(
    'project:select',
    (event, conversationId: unknown, replaceExisting: unknown = false) => {
      const owner = ownerOf(event)
      if (!isAgentId(conversationId)) return resultError('会话 ID 无效')
      if (typeof replaceExisting !== 'boolean') return resultError('附件选择参数无效')
      return selectProjectFiles(owner, conversationId, replaceExisting)
    }
  )
  ipcMain.handle(
    'project:remove',
    (event, conversationId: unknown, snapshotId: unknown, path: unknown) => {
      const owner = ownerOf(event)
      if (
        !isAgentId(conversationId) ||
        !isAgentId(snapshotId) ||
        typeof path !== 'string' ||
        path.length > 240
      ) {
        return resultError('附件参数无效')
      }
      return removeProjectFile(owner.id, conversationId, snapshotId, path)
    }
  )
  ipcMain.handle('project:revoke', (event, snapshotId: unknown): boolean => {
    const owner = ownerOf(event)
    if (
      !isAgentId(snapshotId) ||
      hasProjectSelection(owner.id) ||
      hasWorkspaceSelection(owner.id) ||
      hasImageSelection(owner.id) ||
      nextCallbacks.isAgentJobActive(owner.id)
    )
      return false
    return revokeProjectFiles(owner.id, snapshotId)
  })
  ipcMain.handle(
    'workspace:select',
    (event, conversationId: unknown, operationId: unknown): Promise<WorkspaceSelectionResult> => {
      const owner = ownerOf(event)
      if (!isAgentId(conversationId)) return Promise.resolve(workspaceResultError('会话 ID 无效'))
      if (!isAgentId(operationId)) return Promise.resolve(workspaceResultError('操作 ID 无效'))
      return selectWorkspace(owner, conversationId, operationId)
    }
  )
  ipcMain.handle('workspace:clear', (event, conversationId: unknown): boolean => {
    const owner = ownerOf(event)
    if (!isAgentId(conversationId)) return false
    return clearWorkspace(owner.id, conversationId)
  })
  ipcMain.handle(
    'workspace:instruction',
    async (event, conversationId: unknown): Promise<WorkspaceInstructionResult> => {
      const owner = ownerOf(event)
      if (!isAgentId(conversationId)) return { status: 'error', error: '会话 ID 无效' }
      return readWorkspaceInstruction(owner.id, conversationId)
    }
  )
}

export function cleanupProjectAccess(windowId: number): void {
  cleanupAttachmentAccess(windowId)
  cleanupWorkspaceAccess(windowId)
}

export function attachProjectAccessCleanup(window: BrowserWindow): void {
  const owner = window.webContents
  const cleanup = (): void => cleanupProjectAccess(window.id)
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
    cleanup()
    remove()
  })
}
