export type McpTransport = 'stdio'
export type McpServerConfig = {
  id: string
  name: string
  transport: 'stdio'
  command: string
  args: string[]
  cwd?: string
  enabled: boolean
  timeoutMs: number
}

export type McpToolDescriptor = {
  name: string
  qualifiedName: string
  serverId: string
  description: string
  inputSchema: Record<string, unknown>
  schemaFingerprint: string
  configurationVersion?: number
  connectionToken?: string
}

export type McpServerStatus = {
  id: string
  name: string
  enabled: boolean
  state: 'disabled' | 'stopped' | 'starting' | 'connected' | 'failed' | 'closing'
  tools: McpToolDescriptor[]
  error?: string
  lastRefresh?: string
}

export type McpSettings = { version: 1; servers: McpServerConfig[] }
export type McpToolCallResult = { content: unknown[]; structuredContent?: unknown; isError?: boolean }

const idPattern = /^[A-Za-z0-9_-]{1,32}$/
const unsafeCommand = /[&|<>"'`;$(){}]/
const unsafeValue = /[\u0000\u0001-\u001f\u007f]/

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

export function qualifiedMcpToolName(serverId: string, toolName: string): string {
  return `mcp__${serverId}__${toolName}`
}

export function parseMcpServerConfig(value: unknown): McpServerConfig | null {
  if (!record(value)) return null
  const keys = ['id', 'name', 'transport', 'command', 'args', 'enabled', 'timeoutMs']
  if (Object.hasOwn(value, 'cwd')) keys.push('cwd')
  if (!exact(value, keys) || typeof value.id !== 'string' || !idPattern.test(value.id) ||
      typeof value.name !== 'string' || !value.name.trim() || value.name.length > 128 ||
      value.transport !== 'stdio' || typeof value.command !== 'string' ||
      !value.command.trim() || value.command.length > 1024 || unsafeCommand.test(value.command) || unsafeValue.test(value.command) || /^(?:https?:|file:|\\\\|\/\/)/i.test(value.command) ||
      !Array.isArray(value.args) || value.args.length > 64 ||
      !value.args.every((arg) => typeof arg === 'string' && arg.length <= 2048 && !unsafeValue.test(arg) && !/^(?:https?:|file:|\\\\)/i.test(arg)) ||
      typeof value.enabled !== 'boolean' || typeof value.timeoutMs !== 'number' || !Number.isInteger(value.timeoutMs) ||
      value.timeoutMs < 1000 || value.timeoutMs > 60000 ||
      (Object.hasOwn(value, 'cwd') && (typeof value.cwd !== 'string' || !value.cwd.trim() || value.cwd.length > 4096 || unsafeValue.test(value.cwd) || /^(?:https?:|file:|\\\\)/i.test(value.cwd))) ||
      Object.keys(value).some((key) => /pass|token|secret|cookie|credential|env|shell/i.test(key)))
    return null
  return {
    id: value.id,
    name: value.name.trim(),
    transport: 'stdio',
    command: value.command,
    args: [...value.args],
    ...(Object.hasOwn(value, 'cwd') ? { cwd: value.cwd as string } : {}),
    enabled: value.enabled,
    timeoutMs: value.timeoutMs
  }
}

export function parseMcpSettings(value: unknown): McpSettings | null {
  if (!record(value) || !exact(value, ['version', 'servers']) || value.version !== 1 ||
      !Array.isArray(value.servers) || value.servers.length > 32) return null
  const servers = value.servers.map(parseMcpServerConfig)
  if (servers.some((server) => !server) || new Set(servers.map((server) => server!.id)).size !== servers.length)
    return null
  return { version: 1, servers: servers as McpServerConfig[] }
}

export function parseMcpServerStatus(value: unknown): McpServerStatus | null {
  if (!record(value) || typeof value.id !== 'string' || !idPattern.test(value.id) ||
      typeof value.name !== 'string' || typeof value.enabled !== 'boolean' ||
      !['disabled', 'stopped', 'starting', 'connected', 'failed', 'closing'].includes(String(value.state)) ||
      !Array.isArray(value.tools) || value.tools.length > 256) return null
  return {
    id: value.id,
    name: value.name,
    enabled: value.enabled,
    state: value.state as McpServerStatus['state'],
    tools: value.tools.map(parseMcpToolDescriptor).filter((tool): tool is McpToolDescriptor => tool !== null),
    ...(typeof value.lastRefresh === 'string' ? { lastRefresh: value.lastRefresh.slice(0, 100) } : {}),
    ...(typeof value.error === 'string' ? { error: value.error.slice(0, 500) } : {})
  }
}

export function parseMcpToolDescriptor(value: unknown): McpToolDescriptor | null {
  if (!record(value) || typeof value.name !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(value.name) ||
      typeof value.qualifiedName !== 'string' || typeof value.serverId !== 'string' ||
      typeof value.description !== 'string' || !validSchema(value.inputSchema) ||
      typeof value.schemaFingerprint !== 'string' || value.schemaFingerprint.length > 0xff) return null
  return value as McpToolDescriptor
}

function serializable(value: unknown, maxDepth: number, propertyLimit: number): boolean {
  const ancestors = new Set<object>()
  let properties = 0
  const visit = (item: unknown, depth: number): boolean => {
    if (depth > maxDepth) return false
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return true
    if (typeof item === 'number') return Number.isFinite(item)
    if ((!record(item) && !Array.isArray(item)) || ancestors.has(item)) return false
    ancestors.add(item)
    const fields = Object.getOwnPropertyDescriptors(item)
    if (Array.isArray(item) && Reflect.ownKeys(fields).length !== item.length + 1) return false
    for (const key of Reflect.ownKeys(fields)) {
      if (Array.isArray(item) && key === 'length') continue
      if (typeof key !== 'string' || !fields[key].enumerable || !('value' in fields[key])) return false
      if (key === 'properties') {
        if (!record(fields[key].value)) return false
        properties += Object.keys(fields[key].value).length
        if (properties > propertyLimit) return false
      }
      if (!visit(fields[key].value, depth + 1)) return false
    }
    ancestors.delete(item)
    return true
  }
  try { return visit(value, 0) && new TextEncoder().encode(JSON.stringify(value)).byteLength <= 128 * 1024 }
  catch { return false }
}

export function validSchema(value: unknown): value is Record<string, unknown> {
  return record(value) && serializable(value, 8, 64)
}

/** Deliberately bounded basic JSON Schema checks, not a complete draft implementation. */
export function validateMcpArguments(args: unknown, schema: Record<string, unknown>): boolean {
  if (!record(args) || !serializable(args, 32, Number.POSITIVE_INFINITY)) return false
  const check = (value: unknown, rule: Record<string, unknown>): boolean => {
    if (Array.isArray(rule.enum) && !rule.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))) return false
    const type = (name: unknown): boolean => name === 'object' ? record(value) : name === 'array' ? Array.isArray(value)
      : name === 'null' ? value === null : name === 'integer' ? typeof value === 'number' && Number.isInteger(value)
      : name === 'number' ? typeof value === 'number' && Number.isFinite(value)
      : name === 'string' ? typeof value === 'string' : name === 'boolean' ? typeof value === 'boolean' : false
    if (rule.type !== undefined && !(Array.isArray(rule.type) ? rule.type.some(type) : type(rule.type))) return false
    if (record(value)) {
      if (Array.isArray(rule.required) && rule.required.some((name) => typeof name !== 'string' || !Object.hasOwn(value, name))) return false
      const props = record(rule.properties) ? rule.properties : {}
      for (const [name, item] of Object.entries(value)) {
        if (record(props[name]) && !check(item, props[name])) return false
        if (!Object.hasOwn(props, name) && rule.additionalProperties === false) return false
      }
    }
    if (Array.isArray(value) && record(rule.items) && !value.every((item) => check(item, rule.items as Record<string, unknown>))) return false
    return true
  }
  return check(args, schema)
}

export function parseMcpStatusList(value: unknown): McpServerStatus[] | null {
  if (!Array.isArray(value) || value.length > 32) return null
  const list = value.map(parseMcpServerStatus)
  return list.some((item) => !item) ? null : list as McpServerStatus[]
}
