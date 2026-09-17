import type { Conversation, ConversationLibrary } from '../../../../shared/conversation-library'

const MAX_MESSAGES = 1000
const MAX_TOOL_RUNS_PER_CONVERSATION = 100
const MAX_CONTENT_LENGTH = 1_000_000
const MAX_PROTOCOL_LENGTH = 2_000_000
const MAX_SNAPSHOT_BYTES = 8_000_000
const RESERVED_MESSAGES = 2
const RESERVED_TOOL_RUNS = 1
const RESERVED_CONTENT_LENGTH = 18_000
const RESERVED_PROTOCOL_LENGTH = 128_000
const RESERVED_SNAPSHOT_BYTES = 1_000_000
const CAPACITY_ERROR = '会话记录已接近保存上限，请新建会话或整理记录后再发送。'

function serializedLength(value: unknown): number | null {
  try {
    const text = JSON.stringify(value)
    return typeof text === 'string' ? text.length : null
  } catch {
    return null
  }
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

export function getCapacityError(
  snapshot: ConversationLibrary,
  active: Conversation,
  includeToolRun: boolean
): string | null {
  const messageCount = snapshot.conversations.reduce(
    (total, conversation) => total + conversation.messages.length,
    0
  )
  if (messageCount + RESERVED_MESSAGES > MAX_MESSAGES) return CAPACITY_ERROR

  if (
    includeToolRun &&
    active.toolRuns.length + RESERVED_TOOL_RUNS > MAX_TOOL_RUNS_PER_CONVERSATION
  )
    return CAPACITY_ERROR

  const contentLength = snapshot.conversations.reduce(
    (total, conversation) =>
      total + conversation.messages.reduce((sum, message) => sum + message.content.length, 0),
    0
  )
  if (contentLength + RESERVED_CONTENT_LENGTH > MAX_CONTENT_LENGTH) return CAPACITY_ERROR

  const protocolLength = snapshot.conversations.reduce((total, conversation) => {
    const length = serializedLength(conversation.toolRuns)
    return length === null ? Number.POSITIVE_INFINITY : total + length
  }, 0)
  if (includeToolRun && protocolLength + RESERVED_PROTOCOL_LENGTH > MAX_PROTOCOL_LENGTH)
    return CAPACITY_ERROR

  let snapshotText: string
  try {
    snapshotText = JSON.stringify(snapshot, null, 2)
  } catch {
    return CAPACITY_ERROR
  }
  if (utf8Length(snapshotText) + RESERVED_SNAPSHOT_BYTES > MAX_SNAPSHOT_BYTES) return CAPACITY_ERROR
  return null
}
