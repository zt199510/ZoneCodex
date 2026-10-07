import type { ExecutionApprovalInput } from '../../shared/execution'
import { createHash } from 'node:crypto'
import type { WorkspaceApprovalRequest, WorkspaceApprove } from '../tools/workspace-actions'
import { localPermission, type ExecutionContext } from './execution-context'
import { getExecutionPermissionState } from './permission-state'
import { requestExecutionApproval } from './execution-approval'
import { reviewExecutionApproval } from './approval-reviewer'
import {
  prepareCommandExecution,
  authorizeCommandExecution,
  discardCommandExecution,
  type CommandAuthorize,
  type CommandRequest,
  type CommandExecutionPlan
} from './command-plan'

export type { CommandAuthorize } from './command-plan'

type WorkspaceAuthorizationOptions = {
  windowId: number
  requestId: string
  conversationId: string
  userRequest: string
  execution: ExecutionContext
  assertCurrent: () => boolean
  beginApproval: () => boolean
  finishApproval: () => void
  onApproved: (request: WorkspaceApprovalRequest) => void
}

/** Keeps risk review and manual waiting within the originating task lifecycle. */
export function createWorkspaceAuthorization(
  options: WorkspaceAuthorizationOptions
): WorkspaceApprove {
  const { windowId, requestId, conversationId, userRequest, execution, assertCurrent } = options
  return async (request, signal): Promise<boolean> => {
    signal.throwIfAborted()
    if (!assertCurrent()) return false
    // A boolean file grant cannot select or authorize a command backend.
    if (request.kind === 'command') return false
    const target = request.path
    if (!target) return false
    const decision = localPermission(execution, 'write', target)
    if (decision === 'allow') return true
    if (decision === 'deny') return false
    const common = { requestId, conversationId, cwd: request.cwd }
    const approval: ExecutionApprovalInput =
      request.kind === 'create'
        ? { ...common, kind: 'create', path: request.path, content: request.after }
        : {
            ...common,
            kind: 'edit',
            path: request.path,
            before: request.before,
            after: request.after
          }
    if (!options.beginApproval()) return false
    try {
      let answer = false
      if (decision === 'review') {
        const verdict = await reviewExecutionApproval(approval, userRequest, signal)
        signal.throwIfAborted()
        if (!assertCurrent()) return false
        answer = verdict === 'approve'
      }
      if (!answer) {
        signal.throwIfAborted()
        if (!assertCurrent()) return false
        answer = await requestExecutionApproval(windowId, approval, signal)
      }
      signal.throwIfAborted()
      const approved = answer && assertCurrent()
      if (approved) options.onApproved(request)
      return approved
    } finally {
      options.finishApproval()
    }
  }
}

/** The returned plan binds the exact command and backend to this originating task. */
export function createWorkspaceCommandAuthorization(
  options: WorkspaceAuthorizationOptions
): CommandAuthorize {
  return async (request, signal) => {
    signal.throwIfAborted()
    if (!options.assertCurrent()) return null
    const prepared = await prepareCommandExecution(
      request,
      {
        owner: {
          windowId: options.windowId,
          conversationId: options.conversationId,
          requestId: options.requestId
        },
        permissions: {
          mode: options.execution.info.mode,
          revision: options.execution.info.revision
        },
        scopeId: options.execution.info.scopeId,
        writableRoots: options.execution.writableRoots,
        environment: 'tool',
        assertCurrent: options.assertCurrent
      },
      signal
    )
    try {
      signal.throwIfAborted()
      if (!options.assertCurrent()) return null
      if (prepared.permissions.mode === 'full-access') {
        return authorizeCommandExecution(prepared, 'full-access')
      }
      if (
        prepared.sandboxAvailable &&
        prepared.command.sandbox_permissions !== 'require_escalated'
      ) {
        return authorizeCommandExecution(prepared, 'sandbox')
      }
      const approval: ExecutionApprovalInput = {
        requestId: options.requestId,
        conversationId: options.conversationId,
        kind: 'command',
        program: prepared.command.program,
        args: [...prepared.command.args],
        cwd: prepared.command.cwd,
        reason: prepared.reason.slice(0, 1000) || '此命令需要在当前受限环境之外运行。'
      }
      if (!options.beginApproval()) return null
      try {
        let authorization: 'manual' | 'review' = 'manual'
        let answer = false
        if (prepared.permissions.mode === 'auto-approve') {
          const verdict = await reviewExecutionApproval(approval, options.userRequest, signal)
          signal.throwIfAborted()
          if (!options.assertCurrent()) return null
          answer = verdict === 'approve'
          if (answer) authorization = 'review'
        }
        if (!answer) {
          signal.throwIfAborted()
          if (!options.assertCurrent()) return null
          answer = await requestExecutionApproval(options.windowId, approval, signal)
        }
        signal.throwIfAborted()
        if (!answer || !options.assertCurrent()) return null
        options.onApproved({
          kind: 'command',
          program: prepared.command.program,
          args: [...prepared.command.args],
          cwd: prepared.command.cwd
        })
        return authorizeCommandExecution(prepared, authorization)
      } finally {
        options.finishApproval()
      }
    } finally {
      discardCommandExecution(prepared)
    }
  }
}

/** Legacy proposals lack a verified user request and retain manual review fallback. */
export async function approveStandaloneCommand(
  windowId: number,
  request: CommandRequest & {
    requestId: string
    conversationId: string
  },
  signal: AbortSignal,
  assertSourceCurrent: () => boolean = () => true
): Promise<CommandExecutionPlan | null> {
  signal.throwIfAborted()
  const state = getExecutionPermissionState(windowId)
  const assertCurrent = (): boolean => {
    const current = getExecutionPermissionState(windowId)
    return (
      !signal.aborted &&
      current.mode === state.mode &&
      current.revision === state.revision &&
      assertSourceCurrent()
    )
  }
  if (!assertCurrent()) return null
  const prepared = await prepareCommandExecution(
    request,
    {
      owner: { windowId, conversationId: request.conversationId, requestId: request.requestId },
      permissions: state,
      scopeId: createHash('sha256')
        .update(
          JSON.stringify({ windowId, ...state, cwd: request.cwd, requestId: request.requestId })
        )
        .digest('hex'),
      writableRoots: [request.cwd],
      environment: 'legacy',
      assertCurrent
    },
    signal
  )
  try {
    signal.throwIfAborted()
    if (!assertCurrent()) return null
    if (prepared.permissions.mode === 'full-access') {
      return authorizeCommandExecution(prepared, 'full-access')
    }
    if (prepared.sandboxAvailable && prepared.command.sandbox_permissions !== 'require_escalated') {
      return authorizeCommandExecution(prepared, 'sandbox')
    }
    const approved = await requestExecutionApproval(
      windowId,
      {
        requestId: request.requestId,
        conversationId: request.conversationId,
        cwd: prepared.command.cwd,
        kind: 'command',
        program: prepared.command.program,
        args: [...prepared.command.args],
        reason: prepared.reason.slice(0, 1000) || '此命令需要在当前受限环境之外运行。'
      },
      signal
    )
    signal.throwIfAborted()
    return approved && assertCurrent() ? authorizeCommandExecution(prepared, 'manual') : null
  } finally {
    discardCommandExecution(prepared)
  }
}
