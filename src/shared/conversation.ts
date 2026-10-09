import { getImageTurnNoticeCount, parseImageDescriptors, type ImageDescriptor } from './image-input'
import { parseAgentMode, type AgentMode } from './agent'

// 每轮用户消息随附的安全展示元数据；不包含文件正文、绝对根目录或授权标识。
export type ChatAttachment = {
  path: string
  bytes: number
  lines: number
}

// 聊天消息类型
export type ChatMessage = {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  status: 'pending' | 'complete' | 'failed' | 'cancelled'
  mode: AgentMode
  attachments?: ChatAttachment[]
  images?: ImageDescriptor[]
}

export function getMessageImages(message: Pick<ChatMessage, 'images'>): ImageDescriptor[] {
  if (Object.prototype.hasOwnProperty.call(message, 'image'))
    throw new Error('旧单图消息格式不受支持')
  return message.images ?? []
}
// 保存会话结果类型
export type SaveConversationResult = { ok: true } | { ok: false; error: string }

// 判断值是否为对象类型
function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== 'string') return false
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value')
  })
}

function isIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum
  )
}

function isSafeRelativePath(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 240 ||
    value.includes('\\') ||
    value.includes(':') ||
    value.startsWith('/') ||
    value.startsWith('\\')
  ) {
    return false
  }
  const parts = value.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return false
  if (
    parts.some((part) =>
      Array.from(part).some((character) => {
        const code = character.charCodeAt(0)
        return code < 32 || code === 127
      })
    )
  ) {
    return false
  }
  return true
}

function parseAttachments(value: unknown): ChatAttachment[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) return null
  const paths = new Set<string>()
  let totalBytes = 0
  const attachments: ChatAttachment[] = []
  for (const item of value) {
    if (!isRecord(item)) return null
    const keys = Object.keys(item)
    if (
      keys.length !== 3 ||
      !keys.includes('path') ||
      !keys.includes('bytes') ||
      !keys.includes('lines') ||
      !isSafeRelativePath(item.path) ||
      !isIntegerInRange(item.bytes, 0, 32768) ||
      !isIntegerInRange(item.lines, 1, 32769)
    ) {
      return null
    }
    const path = item.path.replace(/\\/g, '/')
    const key = path.toLowerCase()
    if (paths.has(key)) return null
    totalBytes += item.bytes
    if (totalBytes > 131072) return null
    paths.add(key)
    attachments.push({ path, bytes: item.bytes, lines: item.lines })
  }
  return attachments
}
// 解析当前消息数组；会话格式由会话库统一定义。
export function parseMessages(value: unknown): ChatMessage[] | null {
  if (!Array.isArray(value) || value.length > 1000) return null
  const messages: ChatMessage[] = []
  const ids = new Set<string>()
  let total = 0
  for (const item of value) {
    if (
      !isRecord(item) ||
      Object.keys(item).some(
        (key) => !['id', 'role', 'content', 'status', 'mode', 'attachments', 'images'].includes(key)
      ) ||
      typeof item.id !== 'string' ||
      !item.id ||
      item.id.length > 80 ||
      ids.has(item.id) ||
      typeof item.content !== 'string'
    )
      return null
    const { role, status, content, id } = item
    const mode = parseAgentMode(item.mode)
    if (!mode) return null
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
    let attachments: ChatAttachment[] | undefined
    let images: ImageDescriptor[] | undefined
    if (Object.prototype.hasOwnProperty.call(item, 'images')) {
      const parsed = parseImageDescriptors(item.images)
      if (role !== 'user' || !parsed || getImageTurnNoticeCount(content) !== parsed.length)
        return null
      images = parsed
    }
    if (role === 'user' && getImageTurnNoticeCount(content) !== (images?.length ?? null))
      return null
    if (Object.prototype.hasOwnProperty.call(item, 'attachments')) {
      if (role !== 'user') return null
      const parsed = parseAttachments(item.attachments)
      if (!parsed) return null
      attachments = parsed
    }
    total += content.length
    if (total > 1_000_000) return null
    ids.add(id)
    const previous = messages[messages.length - 1]
    if (role === 'assistant' && previous?.role === 'user' && previous.mode !== mode) return null
    messages.push({
      id,
      role,
      content,
      status,
      mode,
      ...(attachments ? { attachments } : {}),
      ...(images ? { images } : {})
    })
  }
  return messages
}
