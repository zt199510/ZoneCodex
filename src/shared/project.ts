export type ToolScope = { kind: 'time' } | { kind: 'project'; snapshotId: string }

export type ProjectSelection = {
  snapshotId: string
  label: string
  createdAt: string
  files: Array<{ path: string; bytes: number; lines: number }>
}

export type ProjectSelectionResult =
  | { status: 'selected'; selection: ProjectSelection }
  | { status: 'cancelled' }
  | { status: 'cleared' }
  | { status: 'error'; error: string }

export type AgentContext =
  | { kind: 'time' }
  | {
      kind: 'project'
      snapshotId: string
      conversationId: string
      allowUpload: boolean
    }

type PlainRecord = Record<string, unknown>

function isAgentId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(value)
}

const allowedExtensions = new Set([
  '.md',
  '.txt',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.json',
  '.css',
  '.html'
])
const blockedPathParts = new Set([
  'node_modules',
  'dist',
  'out',
  'build',
  'coverage',
  'package-lock.json'
])

function isPlainRecord(value: unknown): value is PlainRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasOwn(value: PlainRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function isIsoTimestamp(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length > 40 ||
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
  const time = Date.parse(value)
  return Number.isFinite(time)
}

function isIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum
  )
}

function isRelativeProjectPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 240) return false
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
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return false
  if (
    parts.some(
      (part) =>
        part.startsWith('.') ||
        /[. ]$/.test(part) ||
        blockedPathParts.has(part.toLowerCase()) ||
        /(^|[-_.])(secret|token|credential|password|private)([-_.]|$)/i.test(part)
    )
  ) {
    return false
  }
  const filename = parts[parts.length - 1].toLowerCase()
  const extensionIndex = filename.lastIndexOf('.')
  return extensionIndex > 0 && allowedExtensions.has(filename.slice(extensionIndex))
}

function cloneSelection(selection: ProjectSelection): ProjectSelection {
  return {
    snapshotId: selection.snapshotId,
    label: selection.label,
    createdAt: selection.createdAt,
    files: selection.files.map((file) => ({ ...file }))
  }
}

export function parseToolScope(value: unknown): ToolScope | null {
  try {
    if (!isPlainRecord(value) || typeof value.kind !== 'string') return null
    if (value.kind === 'time') {
      return hasOwn(value, 'snapshotId') ? null : { kind: 'time' }
    }
    if (value.kind === 'project' && isAgentId(value.snapshotId)) {
      return { kind: 'project', snapshotId: value.snapshotId }
    }
    return null
  } catch {
    return null
  }
}

export function parseAgentContext(value: unknown): AgentContext | null {
  try {
    if (!isPlainRecord(value) || typeof value.kind !== 'string') return null
    if (value.kind === 'time') {
      return Object.keys(value).length === 1 ? { kind: 'time' } : null
    }
    if (
      value.kind === 'project' &&
      Object.keys(value).length === 4 &&
      isAgentId(value.snapshotId) &&
      isAgentId(value.conversationId) &&
      typeof value.allowUpload === 'boolean'
    ) {
      return {
        kind: 'project',
        snapshotId: value.snapshotId,
        conversationId: value.conversationId,
        allowUpload: value.allowUpload
      }
    }
    return null
  } catch {
    return null
  }
}

export function sameToolScope(a: ToolScope, b: ToolScope): boolean {
  if (a.kind === 'time') return b.kind === 'time'
  return b.kind === 'project' && a.snapshotId === b.snapshotId
}

export function parseProjectSelectionResult(value: unknown): ProjectSelectionResult | null {
  try {
    if (!isPlainRecord(value) || typeof value.status !== 'string') return null
    if (value.status === 'cleared') return { status: 'cleared' }
    if (value.status === 'cancelled') return { status: 'cancelled' }
    if (value.status === 'error') {
      if (typeof value.error !== 'string' || !value.error.trim() || value.error.length > 500)
        return null
      return { status: 'error', error: value.error }
    }
    if (value.status !== 'selected' || !isPlainRecord(value.selection)) return null

    const raw = value.selection
    if (
      !isAgentId(raw.snapshotId) ||
      typeof raw.label !== 'string' ||
      !raw.label.trim() ||
      raw.label.length > 80 ||
      !isIsoTimestamp(raw.createdAt) ||
      !Array.isArray(raw.files) ||
      raw.files.length < 1 ||
      raw.files.length > 8
    ) {
      return null
    }

    const files: Array<{ path: string; bytes: number; lines: number }> = []
    const paths = new Set<string>()
    let totalBytes = 0
    for (const rawFile of raw.files) {
      if (!isPlainRecord(rawFile) || !isRelativeProjectPath(rawFile.path)) return null
      const normalizedPath = rawFile.path.replace(/\\/g, '/')
      const pathKey = normalizedPath.toLowerCase()
      if (paths.has(pathKey)) return null
      if (
        !isIntegerInRange(rawFile.bytes, 0, 32768) ||
        !isIntegerInRange(rawFile.lines, 1, 32769)
      ) {
        return null
      }
      totalBytes += rawFile.bytes
      if (totalBytes > 131072) return null
      paths.add(pathKey)
      files.push({ path: normalizedPath, bytes: rawFile.bytes, lines: rawFile.lines })
    }

    return {
      status: 'selected',
      selection: cloneSelection({
        snapshotId: raw.snapshotId,
        label: raw.label,
        createdAt: raw.createdAt,
        files
      })
    }
  } catch {
    return null
  }
}

// A single allowlist is shared by live execution and persisted protocol validation.
export function isToolAllowed(name: unknown, scope: ToolScope): name is string {
  return (
    name === 'get_current_time' ||
    (scope.kind === 'project' &&
      (name === 'search_project_text' ||
        name === 'read_project_file' ||
        name === 'propose_file_change'))
  )
}
