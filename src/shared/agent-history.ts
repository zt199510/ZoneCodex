import type { AgentMode } from './agent'
import type { ChatMessage } from './conversation'
import { parseToolScope, sameToolScope, isToolAllowed } from './project'
import type { ToolScope } from './project'

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export type ProtocolItem = { [key: string]: JsonValue }

export type ToolRun = {
  requestId: string
  userId: string
  assistantId: string
  mode: AgentMode
  scope: ToolScope
  trace: string[]
  items: ProtocolItem[]
}

export type LegacyToolRun = Omit<ToolRun, 'scope'>

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(value)
}

// 先检查 JSON 值，再序列化；不能让 JSON.stringify 静默丢掉 undefined 等非法值。
function cloneJsonArray(
  value: unknown,
  maxItems: number,
  maxLength: number,
  maxDepth = 30
): JsonValue[] | null {
  try {
    if (!Array.isArray(value) || value.length > maxItems) return null
    let budget = maxLength
    function check(item: unknown, depth: number): boolean {
      if (depth > maxDepth || --budget < 0) return false
      if (item === null || typeof item === 'boolean') return true
      if (typeof item === 'number') return Number.isFinite(item)
      if (typeof item === 'string') {
        budget -= item.length
        return budget >= 0
      }
      if (!Array.isArray(item) && !isRecord(item)) return false
      const descriptors = Object.getOwnPropertyDescriptors(item)
      const keys = Reflect.ownKeys(descriptors)
      if (Array.isArray(item) && keys.length !== item.length + 1) return false
      for (const key of keys) {
        if (Array.isArray(item) && key === 'length') continue
        if (typeof key !== 'string') return false
        if (Array.isArray(item) && !/^(0|[1-9]\d*)$/.test(key)) return false
        const descriptor = descriptors[key]
        if (!descriptor.enumerable || !('value' in descriptor)) return false
        if (!Array.isArray(item)) budget -= key.length
        if (budget < 0 || !check(descriptor.value, depth + 1)) return false
      }
      return true
    }
    if (!check(value, 0)) return null
    const text = JSON.stringify(value)
    return text.length <= maxLength ? (JSON.parse(text) as JsonValue[]) : null
  } catch {
    return null
  }
}

function finalText(items: readonly ProtocolItem[]): string {
  const parts: string[] = []
  for (const item of items) {
    if (
      item.type === 'message' &&
      (item.phase === undefined || item.phase === 'final_answer') &&
      Array.isArray(item.content)
    ) {
      for (const part of item.content) {
        if (isRecord(part) && part.type === 'output_text' && typeof part.text === 'string') {
          parts.push(part.text)
        }
      }
    }
  }
  return parts.join('\n')
}

// 只接受一轮完整的工具协议；返回深拷贝，保留 output 原有字段。
export function parseProtocolTurn(
  value: unknown,
  scope: ToolScope = { kind: 'time' }
): ProtocolItem[] | null {
  const checkedScope = parseToolScope(scope)
  if (!checkedScope) return null
  const items = cloneJsonArray(value, 160, 128000)
  if (!items || items.length < 2 || !items.every((item): item is ProtocolItem => isRecord(item)))
    return null
  const first = items[0]
  if (
    Object.keys(first).length !== 2 ||
    first.role !== 'user' ||
    typeof first.content !== 'string' ||
    !first.content.trim() ||
    first.content.length > 2000
  )
    return null

  const calls = new Set<string>()
  let pendingCall: string | null = null
  let hasFinal = false
  for (let index = 1; index < items.length; index++) {
    const item = items[index]
    if (item.role === 'user' || item.role === 'system' || item.role === 'developer') return null
    if (item.type === 'function_call') {
      if (
        hasFinal ||
        pendingCall !== null ||
        !isToolAllowed(item.name, checkedScope) ||
        typeof item.arguments !== 'string' ||
        item.arguments.length > 4096 ||
        typeof item.call_id !== 'string' ||
        !item.call_id ||
        item.call_id.length > 200 ||
        calls.has(item.call_id)
      )
        return null
      calls.add(item.call_id)
      pendingCall = item.call_id
    } else if (item.type === 'function_call_output') {
      if (pendingCall === null || item.call_id !== pendingCall || typeof item.output !== 'string') {
        return null
      }
      pendingCall = null
    } else if (item.type === 'reasoning') {
      if (
        !Array.isArray(item.summary) ||
        !item.summary.every(
          (part) => isRecord(part) && part.type === 'summary_text' && typeof part.text === 'string'
        ) ||
        ('encrypted_content' in item && typeof item.encrypted_content !== 'string')
      )
        return null
    } else if (item.type === 'message') {
      if (
        item.role !== 'assistant' ||
        !Array.isArray(item.content) ||
        !item.content.every(
          (part) => isRecord(part) && part.type === 'output_text' && typeof part.text === 'string'
        ) ||
        (item.phase !== undefined && item.phase !== 'commentary' && item.phase !== 'final_answer')
      )
        return null
      if (item.phase !== 'commentary') {
        if (pendingCall !== null) return null
        hasFinal = true
      } else if (hasFinal) return null
    } else return null
  }
  const last = items[items.length - 1]
  if (pendingCall !== null || last.type !== 'message' || last.phase === 'commentary') return null
  const answer = finalText(items)
  if (!answer.trim() || answer.length > 16000 || !finalText([last]).trim()) return null
  return items
}

// 多轮历史可以为空；每轮都必须完整，且整条历史不能复用 call_id。
export function parseToolHistory(
  value: unknown,
  scope: ToolScope = { kind: 'time' }
): ProtocolItem[] | null {
  const checkedScope = parseToolScope(scope)
  if (!checkedScope) return null
  const items = cloneJsonArray(value, 300, 64000)
  if (!items || !items.every((item): item is ProtocolItem => isRecord(item))) return null
  if (items.length === 0) return []
  const result: ProtocolItem[] = []
  const calls = new Set<string>()
  let start = 0
  for (let index = 1; index <= items.length; index++) {
    if (index < items.length && items[index].role !== 'user') continue
    const turn = parseProtocolTurn(items.slice(start, index), checkedScope)
    if (!turn) return null
    for (const item of turn) {
      if (item.type === 'function_call' && typeof item.call_id === 'string') {
        if (calls.has(item.call_id)) return null
        calls.add(item.call_id)
      }
    }
    result.push(...turn)
    start = index
  }
  return result
}

// messages 应先通过会话消息校验；这里检查工具轮次与消息的关联。
function parseToolRunsInternal(
  value: unknown,
  messages: readonly ChatMessage[],
  version: 3 | 4
): Array<ParsedToolRun> | null {
  if (!Array.isArray(value) || value.length > 100) return null
  const positions = new Map(messages.map((message, index) => [message.id, index]))
  if (positions.size !== messages.length) return null
  const requestIds = new Set<string>()
  const usedMessages = new Set<string>()
  const result: ParsedToolRun[] = []
  let previousIndex = -1
  for (const raw of value) {
    // 一轮的协议和 trace 均有界；JSON 校验同时拒绝访问器与非 JSON 字段。
    // 外层数组和 ToolRun 对象比协议数组多两层；协议本身仍由下面的解析器限深。
    const cloned = cloneJsonArray([raw], 1, 160000, 32)
    const item = cloned?.[0]
    if (!isRecord(item)) return null
    const scope =
      version === 3
        ? 'scope' in item
          ? null
          : ({ kind: 'time' } as ToolScope)
        : parseToolScope(item.scope)
    if (
      !isId(item.requestId) ||
      !isId(item.userId) ||
      !isId(item.assistantId) ||
      requestIds.has(item.requestId) ||
      usedMessages.has(item.userId) ||
      usedMessages.has(item.assistantId) ||
      (item.mode !== 'mock' && item.mode !== 'live') ||
      !Array.isArray(item.trace) ||
      item.trace.length > 30 ||
      !item.trace.every((line): line is string => typeof line === 'string' && line.length <= 500) ||
      !scope
    )
      return null
    const userIndex = positions.get(item.userId)
    if (userIndex === undefined || userIndex <= previousIndex) return null
    const user = messages[userIndex]
    const assistant = messages[userIndex + 1]
    if (
      user.role !== 'user' ||
      !assistant ||
      assistant.id !== item.assistantId ||
      assistant.role !== 'assistant' ||
      user.status !== assistant.status
    )
      return null
    let items: ProtocolItem[]
    if (user.status === 'complete') {
      const parsed = parseProtocolTurn(item.items, scope)
      if (
        !parsed ||
        parsed[0].content !== user.content ||
        finalText(parsed) !== assistant.content
      ) {
        return null
      }
      items = parsed
    } else {
      if (
        (user.status !== 'pending' && user.status !== 'failed' && user.status !== 'cancelled') ||
        !Array.isArray(item.items) ||
        item.items.length !== 0
      )
        return null
      items = []
    }
    requestIds.add(item.requestId)
    usedMessages.add(item.userId)
    usedMessages.add(item.assistantId)
    previousIndex = userIndex + 1
    result.push({
      requestId: item.requestId,
      userId: item.userId,
      assistantId: item.assistantId,
      mode: item.mode,
      scope,
      trace: item.trace,
      items
    })
  }
  return result
}

type ParsedToolRun = {
  requestId: string
  userId: string
  assistantId: string
  mode: AgentMode
  scope: ToolScope
  trace: string[]
  items: ProtocolItem[]
}

export function parseToolRunsV3(
  value: unknown,
  messages: readonly ChatMessage[]
): LegacyToolRun[] | null {
  const parsed = parseToolRunsInternal(value, messages, 3)
  return (
    parsed?.map((run) => ({
      requestId: run.requestId,
      userId: run.userId,
      assistantId: run.assistantId,
      mode: run.mode,
      trace: run.trace,
      items: run.items
    })) ?? null
  )
}

export function parseToolRuns(value: unknown, messages: readonly ChatMessage[]): ToolRun[] | null {
  return parseToolRunsInternal(value, messages, 4)
}

// 只接受完整的轮次；返回深拷贝，保留 output 原有字段。
export function selectToolHistory(
  messages: readonly ChatMessage[],
  runs: readonly ToolRun[],
  mode: AgentMode,
  scope: ToolScope = { kind: 'time' }
): ProtocolItem[] {
  const checkedScope = parseToolScope(scope)
  if (!checkedScope) throw new Error('工具范围无效，请重新选择工具模式。')
  const selected: ToolRun[] = []
  for (let index = messages.length - 1; index >= 1; index -= 2) {
    const assistant = messages[index]
    const user = messages[index - 1]
    const run = runs.find((item) => item.assistantId === assistant.id)
    if (
      assistant.role !== 'assistant' ||
      user.role !== 'user' ||
      assistant.status !== 'complete' ||
      user.status !== 'complete' ||
      !run ||
      run.userId !== user.id ||
      run.mode !== mode ||
      !sameToolScope(run.scope, checkedScope)
    )
      break
    selected.unshift(run)
  }
  const items = selected.flatMap((run) => run.items)
  if (items.length > 300 || JSON.stringify(items).length > 64000) {
    throw new Error('工具上下文已达到本课上限，请新建会话并重新说明问题。')
  }
  return structuredClone(items)
}
