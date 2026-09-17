import { BrowserWindow, dialog, ipcMain } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import { isAgentId } from '../../shared/agent'
import type { ProjectSelection, ProjectSelectionResult } from '../../shared/project'
import { AgentError } from './tool-loop'
import { createAttachmentSnapshot, removeAttachment } from '../tools/project-snapshot'
import type { ProjectSnapshot } from '../tools/project-snapshot'

export type ProjectAccessCallbacks = {
  isAgentJobActive: (windowId: number) => boolean
  abortProjectJob: (windowId: number, snapshotId: string) => void
  onAccessChanged?: (windowId: number) => void
}

type Grant = {
  windowId: number
  conversationId: string
  snapshotId: string
  snapshot: ProjectSnapshot
}

type SelectionState = {
  token: string
  controller: AbortController
}

const grants = new Map<number, Grant>()
const selections = new Map<number, SelectionState>()
let callbacks: ProjectAccessCallbacks = {
  isAgentJobActive: () => false,
  abortProjectJob: () => undefined
}

function cloneSelection(selection: ProjectSelection): ProjectSelection {
  return {
    snapshotId: selection.snapshotId,
    label: selection.label,
    createdAt: selection.createdAt,
    files: selection.files.map((file) => ({ ...file }))
  }
}

function resultError(error: string): ProjectSelectionResult {
  return { status: 'error', error: error.slice(0, 500) }
}

function ownerOf(event: IpcMainInvokeEvent): BrowserWindow {
  const owner = BrowserWindow.fromWebContents(event.sender)
  if (!owner || owner.isDestroyed() || event.senderFrame !== event.sender.mainFrame) {
    throw new Error('不支持的项目选择来源')
  }
  return owner
}

function isCurrent(windowId: number, state: SelectionState, window: BrowserWindow): boolean {
  return (
    selections.get(windowId) === state &&
    !state.controller.signal.aborted &&
    !window.isDestroyed() &&
    !window.webContents.isDestroyed()
  )
}

export function registerProjectAccess(nextCallbacks: ProjectAccessCallbacks): void {
  callbacks = nextCallbacks
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
      if (callbacks.isAgentJobActive(owner.id) || selections.has(owner.id))
        return resultError('请等待当前操作结束')
      const grant = grants.get(owner.id)
      if (!grant || grant.conversationId !== conversationId || grant.snapshotId !== snapshotId)
        return resultError('附件授权已失效')
      try {
        const snapshot = removeAttachment(grant.snapshot, path)
        callbacks.onAccessChanged?.(owner.id)
        if (!snapshot) {
          grants.delete(owner.id)
          return { status: 'cleared' }
        }
        grants.set(owner.id, { ...grant, snapshot, snapshotId: snapshot.selection.snapshotId })
        return { status: 'selected', selection: cloneSelection(snapshot.selection) }
      } catch {
        return resultError('无法移除附件，请重新选择')
      }
    }
  )
  ipcMain.handle('project:revoke', (event, snapshotId: unknown): boolean => {
    const owner = ownerOf(event)
    if (!isAgentId(snapshotId) || selections.has(owner.id) || callbacks.isAgentJobActive(owner.id))
      return false
    return revokeProjectFiles(owner.id, snapshotId)
  })
}

export async function selectProjectFiles(
  window: BrowserWindow,
  conversationId: string,
  replaceExisting = false
): Promise<ProjectSelectionResult> {
  const windowId = window.id
  if (!isAgentId(conversationId)) return resultError('会话 ID 无效')
  if (window.isDestroyed() || window.webContents.isDestroyed()) {
    return resultError('窗口已经关闭')
  }
  if (callbacks.isAgentJobActive(windowId)) return resultError('工具任务进行中，请稍后再选择文件')
  if (selections.has(windowId)) return resultError('文件选择进行中，请先完成当前选择')

  const previous = grants.get(windowId)
  if (previous && previous.conversationId !== conversationId)
    return resultError('请先清除其他会话的附件')

  const state: SelectionState = { token: randomUUID(), controller: new AbortController() }
  selections.set(windowId, state)
  try {
    const fileResult = await dialog.showOpenDialog(window, {
      title: '添加文本文件（可多选）',
      properties: ['openFile', 'multiSelections', 'dontAddToRecent'],
      filters: [
        {
          name: '文本和代码',
          extensions: ['md', 'txt', 'ts', 'tsx', 'js', 'jsx', 'json', 'css', 'html']
        }
      ]
    })
    if (!isCurrent(windowId, state, window)) return { status: 'cancelled' }
    if (fileResult.canceled || fileResult.filePaths.length < 1) return { status: 'cancelled' }

    const snapshot = await createAttachmentSnapshot(
      fileResult.filePaths,
      state.controller.signal,
      replaceExisting ? undefined : previous?.snapshot
    )
    if (!isCurrent(windowId, state, window)) return { status: 'cancelled' }

    callbacks.onAccessChanged?.(windowId)
    grants.set(windowId, {
      windowId,
      conversationId,
      snapshotId: snapshot.selection.snapshotId,
      snapshot
    })
    return { status: 'selected', selection: cloneSelection(snapshot.selection) }
  } catch (error) {
    if (!isCurrent(windowId, state, window)) return { status: 'cancelled' }
    if (error instanceof AgentError) return resultError(error.message)
    return resultError('项目文件选择失败，请重新选择')
  } finally {
    if (selections.get(windowId) === state) selections.delete(windowId)
  }
}

export function hasProjectSelection(windowId: number): boolean {
  return selections.has(windowId)
}

export function captureProjectAccess(
  windowId: number,
  conversationId: string,
  snapshotId: string
): ProjectSnapshot | null {
  const grant = grants.get(windowId)
  if (
    selections.has(windowId) ||
    !grant ||
    grant.windowId !== windowId ||
    grant.conversationId !== conversationId ||
    grant.snapshotId !== snapshotId
  ) {
    return null
  }
  return grant.snapshot
}

export function revokeProjectFiles(windowId: number, snapshotId: string): boolean {
  const grant = grants.get(windowId)
  if (!grant || grant.snapshotId !== snapshotId) return false
  grants.delete(windowId)
  callbacks.onAccessChanged?.(windowId)
  callbacks.abortProjectJob(windowId, snapshotId)
  return true
}

export function cleanupProjectAccess(windowId: number): void {
  callbacks.onAccessChanged?.(windowId)
  const selection = selections.get(windowId)
  if (selection) {
    selection.controller.abort()
    selections.delete(windowId)
  }
  const grant = grants.get(windowId)
  if (grant) {
    grants.delete(windowId)
    callbacks.abortProjectJob(windowId, grant.snapshotId)
  }
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
