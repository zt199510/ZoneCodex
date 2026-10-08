import { createHash } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { AgentRequestContext } from '../../shared/project'
import type { ExecutionInfo } from '../../shared/execution'
import { decideLocalPermission, type LocalPermissionDecision } from '../../shared/permission-policy'
import { captureProjectAccess } from '../project/attachment-access'
import { captureWorkspaceAccess } from '../project/workspace-access'
import { isAgentId } from '../../shared/agent'
import { getExecutionPermissionState } from './permission-state'
import { getAppSettings } from '../settings/settings-service'
import {
  captureConversationDirectory,
  validateConversationDirectory
} from '../settings/conversation-directory'

export function pathWithin(root: string, candidate: string): boolean {
  const offset = relative(resolve(root), resolve(candidate))
  return offset === '' || (!isAbsolute(offset) && offset !== '..' && !offset.startsWith(`..${sep}`))
}

export type ExecutionContext = {
  info: ExecutionInfo
  writableRoots: readonly string[]
}

export async function resolveExecutionContext(
  windowId: number,
  context: AgentRequestContext
): Promise<ExecutionContext> {
  getAppSettings()
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
  const boundDirectory = captureConversationDirectory(windowId, context.conversationId)
  if (!boundDirectory) throw new Error('会话任务目录尚未保存，请重新保存会话后发送')
  const cwd = workspace
    ? await realpath(workspace.root)
    : await validateConversationDirectory(context.conversationId, boundDirectory).catch((error) => {
        if (error instanceof Error && error.message.startsWith('会话')) throw error
        throw new Error('会话任务目录不可访问，请恢复原文件夹或检查权限后重试')
      })
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
  if (captureConversationDirectory(windowId, context.conversationId) !== boundDirectory)
    throw new Error('会话任务目录绑定已失效')
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
  if (!captureConversationDirectory(windowId, context.conversationId)) return false
  const current = getExecutionPermissionState(windowId)
  if (current.mode !== execution.info.mode || current.revision !== execution.info.revision)
    return false
  if (context.workspaceId) {
    const workspace = captureWorkspaceAccess(windowId, context.conversationId)
    if (workspace?.workspaceId !== context.workspaceId || workspace.root !== execution.info.cwd)
      return false
  } else if (
    captureConversationDirectory(windowId, context.conversationId) !== execution.info.cwd
  ) {
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
