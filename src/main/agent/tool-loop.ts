import { executeTimeTool } from '../tools/current-time'
import { parseProtocolTurn } from '../../shared/agent-history'
import type { ProtocolItem } from '../../shared/agent-history'
import { parseToolScope, isToolAllowed } from '../../shared/project'
import type { ToolScope } from '../../shared/project'

export class AgentError extends Error {}
export type SendResponse = (input: unknown[], signal: AbortSignal) => Promise<unknown>
export type ExecuteTool = (
  name: string,
  argumentsText: string,
  signal: AbortSignal
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
  scope: ToolScope = { kind: 'time' }
): Promise<{ answer: string; items: ProtocolItem[] }> {
  const parsedScope = parseToolScope(scope)
  if (!parsedScope) throw new AgentError('工具范围参数无效')
  const checkedScope: ToolScope = parsedScope

  function record(message: string): void {
    const line = message.slice(0, 500)
    trace.push(line)
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

  function checkInputSize(): void {
    if (JSON.stringify(input).length > 128000) throw new AgentError('协议历史过长，任务已停止')
  }

  for (let round = 1; round <= 5; round++) {
    signal.throwIfAborted()
    checkInputSize()
    record(`第 ${round} 次模型请求`) // trace.push(`第 ${round} 次模型请求`)

    const response = await send(input, signal)
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
    for (const item of response.output) {
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
        for (const part of item.content) {
          if (!isRecord(part)) throw new AgentError('消息内容格式不正确')
          if (part.type === 'refusal') throw new AgentError('模型拒绝了本次请求')
          if (part.type === 'output_text') {
            if (typeof part.text !== 'string') throw new AgentError('输出文字格式不正确')
            if (item.phase === undefined || item.phase === 'final_answer') text.push(part.text)
          }
        }
      } else if (item.type !== 'reasoning') {
        throw new AgentError('本课不支持这种输出项，任务已停止')
      }
    }

    // 原样保留完整输出：工具项、reasoning、message 及其 phase 都不重建。
    input.push(...response.output)
    checkInputSize()
    if (calls.length === 0) {
      const answer = text.join('\n')
      if (!answer.trim() || answer.length > 16000) throw new AgentError('缺少有效的最终回答')
      const items = parseProtocolTurn(input.slice(turnStart), checkedScope)
      if (!items) throw new AgentError('本轮协议历史不完整或超过保存上限')
      record('获得最终回答')
      return { answer, items }
    }
    // parallel_tool_calls=false 的教学约束；网关违反约束时直接拒绝。
    if (calls.length !== 1) throw new AgentError('本课每轮只允许一个工具调用')
    if (round === 5 || toolCount >= 4) throw new AgentError('已达到调用上限，未继续执行工具')
    const call = calls[0]
    if (seenCalls.has(call.callId)) throw new AgentError('收到重复 call_id，未重复执行')
    if (!isToolAllowed(call.name, checkedScope))
      throw new AgentError('工具不在当前范围内，任务已停止')
    seenCalls.add(call.callId)
    signal.throwIfAborted()
    const output = await execute(call.name, call.arguments, signal)
    signal.throwIfAborted()
    if (typeof output !== 'string') throw new AgentError('工具结果格式不正确，任务已停止')
    if (output.length > 12000) throw new AgentError('工具结果过长，任务已停止')
    toolCount++
    record(`执行工具：${call.name}；call_id=${call.callId}`)
    record(`工具结果已生成（${output.length} 字符）`)
    input.push({ type: 'function_call_output', call_id: call.callId, output })
    checkInputSize()
  }
  throw new AgentError('任务未产生最终回答')
}
