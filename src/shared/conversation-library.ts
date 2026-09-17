import { parseSnapshot } from './conversation'
import type { ChatMessage } from './conversation'
import { parseToolRuns, parseToolRunsV3 } from './agent-history'
import type { LegacyToolRun, ToolRun } from './agent-history'

export type ConversationV2 = {
  id: string
  title: string
  messages: ChatMessage[]
}

export type ConversationLibraryV2 = {
  version: 2
  activeConversationId: string | null
  conversations: ConversationV2[]
}

export type ConversationV3 = {
  id: string
  title: string
  messages: ChatMessage[]
  toolRuns: LegacyToolRun[]
}

export type ConversationLibraryV3 = {
  version: 3
  activeConversationId: string | null
  conversations: ConversationV3[]
}

export type Conversation = {
  id: string
  title: string
  messages: ChatMessage[]
  toolRuns: ToolRun[]
}

export type ConversationLibrary = {
  version: 4
  activeConversationId: string | null
  conversations: Conversation[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 80
}

function parseCommonLibrary(
  value: unknown,
  expectedVersion: 2 | 3 | 4
): {
  activeConversationId: string | null
  conversations: Array<{ id: string; title: string; messages: ChatMessage[] }>
} | null {
  if (
    !isRecord(value) ||
    value.version !== expectedVersion ||
    !Array.isArray(value.conversations) ||
    value.conversations.length > 100
  )
    return null

  const conversations: Array<{ id: string; title: string; messages: ChatMessage[] }> = []
  const ids = new Set<string>()
  let messageCount = 0
  let contentLength = 0
  for (const item of value.conversations) {
    if (
      !isRecord(item) ||
      !isId(item.id) ||
      ids.has(item.id) ||
      typeof item.title !== 'string' ||
      !item.title.trim() ||
      item.title.length > 80
    )
      return null

    const checked = parseSnapshot({
      version: 1,
      messages: item.messages,
      workspacePath: null
    })
    if (!checked) return null
    messageCount += checked.messages.length
    contentLength += checked.messages.reduce((sum, message) => sum + message.content.length, 0)
    if (messageCount > 1000 || contentLength > 1_000_000) return null
    ids.add(item.id)
    conversations.push({ id: item.id, title: item.title, messages: checked.messages })
  }

  const activeId = value.activeConversationId
  if (conversations.length === 0) {
    if (activeId !== null) return null
  } else if (!isId(activeId) || !ids.has(activeId)) {
    return null
  }
  return { activeConversationId: activeId as string | null, conversations }
}

export function parseLibraryV2(value: unknown): ConversationLibraryV2 | null {
  const common = parseCommonLibrary(value, 2)
  if (!common) return null
  return {
    version: 2,
    activeConversationId: common.activeConversationId,
    conversations: common.conversations
  }
}

function serializedLength(value: unknown): number | null {
  try {
    const text = JSON.stringify(value)
    return typeof text === 'string' ? text.length : null
  } catch {
    return null
  }
}

export function parseLibraryV3(value: unknown): ConversationLibraryV3 | null {
  const common = parseCommonLibrary(value, 3)
  if (!common || !isRecord(value) || !Array.isArray(value.conversations)) return null

  const conversations: ConversationV3[] = []
  let protocolLength = 0
  for (let index = 0; index < common.conversations.length; index++) {
    const raw = value.conversations[index]
    if (!isRecord(raw) || !('toolRuns' in raw)) return null
    const toolRuns = parseToolRunsV3(raw.toolRuns, common.conversations[index].messages)
    if (!toolRuns) return null
    protocolLength += serializedLength(toolRuns) ?? Number.POSITIVE_INFINITY
    if (protocolLength > 2_000_000) return null
    conversations.push({
      ...common.conversations[index],
      toolRuns
    })
  }

  const result: ConversationLibraryV3 = {
    version: 3,
    activeConversationId: common.activeConversationId,
    conversations
  }
  const snapshotLength = serializedLength(result)
  if (snapshotLength === null || snapshotLength > 8_000_000) return null
  return result
}

export function parseLibrary(value: unknown): ConversationLibrary | null {
  const common = parseCommonLibrary(value, 4)
  if (!common || !isRecord(value) || !Array.isArray(value.conversations)) return null

  const conversations: Conversation[] = []
  let protocolLength = 0
  for (let index = 0; index < common.conversations.length; index++) {
    const raw = value.conversations[index]
    if (!isRecord(raw) || !('toolRuns' in raw)) return null
    const toolRuns = parseToolRuns(raw.toolRuns, common.conversations[index].messages)
    if (!toolRuns) return null
    protocolLength += serializedLength(toolRuns) ?? Number.POSITIVE_INFINITY
    if (protocolLength > 2_000_000) return null
    conversations.push({
      ...common.conversations[index],
      toolRuns
    })
  }

  const result: ConversationLibrary = {
    version: 4,
    activeConversationId: common.activeConversationId,
    conversations
  }
  const snapshotLength = serializedLength(result)
  if (snapshotLength === null || snapshotLength > 8_000_000) return null
  return result
}

export function migrateV3(value: unknown): ConversationLibrary | null {
  const old = parseLibraryV3(value)
  if (!old) return null
  const migrated: ConversationLibrary = {
    version: 4,
    activeConversationId: old.activeConversationId,
    conversations: old.conversations.map((conversation) => ({
      ...conversation,
      toolRuns: conversation.toolRuns.map((run) => ({ ...run, scope: { kind: 'time' as const } }))
    }))
  }
  return parseLibrary(migrated)
}

export function migrateV2(value: unknown): ConversationLibrary | null {
  const old = parseLibraryV2(value)
  if (!old) return null
  return migrateV3({
    version: 3,
    activeConversationId: old.activeConversationId,
    conversations: old.conversations.map((conversation) => ({
      ...conversation,
      toolRuns: []
    }))
  })
}

export function migrateV1(value: unknown, conversationId: string): ConversationLibrary | null {
  const old = parseSnapshot(value)
  if (!old || !isId(conversationId)) return null
  return migrateV3({
    version: 3,
    activeConversationId: conversationId,
    conversations: [
      {
        id: conversationId,
        title: '历史会话',
        messages: old.messages,
        toolRuns: []
      }
    ]
  })
}

export function readLibrary(
  value: unknown,
  legacyConversationId: string
): ConversationLibrary | null {
  if (!isRecord(value)) return null
  if (value.version === 4) return parseLibrary(value)
  if (value.version === 3) return migrateV3(value)
  if (value.version === 2) return migrateV2(value)
  if (value.version === 1) return migrateV1(value, legacyConversationId)
  return null
}

export function getActiveConversation(library: ConversationLibrary): Conversation | null {
  return library.conversations.find((item) => item.id === library.activeConversationId) ?? null
}

export type LoadLibraryResult =
  { ok: true; snapshot: ConversationLibrary; missing: boolean } | { ok: false; error: string }
