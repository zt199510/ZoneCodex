import { dialog } from 'electron'
import type { BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { isAgentId } from '../../shared/agent'
import type {
  ProjectInstruction,
  Workspace,
  WorkspaceInstructionResult,
  WorkspaceSelectionResult
} from '../../shared/project'
import { readProjectInstruction, workspaceLabel } from './project-instruction'

type WorkspaceAccessCallbacks = {
  isAgentJobActive: (windowId: number) => boolean
  hasProjectSelection: (windowId: number) => boolean
}
let callbacks: WorkspaceAccessCallbacks = {
  isAgentJobActive: () => false,
  hasProjectSelection: () => false
}

export function configureWorkspaceAccess(next: WorkspaceAccessCallbacks): void {
  callbacks = next
}

type SelectionState = { token: string; controller: AbortController }
type WorkspaceGrant = {
  windowId: number
  conversationId: string
  workspace: Workspace
}

const workspaceGrants = new Map<number, Map<string, WorkspaceGrant>>()
const workspaceSelections = new Map<number, SelectionState>()

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
  if (callbacks.isAgentJobActive(windowId))
    return workspaceResultError('当前操作进行中，请稍后再选择工作区')
  if (callbacks.hasProjectSelection(windowId))
    return workspaceResultError('文件选择进行中，请稍后再选择工作区')
  if (workspaceSelections.has(windowId))
    return workspaceResultError('工作区选择进行中，请先完成当前选择')

  const state: SelectionState = { token: operationId, controller: new AbortController() }
  workspaceSelections.set(windowId, state)
  try {
    const picked = await dialog.showOpenDialog(window, {
      title: '选择供 Agent 搜索和读取的工作区（修改与命令另行确认）',
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
  if (
    callbacks.isAgentJobActive(windowId) ||
    callbacks.hasProjectSelection(windowId) ||
    workspaceSelections.has(windowId)
  ) {
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
  if (
    callbacks.isAgentJobActive(windowId) ||
    callbacks.hasProjectSelection(windowId) ||
    workspaceSelections.has(windowId)
  ) {
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

export function hasWorkspaceSelection(windowId: number): boolean {
  return workspaceSelections.has(windowId)
}

export function captureWorkspaceAccess(windowId: number, conversationId: string): Workspace | null {
  const grant = workspaceGrantFor(windowId, conversationId)
  if (!grant || workspaceSelections.has(windowId)) return null
  return cloneWorkspace(grant.workspace)
}

export function cleanupWorkspaceAccess(windowId: number): void {
  const selection = workspaceSelections.get(windowId)
  if (selection) {
    selection.controller.abort()
    workspaceSelections.delete(windowId)
  }
  workspaceGrants.delete(windowId)
}
