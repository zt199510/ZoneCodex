// 聊天消息类型
export type ChatMessage = {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  status: 'pending' | 'complete' | 'failed' | 'cancelled'
}
// 聊天消息快照类型
export type ConversationSnapshot = {
  version: 1
  messages: ChatMessage[]
  workspacePath: string | null
}
// 加载会话结果类型
export type LoadConversationResult =
  { ok: true; snapshot: ConversationSnapshot; missing: boolean } | { ok: false; error: string }
// 保存会话结果类型
export type SaveConversationResult = { ok: true } | { ok: false; error: string }

// 判断值是否为对象类型
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
// 解析会话快照
export function parseSnapshot(value: unknown): ConversationSnapshot | null {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !Array.isArray(value.messages) ||
    value.messages.length > 1000
  )
    return null
  const workspacePath = value.workspacePath
  if (workspacePath !== null && (typeof workspacePath !== 'string' || workspacePath.length > 4096))
    return null

  const messages: ChatMessage[] = []
  const ids = new Set<string>()
  let total = 0
  for (const item of value.messages) {
    if (
      !isRecord(item) ||
      typeof item.id !== 'string' ||
      !item.id ||
      item.id.length > 80 ||
      ids.has(item.id) ||
      typeof item.content !== 'string'
    )
      return null
    const { role, status, content, id } = item
    if (role !== 'user' && role !== 'assistant' && role !== 'system') return null
    if (
      status !== 'pending' &&
      status !== 'complete' &&
      status !== 'failed' &&
      status !== 'cancelled'
    )
      return null
    if (content.length > 100_000 || (role === 'user' && content.length > 4000)) return null
    if (status === 'complete' && !content.trim()) return null
    total += content.length
    if (total > 1_000_000) return null
    ids.add(id)
    messages.push({ id, role, content, status })
  }
  return { version: 1, messages, workspacePath }
}
