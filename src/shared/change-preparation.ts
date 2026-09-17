import { isAgentId } from './agent'
import { parsePreviewChangeRequest, type PreviewChangeRequest } from './change-preview'

export type PreparationRequest = PreviewChangeRequest & {
  requestId: string
  callId: string
  // Unique per check; correlation IDs above can recur when reopening a suggestion.
  checkId: string
}
export type PreparationResult =
  | {
      status: 'ready'
      preparationId: string
      conversationId: string
      snapshotId: string
      path: string
      checkId: string
      bytes: number
      encoding: string
      newline: string
      expiresAt: number
    }
  | { status: 'conflict' | 'no_change' | 'unsupported' | 'error'; error: string }

function record(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return false
  const own = Reflect.ownKeys(value)
  return (
    own.length === keys.length &&
    own.every(
      (key) =>
        typeof key === 'string' &&
        keys.includes(key) &&
        'value' in Object.getOwnPropertyDescriptor(value, key)!
    )
  )
}

export function parsePreparationRequest(value: unknown): PreparationRequest | null {
  try {
    if (
      !record(value, [
        'conversationId',
        'snapshotId',
        'path',
        'proposedText',
        'requestId',
        'callId',
        'checkId'
      ]) ||
      !isAgentId(value.requestId) ||
      typeof value.callId !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,200}$/.test(value.callId) ||
      !isAgentId(value.checkId) ||
      typeof value.proposedText !== 'string' ||
      value.proposedText.length > 2000
    )
      return null
    const base = parsePreviewChangeRequest({
      conversationId: value.conversationId,
      snapshotId: value.snapshotId,
      path: value.path,
      proposedText: value.proposedText
    })
    if (!base || !/^file-[0-9a-f-]{36}\/[^/]+$/i.test(base.path)) return null
    return { ...base, requestId: value.requestId, callId: value.callId, checkId: value.checkId }
  } catch {
    return null
  }
}

export function parsePreparationResult(value: unknown): PreparationResult | null {
  try {
    if (!value || typeof value !== 'object') return null
    const status = Object.getOwnPropertyDescriptor(value, 'status')?.value
    if (['conflict', 'no_change', 'unsupported', 'error'].includes(status)) {
      if (
        !record(value, ['status', 'error']) ||
        typeof value.error !== 'string' ||
        !value.error ||
        value.error.length > 500
      )
        return null
      return { status, error: value.error }
    }
    if (
      status !== 'ready' ||
      !record(value, [
        'status',
        'preparationId',
        'conversationId',
        'snapshotId',
        'path',
        'checkId',
        'bytes',
        'encoding',
        'newline',
        'expiresAt'
      ])
    )
      return null
    if (
      !isAgentId(value.preparationId) ||
      !isAgentId(value.checkId) ||
      !isAgentId(value.conversationId) ||
      !isAgentId(value.snapshotId) ||
      typeof value.path !== 'string' ||
      value.path.length > 240 ||
      !/^file-[0-9a-f-]{36}\/[^/\\:]+$/i.test(value.path) ||
      typeof value.bytes !== 'number' ||
      !Number.isInteger(value.bytes) ||
      value.bytes < 0 ||
      value.bytes > 32768 ||
      typeof value.encoding !== 'string' ||
      value.encoding.length > 100 ||
      typeof value.newline !== 'string' ||
      value.newline.length > 100 ||
      typeof value.expiresAt !== 'number' ||
      !Number.isFinite(value.expiresAt)
    )
      return null
    return value as PreparationResult
  } catch {
    return null
  }
}
