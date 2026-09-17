import type { ToolRun } from './agent-history'
import type { ChatMessage } from './conversation'

export type ChangeProposalArgs = {
  path: string
  proposedText: string
}

export type ChangeProposalOutput =
  | { status: 'proposal_ready'; path: string }
  | { status: 'error'; error: string }

export type MessageChangeProposal = {
  conversationId: string
  requestId: string
  assistantId: string
  callId: string
  snapshotId: string
  path: string
  proposedText: string
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string' || value.length > 4096) return null
  try {
    const parsed: unknown = JSON.parse(value)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

type PlainRecord = Record<string, unknown>

function isPlainRecord(value: unknown): value is PlainRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  try {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return false
    return Object.values(Object.getOwnPropertyDescriptors(value)).every(
      (descriptor) =>
        'value' in descriptor && descriptor.get === undefined && descriptor.set === undefined
    )
  } catch {
    return false
  }
}

function hasExactKeys(value: PlainRecord, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value)
  if (keys.some((key) => typeof key !== 'string')) return false
  const actual = keys as string[]
  return (
    actual.length === expected.length &&
    actual.every((key) => expected.includes(key)) &&
    expected.every((key) => actual.includes(key))
  )
}

function isBoundedString(value: unknown, maximum: number, allowEmpty = true): value is string {
  return typeof value === 'string' && value.length <= maximum && (allowEmpty || value.length > 0)
}

function isProposalPath(value: unknown): value is string {
  if (!isBoundedString(value, 240, false)) return false
  if (
    value.includes('\\') ||
    value.includes(':') ||
    value.startsWith('/') ||
    Array.from(value).some((character) => {
      const code = character.charCodeAt(0)
      return code < 32 || code === 127
    })
  ) {
    return false
  }
  const parts = value.split('/')
  return !parts.some((part) => part === '' || part === '.' || part === '..')
}

export function parseChangeProposalArgs(value: unknown): ChangeProposalArgs | null {
  try {
    if (
      !isPlainRecord(value) ||
      !hasExactKeys(value, ['path', 'proposedText']) ||
      !isProposalPath(value.path) ||
      !isBoundedString(value.proposedText, 2000)
    ) {
      return null
    }
    return { path: value.path, proposedText: value.proposedText }
  } catch {
    return null
  }
}

export function parseChangeProposalOutput(value: unknown): ChangeProposalOutput | null {
  try {
    if (!isPlainRecord(value) || typeof value.status !== 'string') return null
    if (value.status === 'proposal_ready') {
      return hasExactKeys(value, ['status', 'path']) && isProposalPath(value.path)
        ? { status: 'proposal_ready', path: value.path }
        : null
    }
    if (value.status === 'error') {
      return hasExactKeys(value, ['status', 'error']) && isBoundedString(value.error, 500, false)
        ? { status: 'error', error: value.error }
        : null
    }
    return null
  } catch {
    return null
  }
}

export function deriveMessageChangeProposal(
  conversationId: string,
  run: ToolRun,
  userMessage: ChatMessage | undefined,
  assistantMessage: ChatMessage | undefined
): MessageChangeProposal | null {
  if (
    !conversationId ||
    run.scope.kind !== 'project' ||
    !userMessage ||
    !assistantMessage ||
    userMessage.role !== 'user' ||
    assistantMessage.role !== 'assistant' ||
    userMessage.status !== 'complete' ||
    assistantMessage.status !== 'complete' ||
    run.userId !== userMessage.id ||
    run.assistantId !== assistantMessage.id
  ) {
    return null
  }

  const successful: MessageChangeProposal[] = []
  for (const item of run.items) {
    if (
      item.type !== 'function_call' ||
      item.name !== 'propose_file_change' ||
      typeof item.call_id !== 'string'
    ) {
      continue
    }
    const args = parseChangeProposalArgs(parseJsonObject(item.arguments))
    if (!args) continue
    const outputs = run.items.filter(
      (candidate) =>
        candidate.type === 'function_call_output' && candidate.call_id === item.call_id
    )
    if (outputs.length !== 1) continue
    const output = parseChangeProposalOutput(parseJsonObject(outputs[0].output))
    if (!output || output.status !== 'proposal_ready' || output.path !== args.path) continue
    successful.push({
      conversationId,
      requestId: run.requestId,
      assistantId: run.assistantId,
      callId: item.call_id,
      snapshotId: run.scope.snapshotId,
      path: args.path,
      proposedText: args.proposedText
    })
  }

  return successful.length === 1 ? successful[0] : null
}
