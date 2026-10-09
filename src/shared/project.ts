import { parseExecutionInfo, type ExecutionInfo } from './execution'
import { parseAgentMode, type AgentMode } from './agent'
import {
  parseImageReferences,
  parseImageHistoryReferences,
  maxRequestImages,
  type ImageReference,
  type ImageHistoryReference
} from './image-input'

export type ToolScope =
  | { kind: 'time'; workspaceId?: string; executionId?: string }
  | { kind: 'project'; snapshotId: string; workspaceId?: string; executionId?: string }

/** 当前窗口的项目上下文。目录授权和文件快照仍由主进程单独维护。 */
export type Workspace = {
  workspaceId: string
  root: string
  label: string
  snapshotId: string | null
  instruction: ProjectInstruction | null
}

export type ProjectInstruction = {
  path: string
  content: string
  fingerprint: string
  truncated: boolean
}

/** 可写入会话库的展示信息；不包含目录 grant、preparedId 或执行 ID。 */
export type SavedWorkspace = {
  workspaceId: string
  root: string
  label: string
  instructionPath: string | null
  instructionFingerprint: string | null
}

export type TaskStatus =
  'idle' | 'running' | 'waiting_approval' | 'completed' | 'cancelled' | 'failed'

export type PermissionStatus = 'unscoped' | 'scoped' | 'expired' | 'revoked'

export type WorkspaceInstructionResult =
  | { status: 'absent' }
  | { status: 'read'; instruction: ProjectInstruction }
  | { status: 'error'; error: string }

export type WorkspaceSelectionResult =
  | { status: 'selected'; workspace: Workspace }
  | { status: 'cancelled' }
  | { status: 'cleared' }
  | { status: 'error'; error: string }

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

export type AgentRequestContext = {
  conversationId: string
  mode: AgentMode
  workspaceId?: string
  attachment?: { snapshotId: string; allowUpload: true }
  images?: ImageReference[]
  imageHistory?: ImageHistoryReference[]
  execution?: ExecutionInfo
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

function cloneInstruction(instruction: ProjectInstruction): ProjectInstruction {
  return {
    path: instruction.path,
    content: instruction.content,
    fingerprint: instruction.fingerprint,
    truncated: instruction.truncated
  }
}

function cloneWorkspace(workspace: Workspace): Workspace {
  return {
    workspaceId: workspace.workspaceId,
    root: workspace.root,
    label: workspace.label,
    snapshotId: workspace.snapshotId,
    instruction: workspace.instruction ? cloneInstruction(workspace.instruction) : null
  }
}

export function parseToolScope(value: unknown): ToolScope | null {
  try {
    if (!isPlainRecord(value) || typeof value.kind !== 'string') return null
    if (hasOwn(value, 'workspaceId') && !isAgentId(value.workspaceId)) return null
    if (
      hasOwn(value, 'executionId') &&
      (typeof value.executionId !== 'string' || !/^[a-f0-9]{64}$/.test(value.executionId))
    )
      return null
    const workspace = hasOwn(value, 'workspaceId')
      ? { workspaceId: value.workspaceId as string }
      : {}
    const execution = hasOwn(value, 'executionId')
      ? { executionId: value.executionId as string }
      : {}
    if (value.kind === 'time') {
      return hasOwn(value, 'snapshotId') ? null : { kind: 'time', ...workspace, ...execution }
    }
    if (value.kind === 'project' && isAgentId(value.snapshotId)) {
      return { kind: 'project', snapshotId: value.snapshotId, ...workspace, ...execution }
    }
    return null
  } catch {
    return null
  }
}

export function parseAgentRequestContext(value: unknown): AgentRequestContext | null {
  try {
    if (
      !isPlainRecord(value) ||
      Reflect.ownKeys(value).some((key) => {
        if (typeof key !== 'string') return true
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        return descriptor?.enumerable !== true || !Object.hasOwn(descriptor, 'value')
      }) ||
      !isAgentId(value.conversationId)
    )
      return null
    if (
      Object.keys(value).some(
        (key) =>
          key !== 'conversationId' &&
          key !== 'mode' &&
          key !== 'workspaceId' &&
          key !== 'attachment' &&
          key !== 'images' &&
          key !== 'imageHistory' &&
          key !== 'execution'
      ) ||
      (hasOwn(value, 'workspaceId') && !isAgentId(value.workspaceId))
    )
      return null
    const mode = parseAgentMode(value.mode)
    if (!mode) return null
    const context: AgentRequestContext = { conversationId: value.conversationId, mode }
    if (hasOwn(value, 'workspaceId')) context.workspaceId = value.workspaceId as string
    if (hasOwn(value, 'execution')) {
      const execution = parseExecutionInfo(value.execution)
      if (!execution) return null
      context.execution = execution
    }
    if (hasOwn(value, 'attachment')) {
      const attachment = value.attachment
      if (
        !isPlainRecord(attachment) ||
        Object.keys(attachment).length !== 2 ||
        !isAgentId(attachment.snapshotId) ||
        attachment.allowUpload !== true
      )
        return null
      context.attachment = { snapshotId: attachment.snapshotId, allowUpload: true }
    }
    if (hasOwn(value, 'images')) {
      const images = parseImageReferences(value.images)
      if (!images) return null
      context.images = images
    }
    if (hasOwn(value, 'imageHistory')) {
      const imageHistory = parseImageHistoryReferences(value.imageHistory)
      if (!imageHistory) return null
      context.imageHistory = imageHistory
    }
    if ((context.images?.length ?? 0) + (context.imageHistory?.length ?? 0) > maxRequestImages)
      return null
    return context
  } catch {
    return null
  }
}

export function toolScopeForAgentRequest(context: AgentRequestContext): ToolScope {
  const workspace = context.workspaceId ? { workspaceId: context.workspaceId } : {}
  const execution = context.execution ? { executionId: context.execution.scopeId } : {}
  return context.attachment
    ? { kind: 'project', snapshotId: context.attachment.snapshotId, ...workspace, ...execution }
    : { kind: 'time', ...workspace, ...execution }
}

export function sameToolScope(a: ToolScope, b: ToolScope): boolean {
  if (a.workspaceId !== b.workspaceId) return false
  if (a.executionId !== b.executionId) return false
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

export function parseWorkspaceInstructionResult(value: unknown): WorkspaceInstructionResult | null {
  try {
    if (!isPlainRecord(value) || typeof value.status !== 'string') return null
    if (value.status === 'absent') return { status: 'absent' }
    if (value.status === 'error') {
      if (typeof value.error !== 'string' || !value.error.trim() || value.error.length > 500)
        return null
      return { status: 'error', error: value.error }
    }
    if (value.status !== 'read' || !isPlainRecord(value.instruction)) return null
    const raw = value.instruction
    if (
      typeof raw.path !== 'string' ||
      !raw.path.trim() ||
      raw.path.length > 4096 ||
      typeof raw.content !== 'string' ||
      raw.content.length > 65536 ||
      typeof raw.fingerprint !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(raw.fingerprint) ||
      typeof raw.truncated !== 'boolean'
    ) {
      return null
    }
    return {
      status: 'read',
      instruction: cloneInstruction({
        path: raw.path,
        content: raw.content,
        fingerprint: raw.fingerprint,
        truncated: raw.truncated
      })
    }
  } catch {
    return null
  }
}

export function parseWorkspaceSelectionResult(value: unknown): WorkspaceSelectionResult | null {
  try {
    if (!isPlainRecord(value) || typeof value.status !== 'string') return null
    if (value.status === 'cleared') return { status: 'cleared' }
    if (value.status === 'cancelled') return { status: 'cancelled' }
    if (value.status === 'error') {
      if (typeof value.error !== 'string' || !value.error.trim() || value.error.length > 500)
        return null
      return { status: 'error', error: value.error }
    }
    if (value.status !== 'selected' || !isPlainRecord(value.workspace)) return null
    const raw = value.workspace
    if (
      !isAgentId(raw.workspaceId) ||
      typeof raw.root !== 'string' ||
      !raw.root.trim() ||
      raw.root.length > 4096 ||
      typeof raw.label !== 'string' ||
      !raw.label.trim() ||
      raw.label.length > 80 ||
      (raw.snapshotId !== null && !isAgentId(raw.snapshotId))
    ) {
      return null
    }
    const instructionResult =
      raw.instruction === null
        ? null
        : parseWorkspaceInstructionResult({ status: 'read', instruction: raw.instruction })
    if (raw.instruction !== null && !instructionResult) return null
    return {
      status: 'selected',
      workspace: cloneWorkspace({
        workspaceId: raw.workspaceId,
        root: raw.root,
        label: raw.label,
        snapshotId: raw.snapshotId,
        instruction: instructionResult?.status === 'read' ? instructionResult.instruction : null
      })
    }
  } catch {
    return null
  }
}

// 工具声明、执行器与保存的协议共用当前工作方式和范围的白名单。
export function isToolAllowed(
  name: unknown,
  scope: ToolScope,
  mode: AgentMode = 'execute'
): name is string {
  if (!parseAgentMode(mode)) return false
  if (
    mode === 'plan' &&
    (name === 'create_workspace_file' ||
      name === 'edit_workspace_file' ||
      name === 'run_workspace_command' ||
      name === 'propose_file_change' ||
      name === 'propose_command')
  )
    return false
  return (
    name === 'get_current_time' ||
    ((scope.workspaceId !== undefined || scope.executionId !== undefined) &&
      (name === 'list_workspace_files' ||
        name === 'search_workspace_text' ||
        name === 'read_workspace_file' ||
        name === 'create_workspace_file' ||
        name === 'edit_workspace_file' ||
        name === 'run_workspace_command')) ||
    (scope.kind === 'project' &&
      (name === 'search_project_text' ||
        name === 'read_project_file' ||
        name === 'propose_file_change' ||
        name === 'propose_command'))
  )
}
