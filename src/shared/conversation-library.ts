import { parseMessages, type ChatMessage } from './conversation'
import { parseToolRuns, type ToolRun } from './agent-history'
import type { SavedWorkspace } from './project'
import { isAbsoluteLocalDirectory } from './settings'
import { parseTaskRecords } from './task'
import type { TaskRecord } from './task'
import { parseAgentMode, type AgentMode } from './agent'

export type Conversation = {
  id: string
  title: string
  pinned: boolean
  archived: boolean
  defaultDirectory: string
  agentMode: AgentMode
  messages: ChatMessage[]
  toolRuns: ToolRun[]
  workspace: SavedWorkspace | null
  tasks: TaskRecord[]
}

export type ConversationLibrary = {
  version: 8
  activeConversationId: string | null
  conversations: Conversation[]
}

export const maxConversationTitleLength = 80

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

function serializedLength(value: unknown): number | null {
  try {
    const text = JSON.stringify(value)
    return typeof text === 'string' ? text.length : null
  } catch {
    return null
  }
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

const libraryKeys = ['version', 'activeConversationId', 'conversations'] as const
const conversationKeys = [
  'id',
  'title',
  'pinned',
  'archived',
  'defaultDirectory',
  'agentMode',
  'messages',
  'toolRuns',
  'workspace',
  'tasks'
] as const

/** Parse the only supported library format. Historical scopes never restore permissions. */
export function parseLibrary(value: unknown): ConversationLibrary | null {
  if (!isRecord(value) || !hasExactKeys(value, libraryKeys) || value.version !== 8) return null
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
      typeof raw.archived !== 'boolean' ||
      !isAbsoluteLocalDirectory(raw.defaultDirectory)
    )
      return null
    const messages = parseMessages(raw.messages)
    if (!messages) return null
    const agentMode = parseAgentMode(raw.agentMode)
    if (!agentMode) return null
    const toolRuns = parseToolRuns(raw.toolRuns, messages)
    if (!toolRuns) return null
    const workspace = parseWorkspace(raw.workspace)
    if (workspace === undefined) return null
    const tasks = parseTaskRecords(raw.tasks)
    if (!tasks) return null
    messageCount += messages.length
    contentLength += messages.reduce((sum, message) => sum + message.content.length, 0)
    protocolLength += serializedLength(toolRuns) ?? Number.POSITIVE_INFINITY
    if (messageCount > 1000 || contentLength > 1_000_000 || protocolLength > 2_000_000) return null
    ids.add(raw.id)
    conversations.push({
      id: raw.id,
      title: raw.title,
      pinned: raw.pinned,
      archived: raw.archived,
      defaultDirectory: raw.defaultDirectory,
      agentMode,
      messages,
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
  const result: ConversationLibrary = {
    version: 8,
    activeConversationId: activeId,
    conversations
  }
  const snapshotLength = serializedLength(result)
  return snapshotLength !== null && snapshotLength <= 8_000_000 ? result : null
}

export function readLibrary(value: unknown): ConversationLibrary | null {
  return parseLibrary(value)
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
