import { maxConversationTitleLength } from './conversation-library'

export type ConversationTitleRequest = {
  requestId: string
  conversationId: string
  messageId: string
  content: string
}

export type ConversationTitleResult = {
  status: 'done'
  requestId: string
  conversationId: string
  messageId: string
  title: string
}

export type ConversationTitleOutcome =
  | ConversationTitleResult
  | { status: 'cancelled'; requestId: string }
  | { status: 'error'; requestId: string; error: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value)
  return (
    keys.length === expected.length &&
    keys.every((key) => expected.includes(key)) &&
    expected.every((key) => keys.includes(key))
  )
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(value)
}

function normalizeTitle(value: string): string {
  return value.replace(/\s+/gu, ' ').trim()
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0)
    return code < 0x20 || code === 0x7f
  })
}

export function parseConversationTitleRequest(value: unknown): ConversationTitleRequest | null {
  if (!isRecord(value)) return null
  if (
    !hasExactKeys(value, ['requestId', 'conversationId', 'messageId', 'content']) ||
    !isId(value.requestId) ||
    !isId(value.conversationId) ||
    !isId(value.messageId) ||
    typeof value.content !== 'string' ||
    !value.content.trim() ||
    value.content.length > 2_000
  ) {
    return null
  }
  return {
    requestId: value.requestId,
    conversationId: value.conversationId,
    messageId: value.messageId,
    content: value.content
  }
}

/** Validate and normalize the title payload returned by the real model. */
export function parseConversationTitleResult(value: unknown): ConversationTitleResult | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['status', 'requestId', 'conversationId', 'messageId', 'title']) ||
    value.status !== 'done' ||
    !isId(value.requestId) ||
    !isId(value.conversationId) ||
    !isId(value.messageId) ||
    typeof value.title !== 'string'
  ) {
    return null
  }
  if (hasControlCharacter(value.title)) return null
  const title = normalizeTitle(value.title)
  let isJsonShell = false
  if ((title.startsWith('{') && title.endsWith('}')) || (title.startsWith('[') && title.endsWith(']'))) {
    try {
      const decoded = JSON.parse(title) as unknown
      isJsonShell = typeof decoded === 'object' && decoded !== null
    } catch {
      // Braces can be part of an ordinary title; only reject valid nested JSON.
    }
  }
  if (
    !title ||
    title.length > maxConversationTitleLength ||
    title.includes('```') ||
    isJsonShell
  ) {
    return null
  }
  return {
    status: 'done',
    requestId: value.requestId,
    conversationId: value.conversationId,
    messageId: value.messageId,
    title
  }
}

export function parseConversationTitleOutcome(value: unknown): ConversationTitleOutcome | null {
  const result = parseConversationTitleResult(value)
  if (result) return result
  if (!isRecord(value) || !isId(value.requestId) || typeof value.status !== 'string') return null
  if (value.status === 'cancelled' && hasExactKeys(value, ['status', 'requestId']))
    return { status: 'cancelled', requestId: value.requestId }
  if (
    value.status === 'error' &&
    hasExactKeys(value, ['status', 'requestId', 'error']) &&
    typeof value.error === 'string' &&
    value.error.length <= 500
  ) {
    return { status: 'error', requestId: value.requestId, error: value.error }
  }
  return null
}
