export type CommandSource = {
  conversationId: string
  requestId: string
  assistantId: string
  callId: string
  snapshotId: string
  template: 'npm_typecheck'
}

export type CommandScripts = { pretypecheck?: string; typecheck: string; posttypecheck?: string }
export type CommandDirectoryInfo = {
  grantId: string
  directory: string
  scripts: CommandScripts
  packageManager?: string
  npmrc: 'present' | 'absent'
  expiresAt: string
}
export type CommandPreparationResult =
  | { status: 'selected'; info: CommandDirectoryInfo }
  | { status: 'ready'; preparedId: string; grantId: string; expiresAt: string }
  | { status: 'cancelled' }
  | { status: 'conflict' | 'expired' | 'error'; error: string }
export type SelectCommandDirectoryRequest = { source: CommandSource; operationId: string }
export type PrepareCommandRequest = { source: CommandSource; grantId: string; checkId: string }
export type CommandExecutionRequest = {
  source: CommandSource
  preparedId: string
  confirmationId: string
}
export type CommandExecutionEvent =
  | { status: 'started'; executionId: string }
  | {
      status: 'output'
      executionId: string
      stream: 'stdout' | 'stderr'
      text: string
      totalBytes: number
      truncated?: boolean
    }
  | { status: 'finished'; executionId: string; exitCode: number }
  | { status: 'cancelled' | 'timed_out' | 'error'; executionId: string; error: string }

const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9-]{1,80}$/.test(v)
const record = (v: unknown): v is Record<string, unknown> =>
  !!v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)
export function parseCommandSource(v: unknown): CommandSource | null {
  if (
    !record(v) ||
    Object.keys(v).length !== 6 ||
    !id(v.conversationId) ||
    !id(v.requestId) ||
    !id(v.assistantId) ||
    !id(v.callId) ||
    !id(v.snapshotId) ||
    v.template !== 'npm_typecheck'
  )
    return null
  return {
    conversationId: v.conversationId,
    requestId: v.requestId,
    assistantId: v.assistantId,
    callId: v.callId,
    snapshotId: v.snapshotId,
    template: v.template
  }
}
export function parseSelectCommandDirectoryRequest(
  v: unknown
): SelectCommandDirectoryRequest | null {
  if (
    !record(v) ||
    Object.keys(v).length !== 2 ||
    !parseCommandSource(v.source) ||
    !id(v.operationId)
  )
    return null
  return { source: parseCommandSource(v.source)!, operationId: v.operationId }
}
export function parsePrepareCommandRequest(v: unknown): PrepareCommandRequest | null {
  if (
    !record(v) ||
    Object.keys(v).length !== 3 ||
    !parseCommandSource(v.source) ||
    !id(v.grantId) ||
    !id(v.checkId)
  )
    return null
  return { source: parseCommandSource(v.source)!, grantId: v.grantId, checkId: v.checkId }
}
export function parseCommandExecutionRequest(v: unknown): CommandExecutionRequest | null {
  if (
    !record(v) ||
    Object.keys(v).length !== 3 ||
    !parseCommandSource(v.source) ||
    !id(v.preparedId) ||
    !id(v.confirmationId)
  )
    return null
  return {
    source: parseCommandSource(v.source)!,
    preparedId: v.preparedId,
    confirmationId: v.confirmationId
  }
}
export function parseCommandPreparationResult(v: unknown): CommandPreparationResult | null {
  if (!record(v) || typeof v.status !== 'string') return null
  if (v.status === 'cancelled') return { status: 'cancelled' }
  if (
    (v.status === 'conflict' || v.status === 'expired' || v.status === 'error') &&
    typeof v.error === 'string' &&
    v.error.length <= 500
  )
    return { status: v.status, error: v.error }
  if (
    v.status === 'selected' &&
    record(v.info) &&
    id(v.info.grantId) &&
    typeof v.info.directory === 'string' &&
    record(v.info.scripts) &&
    typeof v.info.scripts.typecheck === 'string' &&
    (v.info.scripts.pretypecheck === undefined ||
      typeof v.info.scripts.pretypecheck === 'string') &&
    (v.info.scripts.posttypecheck === undefined ||
      typeof v.info.scripts.posttypecheck === 'string') &&
    (v.info.npmrc === 'present' || v.info.npmrc === 'absent') &&
    typeof v.info.expiresAt === 'string'
  )
    return {
      status: 'selected',
      info: {
        grantId: v.info.grantId,
        directory: v.info.directory,
        scripts: {
          typecheck: v.info.scripts.typecheck,
          ...(v.info.scripts.pretypecheck !== undefined
            ? { pretypecheck: v.info.scripts.pretypecheck }
            : {}),
          ...(v.info.scripts.posttypecheck !== undefined
            ? { posttypecheck: v.info.scripts.posttypecheck }
            : {})
        },
        ...(typeof v.info.packageManager === 'string'
          ? { packageManager: v.info.packageManager }
          : {}),
        npmrc: v.info.npmrc,
        expiresAt: v.info.expiresAt
      }
    }
  if (v.status === 'ready' && id(v.preparedId) && id(v.grantId) && typeof v.expiresAt === 'string')
    return { status: 'ready', preparedId: v.preparedId, grantId: v.grantId, expiresAt: v.expiresAt }
  return null
}
