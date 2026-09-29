import { BrowserWindow, dialog, ipcMain } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { isAgentId } from '../../shared/agent'
import type {
  ProjectSelection,
  ProjectSelectionResult,
  ProjectInstruction,
  Workspace,
  WorkspaceInstructionResult,
  WorkspaceSelectionResult
} from '../../shared/project'
import { AgentError } from './tool-loop'
import { createAttachmentSnapshot, removeAttachment } from '../tools/project-snapshot'
import type { ProjectSnapshot } from '../tools/project-snapshot'
import { readProjectInstruction, workspaceLabel } from './project-instruction'

export type ProjectAccessCallbacks = {
  isAgentJobActive: (windowId: number) => boolean
  abortProjectJob: (windowId: number, snapshotId: string) => void
  onAccessChanged?: (windowId: number, snapshotId?: string) => void
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

type WorkspaceGrant = {
  windowId: number
  conversationId: string
  workspace: Workspace
}

const grants = new Map<number, Grant>()
const selections = new Map<number, SelectionState>()
const workspaceGrants = new Map<number, Map<string, WorkspaceGrant>>()
const workspaceSelections = new Map<number, SelectionState>()
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

function workspaceResultError(error: string): WorkspaceSelectionResult {
  return { status: 'error', error: error.slice(0, 500) }
}

function cloneInstruction(instruction: ProjectInstruction): ProjectInstruction {
  return {
    path: instruction.path,
    content: instruction.content,
    fingerprint: instruction.fingerprint,
    truncated: instruction.truncated
  }
}

function cloneWorkspace(workspace: Workspace): Workspace {
  return {
    workspaceId: workspace.workspaceId,
    root: workspace.root,
    label: workspace.label,
    snapshotId: workspace.snapshotId,
    instruction: workspace.instruction ? cloneInstruction(workspace.instruction) : null
  }
}

function workspaceGrantFor(windowId: number, conversationId: string): WorkspaceGrant | null {
  return workspaceGrants.get(windowId)?.get(conversationId) ?? null
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

function isWorkspaceCurrent(
  windowId: number,
  state: SelectionState,
  window: BrowserWindow
): boolean {
  return (
    workspaceSelections.get(windowId) === state &&
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
      if (
        callbacks.isAgentJobActive(owner.id) ||
        selections.has(owner.id) ||
        workspaceSelections.has(owner.id)
      )
        return resultError('请等待当前操作结束')
      const grant = grants.get(owner.id)
      if (!grant || grant.conversationId !== conversationId || grant.snapshotId !== snapshotId)
        return resultError('附件授权已失效')
      try {
        const snapshot = removeAttachment(grant.snapshot, path)
        callbacks.onAccessChanged?.(owner.id, snapshotId)
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
    if (
      !isAgentId(snapshotId) ||
      selections.has(owner.id) ||
      workspaceSelections.has(owner.id) ||
      callbacks.isAgentJobActive(owner.id)
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
  if (workspaceSelections.has(windowId)) return resultError('工作区选择进行中，请先完成当前选择')

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

    callbacks.onAccessChanged?.(windowId, previous?.snapshotId)
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

export async function selectWorkspace(
  window: BrowserWindow,
  conversationId: string,
  operationId: string
): Promise<WorkspaceSelectionResult> {
  const windowId = window.id
  if (!isAgentId(conversationId)) return workspaceResultError('会话 ID 无效')
  if (!isAgentId(operationId)) return workspaceResultError('操作 ID 无效')
  if (window.isDestroyed() || window.webContents.isDestroyed()) {
    return workspaceResultError('窗口已经关闭')
  }
  if (callbacks.isAgentJobActive(windowId)) return workspaceResultError('当前操作进行中，请稍后再选择工作区')
  if (selections.has(windowId)) return workspaceResultError('文件选择进行中，请稍后再选择工作区')
  if (workspaceSelections.has(windowId)) return workspaceResultError('工作区选择进行中，请先完成当前选择')

  const state: SelectionState = { token: operationId, controller: new AbortController() }
  workspaceSelections.set(windowId, state)
  try {
    const picked = await dialog.showOpenDialog(window, {
      title: '选择工作区文件夹',
      properties: ['openDirectory', 'dontAddToRecent']
    })
    if (!isWorkspaceCurrent(windowId, state, window)) return { status: 'cancelled' }
    if (picked.canceled || !picked.filePaths[0]) return { status: 'cancelled' }

    let root: string
    try {
      root = await realpath(resolve(picked.filePaths[0]))
      if (!(await stat(root)).isDirectory()) return workspaceResultError('所选路径不是文件夹')
    } catch {
      return workspaceResultError('工作区目录无效')
    }
    if (!isWorkspaceCurrent(windowId, state, window)) return { status: 'cancelled' }

    const instructionResult = await readProjectInstruction(root)
    if (!isWorkspaceCurrent(windowId, state, window)) return { status: 'cancelled' }
    if (instructionResult.status === 'error') return workspaceResultError(instructionResult.error)

    const workspace: Workspace = {
      workspaceId: randomUUID(),
      root,
      label: workspaceLabel(root),
      snapshotId: null,
      instruction:
        instructionResult.status === 'read' ? cloneInstruction(instructionResult.instruction) : null
    }
    const grantsForWindow = workspaceGrants.get(windowId) ?? new Map<string, WorkspaceGrant>()
    grantsForWindow.set(conversationId, { windowId, conversationId, workspace })
    workspaceGrants.set(windowId, grantsForWindow)
    return { status: 'selected', workspace: cloneWorkspace(workspace) }
  } catch {
    if (!isWorkspaceCurrent(windowId, state, window)) return { status: 'cancelled' }
    return workspaceResultError('工作区选择失败，请重新选择')
  } finally {
    if (workspaceSelections.get(windowId) === state) workspaceSelections.delete(windowId)
  }
}

export function clearWorkspace(windowId: number, conversationId: string): boolean {
  if (!isAgentId(conversationId)) return false
  if (callbacks.isAgentJobActive(windowId) || selections.has(windowId) || workspaceSelections.has(windowId)) {
    return false
  }
  const grantsForWindow = workspaceGrants.get(windowId)
  const grant = grantsForWindow?.get(conversationId)
  if (!grant) return true
  grantsForWindow?.delete(conversationId)
  if (grantsForWindow && grantsForWindow.size === 0) workspaceGrants.delete(windowId)
  return true
}

export async function readWorkspaceInstruction(
  windowId: number,
  conversationId: string
): Promise<WorkspaceInstructionResult> {
  if (!isAgentId(conversationId)) return { status: 'error', error: '会话 ID 无效' }
  if (callbacks.isAgentJobActive(windowId) || selections.has(windowId) || workspaceSelections.has(windowId)) {
    return { status: 'error', error: '当前操作进行中，请稍后再读取工作区指令' }
  }
  const grant = workspaceGrantFor(windowId, conversationId)
  if (!grant) {
    return { status: 'error', error: '工作区授权已失效，请重新选择文件夹' }
  }
  const result = await readProjectInstruction(grant.workspace.root)
  if (result.status === 'read') {
    grant.workspace.instruction = cloneInstruction(result.instruction)
  } else if (result.status === 'absent') {
    grant.workspace.instruction = null
  }
  return result
}

export function hasProjectSelection(windowId: number): boolean {
  return selections.has(windowId)
}

export function hasWorkspaceSelection(windowId: number): boolean {
  return workspaceSelections.has(windowId)
}

export function captureWorkspaceAccess(windowId: number, conversationId: string): Workspace | null {
  const grant = workspaceGrantFor(windowId, conversationId)
  if (!grant || workspaceSelections.has(windowId)) return null
  return cloneWorkspace(grant.workspace)
}

export function hasProjectSnapshot(windowId: number, snapshotId: string): boolean {
  const grant = grants.get(windowId)
  return !!grant && !selections.has(windowId) && grant.snapshotId === snapshotId
}

export function captureProjectAccess(
  windowId: number,
  conversationId: string,
  snapshotId: string
): ProjectSnapshot | null {
  const grant = grants.get(windowId)
  if (
    selections.has(windowId) ||
    workspaceSelections.has(windowId) ||
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
  callbacks.onAccessChanged?.(windowId, snapshotId)
  callbacks.abortProjectJob(windowId, snapshotId)
  return true
}

export function cleanupProjectAccess(windowId: number): void {
  callbacks.onAccessChanged?.(windowId, grants.get(windowId)?.snapshotId)
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
  const workspaceSelection = workspaceSelections.get(windowId)
  if (workspaceSelection) {
    workspaceSelection.controller.abort()
    workspaceSelections.delete(windowId)
  }
  workspaceGrants.delete(windowId)
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
