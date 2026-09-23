import { isAgentId } from './agent'

export type CommitRequest = {
  conversationId: string
  snapshotId: string
  preparationId: string
  checkId: string
  commitId: string
}
export type CommitStatus = 'applied' | 'conflict' | 'cancelled' | 'error' | 'uncertain'
export type CommitResult = CommitRequest & {
  status: CommitStatus
  claimed: boolean
  message: string
  recovery: { id: string; name: string } | null
  cleanupWarning: boolean
}

function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== null && prototype !== Object.prototype) return false
  const own = Reflect.ownKeys(value)
  return (
    own.length === keys.length &&
    own.every(
      (key) =>
        typeof key === 'string' &&
        keys.includes(key) &&
        'value' in Object.getOwnPropertyDescriptor(value, key)!
    )
  )
}
const requestKeys = ['conversationId', 'snapshotId', 'preparationId', 'checkId', 'commitId']
export function parseCommitRequest(value: unknown): CommitRequest | null {
  try {
    if (!exact(value, requestKeys) || !requestKeys.every((key) => isAgentId(value[key])))
      return null
    return value as CommitRequest
  } catch {
    return null
  }
}
export function parseCommitResult(value: unknown): CommitResult | null {
  try {
    if (
      !exact(value, [
        ...requestKeys,
        'status',
        'claimed',
        'message',
        'recovery',
        'cleanupWarning'
      ]) ||
      !requestKeys.every((key) => isAgentId(value[key])) ||
      !['applied', 'conflict', 'cancelled', 'error', 'uncertain'].includes(
        value.status as string
      ) ||
      typeof value.claimed !== 'boolean' ||
      typeof value.cleanupWarning !== 'boolean' ||
      typeof value.message !== 'string' ||
      !value.message ||
      value.message.length > 500
    )
      return null
    if (!value.claimed && value.status !== 'error') return null
    if (
      value.recovery !== null &&
      (!exact(value.recovery, ['id', 'name']) ||
        !isAgentId(value.recovery.id) ||
        typeof value.recovery.name !== 'string' ||
        !/^\.zonecodex-[a-f0-9-]{36}\.bak$/.test(value.recovery.name))
    )
      return null
    if (value.status === 'applied' && value.recovery === null) return null
    return value as CommitResult
  } catch {
    return null
  }
}
