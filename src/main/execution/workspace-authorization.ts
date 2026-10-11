import type { ExecutionApprovalInput } from '../../shared/execution'
import type { WorkspaceApprovalRequest, WorkspaceApprove } from '../tools/workspace-actions'
import type { ApprovalReviewer } from './approval-reviewer'
import { localPermission, type ExecutionContext } from './execution-context-policy'
import {
  prepareCommandExecution,
  authorizeCommandExecution,
  discardCommandExecution,
  type CommandAuthorize,
  type CommandOwner
} from './command-plan'

export type HostWorkspaceAuthorizationOptions = {
  owner: CommandOwner
  userRequest: string
  execution: ExecutionContext
  assertCurrent: () => boolean
  beginApproval: () => boolean
  finishApproval: () => void
  onApproved: (request: WorkspaceApprovalRequest) => void
  requestApproval: (input: ExecutionApprovalInput, signal: AbortSignal) => Promise<boolean>
  reviewApproval?: ApprovalReviewer
  runtimeRoot?: string
}

function captureOptions(
  options: HostWorkspaceAuthorizationOptions
): HostWorkspaceAuthorizationOptions {
  return Object.freeze({
    ...options,
    owner: Object.freeze({ ...options.owner }),
    execution: Object.freeze({
      info: Object.freeze({ ...options.execution.info }),
      writableRoots: Object.freeze([...options.execution.writableRoots])
    })
  })
}

/** Policy is shared; the originating host owns the approval wait and task lifecycle. */
export function createHostWorkspaceAuthorization(
  supplied: HostWorkspaceAuthorizationOptions
): WorkspaceApprove {
  const options = captureOptions(supplied)
  const { owner, userRequest, execution, assertCurrent } = options
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
    const common = {
      requestId: owner.requestId,
      conversationId: owner.conversationId,
      cwd: request.cwd
    }
    const approval: ExecutionApprovalInput = Object.freeze(
      request.kind === 'create'
        ? { ...common, kind: 'create', path: request.path, content: request.after }
        : {
            ...common,
            kind: 'edit',
            path: request.path,
            before: request.before,
            after: request.after
          }
    )
    if (!options.beginApproval()) return false
    try {
      let answer = false
      if (decision === 'review' && options.reviewApproval) {
        const verdict = await options.reviewApproval(approval, userRequest, signal)
        signal.throwIfAborted()
        if (!assertCurrent()) return false
        answer = verdict === 'approve'
      }
      if (!answer) {
        signal.throwIfAborted()
        if (!assertCurrent()) return false
        answer = (await options.requestApproval(approval, signal)) === true
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

/** A host decision signs the original exact preparation, never a reconstructed boolean plan. */
export function createHostWorkspaceCommandAuthorization(
  supplied: HostWorkspaceAuthorizationOptions
): CommandAuthorize {
  const options = captureOptions(supplied)
  return async (request, signal) => {
    signal.throwIfAborted()
    if (!options.assertCurrent()) return null
    const prepared = await prepareCommandExecution(
      request,
      {
        owner: options.owner,
        permissions: {
          mode: options.execution.info.mode,
          revision: options.execution.info.revision
        },
        scopeId: options.execution.info.scopeId,
        writableRoots: options.execution.writableRoots,
        environment: 'tool',
        assertCurrent: options.assertCurrent,
        runtimeRoot: options.runtimeRoot
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
      const approval: ExecutionApprovalInput = Object.freeze({
        requestId: options.owner.requestId,
        conversationId: options.owner.conversationId,
        kind: 'command',
        program: prepared.command.program,
        args: [...prepared.command.args],
        cwd: prepared.command.cwd,
        reason: prepared.reason.slice(0, 1000) || '此命令需要在当前受限环境之外运行。'
      })
      Object.freeze(approval.args)
      if (!options.beginApproval()) return null
      try {
        let authorization: 'manual' | 'review' = 'manual'
        let answer = false
        if (prepared.permissions.mode === 'auto-approve' && options.reviewApproval) {
          const verdict = await options.reviewApproval(approval, options.userRequest, signal)
          signal.throwIfAborted()
          if (!options.assertCurrent()) return null
          answer = verdict === 'approve'
          if (answer) authorization = 'review'
        }
        if (!answer) {
          signal.throwIfAborted()
          if (!options.assertCurrent()) return null
          answer = (await options.requestApproval(approval, signal)) === true
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
