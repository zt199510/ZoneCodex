// Main-process-only policies. Tool and IPC arguments cannot select these limits.
export type ChangeCapacityPolicy = 'small' | 'workspace-patch'

export const SMALL_CHANGE_CAPACITY: ChangeCapacityPolicy = 'small'
export const WORKSPACE_PATCH_CAPACITY: ChangeCapacityPolicy = 'workspace-patch'

const small = Object.freeze({ maxBytes: 32768, maxTextLength: 2000, maxTextLines: 80 })
const workspacePatch = Object.freeze({
  maxBytes: 131072,
  maxTextLength: 131072,
  maxTextLines: null
})

export function changeCapacity(policy: ChangeCapacityPolicy): {
  readonly maxBytes: number
  readonly maxTextLength: number
  readonly maxTextLines: number | null
} {
  return policy === WORKSPACE_PATCH_CAPACITY ? workspacePatch : small
}

export function boundedChangeText(value: string, policy: ChangeCapacityPolicy): boolean {
  const limit = changeCapacity(policy)
  return (
    value.length <= limit.maxTextLength &&
    (limit.maxTextLines === null || value.split('\n').length <= limit.maxTextLines)
  )
}
