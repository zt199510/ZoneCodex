import { app } from 'electron'
import { createHash } from 'node:crypto'
import { lstat, mkdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { AgentRequestContext } from '../../shared/project'
import type { ExecutionInfo, PermissionMode, PermissionsState } from '../../shared/execution'
import { decideLocalPermission, type LocalPermissionDecision } from '../../shared/permission-policy'
import { captureProjectAccess, captureWorkspaceAccess } from './project-access'
import { isAgentId } from '../../shared/agent'
import { requestExecutionApproval } from './execution-approval'

const settings = new Map<number, PermissionsState>()

export function getExecutionPermissionState(windowId: number): PermissionsState {
  return { ...(settings.get(windowId) ?? { mode: 'default', revision: 0 }) }
}

export function setExecutionPermissionMode(
  windowId: number,
  mode: PermissionMode
): PermissionsState {
  const current = getExecutionPermissionState(windowId)
  if (current.mode !== mode) {
    settings.set(windowId, { mode, revision: current.revision + 1 })
  }
  return getExecutionPermissionState(windowId)
}

export function clearExecutionPermissionState(windowId: number): void {
  settings.delete(windowId)
}

export function pathWithin(root: string, candidate: string): boolean {
  const offset = relative(resolve(root), resolve(candidate))
  return offset === '' || (!isAbsolute(offset) && offset !== '..' && !offset.startsWith(`..${sep}`))
}

async function defaultDirectory(conversationId: string): Promise<string> {
  const base = join(app.getPath('userData'), 'chats')
  await mkdir(base, { recursive: true })
  if ((await lstat(base)).isSymbolicLink()) throw new Error('默认运行目录不能是符号链接')
  const canonicalBase = await realpath(base)
  const conversationDirectory = join(canonicalBase, conversationId)
  await mkdir(conversationDirectory, { recursive: true })
  if ((await lstat(conversationDirectory)).isSymbolicLink()) {
    throw new Error('会话运行目录不能是符号链接')
  }
  const directory = join(conversationDirectory, 'workspace')
  await mkdir(directory, { recursive: true })
  if ((await lstat(directory)).isSymbolicLink()) throw new Error('默认运行目录不能是符号链接')
  const canonical = await realpath(directory)
  if (!pathWithin(canonicalBase, canonical) || canonical !== resolve(directory)) {
    throw new Error('默认运行目录已变化')
  }
  return canonical
}

export type ExecutionContext = {
  info: ExecutionInfo
  writableRoots: readonly string[]
}

export async function resolveExecutionContext(
  windowId: number,
  context: AgentRequestContext
): Promise<ExecutionContext> {
  if (!isAgentId(context.conversationId)) throw new Error('会话 ID 无效')
  const workspace = context.workspaceId
    ? captureWorkspaceAccess(windowId, context.conversationId)
    : null
  if (context.workspaceId && workspace?.workspaceId !== context.workspaceId) {
    throw new Error('工作区授权已失效，请重新选择文件夹')
  }
  if (
    context.attachment &&
    !captureProjectAccess(windowId, context.conversationId, context.attachment.snapshotId)
  ) {
    throw new Error('附件授权已失效')
  }
  const cwd = workspace
    ? await realpath(workspace.root)
    : await defaultDirectory(context.conversationId)
  const info = await lstat(cwd)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('运行目录无效')
  if (workspace) {
    const current = captureWorkspaceAccess(windowId, context.conversationId)
    if (current?.workspaceId !== workspace.workspaceId || current.root !== cwd) {
      throw new Error('工作区授权已失效，请重新选择文件夹')
    }
  }
  if (
    context.attachment &&
    !captureProjectAccess(windowId, context.conversationId, context.attachment.snapshotId)
  ) {
    throw new Error('附件授权已失效')
  }
  const permissions = getExecutionPermissionState(windowId)
  const writableRoots = [cwd]
  const scopeId = createHash('sha256')
    .update(
      JSON.stringify({
        cwd,
        ...permissions,
        writableRoots,
        workspaceId: context.workspaceId ?? null
      })
    )
    .digest('hex')
  return { info: { cwd, scopeId, ...permissions }, writableRoots }
}

export function executionStillCurrent(
  windowId: number,
  context: AgentRequestContext,
  execution: ExecutionContext
): boolean {
  const current = getExecutionPermissionState(windowId)
  if (current.mode !== execution.info.mode || current.revision !== execution.info.revision)
    return false
  if (context.workspaceId) {
    const workspace = captureWorkspaceAccess(windowId, context.conversationId)
    if (workspace?.workspaceId !== context.workspaceId || workspace.root !== execution.info.cwd)
      return false
  }
  return (
    !context.attachment ||
    !!captureProjectAccess(windowId, context.conversationId, context.attachment.snapshotId)
  )
}

export function localPermission(
  execution: ExecutionContext,
  operation: 'read' | 'write' | 'command',
  target: string
): LocalPermissionDecision {
  return decideLocalPermission({
    operation,
    mode: execution.info.mode,
    withinWritableRoots: execution.writableRoots.some((root) => pathWithin(root, target)),
    sandboxAvailable: false
  })
}

/** Legacy npm execution shares the same setting, without treating old preparation as approval. */
export async function approveStandaloneCommand(
  windowId: number,
  request: {
    requestId: string
    conversationId: string
    cwd: string
    program: string
    args: string[]
  },
  signal: AbortSignal
): Promise<boolean> {
  signal.throwIfAborted()
  const state = getExecutionPermissionState(windowId)
  const decision = decideLocalPermission({
    operation: 'command',
    mode: state.mode,
    withinWritableRoots: true,
    sandboxAvailable: false
  })
  if (decision === 'allow') return true
  if (decision === 'deny') return false
  const approved = await requestExecutionApproval(windowId, { ...request, kind: 'command' }, signal)
  const current = getExecutionPermissionState(windowId)
  return (
    !signal.aborted &&
    current.mode === state.mode &&
    current.revision === state.revision &&
    approved
  )
}
