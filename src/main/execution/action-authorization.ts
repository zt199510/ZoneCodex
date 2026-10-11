import { createHash } from 'node:crypto'
import type { WorkspaceApprovalRequest, WorkspaceApprove } from '../tools/workspace-actions'
import type { ExecutionContext } from './execution-context-policy'
import { getExecutionPermissionState } from './permission-state'
import { requestExecutionApproval } from './execution-approval'
import { reviewExecutionApproval } from './approval-reviewer'
import {
  createHostWorkspaceAuthorization,
  createHostWorkspaceCommandAuthorization,
  type HostWorkspaceAuthorizationOptions
} from './workspace-authorization'
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

function desktopOptions(options: WorkspaceAuthorizationOptions): HostWorkspaceAuthorizationOptions {
  const windowId = options.windowId
  return {
    ...options,
    owner: {
      kind: 'desktop',
      windowId,
      requestId: options.requestId,
      conversationId: options.conversationId
    },
    requestApproval: (input, signal) => requestExecutionApproval(windowId, input, signal),
    reviewApproval: reviewExecutionApproval
  }
}

/** The desktop broker keeps its original window/source checks and waiting lifecycle. */
export function createWorkspaceAuthorization(
  options: WorkspaceAuthorizationOptions
): WorkspaceApprove {
  return createHostWorkspaceAuthorization(desktopOptions(options))
}

/** The returned plan binds the exact command and backend to this originating task. */
export function createWorkspaceCommandAuthorization(
  options: WorkspaceAuthorizationOptions
): CommandAuthorize {
  return createHostWorkspaceCommandAuthorization(desktopOptions(options))
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
      owner: {
        kind: 'desktop',
        windowId,
        conversationId: request.conversationId,
        requestId: request.requestId
      },
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
