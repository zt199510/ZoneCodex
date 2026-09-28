import { useEffect, useRef, useState } from 'react'
import type { AgentMode } from '../../../../shared/agent'
import { selectToolHistory } from '../../../../shared/agent-history'
import type { ProtocolItem, ToolRun } from '../../../../shared/agent-history'
import type { AgentContext, ProjectSelection, ToolScope } from '../../../../shared/project'
import type { ChatMessage } from '../../../../shared/conversation'
import type { Conversation } from '../../../../shared/conversation-library'
import { maxTaskRecords } from '../../../../shared/task'
import type { OperationControl } from '../conversation/useOperation'
import { buildContext, messagesAfterProjectBoundary } from './context'
import { resolveToolRequest, type ChatMode } from './chat-mode'

export type ToolActivity = Record<string, string[]>

type ActiveRequest = {
  conversationId: string
  requestId: string
  userId: string
  assistantId: string
  mode: ChatMode
  agentMode: AgentMode | null
  prompt: string
  scope: ToolScope | null
  context: AgentContext | null
  history: ProtocolItem[]
  chatHistory: ReturnType<typeof buildContext>
  trace: string[]
  text: string
  taskId: string
}
type ChatRetrySource = {
  conversationId: string
  prompt: string
  sourceMessages: readonly ChatMessage[]
  sourceToolRuns: readonly ToolRun[]
  mode: ChatMode
  projectSelection: ProjectSelection | null
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
  mode: ChatMode
  projectSelection: ProjectSelection | null
}
type ChatRequest = {
  error: string | null
  toolActivity: ToolActivity
  send: (
    rawContent: string,
    sourceMessages?: readonly ChatMessage[],
    sourceToolRuns?: readonly ToolRun[],
    targetConversationId?: string | null
  ) => boolean
  canRetry: (assistantId: string) => boolean
  retry: (assistantId: string) => boolean
  stop: () => Promise<void>
  clearError: () => void
  clearActivity: () => void
}

export function useChatRequest({
  conversationId,
  messages,
  updateMessages,
  updateConversation,
  toolRuns,
  operations,
  mode,
  projectSelection
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
      if (!active || active.mode !== 'chat' || active.requestId !== event.requestId) return
      active.text += event.delta
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
      if (!active || active.mode === 'chat' || active.requestId !== event.requestId) return
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
        const belongsToKnownTask = previous.tasks.some((task) => task.taskId === record.taskId)
        // Ignore late events for tasks already removed from this conversation.
        if (!belongsToActiveRequest && !belongsToKnownTask) return previous
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
      if (active.mode === 'chat')
        void window.api.cancelModelStream(active.requestId).catch(() => undefined)
      else void window.api.cancelAgentPractice(active.requestId).catch(() => undefined)
    }
  }, [updateConversation, updateMessages])

  function finishTurn(active: ActiveRequest, status: ChatMessage['status'], answer?: string): void {
    updateMessages(active.conversationId, (previous) =>
      previous.map((message) => {
        if (message.id !== active.userId && message.id !== active.assistantId) return message
        return {
          ...message,
          status,
          content:
            message.id === active.assistantId && answer !== undefined ? answer : message.content
        }
      })
    )
  }

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
      if (active.mode === 'chat') {
        const result = await window.api.startModelStream(
          active.requestId,
          active.chatHistory,
          active.taskId,
          active.conversationId
        )
        if (activeRequest.current?.requestId !== active.requestId) return
        if (result.status === 'done' && active.text.trim()) {
          finishTurn(active, 'complete')
        } else if (result.status === 'cancelled') {
          finishTurn(active, 'cancelled')
        } else {
          finishTurn(active, 'failed')
          const error = result.status === 'error' ? result.error : '未收到有效的回复文字。'
          setError(error)
        }
      } else {
        const result = await window.api.startAgentPractice(
          active.requestId,
          active.prompt,
          active.agentMode ?? 'mock',
          active.history,
          active.context ?? { kind: 'time' },
          active.taskId,
          active.conversationId
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
      }
    } catch {
      if (activeRequest.current?.requestId === active.requestId) {
        if (active.mode === 'chat') finishTurn(active, 'failed')
        else finishToolTurn(active, 'failed', active.trace, [])
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
    sourceMode: ChatMode = mode,
    sourceProjectSelection: ProjectSelection | null = projectSelection
  ): boolean {
    const content = rawContent.trim()
    if (!subscribed.current || !targetConversationId || !content || activeRequest.current)
      return false
    const limit = sourceMode === 'chat' ? 4000 : 2000
    if (content.length > limit) {
      setError(`当前模式请输入不超过 ${limit} 个字符的消息。`)
      return false
    }
    let history: ProtocolItem[] = []
    let chatHistory: ReturnType<typeof buildContext> = []
    let scope: ToolScope | null = null
    let context: AgentContext | null = null
    let agentMode: AgentMode | null = null
    if (sourceMode === 'chat') {
      chatHistory = buildContext(
        messagesAfterProjectBoundary(sourceMessages, sourceToolRuns),
        content
      )
    } else {
      try {
        const request = resolveToolRequest(sourceMode, targetConversationId, sourceProjectSelection)
        if (!request) {
          setError('附件已失效，请重新添加文件。')
          return false
        }
        agentMode = request.agentMode
        scope = request.scope
        context = request.context
        history = selectToolHistory(sourceMessages, sourceToolRuns, request.agentMode, request.scope)
      } catch (error) {
        setError(error instanceof Error ? error.message : '工具上下文无效，请重新说明问题。')
        return false
      }
    }
    if (!begin('generating')) return false
    const active: ActiveRequest = {
      conversationId: targetConversationId,
      requestId: crypto.randomUUID(),
      userId: crypto.randomUUID(),
      assistantId: crypto.randomUUID(),
      mode: sourceMode,
      agentMode,
      prompt: content,
      scope,
      context,
      history,
      chatHistory,
      trace: [],
      text: '',
      taskId: crypto.randomUUID()
    }
    activeRequest.current = active
    setError(null)
    if (sourceMode !== 'chat') {
      setToolActivity((previous) => ({ ...previous, [active.assistantId]: ['正在处理请求…'] }))
    }
    if (sourceMode === 'chat') {
      updateMessages(active.conversationId, (previous) => [
        ...previous,
        { id: active.userId, role: 'user', content, status: 'pending' },
        { id: active.assistantId, role: 'assistant', content: '', status: 'pending' }
      ])
    } else {
      updateConversation(active.conversationId, (previous) => ({
        ...previous,
        messages: [
          ...previous.messages,
          { id: active.userId, role: 'user', content, status: 'pending' },
          { id: active.assistantId, role: 'assistant', content: '', status: 'pending' }
        ],
        toolRuns: [
          ...previous.toolRuns,
          {
            requestId: active.requestId,
            userId: active.userId,
            assistantId: active.assistantId,
            mode: agentMode ?? 'mock',
            scope: active.scope ?? { kind: 'time' },
            trace: [],
            items: []
          }
        ]
      }))
    }
    if (sourceMode === 'chat') {
      retrySources.current.set(active.assistantId, {
        conversationId: active.conversationId,
        prompt: content,
        sourceMessages: [...sourceMessages],
        sourceToolRuns: [...sourceToolRuns],
        mode: sourceMode,
        projectSelection: sourceProjectSelection
      })
    }
    void run(active)
    return true
  }

  function canRetry(assistantId: string): boolean {
    const source = retrySources.current.get(assistantId)
    return Boolean(
      source &&
        source.mode === 'chat' &&
        source.conversationId === conversationId &&
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
      source.mode,
      source.projectSelection
    )
  }

  async function stop(): Promise<void> {
    const active = activeRequest.current
    if (!active) return
    try {
      if (active.mode === 'chat') await window.api.cancelModelStream(active.requestId)
      else await window.api.cancelAgentPractice(active.requestId)
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
