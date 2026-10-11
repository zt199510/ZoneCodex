export const agentContextPhases = [
  'measured',
  'compacting',
  'compacted',
  'failed',
  'blocked'
] as const

export const agentContextReasons = [
  'idle',
  'near_limit',
  'summary_ready',
  'no_eligible_groups',
  'invalid_summary',
  'no_reduction',
  'summary_transport_failed',
  'chunk_limit',
  'summary_limit',
  'working_limit',
  'source_material_limit',
  'summary_retry'
] as const

/** Counts are project characters/items, never tokens or an HTTP body size. */
export type AgentContextState = {
  phase: (typeof agentContextPhases)[number]
  reason: (typeof agentContextReasons)[number]
  rawHistoryItems: number
  rawHistoryCharacters: number
  rawTurnItems: number
  rawTurnCharacters: number
  workingItems: number
  workingCharacters: number
  limitCharacters: 128000
  triggerCharacters: 96000
  rawTurnLimitItems: 160
  instructionsCharacters: number
  toolSchemaCharacters: number
  imageCount: number
  imageBytes: number
  summaryRequests: number
  sourceGroups: number
  beforeCharacters: number
  afterCharacters: number
}

const countKeys = [
  'rawHistoryItems',
  'rawHistoryCharacters',
  'rawTurnItems',
  'rawTurnCharacters',
  'workingItems',
  'workingCharacters',
  'instructionsCharacters',
  'toolSchemaCharacters',
  'imageCount',
  'imageBytes',
  'summaryRequests',
  'sourceGroups',
  'beforeCharacters',
  'afterCharacters'
] as const
const keys = [
  ...countKeys,
  'phase',
  'reason',
  'limitCharacters',
  'triggerCharacters',
  'rawTurnLimitItems'
]

export function parseAgentContextState(value: unknown): AgentContextState | null {
  try {
    return parseContextState(value)
  } catch {
    return null
  }
}

function parseContextState(value: unknown): AgentContextState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return null
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const actualKeys = Reflect.ownKeys(descriptors)
  if (
    actualKeys.length !== keys.length ||
    actualKeys.some(
      (key) =>
        typeof key !== 'string' ||
        !keys.includes(key) ||
        !descriptors[key].enumerable ||
        !('value' in descriptors[key])
    )
  )
    return null
  const item = value as Record<string, unknown>
  if (
    !agentContextPhases.includes(item.phase as AgentContextState['phase']) ||
    !agentContextReasons.includes(item.reason as AgentContextState['reason']) ||
    item.limitCharacters !== 128000 ||
    item.triggerCharacters !== 96000 ||
    item.rawTurnLimitItems !== 160
  )
    return null
  for (const key of countKeys)
    if (
      typeof item[key] !== 'number' ||
      !Number.isInteger(item[key]) ||
      item[key] < 0 ||
      item[key] > 2147483647
    )
      return null
  if ((item.summaryRequests as number) > 12 || (item.sourceGroups as number) > 1000) return null
  return { ...item } as AgentContextState
}
