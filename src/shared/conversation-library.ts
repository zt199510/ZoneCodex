import { parseSnapshot } from './conversation'
import type { ChatMessage } from './conversation'
import { parseToolRuns, parseToolRunsV3 } from './agent-history'
import type { LegacyToolRun, ToolRun } from './agent-history'
import type { SavedWorkspace } from './project'
import { parseTaskRecords } from './task'
import type { TaskRecord } from './task'

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

/** The version 4 shape accepted only as a migration source. */
export type ConversationV4 = {
  id: string
  title: string
  messages: ChatMessage[]
  toolRuns: ToolRun[]
  workspace: SavedWorkspace | null
  tasks: TaskRecord[]
}

export type ConversationLibraryV4 = {
  version: 4
  activeConversationId: string | null
  conversations: ConversationV4[]
}

export type Conversation = ConversationV4 & {
  pinned: boolean
  archived: boolean
}

/** The version 5 shape accepted only as a migration source. */
export type ConversationLibraryV5 = {
  version: 5
  activeConversationId: string | null
  conversations: Conversation[]
}

export type ConversationLibrary = {
  version: 6
  activeConversationId: string | null
  conversations: Conversation[]
}

export const maxConversationTitleLength = 80

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
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 80
}

/** Generate a short deterministic title from the first user message. */
export function createConversationTitle(content: string): string {
  const normalized = content.replace(/\s+/gu, ' ').trim()
  if (!normalized) return ''
  const characters = Array.from(normalized)
  return characters.length > 40 ? `${characters.slice(0, 40).join('')}…` : normalized
}

/** Placeholder titles are eligible for automatic first-message naming. */
export function isPlaceholderConversationTitle(title: string): boolean {
  return /^新会话\s+\d+$/.test(title)
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
      item.title.length > maxConversationTitleLength
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

function parseWorkspace(value: unknown): SavedWorkspace | null | undefined {
  if (value === null) return null
  if (!isRecord(value)) return undefined
  if (
    !hasExactKeys(value, [
      'workspaceId',
      'root',
      'label',
      'instructionPath',
      'instructionFingerprint'
    ])
  )
    return undefined
  if (
    typeof value.workspaceId !== 'string' ||
    value.workspaceId.length < 1 ||
    value.workspaceId.length > 80 ||
    typeof value.root !== 'string' ||
    !value.root.trim() ||
    value.root.length > 4096 ||
    typeof value.label !== 'string' ||
    !value.label.trim() ||
    value.label.length > 80 ||
    (value.instructionPath !== null &&
      (typeof value.instructionPath !== 'string' || value.instructionPath.length > 4096)) ||
    (value.instructionFingerprint !== null &&
      (typeof value.instructionFingerprint !== 'string' ||
        !/^[a-f0-9]{64}$/i.test(value.instructionFingerprint)))
  )
    return undefined
  return {
    workspaceId: value.workspaceId,
    root: value.root,
    label: value.label,
    instructionPath: value.instructionPath as string | null,
    instructionFingerprint: value.instructionFingerprint as string | null
  }
}

function parseConversationProtocol(
  common: ReturnType<typeof parseCommonLibrary>,
  value: Record<string, unknown>
): ConversationV4[] | null {
  if (!common || !Array.isArray(value.conversations)) return null
  const conversations: ConversationV4[] = []
  let protocolLength = 0
  for (let index = 0; index < common.conversations.length; index++) {
    const raw = value.conversations[index]
    if (!isRecord(raw) || !('toolRuns' in raw)) return null
    const toolRuns = parseToolRuns(raw.toolRuns, common.conversations[index].messages)
    if (!toolRuns) return null
    protocolLength += serializedLength(toolRuns) ?? Number.POSITIVE_INFINITY
    if (protocolLength > 2_000_000) return null
    const workspace = 'workspace' in raw ? parseWorkspace(raw.workspace) : null
    if (workspace === undefined) return null
    let tasks: TaskRecord[] = []
    if ('tasks' in raw) {
      const parsedTasks = parseTaskRecords(raw.tasks)
      if (!parsedTasks) return null
      tasks = parsedTasks
    }
    conversations.push({
      ...common.conversations[index],
      toolRuns,
      workspace,
      tasks
    })
  }
  return conversations
}

/** Parse the version 4 shape before adding the version 5 metadata. */
export function parseLibraryV4(value: unknown): ConversationLibraryV4 | null {
  const common = parseCommonLibrary(value, 4)
  if (!common || !isRecord(value)) return null
  if (!hasExactKeys(value, libraryKeys) || !Array.isArray(value.conversations)) return null
  for (const raw of value.conversations) {
    if (
      !isRecord(raw) ||
      Object.keys(raw).some(
        (key) => !['id', 'title', 'messages', 'toolRuns', 'workspace', 'tasks'].includes(key)
      )
    )
      return null
  }
  const conversations = parseConversationProtocol(common, value)
  if (!conversations) return null
  const result: ConversationLibraryV4 = {
    version: 4,
    activeConversationId: common.activeConversationId,
    conversations
  }
  const snapshotLength = serializedLength(result)
  return snapshotLength !== null && snapshotLength <= 8_000_000 ? result : null
}

const libraryKeys = ['version', 'activeConversationId', 'conversations'] as const
const conversationKeys = [
  'id',
  'title',
  'pinned',
  'archived',
  'messages',
  'toolRuns',
  'workspace',
  'tasks'
] as const

function parseVersionedLibrary<Version extends 5 | 6>(
  value: unknown,
  version: Version
): { version: Version; activeConversationId: string | null; conversations: Conversation[] } | null {
  if (!isRecord(value) || !hasExactKeys(value, libraryKeys) || value.version !== version)
    return null
  if (!Array.isArray(value.conversations) || value.conversations.length > 100) return null

  const ids = new Set<string>()
  const conversations: Conversation[] = []
  let messageCount = 0
  let contentLength = 0
  let protocolLength = 0
  for (const raw of value.conversations) {
    if (!isRecord(raw) || !hasExactKeys(raw, conversationKeys)) return null
    if (
      !isId(raw.id) ||
      ids.has(raw.id) ||
      typeof raw.title !== 'string' ||
      !raw.title.trim() ||
      raw.title.length > maxConversationTitleLength ||
      typeof raw.pinned !== 'boolean' ||
      typeof raw.archived !== 'boolean'
    )
      return null
    const checked = parseSnapshot({ version: 1, messages: raw.messages, workspacePath: null })
    if (!checked) return null
    const toolRuns = parseToolRuns(raw.toolRuns, checked.messages)
    if (!toolRuns) return null
    const workspace = parseWorkspace(raw.workspace)
    if (workspace === undefined) return null
    const tasks = parseTaskRecords(raw.tasks)
    if (!tasks) return null
    messageCount += checked.messages.length
    contentLength += checked.messages.reduce((sum, message) => sum + message.content.length, 0)
    protocolLength += serializedLength(toolRuns) ?? Number.POSITIVE_INFINITY
    if (messageCount > 1000 || contentLength > 1_000_000 || protocolLength > 2_000_000) return null
    ids.add(raw.id)
    conversations.push({
      id: raw.id,
      title: raw.title,
      pinned: raw.pinned,
      archived: raw.archived,
      messages: checked.messages,
      toolRuns,
      workspace,
      tasks
    })
  }

  const activeId = value.activeConversationId
  if (activeId !== null && (!isId(activeId) || !ids.has(activeId))) return null
  if (
    activeId !== null &&
    conversations.find((conversation) => conversation.id === activeId)?.archived
  )
    return null
  const result = {
    version,
    activeConversationId: activeId,
    conversations
  }
  const snapshotLength = serializedLength(result)
  return snapshotLength !== null && snapshotLength <= 8_000_000 ? result : null
}

/** Parse the version 5 shape without restoring any runtime permission. */
export function parseLibraryV5(value: unknown): ConversationLibraryV5 | null {
  return parseVersionedLibrary(value, 5)
}

/** Parse the current strict version 6 shape. Tool scope IDs describe history only. */
export function parseLibrary(value: unknown): ConversationLibrary | null {
  return parseVersionedLibrary(value, 6)
}

function migrateConversations(
  conversations: ConversationV4[],
  activeConversationId: string | null
): ConversationLibrary | null {
  const migrated: ConversationLibrary = {
    version: 6,
    activeConversationId,
    conversations: conversations.map((conversation) => ({
      ...conversation,
      pinned: false,
      archived: false
    }))
  }
  return parseLibrary(migrated)
}

export function migrateV5(value: unknown): ConversationLibrary | null {
  const old = parseLibraryV5(value)
  return old ? parseLibrary({ ...old, version: 6 }) : null
}

export function migrateV4(value: unknown): ConversationLibrary | null {
  const old = parseLibraryV4(value)
  return old ? migrateConversations(old.conversations, old.activeConversationId) : null
}

export function migrateV3(value: unknown): ConversationLibrary | null {
  const old = parseLibraryV3(value)
  if (!old) return null
  return migrateConversations(
    old.conversations.map((conversation) => ({
      ...conversation,
      workspace: null,
      tasks: [],
      toolRuns: conversation.toolRuns.map((run) => ({ ...run, scope: { kind: 'time' as const } }))
    })),
    old.activeConversationId
  )
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
  const root = old.workspacePath
  // A legacy path is display metadata. Runtime directory grants must be acquired again.
  const workspace: SavedWorkspace | null = root?.trim()
    ? {
        workspaceId: conversationId,
        root,
        label: (root.split(/[\\/]/).filter(Boolean).at(-1) ?? root).slice(0, 80),
        instructionPath: null,
        instructionFingerprint: null
      }
    : null
  return migrateConversations(
    [
      {
        id: conversationId,
        title: '历史会话',
        messages: old.messages,
        toolRuns: [],
        workspace,
        tasks: []
      }
    ],
    conversationId
  )
}

export function readLibrary(
  value: unknown,
  legacyConversationId: string
): ConversationLibrary | null {
  if (!isRecord(value)) return null
  if (value.version === 6) return parseLibrary(value)
  if (value.version === 5) return migrateV5(value)
  if (value.version === 4) return migrateV4(value)
  if (value.version === 3) return migrateV3(value)
  if (value.version === 2) return migrateV2(value)
  if (value.version === 1) return migrateV1(value, legacyConversationId)
  return null
}

export function getActiveConversation(library: ConversationLibrary): Conversation | null {
  return (
    library.conversations.find(
      (item) => item.id === library.activeConversationId && !item.archived
    ) ?? null
  )
}

export type LoadLibraryResult =
  { ok: true; snapshot: ConversationLibrary; missing: boolean } | { ok: false; error: string }
