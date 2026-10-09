import { performance } from 'node:perf_hooks'
import { AgentError } from '../errors'
import type { SendResponse } from '../model/response-client'
import { executeTimeTool } from '../tools/current-time'
import { parseProtocolTurn } from '../../shared/agent-history'
import type { ProtocolItem } from '../../shared/agent-history'
import {
  parseAgentMode,
  type AgentMode,
  type AgentMessageEvent,
  type ToolCallEvent
} from '../../shared/agent'
import { parseToolScope, isToolAllowed } from '../../shared/project'
import type { ToolScope } from '../../shared/project'

export type ExecuteTool = (
  name: string,
  argumentsText: string,
  signal: AbortSignal,
  callId?: string
) => Promise<string>

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export async function runToolLoop(
  prompt: string,
  send: SendResponse,
  signal: AbortSignal,
  trace: string[],
  onProgress: (message: string) => void = () => undefined,
  history: ProtocolItem[] = [],
  execute: ExecuteTool = async (name, argumentsText, signal) => {
    signal.throwIfAborted()
    const output = executeTimeTool(name, argumentsText)
    signal.throwIfAborted()
    return output
  },
  scope: ToolScope = { kind: 'time' },
  onTextDelta: (delta: string) => void = () => undefined,
  onToolEvent: (event: ToolCallEvent) => void = () => undefined,
  onMessageEvent?: (event: Omit<AgentMessageEvent, 'requestId'>) => void,
  mode: AgentMode = 'execute'
): Promise<{ answer: string; items: ProtocolItem[] }> {
  if (!parseAgentMode(mode)) throw new AgentError('工作方式参数无效')
  const parsedScope = parseToolScope(scope)
  if (!parsedScope) throw new AgentError('工具范围参数无效')
  const checkedScope: ToolScope = parsedScope

  function record(message: string): void {
    const line = message.slice(0, 500)
    trace.push(line)
    if (trace.length > 30) trace.shift()
    onProgress(line)
  }

  const input: unknown[] = [...structuredClone(history), { role: 'user', content: prompt }]
  const turnStart = history.length
  const seenCalls = new Set<string>(
    history.flatMap((item) =>
      item.type === 'function_call' && typeof item.call_id === 'string' ? [item.call_id] : []
    )
  )
  let toolCount = 0
  const messageSnapshots = new Map<string, { phase: AgentMessageEvent['phase']; text: string }>()
  const publishMessage = (
    round: number,
    outputIndex: number,
    phase: AgentMessageEvent['phase'],
    text: string
  ): void => {
    if (!onMessageEvent) return
    if (
      !Number.isInteger(outputIndex) ||
      outputIndex < 0 ||
      outputIndex >= 50 ||
      (phase !== 'commentary' && phase !== 'final_answer') ||
      typeof text !== 'string' ||
      text.length > 16000
    )
      throw new AgentError('公开消息事件格式不正确')
    const messageId = `response-${round}-message-${outputIndex}`
    const previous = messageSnapshots.get(messageId)
    if (previous && previous.phase !== phase) throw new AgentError('公开消息阶段不一致')
    if (previous?.phase === phase && previous.text === text) return
    if (!previous && !text) return
    messageSnapshots.set(messageId, { phase, text })
    onMessageEvent({ messageId, phase, text })
  }

  function checkInputSize(): void {
    if (JSON.stringify(input).length > 128000) throw new AgentError('协议历史过长，任务已停止')
  }

  for (let round = 1; round <= 9; round++) {
    signal.throwIfAborted()
    checkInputSize()
    record(`第 ${round} 次模型请求`) // trace.push(`第 ${round} 次模型请求`)

    const response = await send(input, signal, {
      onTextDelta: (delta) => {
        onTextDelta(delta)
      },
      ...(onMessageEvent
        ? {
            onMessageEvent: (event) =>
              publishMessage(round, event.outputIndex, event.phase, event.text)
          }
        : {})
    })
    signal.throwIfAborted()
    if (
      !isRecord(response) ||
      response.status !== 'completed' ||
      !Array.isArray(response.output) ||
      response.output.length > 50
    ) {
      throw new AgentError('响应未完成或 output 格式不正确，未执行工具')
    }

    const calls: Array<{ callId: string; name: string; arguments: string }> = []
    const text: string[] = []
    const commentary: string[] = []
    const publicMessages: Array<{ outputIndex: number; phase: unknown; text: string }> = []
    for (const [outputIndex, item] of response.output.entries()) {
      if (!isRecord(item)) throw new AgentError('输出项不是对象')
      if (item.type === 'function_call') {
        if (
          typeof item.call_id !== 'string' ||
          !item.call_id ||
          item.call_id.length > 200 ||
          typeof item.name !== 'string' ||
          !item.name ||
          item.name.length > 80 ||
          typeof item.arguments !== 'string' ||
          item.arguments.length > 4096
        ) {
          throw new AgentError('工具调用字段无效')
        }
        calls.push({ callId: item.call_id, name: item.name, arguments: item.arguments })
      } else if (item.type === 'message') {
        if (item.role !== 'assistant' || !Array.isArray(item.content)) {
          throw new AgentError('助手消息格式不正确')
        }
        const messageText: string[] = []
        for (const part of item.content) {
          if (!isRecord(part)) throw new AgentError('消息内容格式不正确')
          if (part.type === 'refusal') throw new AgentError('模型拒绝了本次请求')
          if (part.type === 'output_text') {
            if (typeof part.text !== 'string') throw new AgentError('输出文字格式不正确')
            messageText.push(part.text)
            if (item.phase === undefined || item.phase === 'final_answer') text.push(part.text)
            else if (item.phase === 'commentary') commentary.push(part.text)
          }
        }
        publicMessages.push({ outputIndex, phase: item.phase, text: messageText.join('\n') })
      } else if (item.type !== 'reasoning') {
        throw new AgentError('本课不支持这种输出项，任务已停止')
      }
    }

    // Some gateways and offline callers provide only completed output. Replay
    // the same public snapshots before a tool starts, without altering history.
    for (const message of publicMessages) {
      if (
        message.phase === undefined ||
        message.phase === 'commentary' ||
        message.phase === 'final_answer'
      ) {
        publishMessage(
          round,
          message.outputIndex,
          message.phase === undefined
            ? (messageSnapshots.get(`response-${round}-message-${message.outputIndex}`)?.phase ??
                (calls.length > 0 ? 'commentary' : 'final_answer'))
            : message.phase,
          message.text
        )
      }
    }

    // 原样保留完整输出：工具项、reasoning、message 及其 phase 都不重建。
    input.push(...response.output)
    checkInputSize()
    if (calls.length === 0) {
      const answer = text.join('\n')
      if (!answer.trim() || answer.length > 16000) throw new AgentError('缺少有效的最终回答')
      const items = parseProtocolTurn(input.slice(turnStart), checkedScope, mode)
      if (!items) throw new AgentError('本轮协议历史不完整或超过保存上限')
      record('获得最终回答')
      return { answer, items }
    }
    // parallel_tool_calls=false 的教学约束；网关违反约束时直接拒绝。
    if (calls.length !== 1) throw new AgentError('本课每轮只允许一个工具调用')
    if (round === 9 || toolCount >= 8) throw new AgentError('已达到调用上限，未继续执行工具')
    const call = calls[0]
    if (seenCalls.has(call.callId)) throw new AgentError('收到重复 call_id，未重复执行')
    // The hidden-tool defense precedes tool events and all executor side effects.
    if (mode === 'plan' && !isToolAllowed(call.name, checkedScope, mode))
      throw new AgentError('计划模式只允许研究与读取，不能写入、运行命令或生成可执行提案')
    if (!isToolAllowed(call.name, checkedScope, mode))
      throw new AgentError('工具不在当前范围内，任务已停止')
    seenCalls.add(call.callId)
    signal.throwIfAborted()
    const visibleCommentary = commentary.join('\n')
    if (visibleCommentary.length > 16000) throw new AgentError('工具活动说明过长，未执行工具')
    onToolEvent({
      phase: 'start',
      callId: call.callId,
      name: call.name,
      arguments: call.arguments,
      ...(visibleCommentary && !onMessageEvent ? { commentary: visibleCommentary } : {})
    })
    const startedAt = performance.now()
    const output = await execute(call.name, call.arguments, signal, call.callId)
    if (typeof output !== 'string') throw new AgentError('工具结果格式不正确，任务已停止')
    if (output.length > 12000) throw new AgentError('工具结果过长，任务已停止')
    onToolEvent({
      phase: 'finish',
      callId: call.callId,
      name: call.name,
      output,
      durationMs: Math.max(0, Math.round(performance.now() - startedAt))
    })
    signal.throwIfAborted()
    toolCount++
    // 展示步骤只保留工具名称；call_id 属于协议内部标识，不应出现在聊天记录中。
    record(`执行工具：${call.name}`)
    record(`工具结果已生成（${output.length} 字符）`)
    input.push({ type: 'function_call_output', call_id: call.callId, output })
    checkInputSize()
  }
  throw new AgentError('任务未产生最终回答')
}
