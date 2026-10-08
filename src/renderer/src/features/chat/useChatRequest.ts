import { useEffect, useRef, useState } from 'react'
import { parseIncompleteToolTurn, selectToolContext } from '../../../../shared/agent-history'
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
import { applyConversationTaskEvent } from '../conversation/useConversationTasks'
import type { OperationControl } from '../conversation/useOperation'
import { resolveAgentRequest } from './agent-request'
import {
  appendImageTurnNotice,
  maxImagesPerMessage,
  stripImageTurnNotice,
  type ImageDescriptor
} from '../../../../shared/image-input'

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
  items: ProtocolItem[]
  commentaryIndexes: Map<string, number>
  answerMessages: Map<string, string>
  attachments: ChatAttachment[]
  taskId: string
  startedAt: number
  imageIds?: readonly string[]
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
  imageIds?: readonly string[]
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
  isImageAvailable?: (imageId: string) => boolean
  getImageDescriptor?: (imageId: string) => ImageDescriptor | null
  onImagesAccepted?: (messageId: string, imageIds: readonly string[]) => void
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
    expectedExecution?: ExecutionInfo,
    imageIds?: readonly string[]
  ) => boolean
  canRetry: (assistantId: string) => boolean
  retry: (assistantId: string) => boolean
  getRetryImages: (assistantId: string) => readonly string[]
  stop: () => Promise<void>
  clearError: () => void
  clearActivity: () => void
}

/** Metadata for the message that was accepted into the live conversation. */
export type AcceptedChatRequest = {
  conversationId: string
  messageId: string
  content: string
  titleContent?: string
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
  observeExecution,
  isImageAvailable,
  getImageDescriptor,
  onImagesAccepted
}: ChatRequestOptions): ChatRequest {
  const { begin, finish } = operations
  const [error, setError] = useState<string | null>(null)
  const [toolActivity, setToolActivity] = useState<ToolActivity>({})
  const activeRequest = useRef<ActiveRequest | null>(null)
  const retrySources = useRef(new Map<string, ChatRetrySource>())
  const subscribed = useRef(false)

  useEffect(() => {
    const offMessage = window.api.onAgentMessageEvent((event) => {
      const active = activeRequest.current
      if (!active || active.phase !== 'running' || active.requestId !== event.requestId) return
      if (event.phase === 'final_answer') {
        const answers = new Map(active.answerMessages)
        answers.set(event.messageId, event.text)
        const content = [...answers]
          .sort(([first], [second]) => first.localeCompare(second, undefined, { numeric: true }))
          .map(([, text]) => text)
          .join('\n')
        if (content.length > 16000) return
        active.answerMessages = answers
        updateMessages(active.conversationId, (previous) =>
          previous.map((message) =>
            message.id === active.assistantId && message.status === 'pending'
              ? { ...message, content }
              : message
          )
        )
        return
      }
      const next = active.items.length
        ? [...active.items]
        : [{ role: 'user', content: active.prompt }]
      const index = active.commentaryIndexes.get(event.messageId)
      const commentary: ProtocolItem = {
        type: 'message',
        role: 'assistant',
        phase: 'commentary',
        content: [{ type: 'output_text', text: event.text }]
      }
      if (index === undefined) next.push(commentary)
      else if (next[index]?.type === 'message') next[index] = commentary
      else return
      const checked = parseIncompleteToolTurn(
        next,
        toolScopeForAgentRequest(active.context),
        active.prompt
      )
      if (!checked) return
      if (index === undefined) active.commentaryIndexes.set(event.messageId, checked.length - 1)
      active.items = checked
      updateConversation(active.conversationId, (previous) => ({
        ...previous,
        toolRuns: previous.toolRuns.map((run) =>
          run.requestId === active.requestId && run.assistantId === active.assistantId
            ? { ...run, items: checked }
            : run
        )
      }))
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
    const offTool = window.api.onAgentToolEvent((event) => {
      const active = activeRequest.current
      if (!active || active.phase !== 'running' || active.requestId !== event.requestId) return
      let next: ProtocolItem[]
      if (event.phase === 'start') {
        if (
          active.items.some(
            (item) => item.type === 'function_call' && item.call_id === event.callId
          )
        )
          return
        next = active.items.length ? [...active.items] : [{ role: 'user', content: active.prompt }]
        next.push({
          type: 'function_call',
          call_id: event.callId,
          name: event.name,
          arguments: event.arguments
        })
      } else {
        const pending = active.items.at(-1)
        if (
          pending?.type !== 'function_call' ||
          pending.call_id !== event.callId ||
          pending.name !== event.name
        )
          return
        next = [
          ...active.items,
          { type: 'function_call_output', call_id: event.callId, output: event.output }
        ]
      }
      const checked = parseIncompleteToolTurn(
        next,
        toolScopeForAgentRequest(active.context),
        active.prompt
      )
      if (!checked) return
      active.items = checked
      updateConversation(active.conversationId, (previous) => ({
        ...previous,
        toolRuns: previous.toolRuns.map((run) =>
          run.requestId === active.requestId && run.assistantId === active.assistantId
            ? { ...run, items: checked }
            : run
        )
      }))
    })
    const offTask = window.api.onTaskState((record) => {
      updateConversation(record.conversationId, (previous) => {
        const active = activeRequest.current
        return applyConversationTaskEvent(
          previous,
          record,
          active?.conversationId === record.conversationId ? active.taskId : null
        )
      })
    })
    subscribed.current = true
    return () => {
      subscribed.current = false
      offMessage()
      offProgress()
      offTool()
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
    const finalTrace = [
      ...trace.filter((line) => !/^用时：\d+毫秒$/.test(line)),
      `用时：${Math.max(0, Math.round(performance.now() - active.startedAt))}毫秒`
    ].slice(-30)
    const finishedRun: ToolRun = {
      requestId: active.requestId,
      userId: active.userId,
      assistantId: active.assistantId,
      mode: 'live',
      scope: toolScopeForAgentRequest(active.context),
      trace: finalTrace,
      items
    }
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
      toolRuns: previous.toolRuns.some((run) => run.requestId === active.requestId)
        ? previous.toolRuns.map((run) =>
            run.requestId === active.requestId && run.assistantId === active.assistantId
              ? { ...run, trace: finalTrace, items }
              : run
          )
        : [...previous.toolRuns, finishedRun]
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
      const selected = selectToolContext(
        active.sourceMessages,
        active.sourceToolRuns,
        'live',
        scope
      )
      active.history = selected.history
      if (selected.imageHistory.length)
        active.context = { ...active.context, imageHistory: selected.imageHistory }
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
        finishToolTurn(active, 'cancelled', result.trace, result.items ?? active.items)
      } else {
        finishToolTurn(
          active,
          'failed',
          result.trace,
          result.items ?? active.items,
          active.sideEffectStarted || hasLocalSideEffects(result.trace) ? result.error : undefined
        )
        setError(result.error)
      }
    } catch (cause) {
      if (activeRequest.current?.requestId === active.requestId) {
        finishToolTurn(active, 'failed', active.trace, active.items)
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
    expectedExecution?: ExecutionInfo,
    imageIds: readonly string[] = []
  ): boolean {
    const frozenImageIds = [...imageIds]
    const question = frozenImageIds.length
      ? stripImageTurnNotice(rawContent).trim()
      : rawContent.trim()
    const content = frozenImageIds.length
      ? appendImageTurnNotice(question, frozenImageIds.length)
      : question
    // `begin` 仍是最终的原子互斥点；这里的同步检查让保存、选文件或生成期间
    // 的调用在解析附件和历史之前就被拒绝，避免产生任何请求副作用。
    if (
      !subscribed.current ||
      !operations.isIdle() ||
      !targetConversationId ||
      !question ||
      activeRequest.current
    )
      return false
    if (
      frozenImageIds.length > maxImagesPerMessage ||
      new Set(frozenImageIds).size !== frozenImageIds.length ||
      frozenImageIds.some((imageId) => !isImageAvailable?.(imageId))
    ) {
      setError('原图片组已失效或超过上限，请核对后重新添加图片。')
      return false
    }
    const images: ImageDescriptor[] = []
    for (const imageId of frozenImageIds) {
      const image = getImageDescriptor?.(imageId)
      if (image) images.push({ ...image })
    }
    if (images.length !== frozenImageIds.length) {
      setError('原图片组不可用，请重新添加后发送。')
      return false
    }
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
      if (frozenImageIds.length)
        request.context = {
          ...request.context,
          images: frozenImageIds.map((imageId) => ({ imageId }))
        }
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
      items: [],
      commentaryIndexes: new Map(),
      answerMessages: new Map(),
      attachments,
      taskId: crypto.randomUUID(),
      startedAt: performance.now(),
      ...(frozenImageIds.length ? { imageIds: frozenImageIds } : {})
    }
    if (active.context.images)
      active.context.images = active.context.images.map((image) => ({
        ...image,
        messageId: active.userId
      }))
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
          ...(images.length ? { images } : {}),
          ...(active.attachments.length > 0 ? { attachments: active.attachments } : {})
        },
        { id: active.assistantId, role: 'assistant', content: '', status: 'pending' }
      ]
    }))
    onAccepted?.({
      conversationId: active.conversationId,
      messageId: active.userId,
      content,
      ...(frozenImageIds.length ? { titleContent: question } : {})
    })
    if (frozenImageIds.length) onImagesAccepted?.(active.userId, frozenImageIds)
    retrySources.current.set(active.assistantId, {
      conversationId: active.conversationId,
      prompt: content,
      sourceMessages: [...sourceMessages],
      sourceToolRuns: [...sourceToolRuns],
      snapshotId: sourceProjectSelection?.snapshotId ?? null,
      attachments,
      workspaceId: sourceWorkspace?.workspaceId ?? null,
      permissions: { ...permissions },
      ...(frozenImageIds.length ? { imageIds: frozenImageIds } : {})
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
      (!source.imageIds?.length ||
        source.imageIds.every((imageId) => isImageAvailable?.(imageId))) &&
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
      source.execution,
      source.imageIds
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
    getRetryImages: (assistantId) => retrySources.current.get(assistantId)?.imageIds ?? [],
    stop,
    clearError: () => setError(null),
    clearActivity: () => {
      retrySources.current.clear()
      setToolActivity({})
    }
  }
}
