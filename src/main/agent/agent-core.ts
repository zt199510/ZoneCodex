import { performance } from 'node:perf_hooks'
import {
  isAgentId,
  parseAgentMode,
  parseAgentRetryEvent,
  parseAgentContextEvent,
  parseResponseMessageId,
  type AgentMessageEvent,
  type AgentResult,
  type AgentRetryEvent,
  type ToolCallEvent
} from '../../shared/agent'
import { parseIncompleteToolTurn, parseToolHistory } from '../../shared/agent-history'
import type { ProtocolItem } from '../../shared/agent-history'
import { parseToolScope } from '../../shared/project'
import { AgentError } from '../errors'
import { runToolLoop } from './tool-loop'
import type {
  AgentCoreDependencies,
  AgentCoreEvent,
  AgentCoreInput,
  AgentCoreObserver,
  AgentCoreOutcome
} from './agent-core-contract'

/** One invocation owns its public evidence, retry identities and effect risk. */
export async function runAgentCore(
  input: AgentCoreInput,
  dependencies: AgentCoreDependencies
): Promise<AgentCoreOutcome> {
  const {
    signal,
    send,
    createTools,
    assertCurrent: isCurrent,
    onEvent,
    transportLabel
  } = dependencies
  const requestId = input.requestId
  const startedAt = dependencies.startedAt ?? performance.now()
  const trace: string[] = []
  let observedItems: ProtocolItem[] = []
  const effects = { approved: false, started: false }
  let active = true
  let result: AgentResult
  let task: AgentCoreOutcome['task']
  const appendTrace = (message: string): void => {
    if (!active) return
    trace.push(message.slice(0, 500))
    if (trace.length > 30) trace.shift()
  }
  const publish = (event: AgentCoreEvent): void => {
    if (!active || signal.aborted) return
    onEvent?.(event)
  }
  const progress = (message: string): void => {
    if (!active) return
    publish({ type: 'progress', requestId, message: message.slice(0, 500) })
  }
  const observer: AgentCoreObserver = {
    appendTrace,
    progress,
    actionApproved: (kind) => {
      if (!active) return
      effects.approved = true
      const message = `工作区操作已批准：${kind}`
      appendTrace(message)
      progress(message)
    },
    effectStarted: () => {
      if (!active) return
      effects.started = true
      const message = '本地操作已开始：文件或命令'
      appendTrace(message)
      progress(message)
    }
  }
  try {
    // Capture before the first await. Later mutations of caller data cannot
    // change the request, history, tool scope or public message identity.
    const mode = parseAgentMode(input.mode)
    const scope = parseToolScope(input.scope)
    const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : ''
    if (
      !isAgentId(requestId) ||
      !isAgentId(input.conversationId) ||
      !mode ||
      !scope ||
      !prompt ||
      input.prompt.length > 2000
    )
      throw new AgentError('任务或工具上下文参数无效')
    const history = parseToolHistory(input.history, scope, input.imageHistory, mode)
    if (!history) throw new AgentError('工具历史参数无效')
    if (
      typeof send !== 'function' ||
      typeof createTools !== 'function' ||
      typeof isCurrent !== 'function'
    )
      throw new AgentError('当前请求缺少模型、工具或上下文适配')
    const assertCurrent = (): void => {
      signal.throwIfAborted()
      if (!isCurrent()) throw new AgentError('运行上下文已失效，请重新发送')
    }
    assertCurrent()
    appendTrace(
      `工作方式：${mode === 'plan' ? '计划' : '执行'}；${transportLabel ?? '模型与工具循环'}`
    )
    const execute = createTools(observer)
    if (typeof execute !== 'function') throw new AgentError('当前请求缺少工具适配')
    const commentaryPositions = new Map<string, number>()
    const publicMessages = new Map<string, { phase: AgentMessageEvent['phase']; text: string }>()
    const roundAttempts = new Map<number, number>()
    let latestResponseRound = 0
    const observeRetry = (event: Omit<AgentRetryEvent, 'requestId'>): void => {
      if (!active || signal.aborted) return
      const retry = parseAgentRetryEvent({ ...event, requestId })
      if (!retry) throw new AgentError('重试事件格式不正确')
      if (retry.round < latestResponseRound || retry.retry <= (roundAttempts.get(retry.round) ?? 0))
        return
      latestResponseRound = retry.round
      roundAttempts.set(retry.round, retry.retry)
      const removed = new Set<number>()
      for (const [messageId, position] of commentaryPositions) {
        if (parseResponseMessageId(messageId)?.round === retry.round) removed.add(position)
      }
      // Retire only failed-stream commentary, retaining actual prior calls/results.
      observedItems = observedItems.filter((_, index) => !removed.has(index))
      for (const [messageId, position] of commentaryPositions) {
        if (removed.has(position)) commentaryPositions.delete(messageId)
        else {
          const offset = [...removed].filter((index) => index < position).length
          commentaryPositions.set(messageId, position - offset)
        }
      }
      for (const messageId of publicMessages.keys()) {
        if (parseResponseMessageId(messageId)?.round === retry.round)
          publicMessages.delete(messageId)
      }
      publish({ type: 'retry', event: retry })
    }
    const observeMessage = (event: Omit<AgentMessageEvent, 'requestId'>): void => {
      if (!active || signal.aborted) return
      const identity = parseResponseMessageId(event.messageId)
      if (
        !identity ||
        identity.round < latestResponseRound ||
        identity.attempt !== (roundAttempts.get(identity.round) ?? 0)
      )
        return
      latestResponseRound = identity.round
      const previous = publicMessages.get(event.messageId)
      if (previous?.phase === event.phase && previous.text === event.text) return
      if (previous && previous.phase !== event.phase) throw new AgentError('公开消息阶段不一致')
      if (event.phase === 'final_answer') {
        const finalTexts = [...publicMessages]
          .filter(
            ([messageId, message]) =>
              messageId !== event.messageId && message.phase === 'final_answer'
          )
          .map(([, message]) => message.text)
        finalTexts.push(event.text)
        if (finalTexts.join('\n').length > 16000)
          throw new AgentError('最终回答超过本轮显示长度上限')
      }
      if (event.phase === 'commentary') {
        const candidate: ProtocolItem[] =
          observedItems.length > 0 ? [...observedItems] : [{ role: 'user', content: prompt }]
        const position = commentaryPositions.get(event.messageId)
        if (position === undefined) {
          let pendingCall = false
          for (const item of candidate) {
            if (item.type === 'function_call') pendingCall = true
            else if (item.type === 'function_call_output') pendingCall = false
          }
          if (pendingCall) return
        }
        const message: ProtocolItem = {
          type: 'message',
          role: 'assistant',
          phase: 'commentary',
          content: [{ type: 'output_text', text: event.text }]
        }
        if (position === undefined) candidate.push(message)
        else candidate[position] = message
        const checked = parseIncompleteToolTurn(candidate, scope, prompt, mode)
        if (!checked) throw new AgentError('公开过程文字超过本轮保存上限')
        observedItems = checked
        if (position === undefined) commentaryPositions.set(event.messageId, candidate.length - 1)
      }
      publicMessages.set(event.messageId, { phase: event.phase, text: event.text })
      publish({ type: 'message', event: { requestId, ...event } })
    }
    const observeToolCall = (event: ToolCallEvent): void => {
      if (!active) return
      const candidate: ProtocolItem[] =
        observedItems.length > 0 ? [...observedItems] : [{ role: 'user', content: prompt }]
      if (event.phase === 'start') {
        if (event.commentary) {
          candidate.push({
            type: 'message',
            role: 'assistant',
            phase: 'commentary',
            content: [{ type: 'output_text', text: event.commentary }]
          })
        }
        candidate.push({
          type: 'function_call',
          call_id: event.callId,
          name: event.name,
          arguments: event.arguments
        })
      } else {
        candidate.push({
          type: 'function_call_output',
          call_id: event.callId,
          output: event.output
        })
      }
      const checked = parseIncompleteToolTurn(candidate, scope, prompt, mode)
      if (checked) observedItems = checked
      else if (event.phase === 'start')
        throw new AgentError('调用记录已超过本轮保存上限，未继续执行工具')
      else appendTrace('工具结果超过本轮保存上限：最后结果未保存')
      // A completed operation remains evidence even if cancellation raced its
      // return. Public delivery still stops immediately on the shared signal.
      publish({ type: 'tool', event: { requestId, ...event } })
    }
    const completed = await runToolLoop(
      prompt,
      (items, signal, options) => {
        assertCurrent()
        return send(items, signal, options)
      },
      signal,
      trace,
      progress,
      history,
      (name, args, signal, callId) => {
        assertCurrent()
        return execute(name, args, signal, callId)
      },
      scope,
      (delta) => publish({ type: 'delta', requestId, delta }),
      observeToolCall,
      observeMessage,
      mode,
      observeRetry,
      dependencies.summarize
        ? {
            summarize: dependencies.summarize,
            assertCurrent,
            imageIndices: [...new Set(input.imageHistory?.map((image) => image.index))],
            networkOverhead: dependencies.networkOverhead,
            onContext: (state) => {
              assertCurrent()
              const event = parseAgentContextEvent({ requestId, ...state })
              if (!event) throw new AgentError('上下文状态格式不正确')
              publish({ type: 'context', event })
            }
          }
        : undefined
    )
    assertCurrent()
    const needsApproval = completed.items.some(
      (item) => item.type === 'function_call' && item.name === 'propose_command'
    )
    task = {
      state: needsApproval ? 'waiting_approval' : 'completed',
      result: completed.answer
    }
    result = { status: 'done', answer: completed.answer, items: completed.items, trace }
  } catch (error) {
    const hasEffectRisk = effects.approved || effects.started
    if (
      hasEffectRisk &&
      !trace.some(
        (line) => line.startsWith('工作区操作已批准：') || line.startsWith('本地操作已开始：')
      )
    )
      appendTrace('本地操作已开始：结果待核对')
    const actionWarning = hasEffectRisk
      ? '本地操作可能已经执行。请先核对文件或命令结果，再决定是否重新请求。'
      : null
    const terminationWarning =
      error instanceof Error && error.message.includes('进程树是否退出未确认')
        ? error.message
        : null
    if (terminationWarning) appendTrace(`命令停止结果：${terminationWarning}`)
    if (signal.aborted) {
      task = {
        state: 'cancelled',
        error: ['用户已取消任务', terminationWarning, actionWarning].filter(Boolean).join('。')
      }
      result = { status: 'cancelled', trace, items: observedItems }
    } else {
      const message = [
        error instanceof AgentError ? error.message : '请求或工具处理失败，请检查网络和响应格式',
        actionWarning
      ]
        .filter(Boolean)
        .join('。')
      task = { state: 'failed', error: message }
      result = { status: 'error', error: message, trace, items: observedItems }
    }
  }
  const elapsedMs = Math.max(0, Math.round(performance.now() - startedAt))
  appendTrace(`用时：${elapsedMs}毫秒`)
  active = false
  return { result, task, effects, elapsedMs }
}
