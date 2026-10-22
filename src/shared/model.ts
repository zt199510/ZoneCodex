export type ModelStatus = {
  provider: 'offline' | 'responses' | 'unconfigured'
  state: 'offline' | 'ready' | 'error'
  label: string
  errorCode?: 'MODEL_CONFIGURATION_INVALID'
}

export function parseModelStatus(value: unknown): ModelStatus | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const item = value as Record<string, unknown>
  if (Object.keys(item).some((key) => !['provider', 'state', 'label', 'errorCode'].includes(key)) ||
      typeof item.label !== 'string' || item.label.length > 100) return null
  if (item.provider === 'offline' && item.state === 'offline' && item.errorCode === undefined)
    return { provider: 'offline', state: 'offline', label: item.label }
  if (item.provider === 'responses' && item.state === 'ready' && item.errorCode === undefined)
    return { provider: 'responses', state: 'ready', label: item.label }
  if (item.provider === 'unconfigured' && item.state === 'error' && item.errorCode === 'MODEL_CONFIGURATION_INVALID')
    return { provider: 'unconfigured', state: 'error', label: item.label, errorCode: 'MODEL_CONFIGURATION_INVALID' }
  return null
}
