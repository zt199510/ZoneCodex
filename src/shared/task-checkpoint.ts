import { parseAgentMode, type AgentMode } from './agent'
import { parseToolScope, type ToolScope } from './project'
import { parseSkillSnapshot, type SkillSnapshot } from './skills'

export const taskCheckpointSchemaVersion = 1 as const
export const taskCheckpointProgress = [
  'interrupted',
  'resumable',
  'completed',
  'abandoned'
] as const
export const taskCheckpointReasons = [
  'user_cancelled',
  'host_exit',
  'budget_stop',
  'failure',
  'saved',
  'completed',
  'abandoned'
] as const

/** Directory identity is a drift check, never a persisted grant. */
export type TaskDirectoryBinding = { path: string; realPath: string; identity: string }
export type TaskCheckpointSummary = {
  sourceFingerprint: string
  contentHash: string
  content: string
  workingItems: number
  workingCharacters: number
}

/**
 * A separate v1 pointer, independent from the v9 conversation library. Every
 * field is public task data. Credentials, approvals, command tickets, window /
 * process handles, image bytes and HTTP bodies have no schema field.
 * Raw protocol lives in a separately validated immutable sidecar.
 */
export type TaskCheckpoint = {
  schemaVersion: 1
  taskId: string
  conversationId?: string
  createdAt: string
  updatedAt: string
  mode: AgentMode
  prompt: string
  scope: ToolScope
  scopeFingerprint: string
  bindings: { cwd: TaskDirectoryBinding; workspace: TaskDirectoryBinding | null }
  raw: { file: string; fingerprint: string; items: number; characters: number }
  summary?: TaskCheckpointSummary
  skill?: SkillSnapshot
  progress: (typeof taskCheckpointProgress)[number]
  reason: (typeof taskCheckpointReasons)[number]
}

export type TaskCheckpointErrorCode =
  | 'CHECKPOINT_NOT_FOUND'
  | 'CHECKPOINT_INVALID'
  | 'CHECKPOINT_VERSION'
  | 'RAW_MISSING'
  | 'RAW_INVALID'
  | 'RAW_FINGERPRINT'
  | 'MODE_MISMATCH'
  | 'SCOPE_MISMATCH'
  | 'DIRECTORY_MISSING'
  | 'DIRECTORY_DRIFT'
  | 'NOT_RESUMABLE'
  | 'STORAGE'

const errors: Record<TaskCheckpointErrorCode, string> = {
  CHECKPOINT_NOT_FOUND: '未找到任务续接记录。',
  CHECKPOINT_INVALID: '任务续接记录格式无效，原文件已保留。',
  CHECKPOINT_VERSION: '不支持此任务续接版本，原文件已保留。',
  RAW_MISSING: '任务原记录缺失，未开始续接。',
  RAW_INVALID: '任务原记录不完整或无效，未开始续接。',
  RAW_FINGERPRINT: '任务原记录指纹不一致，未开始续接。',
  MODE_MISMATCH: '任务工作方式不一致，未开始续接。',
  SCOPE_MISMATCH: '任务工具范围不一致，未开始续接。',
  DIRECTORY_MISSING: '任务绑定目录不可访问，未开始续接。',
  DIRECTORY_DRIFT: '任务绑定目录已变化，未开始续接。',
  NOT_RESUMABLE: '此任务已完成或放弃，不能继续。',
  STORAGE: '任务续接记录读写失败，原文件已保留。'
}

export class TaskCheckpointError extends Error {
  constructor(public readonly code: TaskCheckpointErrorCode) {
    super(errors[code])
    this.name = 'TaskCheckpointError'
  }
}

function record(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = []
): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const keys = Reflect.ownKeys(descriptors)
  return (
    required.every((key) => Object.hasOwn(descriptors, key)) &&
    keys.every(
      (key) =>
        typeof key === 'string' &&
        (required.includes(key) || optional.includes(key)) &&
        descriptors[key].enumerable &&
        'value' in descriptors[key]
    )
  )
}

function id(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(value)
}

function hash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function count(value: unknown, maximum = 2147483647): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= maximum
}

function path(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 4096 &&
    !Array.from(value).some((character) => {
      const code = character.charCodeAt(0)
      return code < 32 || code === 127
    }) &&
    (/^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('/'))
  )
}

function timestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  )
}

function binding(value: unknown): value is TaskDirectoryBinding {
  return (
    record(value, ['path', 'realPath', 'identity']) &&
    path(value.path) &&
    path(value.realPath) &&
    typeof value.identity === 'string' &&
    /^\d+:\d+:\d+(?:\.\d+)?$/.test(value.identity)
  )
}

export function parseTaskCheckpointSummary(value: unknown): TaskCheckpointSummary | null {
  try {
    if (
      !record(value, [
        'sourceFingerprint',
        'contentHash',
        'content',
        'workingItems',
        'workingCharacters'
      ]) ||
      !hash(value.sourceFingerprint) ||
      !hash(value.contentHash) ||
      typeof value.content !== 'string' ||
      !value.content.trim() ||
      value.content.length > 20000 ||
      !count(value.workingItems) ||
      !count(value.workingCharacters, 128000) ||
      /data:image\/[^;,]+;base64,/i.test(value.content)
    )
      return null
    return structuredClone(value) as TaskCheckpointSummary
  } catch {
    return null
  }
}

/** Parse only metadata; disk/source fingerprints are checked by the shared loader. */
export function parseTaskCheckpoint(value: unknown): TaskCheckpoint | null {
  try {
    if (
      !record(
        value,
        [
          'schemaVersion',
          'taskId',
          'createdAt',
          'updatedAt',
          'mode',
          'prompt',
          'scope',
          'scopeFingerprint',
          'bindings',
          'raw',
          'progress',
          'reason'
        ],
        ['conversationId', 'summary', 'skill']
      ) ||
      value.schemaVersion !== taskCheckpointSchemaVersion ||
      !id(value.taskId) ||
      (Object.hasOwn(value, 'conversationId') && !id(value.conversationId)) ||
      !timestamp(value.createdAt) ||
      !timestamp(value.updatedAt) ||
      Date.parse(value.updatedAt) < Date.parse(value.createdAt) ||
      !parseAgentMode(value.mode) ||
      typeof value.prompt !== 'string' ||
      !value.prompt.trim() ||
      value.prompt.length > 2000 ||
      !hash(value.scopeFingerprint) ||
      !taskCheckpointProgress.includes(value.progress as TaskCheckpoint['progress']) ||
      !taskCheckpointReasons.includes(value.reason as TaskCheckpoint['reason'])
    )
      return null
    const scopeFields = ['kind']
    if (!record(value.scope, scopeFields, ['snapshotId', 'workspaceId', 'executionId'])) return null
    const scope = parseToolScope(value.scope)
    if (!scope) return null
    if (
      !record(value.bindings, ['cwd', 'workspace']) ||
      !binding(value.bindings.cwd) ||
      (value.bindings.workspace !== null && !binding(value.bindings.workspace)) ||
      !record(value.raw, ['file', 'fingerprint', 'items', 'characters']) ||
      !hash(value.raw.fingerprint) ||
      value.raw.file !== `raw-${value.raw.fingerprint}.json` ||
      !count(value.raw.items) ||
      !count(value.raw.characters) ||
      value.raw.characters < 2
    )
      return null
    if (Object.hasOwn(value, 'summary')) {
      if (!parseTaskCheckpointSummary(value.summary)) return null
    }
    if (Object.hasOwn(value, 'skill') && !parseSkillSnapshot(value.skill)) return null
    // Checkpoint metadata must never contain an inline original image.
    if (/data:image\/[^;,]+;base64,/i.test(JSON.stringify(value))) return null
    return structuredClone({ ...value, scope }) as TaskCheckpoint
  } catch {
    return null
  }
}
