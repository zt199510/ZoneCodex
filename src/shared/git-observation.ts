export type GitTurnCaptureState = {
  turnNumber: number
  state: 'unavailable' | 'capturing' | 'completed' | 'interrupted' | 'failed' | 'error'
  startedAt: number | null
  completedAt: number | null
  message: string | null
}
export type GitInvalidatedEvent = {
  viewId: string
  reason: 'worktree' | 'metadata' | 'recovery' | 'turn'
  sequence: number
  status: 'watching' | 'limited' | 'error'
  message?: string
}
function record(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return (
    (prototype === Object.prototype || prototype === null) &&
    Reflect.ownKeys(value).every(
      (key) => typeof key === 'string' && 'value' in Object.getOwnPropertyDescriptor(value, key)!
    )
  )
}
function shape(
  value: Record<string, unknown>,
  required: string[],
  optional: string[] = []
): boolean {
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Reflect.ownKeys(value).every(
      (key) => typeof key === 'string' && (required.includes(key) || optional.includes(key))
    )
  )
}
function integer(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum
}
function message(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 2048 && !/\p{Cc}/u.test(value)
}
export function parseGitTurnCaptureState(value: unknown): GitTurnCaptureState | null {
  if (
    !record(value) ||
    !shape(value, ['turnNumber', 'state', 'startedAt', 'completedAt', 'message']) ||
    !integer(value.turnNumber) ||
    !['unavailable', 'capturing', 'completed', 'interrupted', 'failed', 'error'].includes(
      value.state as string
    ) ||
    (value.startedAt !== null && !integer(value.startedAt)) ||
    (value.completedAt !== null && !integer(value.completedAt)) ||
    (value.message !== null && !message(value.message))
  )
    return null
  if (
    value.state === 'unavailable' &&
    (value.turnNumber !== 0 || value.startedAt !== null || value.completedAt !== null)
  )
    return null
  if (value.state !== 'unavailable' && (!value.turnNumber || value.startedAt === null)) return null
  if (value.state === 'capturing' && value.completedAt !== null) return null
  if (value.state !== 'capturing' && value.state !== 'unavailable' && value.completedAt === null)
    return null
  if (
    typeof value.startedAt === 'number' &&
    typeof value.completedAt === 'number' &&
    value.completedAt < value.startedAt
  )
    return null
  return {
    turnNumber: value.turnNumber,
    state: value.state as GitTurnCaptureState['state'],
    startedAt: value.startedAt as number | null,
    completedAt: value.completedAt as number | null,
    message: value.message as string | null
  }
}
export function parseGitInvalidatedEvent(value: unknown): GitInvalidatedEvent | null {
  if (
    !record(value) ||
    !shape(value, ['viewId', 'reason', 'sequence', 'status'], ['message']) ||
    typeof value.viewId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.viewId) ||
    !['worktree', 'metadata', 'recovery', 'turn'].includes(value.reason as string) ||
    !integer(value.sequence) ||
    !value.sequence ||
    !['watching', 'limited', 'error'].includes(value.status as string) ||
    (value.message !== undefined && !message(value.message))
  )
    return null
  return {
    viewId: value.viewId,
    reason: value.reason as GitInvalidatedEvent['reason'],
    sequence: value.sequence,
    status: value.status as GitInvalidatedEvent['status'],
    ...(value.message !== undefined ? { message: value.message } : {})
  }
}
