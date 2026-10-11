import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { parseResumableHistory, type ProtocolItem } from '../../shared/agent-history'
import { parseAgentMode, type AgentMode } from '../../shared/agent'
import { parseToolScope, type ToolScope } from '../../shared/project'
import {
  parseTaskCheckpoint,
  TaskCheckpointError,
  type TaskCheckpoint,
  type TaskCheckpointErrorCode,
  type TaskCheckpointSummary,
  type TaskDirectoryBinding
} from '../../shared/task-checkpoint'

export type TaskCheckpointLoadOptions = {
  cwd?: string
  workspace?: string | null
  mode?: AgentMode
  /** Fresh host scope. Rebinding descriptors never reinstates authorization. */
  scope?: ToolScope
}

export type LoadedTaskCheckpoint = {
  checkpoint: TaskCheckpoint
  history: ProtocolItem[]
  requestId: string
  scope: ToolScope
  summary?: TaskCheckpointSummary
  resume: {
    taskId: string
    previousUpdatedAt: string
    summaryStatus: 'absent' | 'accepted' | 'discarded'
  }
}

export type TaskCheckpointSaveResult =
  | { ok: true; file: string; checkpoint: TaskCheckpoint }
  | { ok: false; code: TaskCheckpointErrorCode; error: string }

type CreateTaskCheckpointInput = {
  taskId: string
  conversationId?: string
  createdAt?: string
  mode: AgentMode
  prompt: string
  scope: ToolScope
  bindings: TaskCheckpoint['bindings']
  history: ProtocolItem[]
  summary?: TaskCheckpointSummary
  progress: TaskCheckpoint['progress']
  reason: TaskCheckpoint['reason']
}

const queues = new Map<string, Promise<unknown>>()

function serial<T>(file: string, work: () => Promise<T>): Promise<T> {
  const key = pathKey(file)
  const previous = queues.get(key) ?? Promise.resolve()
  const next = previous.then(work, work)
  const settled = next.catch(() => undefined)
  queues.set(key, settled)
  void settled.then(() => {
    if (queues.get(key) === settled) queues.delete(key)
  })
  return next
}

function pathKey(value: string): string {
  const absolute = resolve(value)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

function errno(error: unknown, code: string): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === code
}

/** Exact JSON hash matches the raw/working context source fingerprint convention. */
export function checkpointFingerprint(value: unknown): string {
  const encoded = JSON.stringify(value)
  if (typeof encoded !== 'string') throw new TaskCheckpointError('CHECKPOINT_INVALID')
  return createHash('sha256').update(encoded).digest('hex')
}

/** No I/O at import time; capture occurs only for an explicit save/load request. */
export async function captureTaskDirectoryBinding(path: string): Promise<TaskDirectoryBinding> {
  try {
    if (typeof path !== 'string' || !path.trim() || path.length > 4096) throw new Error()
    const selected = resolve(path)
    const canonical = await realpath(selected)
    const info = await stat(canonical)
    if (!info.isDirectory()) throw new Error()
    return {
      path: selected,
      realPath: canonical,
      identity: `${info.dev}:${info.ino}:${info.birthtimeMs}`
    }
  } catch {
    throw new TaskCheckpointError('DIRECTORY_MISSING')
  }
}

function checkedScope(value: unknown): ToolScope {
  // parseToolScope itself accepts legacy extra fields; checkpoint descriptors do not.
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TaskCheckpointError('SCOPE_MISMATCH')
  const allowed = ['kind', 'snapshotId', 'workspaceId', 'executionId']
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (
    Reflect.ownKeys(descriptors).some(
      (key) =>
        typeof key !== 'string' ||
        !allowed.includes(key) ||
        !descriptors[key].enumerable ||
        !('value' in descriptors[key])
    )
  )
    throw new TaskCheckpointError('SCOPE_MISMATCH')
  const scope = parseToolScope(value)
  if (!scope) throw new TaskCheckpointError('SCOPE_MISMATCH')
  return scope
}

function onlyFields(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key))
}

function safeProtocolMetadata(value: Record<string, unknown>): boolean {
  return (
    (!Object.hasOwn(value, 'id') ||
      (typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 200)) &&
    (!Object.hasOwn(value, 'status') ||
      value.status === 'completed' ||
      value.status === 'incomplete' ||
      value.status === 'in_progress')
  )
}

function safeAnnotations(value: unknown): boolean {
  if (!Array.isArray(value)) return false
  const allowed = [
    'type',
    'start_index',
    'end_index',
    'index',
    'url',
    'title',
    'file_id',
    'filename',
    'container_id'
  ]
  return value.every(
    (entry) =>
      entry !== null &&
      typeof entry === 'object' &&
      !Array.isArray(entry) &&
      onlyFields(entry, allowed) &&
      typeof entry.type === 'string' &&
      Object.values(entry).every(
        (field) =>
          typeof field === 'string' || (typeof field === 'number' && Number.isFinite(field))
      )
  )
}

function safeLogprob(value: unknown, top = false): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entry = value as Record<string, unknown>
  return (
    onlyFields(
      entry,
      top ? ['token', 'logprob', 'bytes'] : ['token', 'logprob', 'bytes', 'top_logprobs']
    ) &&
    typeof entry.token === 'string' &&
    typeof entry.logprob === 'number' &&
    Number.isFinite(entry.logprob) &&
    (entry.bytes === null ||
      (Array.isArray(entry.bytes) &&
        entry.bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255))) &&
    (top ||
      (Array.isArray(entry.top_logprobs) &&
        entry.top_logprobs.every((part) => safeLogprob(part, true))))
  )
}

function safeTextPart(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entry = value as Record<string, unknown>
  return (
    onlyFields(entry, ['type', 'text', 'annotations', 'logprobs']) &&
    (!Object.hasOwn(entry, 'annotations') || safeAnnotations(entry.annotations)) &&
    (!Object.hasOwn(entry, 'logprobs') ||
      entry.logprobs === null ||
      (Array.isArray(entry.logprobs) && entry.logprobs.every((part) => safeLogprob(part))))
  )
}

const privateFieldNames = new Set([
  'approval',
  'approvals',
  'approvaldecision',
  'approvaldecisions',
  'readcredential',
  'readcredentials',
  'commandticket',
  'commandtickets',
  'windowid',
  'job',
  'pty',
  'apikey',
  'authorization',
  'credentials',
  'hiddenreasoning',
  'httpbody',
  'requestbody',
  'responsebody',
  'dataurl'
])

function containsPrivateObject(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some(containsPrivateObject)
  return Object.entries(value).some(
    ([key, child]) =>
      privateFieldNames.has(key.replace(/_/g, '').toLowerCase()) || containsPrivateObject(child)
  )
}

/**
 * Preserve actual Responses protocol fields, including opaque encrypted_content,
 * without turning arbitrary appended host objects into a persistence channel.
 * Unknown fields are refused; original records are never edited to make them fit.
 */
function parseCheckpointRawHistory(
  value: unknown,
  scope: ToolScope,
  mode: AgentMode
): ProtocolItem[] | null {
  const history = parseResumableHistory(value, scope, mode)
  if (!history) return null
  if (containsPrivateObject(history)) return null
  for (const item of history) {
    if (!safeProtocolMetadata(item)) return null
    if (item.role === 'user') {
      if (!onlyFields(item, ['role', 'content'])) return null
    } else if (item.type === 'function_call') {
      if (!onlyFields(item, ['type', 'id', 'status', 'call_id', 'name', 'arguments'])) return null
    } else if (item.type === 'function_call_output') {
      if (!onlyFields(item, ['type', 'call_id', 'output'])) return null
    } else if (item.type === 'reasoning') {
      if (!onlyFields(item, ['type', 'id', 'status', 'summary', 'encrypted_content'])) return null
      if (
        !Array.isArray(item.summary) ||
        !item.summary.every(
          (part) =>
            part !== null &&
            typeof part === 'object' &&
            !Array.isArray(part) &&
            onlyFields(part, ['type', 'text'])
        )
      )
        return null
    } else if (item.type === 'message') {
      if (!onlyFields(item, ['type', 'id', 'status', 'role', 'phase', 'content'])) return null
      if (!Array.isArray(item.content) || !item.content.every(safeTextPart)) return null
    }
  }
  // Original image bytes are never checkpoint material. A literal data URL in
  // public task/tool text is also refused, without truncating or rewriting raw.
  if (/data:image\/[^;,]+;base64,/i.test(JSON.stringify(history))) return null
  return history
}

export function createTaskCheckpoint(input: CreateTaskCheckpointInput): TaskCheckpoint {
  const scope = checkedScope(input.scope)
  const history = parseCheckpointRawHistory(input.history, scope, input.mode)
  if (!history) throw new TaskCheckpointError('RAW_INVALID')
  const fingerprint = checkpointFingerprint(history)
  const now = new Date().toISOString()
  const checkpoint = parseTaskCheckpoint({
    schemaVersion: 1,
    taskId: input.taskId,
    ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
    createdAt: input.createdAt ?? now,
    updatedAt: now,
    mode: input.mode,
    prompt: input.prompt,
    scope,
    scopeFingerprint: checkpointFingerprint(scope),
    bindings: input.bindings,
    raw: {
      file: `raw-${fingerprint}.json`,
      fingerprint,
      items: history.length,
      characters: JSON.stringify(history).length
    },
    ...(input.summary === undefined ? {} : { summary: input.summary }),
    progress: input.progress,
    reason: input.reason
  })
  if (!checkpoint) throw new TaskCheckpointError('CHECKPOINT_INVALID')
  return checkpoint
}

async function verifyDirectory(saved: TaskDirectoryBinding, selected = saved.path): Promise<void> {
  const current = await captureTaskDirectoryBinding(selected)
  const original = await captureTaskDirectoryBinding(saved.path)
  if (
    pathKey(current.realPath) !== pathKey(saved.realPath) ||
    current.identity !== saved.identity ||
    pathKey(original.realPath) !== pathKey(saved.realPath) ||
    original.identity !== saved.identity
  )
    throw new TaskCheckpointError('DIRECTORY_DRIFT')
}

async function verifyBindings(
  checkpoint: TaskCheckpoint,
  options: TaskCheckpointLoadOptions = {}
): Promise<void> {
  await verifyDirectory(checkpoint.bindings.cwd, options.cwd)
  const savedWorkspace = checkpoint.bindings.workspace
  if (savedWorkspace) {
    if (options.workspace === null) throw new TaskCheckpointError('DIRECTORY_DRIFT')
    await verifyDirectory(savedWorkspace, options.workspace)
  } else if (options.workspace !== undefined && options.workspace !== null) {
    throw new TaskCheckpointError('DIRECTORY_DRIFT')
  }
}

async function readPlainFile(file: string, missing: TaskCheckpointErrorCode): Promise<Buffer> {
  const absolute = resolve(file)
  try {
    const info = await lstat(absolute)
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      pathKey(await realpath(absolute)) !== pathKey(absolute)
    )
      throw new TaskCheckpointError('STORAGE')
    return await readFile(absolute)
  } catch (cause) {
    if (cause instanceof TaskCheckpointError) throw cause
    throw new TaskCheckpointError(errno(cause, 'ENOENT') ? missing : 'STORAGE')
  }
}

async function readCheckpoint(file: string): Promise<TaskCheckpoint> {
  const bytes = await readPlainFile(file, 'CHECKPOINT_NOT_FOUND')
  if (bytes.length > 256000) throw new TaskCheckpointError('CHECKPOINT_INVALID')
  let value: unknown
  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new TaskCheckpointError('CHECKPOINT_INVALID')
  }
  if (value && typeof value === 'object' && 'schemaVersion' in value && value.schemaVersion !== 1)
    throw new TaskCheckpointError('CHECKPOINT_VERSION')
  const checkpoint = parseTaskCheckpoint(value)
  if (!checkpoint) throw new TaskCheckpointError('CHECKPOINT_INVALID')
  if (checkpointFingerprint(checkpoint.scope) !== checkpoint.scopeFingerprint)
    throw new TaskCheckpointError('SCOPE_MISMATCH')
  return checkpoint
}

async function readRaw(file: string, checkpoint: TaskCheckpoint): Promise<ProtocolItem[]> {
  let value: unknown
  try {
    const bytes = await readPlainFile(join(dirname(file), checkpoint.raw.file), 'RAW_MISSING')
    value = JSON.parse(bytes.toString('utf8'))
  } catch (cause) {
    if (cause instanceof TaskCheckpointError) throw cause
    throw new TaskCheckpointError('RAW_INVALID')
  }
  if (checkpointFingerprint(value) !== checkpoint.raw.fingerprint)
    throw new TaskCheckpointError('RAW_FINGERPRINT')
  const history = parseCheckpointRawHistory(value, checkpoint.scope, checkpoint.mode)
  if (
    !history ||
    history.length !== checkpoint.raw.items ||
    JSON.stringify(history).length !== checkpoint.raw.characters
  )
    throw new TaskCheckpointError('RAW_INVALID')
  return history
}

function rebindScope(saved: ToolScope, supplied?: ToolScope): ToolScope {
  if (supplied === undefined) return structuredClone(saved)
  const current = checkedScope(supplied)
  if (
    current.kind !== saved.kind ||
    (current.workspaceId !== undefined) !== (saved.workspaceId !== undefined) ||
    (current.executionId !== undefined) !== (saved.executionId !== undefined) ||
    (saved.kind === 'project' &&
      (current.kind !== 'project' || current.snapshotId !== saved.snapshotId))
  )
    throw new TaskCheckpointError('SCOPE_MISMATCH')
  return current
}

/** Read/validate the entire pointer before any host constructs a model transport. */
export async function loadTaskCheckpoint(
  file: string,
  options: TaskCheckpointLoadOptions = {}
): Promise<LoadedTaskCheckpoint> {
  const captured: TaskCheckpointLoadOptions = {
    cwd: options.cwd,
    workspace: options.workspace,
    mode: options.mode,
    scope: options.scope === undefined ? undefined : checkedScope(options.scope)
  }
  return serial(resolve(file), async () => {
    const checkpoint = await readCheckpoint(file)
    if (checkpoint.progress !== 'interrupted' && checkpoint.progress !== 'resumable')
      throw new TaskCheckpointError('NOT_RESUMABLE')
    if (captured.mode !== undefined && parseAgentMode(captured.mode) !== checkpoint.mode)
      throw new TaskCheckpointError('MODE_MISMATCH')
    const scope = rebindScope(checkpoint.scope, captured.scope)
    await verifyBindings(checkpoint, captured)
    const history = await readRaw(file, checkpoint)
    if (history.length) {
      let start = history.length - 1
      while (start > 0 && history[start].role !== 'user') start--
      const matchesTask = history[start].content === checkpoint.prompt.trim()
      const last = history[history.length - 1]
      const hasFinal = last.type === 'message' && last.phase !== 'commentary'
      // A stale "resumable" pointer after the final raw commit must never rerun
      // an already completed task. A pending turn must belong to this intent.
      if (hasFinal && matchesTask) throw new TaskCheckpointError('NOT_RESUMABLE')
      if (!hasFinal && !matchesTask) throw new TaskCheckpointError('RAW_INVALID')
    }
    // Source changes invalidate optional knowledge, never the authoritative raw.
    const summary = checkpoint.summary
    const accepted =
      summary !== undefined &&
      summary.sourceFingerprint === checkpoint.raw.fingerprint &&
      checkpointFingerprint(summary.content) === summary.contentHash
    return {
      checkpoint,
      history,
      requestId: randomUUID(),
      scope,
      ...(accepted ? { summary: structuredClone(summary) } : {}),
      resume: {
        taskId: checkpoint.taskId,
        previousUpdatedAt: checkpoint.updatedAt,
        summaryStatus: summary === undefined ? 'absent' : accepted ? 'accepted' : 'discarded'
      }
    }
  })
}

async function atomicWrite(file: string, text: string): Promise<void> {
  const directory = dirname(file)
  const temporary = join(directory, `checkpoint-${randomUUID()}.tmp`)
  try {
    await mkdir(directory, { recursive: true })
    await writeFile(temporary, text, { encoding: 'utf8', flag: 'wx' })
    await rename(temporary, file)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

/** Bad existing pointers/sidecars are deliberately left untouched. */
export async function saveTaskCheckpoint(
  file: string,
  supplied: TaskCheckpoint,
  rawHistory: ProtocolItem[]
): Promise<TaskCheckpointSaveResult> {
  const target = resolve(file)
  // Capture before the first await: a caller cannot mutate a queued write.
  const checkpoint = parseTaskCheckpoint(supplied)
  const history = checkpoint
    ? parseCheckpointRawHistory(rawHistory, checkpoint.scope, checkpoint.mode)
    : null
  return serial(target, async () => {
    try {
      if (!checkpoint) throw new TaskCheckpointError('CHECKPOINT_INVALID')
      if (
        !history ||
        checkpointFingerprint(history) !== checkpoint.raw.fingerprint ||
        history.length !== checkpoint.raw.items ||
        JSON.stringify(history).length !== checkpoint.raw.characters
      )
        throw new TaskCheckpointError('RAW_INVALID')
      if (checkpointFingerprint(checkpoint.scope) !== checkpoint.scopeFingerprint)
        throw new TaskCheckpointError('SCOPE_MISMATCH')
      await verifyBindings(checkpoint)
      let previous: TaskCheckpoint | null = null
      try {
        previous = await readCheckpoint(target)
      } catch (cause) {
        if (!(cause instanceof TaskCheckpointError) || cause.code !== 'CHECKPOINT_NOT_FOUND')
          throw cause
      }
      if (previous) {
        await verifyBindings(previous, {
          cwd: checkpoint.bindings.cwd.path,
          workspace: checkpoint.bindings.workspace?.path ?? null
        })
        rebindScope(previous.scope, checkpoint.scope)
        const original = await readRaw(target, previous)
        if (
          previous.taskId !== checkpoint.taskId ||
          previous.conversationId !== checkpoint.conversationId ||
          previous.createdAt !== checkpoint.createdAt ||
          Date.parse(previous.updatedAt) > Date.parse(checkpoint.updatedAt) ||
          previous.mode !== checkpoint.mode ||
          original.length > history.length ||
          checkpointFingerprint(history.slice(0, original.length)) !==
            checkpointFingerprint(original)
        )
          throw new TaskCheckpointError('RAW_INVALID')
      }
      const rawFile = join(dirname(target), checkpoint.raw.file)
      try {
        await readRaw(target, checkpoint)
      } catch (cause) {
        if (!(cause instanceof TaskCheckpointError) || cause.code !== 'RAW_MISSING') throw cause
        await atomicWrite(rawFile, JSON.stringify(history))
      }
      // Recheck before replacing the pointer; a newly damaged file is preserved.
      if (previous) {
        const rechecked = await readCheckpoint(target)
        if (checkpointFingerprint(rechecked) !== checkpointFingerprint(previous))
          throw new TaskCheckpointError('STORAGE')
        await readRaw(target, rechecked)
      } else {
        try {
          await readCheckpoint(target)
          throw new TaskCheckpointError('STORAGE')
        } catch (cause) {
          if (!(cause instanceof TaskCheckpointError) || cause.code !== 'CHECKPOINT_NOT_FOUND')
            throw cause
        }
      }
      await atomicWrite(target, JSON.stringify(checkpoint, null, 2))
      return { ok: true, file: target, checkpoint }
    } catch (cause) {
      const failure =
        cause instanceof TaskCheckpointError ? cause : new TaskCheckpointError('STORAGE')
      return { ok: false, code: failure.code, error: failure.message }
    }
  })
}

export function createTaskCheckpointStore(directory: string): {
  save: (
    checkpoint: TaskCheckpoint,
    history: ProtocolItem[],
    file?: string
  ) => Promise<TaskCheckpointSaveResult>
  inspect: (taskId: string) => Promise<TaskCheckpoint | null>
  findByConversation: (conversationId: string) => Promise<TaskCheckpoint | null>
  load: (taskId: string, options?: TaskCheckpointLoadOptions) => Promise<LoadedTaskCheckpoint>
} {
  const root = resolve(directory)
  const pathFor = (taskId: string): string => {
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(taskId)) throw new TaskCheckpointError('CHECKPOINT_INVALID')
    return join(root, `${taskId}.checkpoint.json`)
  }
  return {
    save: (checkpoint, history, file) =>
      saveTaskCheckpoint(
        file === undefined ? pathFor(checkpoint.taskId) : file,
        checkpoint,
        history
      ),
    inspect: (taskId) =>
      serial(pathFor(taskId), async () => {
        try {
          const checkpoint = await readCheckpoint(pathFor(taskId))
          if (checkpoint.taskId !== taskId) throw new TaskCheckpointError('CHECKPOINT_INVALID')
          return checkpoint
        } catch (cause) {
          if (cause instanceof TaskCheckpointError && cause.code === 'CHECKPOINT_NOT_FOUND')
            return null
          throw cause
        }
      }),
    findByConversation: async (conversationId) => {
      // Inventory is passive metadata only; it does not load raw, bind access or run a task.
      const { readdir } = await import('node:fs/promises')
      let files: string[]
      try {
        files = await readdir(root)
      } catch (cause) {
        if (errno(cause, 'ENOENT')) return null
        throw new TaskCheckpointError('STORAGE')
      }
      const candidates: TaskCheckpoint[] = []
      for (const name of files.sort()) {
        if (!/^[a-zA-Z0-9-]{1,80}\.checkpoint\.json$/.test(basename(name))) continue
        // An unrelated damaged pointer does not prevent passive discovery of this conversation.
        try {
          const checkpoint = await serial(join(root, name), () => readCheckpoint(join(root, name)))
          if (
            name === `${checkpoint.taskId}.checkpoint.json` &&
            checkpoint.conversationId === conversationId &&
            (checkpoint.progress === 'interrupted' || checkpoint.progress === 'resumable')
          )
            candidates.push(checkpoint)
        } catch {
          /* Keep damaged files intact for inspection; explicit load reports the public code. */
        }
      }
      return candidates.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null
    },
    load: async (taskId, options) => {
      const loaded = await loadTaskCheckpoint(pathFor(taskId), options)
      if (loaded.checkpoint.taskId !== taskId) throw new TaskCheckpointError('CHECKPOINT_INVALID')
      return loaded
    }
  }
}
