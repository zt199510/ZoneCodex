import { parseIncompleteToolTurn, parseProtocolTurn } from './agent-history'
import type { ProtocolItem } from './agent-history'
import type { ToolScope } from './project'

// 两种工作方式均使用真实模型 SSE，与执行批准方式独立。
export type AgentMode = 'execute' | 'plan'

export function parseAgentMode(value: unknown): AgentMode | null {
  return value === 'execute' || value === 'plan' ? value : null
}
// 统一模型与 Agent 的文字增量事件。Agent 通过同一 IPC 通道发送，
// 这样 renderer 不需要根据请求模式选择另一套消息更新协议。
export type AgentDelta = { requestId: string; delta: string }
export type AgentMessageEvent = {
  requestId: string
  messageId: string
  phase: 'commentary' | 'final_answer'
  text: string
}
export type AgentRetryEvent = {
  requestId: string
  round: number
  retry: number
  maxRetries: 5
  delayMs: number
  reason: 'http' | 'connection' | 'stream'
  status?: number
}

export function parseResponseMessageId(
  value: unknown
): { round: number; attempt: number; index: number } | null {
  if (typeof value !== 'string') return null
  const match = /^response-([1-9][0-9]{0,15})-attempt-([0-5])-message-([0-9]|[1-4][0-9])$/.exec(
    value
  )
  if (!match || match[0] !== value) return null
  const round = Number(match[1])
  return Number.isSafeInteger(round)
    ? { round, attempt: Number(match[2]), index: Number(match[3]) }
    : null
}

export function parseAgentRetryEvent(value: unknown): AgentRetryEvent | null {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return null
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const keys = Reflect.ownKeys(descriptors)
    if (
      keys.length < 6 ||
      keys.length > 7 ||
      keys.some(
        (key) =>
          typeof key !== 'string' ||
          !['requestId', 'round', 'retry', 'maxRetries', 'delayMs', 'reason', 'status'].includes(
            key
          ) ||
          !descriptors[key].enumerable ||
          !('value' in descriptors[key])
      )
    )
      return null
    const event = value as Record<string, unknown>
    if (
      !isAgentId(event.requestId) ||
      !Number.isSafeInteger(event.round) ||
      (event.round as number) < 1 ||
      !Number.isSafeInteger(event.retry) ||
      (event.retry as number) < 1 ||
      (event.retry as number) > 5 ||
      event.maxRetries !== 5 ||
      !Number.isSafeInteger(event.delayMs) ||
      (event.delayMs as number) < 0 ||
      (event.delayMs as number) > 2_147_483_647 ||
      !['http', 'connection', 'stream'].includes(event.reason as string) ||
      ('status' in event &&
        (!Number.isSafeInteger(event.status) ||
          (event.status as number) < 100 ||
          (event.status as number) > 599))
    )
      return null
    return {
      requestId: event.requestId,
      round: event.round as number,
      retry: event.retry as number,
      maxRetries: 5,
      delayMs: event.delayMs as number,
      reason: event.reason as AgentRetryEvent['reason'],
      ...(typeof event.status === 'number' ? { status: event.status } : {})
    }
  } catch {
    return null
  }
}
// Agent 请求的执行结果
export type AgentResult =
  | { status: 'done'; answer: string; trace: string[]; items: ProtocolItem[] }
  | { status: 'cancelled'; trace: string[]; items?: ProtocolItem[] }
  | { status: 'error'; error: string; trace: string[]; items?: ProtocolItem[] }

export type ToolCallEvent = { callId: string; name: string } & (
  | { phase: 'start'; arguments: string; commentary?: string }
  | { phase: 'finish'; output: string; durationMs: number }
)
export type AgentToolEvent = ToolCallEvent & { requestId: string }

export function parseAgentMessageEvent(value: unknown): AgentMessageEvent | null {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return null
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const keys = Reflect.ownKeys(descriptors)
    if (
      keys.length !== 4 ||
      keys.some(
        (key) =>
          typeof key !== 'string' ||
          !['requestId', 'messageId', 'phase', 'text'].includes(key) ||
          !descriptors[key].enumerable ||
          !('value' in descriptors[key])
      )
    )
      return null
    const event = value as Record<string, unknown>
    if (
      !isAgentId(event.requestId) ||
      typeof event.messageId !== 'string' ||
      !parseResponseMessageId(event.messageId) ||
      (event.phase !== 'commentary' && event.phase !== 'final_answer') ||
      typeof event.text !== 'string' ||
      event.text.length > 16000
    )
      return null
    return {
      requestId: event.requestId,
      messageId: event.messageId,
      phase: event.phase,
      text: event.text
    }
  } catch {
    return null
  }
}

// Transport validation identifies known tools; the executor and stored prefix
// independently enforce the active request's scope before any operation occurs.
const toolEventNames = new Set([
  'get_current_time',
  'request_user_input',
  'search_project_text',
  'read_project_file',
  'propose_file_change',
  'propose_command',
  'list_workspace_files',
  'search_workspace_text',
  'read_workspace_file',
  'create_workspace_file',
  'apply_workspace_patch',
  'run_workspace_command'
])

/** Patch text and JSON escaping need a larger envelope; other tools keep their existing limit. */
export function toolArgumentsLimit(name: unknown): number {
  return name === 'apply_workspace_patch' ? 12000 : 4096
}

export function parseAgentToolEvent(value: unknown): AgentToolEvent | null {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return null
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (
      Reflect.ownKeys(descriptors).some(
        (key) =>
          typeof key !== 'string' || !descriptors[key].enumerable || !('value' in descriptors[key])
      )
    )
      return null
    const event = value as Record<string, unknown>
    if (
      !isAgentId(event.requestId) ||
      typeof event.callId !== 'string' ||
      !event.callId ||
      event.callId.length > 200 ||
      typeof event.name !== 'string' ||
      !toolEventNames.has(event.name)
    )
      return null
    const identity = { requestId: event.requestId, callId: event.callId, name: event.name }
    if (event.phase === 'start') {
      if (
        Object.keys(event).some(
          (key) =>
            !['requestId', 'callId', 'name', 'phase', 'arguments', 'commentary'].includes(key)
        ) ||
        typeof event.arguments !== 'string' ||
        event.arguments.length > toolArgumentsLimit(event.name) ||
        ('commentary' in event &&
          (typeof event.commentary !== 'string' || event.commentary.length > 16000))
      )
        return null
      return {
        ...identity,
        phase: 'start',
        arguments: event.arguments,
        ...(typeof event.commentary === 'string' ? { commentary: event.commentary } : {})
      }
    }
    if (
      event.phase !== 'finish' ||
      Object.keys(event).some(
        (key) => !['requestId', 'callId', 'name', 'phase', 'output', 'durationMs'].includes(key)
      ) ||
      typeof event.output !== 'string' ||
      event.output.length > 12000 ||
      typeof event.durationMs !== 'number' ||
      !Number.isSafeInteger(event.durationMs) ||
      event.durationMs < 0
    )
      return null
    return { ...identity, phase: 'finish', output: event.output, durationMs: event.durationMs }
  } catch {
    return null
  }
}
// 判断是否为合法的 Agent ID
export function isAgentId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(value)
}
// 判断是否为合法的 Agent 结果
export function parseAgentResult(
  value: unknown,
  scope: ToolScope = { kind: 'time' },
  expectedPrompt?: string,
  mode: AgentMode = 'execute'
): AgentResult {
  if (!parseAgentMode(mode)) throw new Error('Agent 工作方式不正确')
  if (
    typeof value !== 'object' ||
    value === null ||
    !('status' in value) ||
    !('trace' in value) ||
    !Array.isArray(value.trace) ||
    value.trace.length > 30 ||
    !value.trace.every((line: unknown) => typeof line === 'string' && line.length <= 500)
  ) {
    throw new Error('Agent 结果格式不正确')
  }
  const trace: string[] = value.trace
  const readIncompleteItems = (): { items?: ProtocolItem[] } => {
    if (!('items' in value)) return {}
    const items = parseIncompleteToolTurn(value.items, scope, expectedPrompt, mode)
    if (!items) throw new Error('Agent 未完成调用记录格式不正确')
    return { items }
  }
  if (value.status === 'cancelled') return { status: 'cancelled', trace, ...readIncompleteItems() }
  if (
    value.status === 'done' &&
    'answer' in value &&
    typeof value.answer === 'string' &&
    value.answer.length <= 16000 &&
    'items' in value
  ) {
    const items = parseProtocolTurn(value.items, scope, mode)
    if (
      !items ||
      items[items.length - 1].type !== 'message' ||
      (expectedPrompt !== undefined && items[0].content !== expectedPrompt)
    ) {
      throw new Error('Agent 协议历史格式不正确')
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
      throw new Error('Agent 最终回答与协议历史不一致')
    }
    return { status: 'done', answer: value.answer, trace, items }
  }
  if (value.status === 'error' && 'error' in value && typeof value.error === 'string') {
    return { status: 'error', error: value.error, trace, ...readIncompleteItems() }
  }
  throw new Error('Agent 状态格式不正确')
}

//19课 1定义独立的进度事件
// Agent 请求的进度信息
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

// 解析统一文字增量；单片段限制与普通消息的 100,000 字符边界一致，
// Agent 最终答案的 16,000 字符限制仍由 AgentResult 协议解析负责。
export function parseAgentDelta(value: unknown): AgentDelta | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('requestId' in value) ||
    !isAgentId(value.requestId) ||
    !('delta' in value) ||
    typeof value.delta !== 'string' ||
    value.delta.length > 100_000
  ) {
    return null
  }
  return { requestId: value.requestId, delta: value.delta }
}
