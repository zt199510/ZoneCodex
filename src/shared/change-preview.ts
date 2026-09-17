import { isAgentId } from './agent'

export type PreviewChangeRequest = {
  conversationId: string
  snapshotId: string
  path: string
  proposedText: string
}

export type ChangePreview = {
  conversationId: string
  snapshotId: string
  path: string
  createdAt: string
  before: string
  after: string
}

export type PreviewChangeResult =
  { status: 'ready'; preview: ChangePreview } | { status: 'error'; error: string }

const maxIdLength = 80
const maxPathLength = 240
const maxTextLength = 32768
const maxErrorLength = 500
const maxTimestampLength = 40

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

function isPreviewPath(value: unknown): value is string {
  if (!isBoundedString(value, maxPathLength, false)) return false
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

function isIsoTimestamp(value: unknown): value is string {
  if (
    !isBoundedString(value, maxTimestampLength, false) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  ) {
    return false
  }
  const parts = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/
  )
  if (!parts) return false
  const year = Number(parts[1])
  const month = Number(parts[2])
  const day = Number(parts[3])
  const hour = Number(parts[4])
  const minute = Number(parts[5])
  const second = Number(parts[6])
  const offsetHour = parts[8] === undefined ? 0 : Number(parts[8])
  const offsetMinute = parts[9] === undefined ? 0 : Number(parts[9])
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth[month - 1] ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    return false
  }
  return Number.isFinite(Date.parse(value))
}

function isProtocolId(value: unknown): value is string {
  return isAgentId(value) && value.length <= maxIdLength
}

function parseChangePreview(value: unknown): ChangePreview | null {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, [
      'conversationId',
      'snapshotId',
      'path',
      'createdAt',
      'before',
      'after'
    ]) ||
    !isProtocolId(value.conversationId) ||
    !isProtocolId(value.snapshotId) ||
    !isPreviewPath(value.path) ||
    !isIsoTimestamp(value.createdAt) ||
    !isBoundedString(value.before, maxTextLength) ||
    !isBoundedString(value.after, maxTextLength)
  ) {
    return null
  }
  return {
    conversationId: value.conversationId,
    snapshotId: value.snapshotId,
    path: value.path,
    createdAt: value.createdAt,
    before: value.before,
    after: value.after
  }
}

export function parsePreviewChangeRequest(value: unknown): PreviewChangeRequest | null {
  try {
    if (
      !isPlainRecord(value) ||
      !hasExactKeys(value, ['conversationId', 'snapshotId', 'path', 'proposedText']) ||
      !isProtocolId(value.conversationId) ||
      !isProtocolId(value.snapshotId) ||
      !isPreviewPath(value.path) ||
      !isBoundedString(value.proposedText, maxTextLength)
    ) {
      return null
    }
    return {
      conversationId: value.conversationId,
      snapshotId: value.snapshotId,
      path: value.path,
      proposedText: value.proposedText
    }
  } catch {
    return null
  }
}

export function parsePreviewChangeResult(value: unknown): PreviewChangeResult | null {
  try {
    if (!isPlainRecord(value) || typeof value.status !== 'string') return null
    if (value.status === 'error') {
      if (
        !hasExactKeys(value, ['status', 'error']) ||
        !isBoundedString(value.error, maxErrorLength, false)
      ) {
        return null
      }
      return { status: 'error', error: value.error }
    }
    if (value.status !== 'ready' || !hasExactKeys(value, ['status', 'preview'])) return null
    const preview = parseChangePreview(value.preview)
    return preview ? { status: 'ready', preview } : null
  } catch {
    return null
  }
}
