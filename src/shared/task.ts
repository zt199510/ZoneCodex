/**
 * Persisted task lifecycle data. Runtime handles such as AbortController,
 * child processes, listeners, timers, grants and one-time execution IDs are
 * deliberately not represented by this type.
 */
export const taskKinds = ['chat', 'agent', 'command'] as const
export type TaskKind = (typeof taskKinds)[number]

export const taskStatuses = [
  'created',
  'running',
  'waiting_approval',
  'waiting_input',
  'completed',
  'cancelled',
  'failed',
  'timed_out',
  'interrupted'
] as const
export type TaskRecordStatus = (typeof taskStatuses)[number]

// Kept as an alias for callers that use the shorter status name.
export type TaskStatus = TaskRecordStatus

export type TaskRecord = {
  taskId: string
  requestId: string
  conversationId: string
  kind: TaskKind
  status: TaskRecordStatus
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  result: string | null
  error: string | null
}

type PlainRecord = Record<string, unknown>

const taskRecordKeys = [
  'taskId',
  'requestId',
  'conversationId',
  'kind',
  'status',
  'createdAt',
  'startedAt',
  'finishedAt',
  'result',
  'error'
] as const

const maxIdLength = 80
const maxTimestampLength = 40
const maxResultLength = 16_000
const maxErrorLength = 500
/** Maximum number of task records retained by a conversation/window. */
export const maxTaskRecords = 100

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
  try {
    const keys = Reflect.ownKeys(value)
    if (keys.some((key) => typeof key !== 'string')) return false
    const actual = keys as string[]
    return (
      actual.length === expected.length &&
      actual.every((key) => expected.includes(key)) &&
      expected.every((key) => actual.includes(key))
    )
  } catch {
    return false
  }
}

export function isTaskId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxIdLength &&
    /^[a-zA-Z0-9-]+$/.test(value)
  )
}

function isTaskKind(value: unknown): value is TaskKind {
  return typeof value === 'string' && (taskKinds as readonly string[]).includes(value)
}

function isTaskStatus(value: unknown): value is TaskRecordStatus {
  return typeof value === 'string' && (taskStatuses as readonly string[]).includes(value)
}

function isIsoTimestamp(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxTimestampLength ||
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

function isSafeText(value: unknown, maximum: number): value is string {
  if (typeof value !== 'string' || value.length > maximum) return false
  // Keep ordinary formatting whitespace, but reject other control characters.
  return !Array.from(value).some((character) => {
    const code = character.charCodeAt(0)
    return code < 9 || (code > 13 && code < 32) || code === 127
  })
}

function cloneTaskRecord(value: PlainRecord): TaskRecord {
  return {
    taskId: value.taskId as string,
    requestId: value.requestId as string,
    conversationId: value.conversationId as string,
    kind: value.kind as TaskKind,
    status: value.status as TaskRecordStatus,
    createdAt: value.createdAt as string,
    startedAt: value.startedAt as string | null,
    finishedAt: value.finishedAt as string | null,
    result: value.result as string | null,
    error: value.error as string | null
  }
}

/** Parse a single persisted task record. Unknown fields and accessors are rejected. */
export function parseTaskRecord(value: unknown): TaskRecord | null {
  try {
    if (
      !isPlainRecord(value) ||
      !hasExactKeys(value, taskRecordKeys) ||
      !isTaskId(value.taskId) ||
      !isTaskId(value.requestId) ||
      !isTaskId(value.conversationId) ||
      !isTaskKind(value.kind) ||
      !isTaskStatus(value.status) ||
      !isIsoTimestamp(value.createdAt) ||
      (value.startedAt !== null && !isIsoTimestamp(value.startedAt)) ||
      (value.finishedAt !== null && !isIsoTimestamp(value.finishedAt)) ||
      (value.result !== null && !isSafeText(value.result, maxResultLength)) ||
      (value.error !== null && !isSafeText(value.error, maxErrorLength))
    ) {
      return null
    }

    return cloneTaskRecord(value)
  } catch {
    return null
  }
}

/** Parse the bounded task list saved in a conversation snapshot. */
export function parseTaskRecords(value: unknown): TaskRecord[] | null {
  try {
    if (!Array.isArray(value) || value.length > maxTaskRecords) return null
    const taskIds = new Set<string>()
    const requestIds = new Set<string>()
    const records: TaskRecord[] = []
    for (const item of value) {
      const record = parseTaskRecord(item)
      if (!record || taskIds.has(record.taskId) || requestIds.has(record.requestId)) return null
      taskIds.add(record.taskId)
      requestIds.add(record.requestId)
      records.push(record)
    }
    return records
  } catch {
    return null
  }
}

export function parseTaskKind(value: unknown): TaskKind | null {
  return isTaskKind(value) ? value : null
}

export function parseTaskStatus(value: unknown): TaskRecordStatus | null {
  return isTaskStatus(value) ? value : null
}

export function isTerminalTaskStatus(status: TaskRecordStatus): boolean {
  return (
    status === 'completed' ||
    status === 'cancelled' ||
    status === 'failed' ||
    status === 'timed_out' ||
    status === 'interrupted'
  )
}
