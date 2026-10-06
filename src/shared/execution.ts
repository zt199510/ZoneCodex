export type PermissionMode = 'default' | 'auto-approve' | 'full-access'

export type PermissionsState = {
  mode: PermissionMode
  revision: number
}

export type ExecutionApprovalInput = {
  requestId: string
  conversationId: string
  cwd: string
} & (
  | { kind: 'create'; path: string; content: string }
  | { kind: 'edit'; path: string; before: string; after: string }
  | { kind: 'command'; program: string; args: string[] }
)

/** One pending operation, never a persistent permission or directory grant. */
export type ExecutionApproval = ExecutionApprovalInput & { approvalId: string }

/** Describes a run for history selection; it is never an execution grant. */
export type ExecutionInfo = PermissionsState & {
  cwd: string
  scopeId: string
}

export function parsePermissionMode(value: unknown): PermissionMode | null {
  return value === 'default' || value === 'auto-approve' || value === 'full-access' ? value : null
}

function record(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function parseExecutionApproval(value: unknown): ExecutionApproval | null {
  if (!record(value)) return null
  const id = (input: unknown): input is string =>
    typeof input === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(input)
  const localPath = (input: unknown): input is string =>
    typeof input === 'string' &&
    input.length > 0 &&
    input.length <= 4096 &&
    !Array.from(input).some((character) => {
      const code = character.charCodeAt(0)
      return code < 32 || code === 127
    })
  const text = (input: unknown): input is string =>
    typeof input === 'string' && input.length <= 128 * 1024
  if (
    !id(value.approvalId) ||
    !id(value.requestId) ||
    !id(value.conversationId) ||
    !localPath(value.cwd)
  )
    return null
  const common = {
    approvalId: value.approvalId,
    requestId: value.requestId,
    conversationId: value.conversationId,
    cwd: value.cwd
  }
  const keys = ['approvalId', 'requestId', 'conversationId', 'cwd', 'kind']
  const exact = (extra: string[]): boolean =>
    Object.keys(value).length === keys.length + extra.length &&
    [...keys, ...extra].every((key) => Object.hasOwn(value, key))
  if (
    value.kind === 'create' &&
    exact(['path', 'content']) &&
    localPath(value.path) &&
    text(value.content)
  ) {
    return { ...common, kind: 'create', path: value.path, content: value.content }
  }
  if (
    value.kind === 'edit' &&
    exact(['path', 'before', 'after']) &&
    localPath(value.path) &&
    text(value.before) &&
    text(value.after)
  ) {
    return { ...common, kind: 'edit', path: value.path, before: value.before, after: value.after }
  }
  if (
    value.kind === 'command' &&
    exact(['program', 'args']) &&
    localPath(value.program) &&
    Array.isArray(value.args) &&
    value.args.length <= 20 &&
    value.args.every((arg) => typeof arg === 'string' && arg.length <= 500)
  ) {
    return { ...common, kind: 'command', program: value.program, args: [...value.args] }
  }
  return null
}

export function parsePermissionsState(value: unknown): PermissionsState | null {
  if (
    !record(value) ||
    Object.keys(value).length !== 2 ||
    !parsePermissionMode(value.mode) ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0
  )
    return null
  return { mode: value.mode as PermissionMode, revision: value.revision as number }
}

export function parseExecutionInfo(value: unknown): ExecutionInfo | null {
  if (
    !record(value) ||
    Object.keys(value).length !== 4 ||
    typeof value.cwd !== 'string' ||
    !value.cwd ||
    value.cwd.length > 4096 ||
    Array.from(value.cwd).some((character) => {
      const code = character.charCodeAt(0)
      return code < 32 || code === 127
    }) ||
    typeof value.scopeId !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.scopeId)
  )
    return null
  const permissions = parsePermissionsState({ mode: value.mode, revision: value.revision })
  return permissions ? { ...permissions, cwd: value.cwd, scopeId: value.scopeId } : null
}

export function sameExecutionInfo(a: ExecutionInfo, b: ExecutionInfo): boolean {
  return (
    a.scopeId === b.scopeId && a.cwd === b.cwd && a.mode === b.mode && a.revision === b.revision
  )
}

export function hasLocalSideEffects(trace: readonly string[]): boolean {
  return trace.some(
    (line) => line.startsWith('本地操作已开始：') || line.startsWith('工作区操作已批准：')
  )
}
