import type { ExecutionApprovalInput } from '../../shared/execution'
import { decideLocalPermission } from '../../shared/permission-policy'
import type { WorkspaceApprovalRequest, WorkspaceApprove } from '../tools/workspace-actions'
import { localPermission, type ExecutionContext } from './execution-context'
import { getExecutionPermissionState } from './permission-state'
import { requestExecutionApproval } from './execution-approval'
import { reviewExecutionApproval } from './approval-reviewer'

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
    const target = request.kind === 'command' ? request.cwd : request.path
    if (!target) return false
    const decision = localPermission(
      execution,
      request.kind === 'command' ? 'command' : 'write',
      target
    )
    if (decision === 'allow') return true
    if (decision === 'deny') return false
    const common = { requestId, conversationId, cwd: request.cwd }
    const approval: ExecutionApprovalInput =
      request.kind === 'create'
        ? { ...common, kind: 'create', path: request.path, content: request.after }
        : request.kind === 'edit'
          ? {
              ...common,
              kind: 'edit',
              path: request.path,
              before: request.before,
              after: request.after
            }
          : { ...common, kind: 'command', program: request.program, args: [...request.args] }
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

/** Legacy proposals lack a verified user request and retain manual review fallback. */
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
