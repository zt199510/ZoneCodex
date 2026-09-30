import { useEffect, useRef, useState } from 'react'
import { selectToolHistory } from '../../../../shared/agent-history'
import type { ProtocolItem, ToolRun } from '../../../../shared/agent-history'
import type { AgentRequestContext, ProjectSelection, Workspace } from '../../../../shared/project'
import type { ChatAttachment, ChatMessage } from '../../../../shared/conversation'
import type { Conversation } from '../../../../shared/conversation-library'
import { isTerminalTaskStatus, maxTaskRecords } from '../../../../shared/task'
import type { OperationControl } from '../conversation/useOperation'
import { resolveAgentRequest } from './agent-request'

export type ToolActivity = Record<string, string[]>

// 输入框和请求层共用同一条上限；请求层仍需独立校验，避免其他入口绕过表单限制。
const maxPromptLength = 2000

type ActiveRequest = {
  conversationId: string
  requestId: string
  userId: string
  assistantId: string
  prompt: string
  context: AgentRequestContext
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
    messageAttachments?: readonly ChatAttachment[]
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
  workspace
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
      void window.api.cancelAgentRequest(active.requestId).catch(() => undefined)
    }
  }, [updateConversation, updateMessages])

  function finishToolTurn(
    active: ActiveRequest,
    status: ChatMessage['status'],
    trace: string[],
    items: ProtocolItem[],
    answer?: string
  ): void {
    updateConversation(active.conversationId, (previous) => ({
      ...previous,
      messages: previous.messages.map((message) => {
        if (message.id !== active.userId && message.id !== active.assistantId) return message
        return {
          ...message,
          status,
          content:
            message.id === active.assistantId && answer !== undefined ? answer : message.content
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
        finishToolTurn(active, 'failed', result.trace, [])
        setError(result.error)
      }
    } catch {
      if (activeRequest.current?.requestId === active.requestId) {
        finishToolTurn(active, 'failed', active.trace, [])
        setError('回复连接中断，请稍后重试。')
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
    messageAttachments: readonly ChatAttachment[] = []
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
    let history: ProtocolItem[]
    let request: ReturnType<typeof resolveAgentRequest>
    try {
      request = resolveAgentRequest(targetConversationId, sourceWorkspace, sourceProjectSelection)
      history = selectToolHistory(sourceMessages, sourceToolRuns, 'live', request.scope)
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
      history,
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
      ],
      toolRuns: [
        ...previous.toolRuns,
        {
          requestId: active.requestId,
          userId: active.userId,
          assistantId: active.assistantId,
          mode: 'live',
          scope: request.scope,
          trace: [],
          items: []
        }
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
      workspaceId: sourceWorkspace?.workspaceId ?? null
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
      operations.isIdle() &&
      !activeRequest.current
    )
  }

  function retry(assistantId: string): boolean {
    const source = retrySources.current.get(assistantId)
    if (!source || !canRetry(assistantId)) return false
    return send(
      source.prompt,
      source.sourceMessages,
      source.sourceToolRuns,
      source.conversationId,
      projectSelection,
      workspace,
      undefined,
      source.attachments
    )
  }

  async function stop(): Promise<void> {
    const active = activeRequest.current
    if (!active) return
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
