import { isAgentId } from './agent'

export const maxFileViewBytes = 1024 * 1024
export const maxFileViewLines = 20000

export type FileReference = { path: string; startLine?: number; endLine?: number }
export type FileViewSource =
  | { kind: 'local'; workspaceId?: string; executionId?: string }
  | { kind: 'snapshot'; snapshotId: string }
export type FileViewRequest = {
  requestId: string
  conversationId: string
  reference: FileReference
  source: FileViewSource
}
export type FileViewResult = FileViewRequest &
  (
    | {
        status: 'ready'
        path: string
        fileName: string
        text: string
        bytes: number
        lineCount: number
      }
    | { status: 'error'; error: string }
  )

export function hasFileViewControlCharacters(text: string, allowWhitespace = false): boolean {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (
      (code < 32 || code === 127) &&
      !(allowWhitespace && (code === 9 || code === 10 || code === 13))
    )
      return true
  }
  return false
}

function record(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return (
    (prototype === Object.prototype || prototype === null) &&
    Reflect.ownKeys(value).every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      return typeof key === 'string' && descriptor && 'value' in descriptor
    })
  )
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Reflect.ownKeys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  )
}

function pathString(value: unknown, maximum = 512): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    !hasFileViewControlCharacters(value)
  )
}

export function isAbsoluteFilePath(path: string): boolean {
  return /^[a-z]:[\\/]/i.test(path) || path.startsWith('/') || path.startsWith('\\\\')
}

export function splitFileViewLines(text: string): string[] {
  return text.split(/\r\n|\n|\r/)
}

export function parseFileReference(value: unknown): FileReference | null {
  if (!record(value) || !pathString(value.path)) return null
  const keys = ['path']
  if (Object.hasOwn(value, 'startLine')) keys.push('startLine')
  if (Object.hasOwn(value, 'endLine')) keys.push('endLine')
  if (!exact(value, keys)) return null
  const line = (input: unknown): input is number =>
    typeof input === 'number' && Number.isSafeInteger(input) && input > 0
  if (Object.hasOwn(value, 'startLine') && !line(value.startLine)) return null
  if (
    Object.hasOwn(value, 'endLine') &&
    (!line(value.endLine) || !line(value.startLine) || value.endLine < value.startLine)
  )
    return null
  return {
    path: value.path,
    ...(line(value.startLine) ? { startLine: value.startLine } : {}),
    ...(line(value.endLine) ? { endLine: value.endLine } : {})
  }
}

/** Only explicit link destinations are parsed; ordinary prose and code remain literal. */
export function parseFileReferenceLink(value: unknown): FileReference | null {
  if (typeof value !== 'string' || !value || value.length > 2048 || value.startsWith('#'))
    return null
  let path = value
  let startLine: number | undefined
  let endLine: number | undefined
  const suffix = path.match(/(?:#L([0-9]+)(?:-L([0-9]+))?|:([0-9]+))$/)
  if (suffix) {
    path = path.slice(0, suffix.index)
    startLine = Number(suffix[1] ?? suffix[3])
    if (suffix[2] !== undefined) endLine = Number(suffix[2])
  }
  // A fragment is not a file reference. Malformed line suffixes never become other paths.
  if (path.includes('#') || path.includes('?') || /:[^/\\]*$/.test(path.replace(/^[a-z]:/i, '')))
    return null
  try {
    path = decodeURIComponent(path)
  } catch {
    return null
  }
  // Codex file links may use /D:/... as their absolute Windows destination.
  // Normalize that explicit drive form before the existing local path checks.
  if (/^\/[a-z]:[\\/]/i.test(path)) path = path.slice(1)
  if (
    !pathString(path) ||
    path.startsWith('//') ||
    path.startsWith('\\\\') ||
    (/^[a-z][a-z0-9+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path))
  )
    return null
  return parseFileReference({
    path,
    ...(startLine !== undefined ? { startLine } : {}),
    ...(endLine !== undefined ? { endLine } : {})
  })
}

function parseSource(value: unknown): FileViewSource | null {
  if (!record(value)) return null
  if (
    value.kind === 'snapshot' &&
    exact(value, ['kind', 'snapshotId']) &&
    isAgentId(value.snapshotId)
  )
    return { kind: 'snapshot', snapshotId: value.snapshotId }
  if (value.kind !== 'local') return null
  const keys = ['kind']
  if (Object.hasOwn(value, 'workspaceId')) keys.push('workspaceId')
  if (Object.hasOwn(value, 'executionId')) keys.push('executionId')
  if (!exact(value, keys) || (Object.hasOwn(value, 'workspaceId') && !isAgentId(value.workspaceId)))
    return null
  if (
    Object.hasOwn(value, 'executionId') &&
    (typeof value.executionId !== 'string' || !/^[a-f0-9]{64}$/.test(value.executionId))
  )
    return null
  return {
    kind: 'local',
    ...(typeof value.workspaceId === 'string' ? { workspaceId: value.workspaceId } : {}),
    ...(typeof value.executionId === 'string' ? { executionId: value.executionId } : {})
  }
}

export function parseFileViewRequest(value: unknown): FileViewRequest | null {
  if (
    !record(value) ||
    !exact(value, ['requestId', 'conversationId', 'reference', 'source']) ||
    !isAgentId(value.requestId) ||
    !isAgentId(value.conversationId)
  )
    return null
  const reference = parseFileReference(value.reference)
  const source = parseSource(value.source)
  return reference && source
    ? { requestId: value.requestId, conversationId: value.conversationId, reference, source }
    : null
}

export function sameFileViewRequest(a: FileViewRequest, b: FileViewRequest): boolean {
  return (
    a.requestId === b.requestId &&
    a.conversationId === b.conversationId &&
    a.reference.path === b.reference.path &&
    a.reference.startLine === b.reference.startLine &&
    a.reference.endLine === b.reference.endLine &&
    a.source.kind === b.source.kind &&
    (a.source.kind === 'snapshot' && b.source.kind === 'snapshot'
      ? a.source.snapshotId === b.source.snapshotId
      : a.source.kind === 'local' &&
        b.source.kind === 'local' &&
        a.source.workspaceId === b.source.workspaceId &&
        a.source.executionId === b.source.executionId)
  )
}

export function parseFileViewResult(value: unknown): FileViewResult | null {
  if (!record(value)) return null
  const request = parseFileViewRequest({
    requestId: value.requestId,
    conversationId: value.conversationId,
    reference: value.reference,
    source: value.source
  })
  if (!request) return null
  const common = ['requestId', 'conversationId', 'reference', 'source', 'status']
  if (
    value.status === 'error' &&
    exact(value, [...common, 'error']) &&
    typeof value.error === 'string' &&
    value.error.length > 0 &&
    value.error.length <= 500
  )
    return { ...request, status: 'error', error: value.error }
  if (
    value.status !== 'ready' ||
    !exact(value, [...common, 'path', 'fileName', 'text', 'bytes', 'lineCount']) ||
    !pathString(value.path, 4096) ||
    !pathString(value.fileName) ||
    typeof value.text !== 'string' ||
    value.text.length > maxFileViewBytes ||
    hasFileViewControlCharacters(value.text, true) ||
    typeof value.bytes !== 'number' ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 0 ||
    value.bytes > maxFileViewBytes ||
    typeof value.lineCount !== 'number' ||
    value.lineCount < 1 ||
    value.lineCount > maxFileViewLines ||
    value.lineCount !== splitFileViewLines(value.text).length
  )
    return null
  const encodedBytes = new TextEncoder().encode(value.text).byteLength
  if (
    encodedBytes > maxFileViewBytes ||
    (value.bytes !== encodedBytes && value.bytes !== encodedBytes + 3) ||
    value.fileName !== value.path.split(/[\\/]/).at(-1) ||
    (request.source.kind === 'snapshot'
      ? value.path !== request.reference.path
      : !isAbsoluteFilePath(value.path))
  )
    return null
  return {
    ...request,
    status: 'ready',
    path: value.path,
    fileName: value.fileName,
    text: value.text,
    bytes: value.bytes,
    lineCount: value.lineCount
  }
}
