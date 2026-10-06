import { useEffect, useRef, useState } from 'react'
import { selectToolHistory } from '../../../../shared/agent-history'
import type { ProtocolItem, ToolRun } from '../../../../shared/agent-history'
import type { AgentRequestContext, ProjectSelection, Workspace } from '../../../../shared/project'
import { toolScopeForAgentRequest } from '../../../../shared/project'
import type { ChatAttachment, ChatMessage } from '../../../../shared/conversation'
import type { Conversation } from '../../../../shared/conversation-library'
import {
  hasLocalSideEffects,
  sameExecutionInfo,
  type ExecutionInfo,
  type PermissionsState
} from '../../../../shared/execution'
import { isTerminalTaskStatus, maxTaskRecords } from '../../../../shared/task'
import type { OperationControl } from '../conversation/useOperation'
import { resolveAgentRequest } from './agent-request'

export type ToolActivity = Record<string, string[]>

// 输入框和请求层共用同一条上限；请求层仍需独立校验，避免其他入口绕过表单限制。
const maxPromptLength = 2000

function samePermissions(expected: PermissionsState, current: PermissionsState | null): boolean {
  return current?.mode === expected.mode && current.revision === expected.revision
}

type ActiveRequest = {
  conversationId: string
  requestId: string
  userId: string
  assistantId: string
  prompt: string
  context: AgentRequestContext
  sourceMessages: readonly ChatMessage[]
  sourceToolRuns: readonly ToolRun[]
  permissions: PermissionsState
  expectedExecution?: ExecutionInfo
  phase: 'resolving' | 'running'
  sideEffectStarted: boolean
  history: ProtocolItem[]
  trace: string[]
  attachments: ChatAttachment[]
  taskId: string
}
type ChatRetrySource = {
  conversationId: string
  prompt: string
  sourceMessages: readonly ChatMessage[]
  sourceToolRuns: readonly ToolRun[]
  snapshotId: string | null
  attachments: ChatAttachment[]
  workspaceId: string | null
  permissions: PermissionsState
  execution?: ExecutionInfo
}
type UpdateMessages = (
  conversationId: string,
  update: (previous: ChatMessage[]) => ChatMessage[]
) => void
type UpdateConversation = (
  conversationId: string,
  update: (previous: Conversation) => Conversation
) => void
type ChatRequestOptions = {
  conversationId: string | null
  messages: ChatMessage[]
  updateMessages: UpdateMessages
  updateConversation: UpdateConversation
  toolRuns: readonly ToolRun[]
  operations: OperationControl
  projectSelection: ProjectSelection | null
  workspace: Workspace | null
  getPermissions: () => PermissionsState | null
  observeExecution: (execution: ExecutionInfo) => void
}
type ChatRequest = {
  error: string | null
  toolActivity: ToolActivity
  send: (
    rawContent: string,
    sourceMessages?: readonly ChatMessage[],
    sourceToolRuns?: readonly ToolRun[],
    targetConversationId?: string | null,
    sourceProjectSelection?: ProjectSelection | null,
    sourceWorkspace?: Workspace | null,
    onAccepted?: (accepted: AcceptedChatRequest) => void,
    messageAttachments?: readonly ChatAttachment[],
    expectedExecution?: ExecutionInfo
  ) => boolean
  canRetry: (assistantId: string) => boolean
  retry: (assistantId: string) => boolean
  stop: () => Promise<void>
  clearError: () => void
  clearActivity: () => void
}

/** Metadata for the message that was accepted into the live conversation. */
export type AcceptedChatRequest = {
  conversationId: string
  messageId: string
  content: string
}

export function useChatRequest({
  conversationId,
  messages,
  updateMessages,
  updateConversation,
  toolRuns,
  operations,
  projectSelection,
  workspace,
  getPermissions,
  observeExecution
}: ChatRequestOptions): ChatRequest {
  const { begin, finish } = operations
  const [error, setError] = useState<string | null>(null)
  const [toolActivity, setToolActivity] = useState<ToolActivity>({})
  const activeRequest = useRef<ActiveRequest | null>(null)
  const retrySources = useRef(new Map<string, ChatRetrySource>())
  const subscribed = useRef(false)

  useEffect(() => {
    const offDelta = window.api.onModelDelta((event) => {
      const active = activeRequest.current
      if (!active || active.requestId !== event.requestId) return
      updateMessages(active.conversationId, (previous) =>
        previous.map((message) =>
          message.id === active.assistantId && message.status === 'pending'
            ? { ...message, content: message.content + event.delta }
            : message
        )
      )
    })
    const offProgress = window.api.onAgentProgress((event) => {
      const active = activeRequest.current
      if (!active || active.requestId !== event.requestId) return
      if (hasLocalSideEffects([event.message])) {
        active.sideEffectStarted = true
        retrySources.current.delete(active.assistantId)
      }
      active.trace = [...active.trace, event.message].slice(-30)
      setToolActivity((previous) => ({
        ...previous,
        [active.assistantId]: [...(previous[active.assistantId] ?? []), event.message].slice(-30)
      }))
    })
    const offTask = window.api.onTaskState((record) => {
      updateConversation(record.conversationId, (previous) => {
        const active = activeRequest.current
        const belongsToActiveRequest =
          active?.taskId === record.taskId && active.conversationId === record.conversationId
        const existing = previous.tasks.find((task) => task.taskId === record.taskId)
        const belongsToKnownTask = existing !== undefined
        // Ignore late events for tasks already removed from this conversation.
        if (!belongsToActiveRequest && !belongsToKnownTask) return previous
        // Reconciliation can close an orphaned task as `interrupted` while an
        // event queued before refresh is still in flight. Persisted terminal
        // records are immutable from the renderer's point of view; accepting a
        // stale running event here would reopen work that no longer has a
        // runtime handle.
        if (existing && isTerminalTaskStatus(existing.status)) {
          return previous
        }
        const known = previous.tasks.some((task) => task.taskId === record.taskId)
        const tasks = known
          ? previous.tasks.map((task) => (task.taskId === record.taskId ? record : task))
          : [...previous.tasks, record].slice(-maxTaskRecords)
        return {
          ...previous,
          tasks
        }
      })
    })
    subscribed.current = true
    return () => {
      subscribed.current = false
      offDelta()
      offProgress()
      offTask()
      const active = activeRequest.current
      activeRequest.current = null
      if (!active) return
      if (active.phase === 'running') {
        void window.api.cancelAgentRequest(active.requestId).catch(() => undefined)
      }
    }
  }, [updateConversation, updateMessages])

  function finishToolTurn(
    active: ActiveRequest,
    status: ChatMessage['status'],
    trace: string[],
    items: ProtocolItem[],
    answer?: string
  ): void {
    active.sideEffectStarted ||= hasLocalSideEffects(trace)
    if (active.sideEffectStarted) retrySources.current.delete(active.assistantId)
    const visibleAnswer =
      answer ??
      (active.sideEffectStarted && status !== 'complete'
        ? '本地操作可能已经执行。请先核对文件或命令结果，再决定是否重新请求。'
        : undefined)
    updateConversation(active.conversationId, (previous) => ({
      ...previous,
      messages: previous.messages.map((message) => {
        if (message.id !== active.userId && message.id !== active.assistantId) return message
        return {
          ...message,
          status,
          content:
            message.id === active.assistantId && visibleAnswer !== undefined
              ? visibleAnswer
              : message.content
        }
      }),
      toolRuns: previous.toolRuns.map((run) =>
        run.requestId === active.requestId && run.assistantId === active.assistantId
          ? { ...run, trace: trace.slice(-30), items }
          : run
      )
    }))
    setToolActivity((previous) => {
      const next = { ...previous }
      delete next[active.assistantId]
      return next
    })
  }

  async function run(active: ActiveRequest): Promise<void> {
    try {
      const execution = await window.api.resolveAgentExecution(active.context)
      // Resolving the directory and settings is asynchronous. Stop can finish
      // the placeholder immediately; a late resolution must not start a task.
      if (activeRequest.current !== active) return
      observeExecution(execution)
      if (
        !samePermissions(active.permissions, execution) ||
        !samePermissions(active.permissions, getPermissions())
      ) {
        throw new Error('权限设置已变化，请重新发送消息。')
      }
      if (active.expectedExecution && !sameExecutionInfo(active.expectedExecution, execution)) {
        retrySources.current.delete(active.assistantId)
        throw new Error('运行目录或权限已变化，请核对后重新发送消息。')
      }
      active.context = { ...active.context, execution }
      // Keep the original project and attachment fields; only the execution
      // information comes from the main-process resolver.
      const scope = toolScopeForAgentRequest(active.context)
      active.history = selectToolHistory(
        active.sourceMessages,
        active.sourceToolRuns,
        'live',
        scope
      )
      const source = retrySources.current.get(active.assistantId)
      if (source) source.execution = execution
      updateConversation(active.conversationId, (previous) => ({
        ...previous,
        toolRuns: [
          ...previous.toolRuns,
          {
            requestId: active.requestId,
            userId: active.userId,
            assistantId: active.assistantId,
            mode: 'live',
            scope,
            trace: [],
            items: []
          }
        ]
      }))
      active.phase = 'running'
      const result = await window.api.startAgentRequest(
        active.requestId,
        active.prompt,
        active.history,
        active.context,
        active.taskId
      )
      if (activeRequest.current?.requestId !== active.requestId) return
      if (result.status === 'done') {
        finishToolTurn(active, 'complete', result.trace, result.items, result.answer)
      } else if (result.status === 'cancelled') {
        finishToolTurn(active, 'cancelled', result.trace, [])
      } else {
        finishToolTurn(
          active,
          'failed',
          result.trace,
          [],
          active.sideEffectStarted || hasLocalSideEffects(result.trace) ? result.error : undefined
        )
        setError(result.error)
      }
    } catch (cause) {
      if (activeRequest.current?.requestId === active.requestId) {
        finishToolTurn(active, 'failed', active.trace, [])
        setError(
          active.phase === 'resolving' && cause instanceof Error
            ? cause.message
            : '回复连接中断，请稍后重试。'
        )
      }
    } finally {
      if (activeRequest.current?.requestId === active.requestId) {
        activeRequest.current = null
        finish('generating')
      }
    }
  }

  function send(
    rawContent: string,
    sourceMessages: readonly ChatMessage[] = messages,
    sourceToolRuns: readonly ToolRun[] = toolRuns,
    targetConversationId: string | null = conversationId,
    sourceProjectSelection: ProjectSelection | null = projectSelection,
    sourceWorkspace: Workspace | null = workspace,
    onAccepted?: (accepted: AcceptedChatRequest) => void,
    messageAttachments: readonly ChatAttachment[] = [],
    expectedExecution?: ExecutionInfo
  ): boolean {
    const content = rawContent.trim()
    // `begin` 仍是最终的原子互斥点；这里的同步检查让保存、选文件或生成期间
    // 的调用在解析附件和历史之前就被拒绝，避免产生任何请求副作用。
    if (
      !subscribed.current ||
      !operations.isIdle() ||
      !targetConversationId ||
      !content ||
      activeRequest.current
    )
      return false
    if (rawContent.length > maxPromptLength || content.length > maxPromptLength) {
      setError(`请输入不超过 ${maxPromptLength} 个字符的消息。`)
      return false
    }
    const permissions = getPermissions()
    if (!permissions) {
      setError('权限设置尚未就绪，请稍后再发送。')
      return false
    }
    let request: ReturnType<typeof resolveAgentRequest>
    try {
      request = resolveAgentRequest(targetConversationId, sourceWorkspace, sourceProjectSelection)
    } catch (error) {
      setError(error instanceof Error ? error.message : '工具上下文无效，请重新说明问题。')
      return false
    }
    if (!begin('generating')) return false
    const attachments: ChatAttachment[] = messageAttachments.map((file) => ({
      path: file.path,
      bytes: file.bytes,
      lines: file.lines
    }))
    const active: ActiveRequest = {
      conversationId: targetConversationId,
      requestId: crypto.randomUUID(),
      userId: crypto.randomUUID(),
      assistantId: crypto.randomUUID(),
      prompt: content,
      context: request.context,
      sourceMessages: [...sourceMessages],
      sourceToolRuns: [...sourceToolRuns],
      permissions: { ...permissions },
      ...(expectedExecution ? { expectedExecution } : {}),
      phase: 'resolving',
      sideEffectStarted: false,
      history: [],
      trace: [],
      attachments,
      taskId: crypto.randomUUID()
    }
    activeRequest.current = active
    setError(null)
    setToolActivity((previous) => ({ ...previous, [active.assistantId]: ['正在处理请求…'] }))
    updateConversation(active.conversationId, (previous) => ({
      ...previous,
      messages: [
        ...previous.messages,
        {
          id: active.userId,
          role: 'user',
          content,
          status: 'pending',
          ...(active.attachments.length > 0 ? { attachments: active.attachments } : {})
        },
        { id: active.assistantId, role: 'assistant', content: '', status: 'pending' }
      ]
    }))
    onAccepted?.({
      conversationId: active.conversationId,
      messageId: active.userId,
      content
    })
    retrySources.current.set(active.assistantId, {
      conversationId: active.conversationId,
      prompt: content,
      sourceMessages: [...sourceMessages],
      sourceToolRuns: [...sourceToolRuns],
      snapshotId: sourceProjectSelection?.snapshotId ?? null,
      attachments,
      workspaceId: sourceWorkspace?.workspaceId ?? null,
      permissions: { ...permissions }
    })
    void run(active)
    return true
  }

  function canRetry(assistantId: string): boolean {
    const source = retrySources.current.get(assistantId)
    return Boolean(
      source &&
      source.conversationId === conversationId &&
      source.snapshotId === (projectSelection?.snapshotId ?? null) &&
      source.workspaceId === (workspace?.workspaceId ?? null) &&
      samePermissions(source.permissions, getPermissions()) &&
      operations.isIdle() &&
      !activeRequest.current
    )
  }

  function retry(assistantId: string): boolean {
    const source = retrySources.current.get(assistantId)
    if (!source || !canRetry(assistantId)) return false
    const accepted = send(
      source.prompt,
      source.sourceMessages,
      source.sourceToolRuns,
      source.conversationId,
      projectSelection,
      workspace,
      undefined,
      source.attachments,
      source.execution
    )
    if (accepted) retrySources.current.delete(assistantId)
    return accepted
  }

  async function stop(): Promise<void> {
    const active = activeRequest.current
    if (!active) return
    if (active.phase === 'resolving') {
      activeRequest.current = null
      finishToolTurn(active, 'cancelled', active.trace, [])
      finish('generating')
      return
    }
    try {
      await window.api.cancelAgentRequest(active.requestId)
    } catch {
      if (activeRequest.current?.requestId === active.requestId) {
        setError('停止请求失败，请等待回复结束或超时。')
      }
    }
  }

  return {
    error,
    toolActivity,
    send,
    canRetry,
    retry,
    stop,
    clearError: () => setError(null),
    clearActivity: () => setToolActivity({})
  }
}
