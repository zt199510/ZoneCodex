import { parseProtocolTurn } from './agent-history'
import type { ProtocolItem } from './agent-history'
import type { ToolScope } from './project'

// 练习工具的模式
export type AgentMode = 'mock' | 'live'
// 练习工具的执行结果
export type AgentResult =
  | { status: 'done'; answer: string; trace: string[]; items: ProtocolItem[] }
  | { status: 'cancelled'; trace: string[] }
  | { status: 'error'; error: string; trace: string[] }
// 判断是否为合法的 Agent ID
export function isAgentId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(value)
}
// 判断是否为合法的 Agent 结果
export function parseAgentResult(value: unknown, scope: ToolScope = { kind: 'time' }): AgentResult {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('status' in value) ||
    !('trace' in value) ||
    !Array.isArray(value.trace) ||
    value.trace.length > 30 ||
    !value.trace.every((line: unknown) => typeof line === 'string' && line.length <= 500)
  ) {
    throw new Error('工具练习结果格式不正确')
  }
  const trace: string[] = value.trace
  if (value.status === 'cancelled') return { status: 'cancelled', trace }
  if (
    value.status === 'done' &&
    'answer' in value &&
    typeof value.answer === 'string' &&
    value.answer.length <= 16000 &&
    'items' in value
  ) {
    const items = parseProtocolTurn(value.items, scope)
    if (!items || items[items.length - 1].type !== 'message') {
      throw new Error('工具练习协议历史格式不正确')
    }
    const finalContent = items[items.length - 1].content
    const finalText = Array.isArray(finalContent)
      ? finalContent
          .filter(
            (part) =>
              typeof part === 'object' &&
              part !== null &&
              !Array.isArray(part) &&
              'type' in part &&
              part.type === 'output_text' &&
              'text' in part &&
              typeof part.text === 'string'
          )
          .map((part) => (part as { text: string }).text)
          .join('\n')
      : ''
    if (finalText !== value.answer) {
      throw new Error('工具练习最终回答与协议历史不一致')
    }
    return { status: 'done', answer: value.answer, trace, items }
  }
  if (value.status === 'error' && 'error' in value && typeof value.error === 'string') {
    return { status: 'error', error: value.error, trace }
  }
  throw new Error('工具练习状态格式不正确')
}

//19课 1定义独立的进度事件
// 练习工具的进度信息
export type AgentProgress = { requestId: string; message: string }
// 判断是否为合法的 Agent 进度信息
export function parseAgentProgress(value: unknown): AgentProgress | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('requestId' in value) ||
    !isAgentId(value.requestId) ||
    !('message' in value) ||
    typeof value.message !== 'string' ||
    value.message.length > 500
  )
    return null
  return { requestId: value.requestId, message: value.message }
}
