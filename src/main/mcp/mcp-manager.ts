import { app, BrowserWindow, ipcMain } from 'electron'
import { mkdir, readFile, rename, rm, writeFile, lstat, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { getIpcWindow } from '../ipc-source'
import { isAbsoluteLocalDirectory } from '../../shared/settings'
import { parseMcpServerConfig, parseMcpSettings, type McpServerConfig, type McpServerStatus, type McpToolDescriptor } from '../../shared/mcp'
import { McpClient } from './mcp-client'

type Runtime = { config: McpServerConfig; client?: McpClient; connecting?: Promise<McpServerStatus>; closing?: Promise<void>; status: McpServerStatus; generation: number; token: string }
const settingsFile = (): string => join(app.getPath('userData'), 'mcp-settings.json')
let settings: McpServerConfig[] = []
let loadPromise: Promise<void> | undefined
let revision = 0
let mutations: Promise<unknown> = Promise.resolve()
const windows = new Map<number, Map<string, Runtime>>()
const epochs = new Map<number, number>()
const cleanups = new Map<number, Promise<void>>()
const taskTools = new Map<number, Map<string, readonly McpToolDescriptor[]>>()
const copy = <T>(value: T): T => structuredClone(value)
function snapshot(runtime: Runtime): McpServerStatus {
  return { ...copy(runtime.status), tools: runtime.status.tools.map((tool) => ({ ...copy(tool), configurationVersion: revision, connectionToken: runtime.token })) }
}
function emit(windowId: number, runtime: Runtime): void {
  const window = BrowserWindow.fromId(windowId)
  if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('mcp:status', snapshot(runtime))
}
async function load(): Promise<void> {
  loadPromise ??= (async () => {
    try {
      let text: string
      try { text = await readFile(settingsFile(), 'utf8') }
      catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return; throw cause }
      const parsed = parseMcpSettings(JSON.parse(text))
      if (!parsed) throw new Error()
      settings = parsed.servers
    } catch { throw new Error('MCP 设置文件损坏或无法读取，原文件已保留；请修复后重启') }
  })()
  await loadPromise
}
function mutate<T>(work: () => Promise<T>): Promise<T> {
  const next = mutations.then(work, work)
  mutations = next.catch(() => undefined)
  return next
}
async function save(next: McpServerConfig[]): Promise<void> {
  const file = settingsFile(), temporary = file + '.' + randomUUID() + '.tmp'
  await mkdir(app.getPath('userData'), { recursive: true })
  try { await writeFile(temporary, JSON.stringify({ version: 1, servers: next }, null, 2), { flag: 'wx' }); await rename(temporary, file) }
  catch (cause) { await rm(temporary, { force: true }); throw cause }
  settings = next
}
async function validateDirectory(config: McpServerConfig): Promise<void> {
  if (!config.cwd) return
  if (!isAbsoluteLocalDirectory(config.cwd)) throw new Error('MCP 工作目录必须是本地绝对路径')
  const info = await lstat(config.cwd).catch(() => null)
  if (!info?.isDirectory() || info.isSymbolicLink() || (await realpath(config.cwd)).toLowerCase().replace(/[\\/]+$/, '') !== config.cwd.toLowerCase().replace(/[\\/]+$/, ''))
    throw new Error('MCP 工作目录无效或包含符号链接')
}
function runtimeFor(windowId: number, config: McpServerConfig): Runtime {
  let map = windows.get(windowId)
  if (!map) { map = new Map(); windows.set(windowId, map) }
  let runtime = map.get(config.id)
  if (!runtime) {
    runtime = { config: copy(config), generation: 0, token: randomUUID(), status: { id: config.id, name: config.name, enabled: config.enabled, state: config.enabled ? 'stopped' : 'disabled', tools: [] } }
    map.set(config.id, runtime)
  }
  return runtime
}
export async function listMcpServers(windowId?: number): Promise<McpServerStatus[]> {
  await load(); await mutations
  return settings.map((config) => windowId === undefined ? { id: config.id, name: config.name, enabled: config.enabled, state: config.enabled ? 'stopped' : 'disabled', tools: [] } : snapshot(runtimeFor(windowId, config)))
}
export async function listMcpConfigs(): Promise<McpServerConfig[]> { await load(); await mutations; return copy(settings) }
export async function upsertMcpServer(value: unknown): Promise<McpServerConfig> {
  const config = parseMcpServerConfig(value)
  if (!config) throw new Error('MCP Server 配置无效')
  const reconnect = await mutate(async () => {
    await load(); await validateDirectory(config)
    if (!settings.some((item) => item.id === config.id) && settings.length >= 32) throw new Error('MCP Server 数量超过限制')
    const reconnect: number[] = []
    ++revision
    for (const [owner, map] of windows) {
      const old = map.get(config.id)
      if (old?.client && config.enabled) reconnect.push(owner)
      await disconnectMcpServer(owner, config.id)
    }
    const next = settings.filter((item) => item.id !== config.id); next.push(copy(config)); await save(next)
    for (const [owner, map] of windows) { map.delete(config.id); emit(owner, runtimeFor(owner, config)) }
    return reconnect
  })
  await Promise.all(reconnect.map(async (owner) => { if (windows.has(owner)) await connectMcpServer(owner, config.id) }))
  return copy(config)
}
export async function setMcpServerEnabled(id: string, enabled: boolean, windowId?: number): Promise<McpServerStatus> {
  await load(); await mutations
  const config = settings.find((item) => item.id === id)
  if (!config) throw new Error('MCP Server 不存在')
  await upsertMcpServer({ ...config, enabled })
  return (await listMcpServers(windowId)).find((item) => item.id === id)!
}
export async function removeMcpServer(id: string): Promise<boolean> {
  return mutate(async () => {
    await load()
    if (!settings.some((item) => item.id === id)) return false
    ++revision
    for (const [owner] of windows) await disconnectMcpServer(owner, id)
    await save(settings.filter((item) => item.id !== id))
    for (const map of windows.values()) map.delete(id)
    return true
  })
}
export async function connectMcpServer(windowId: number, id: string): Promise<McpServerStatus> {
  const epoch = epochs.get(windowId) ?? 0
  await load(); await mutations; await cleanups.get(windowId)
  if ((epochs.get(windowId) ?? 0) !== epoch) throw new Error('MCP 窗口上下文已失效')
  const config = settings.find((item) => item.id === id)
  if (!config) throw new Error('MCP Server 不存在')
  const runtime = runtimeFor(windowId, config)
  if (runtime.closing) await runtime.closing
  if (!config.enabled) return snapshot(runtime)
  if (runtime.connecting) return runtime.connecting
  if (runtime.client && runtime.status.state === 'connected') return snapshot(runtime)
  if (runtime.client) {
    await disconnectMcpServer(windowId, id)
    return connectMcpServer(windowId, id)
  }
  const generation = ++runtime.generation
  runtime.token = randomUUID()
  runtime.status = { ...runtime.status, state: 'starting', tools: [], error: undefined }
  emit(windowId, runtime)
  const current = (): boolean => runtime.generation === generation && (epochs.get(windowId) ?? 0) === epoch
  const client = new McpClient(copy(config), () => {
    if (current() && runtime.status.state === 'connected') {
      runtime.status = { ...runtime.status, tools: client.getTools(), lastRefresh: new Date().toISOString() }; emit(windowId, runtime)
    }
  }, (error) => {
    if (current()) { runtime.status = { ...runtime.status, state: 'failed', tools: [], error: error.message }; emit(windowId, runtime) }
  })
  // Register before any await: teardown must own initializing processes too.
  runtime.client = client
  const work = (async () => {
    try {
      await validateDirectory(config)
      if (!current()) return snapshot(runtime)
      await client.connect()
      if (!current()) { await client.close(); return snapshot(runtime) }
      runtime.status = { ...runtime.status, state: 'connected', tools: client.getTools(), error: undefined, lastRefresh: new Date().toISOString() }
    } catch (cause) {
      try { await client.close() } catch { /* Retain client for another close attempt. */ }
      if (current()) runtime.status = { ...runtime.status, state: 'failed', tools: [], error: cause instanceof Error ? cause.message : 'MCP 连接失败' }
    }
    if (current()) emit(windowId, runtime)
    return snapshot(runtime)
  })()
  runtime.connecting = work
  try { return await work } finally { if (runtime.connecting === work) runtime.connecting = undefined }
}
export async function disconnectMcpServer(windowId: number, id: string): Promise<boolean> {
  const runtime = windows.get(windowId)?.get(id)
  if (!runtime) return false
  if (runtime.closing) { await runtime.closing; return true }
  ++runtime.generation
  runtime.status = { ...runtime.status, state: 'closing', tools: [] }; emit(windowId, runtime)
  const work = (async () => {
    try {
      await runtime.client?.close(); await runtime.connecting
      runtime.client = undefined
      runtime.status = { ...runtime.status, state: runtime.config.enabled ? 'stopped' : 'disabled', error: undefined, tools: [] }
    } catch (cause) {
      runtime.status = { ...runtime.status, state: 'failed', error: 'MCP 子进程尚未退出，请重试断开', tools: [] }
      throw cause
    } finally { emit(windowId, runtime) }
  })()
  runtime.closing = work
  try { await work; return true } finally { runtime.closing = undefined }
}
export async function refreshMcpServer(windowId: number, id: string): Promise<McpServerStatus> {
  await connectMcpServer(windowId, id)
  const runtime = windows.get(windowId)?.get(id)
  if (!runtime?.client || runtime.status.state !== 'connected') throw new Error('MCP Server 未连接')
  const generation = runtime.generation
  await runtime.client.refreshTools()
  if (generation !== runtime.generation) throw new Error('MCP 连接已变化，刷新结果已丢弃')
  return snapshot(runtime)
}
export async function connectEnabledMcpServers(windowId: number): Promise<McpToolDescriptor[]> {
  await load(); await mutations
  const results = await Promise.allSettled(settings.filter((config) => config.enabled).map((config) => connectMcpServer(windowId, config.id)))
  return results.flatMap((item) => item.status === 'fulfilled' && item.value.state === 'connected' ? item.value.tools : [])
}
export function assertMcpToolCurrent(windowId: number, tool: McpToolDescriptor): void {
  const runtime = windows.get(windowId)?.get(tool.serverId)
  if (!runtime?.client || runtime.status.state !== 'connected' || !runtime.config.enabled) throw new Error('MCP Server 未连接')
  if (tool.configurationVersion !== revision || tool.connectionToken !== runtime.token || !runtime.status.tools.some((item) => item.name === tool.name && item.qualifiedName === tool.qualifiedName && item.schemaFingerprint === tool.schemaFingerprint))
    throw new Error('MCP 配置、连接或 schema 已变化，请重新发送')
}
/** Transient proof only: persisted history cannot restore an old server grant. */
export function captureMcpTaskTools(windowId: number, taskId: string, tools: readonly McpToolDescriptor[]): void {
  let tasks = taskTools.get(windowId)
  if (!tasks) { tasks = new Map(); taskTools.set(windowId, tasks) }
  tasks.set(taskId, copy(tools))
}
export function assertMcpTaskResume(windowId: number, taskId: string, history: readonly Record<string, unknown>[]): void {
  const captured = taskTools.get(windowId)?.get(taskId)
  if (!captured && history.some((item) => item.type === 'function_call' && typeof item.name === 'string' && item.name.startsWith('mcp__')))
    throw new Error('原 MCP 连接快照已失效，不能续接；请核对工具效果后重新发送')
  for (const tool of captured ?? []) assertMcpToolCurrent(windowId, tool)
}
export async function callMcpTool(windowId: number, tool: McpToolDescriptor, args: unknown, signal: AbortSignal): Promise<string> {
  assertMcpToolCurrent(windowId, tool)
  const result = await windows.get(windowId)!.get(tool.serverId)!.client!.call(tool, args, signal)
  signal.throwIfAborted(); assertMcpToolCurrent(windowId, tool)
  return result
}
export function cleanupMcpWindow(windowId: number): Promise<void> {
  const existing = cleanups.get(windowId)
  if (existing) return existing
  epochs.set(windowId, (epochs.get(windowId) ?? 0) + 1)
  taskTools.delete(windowId)
  const map = windows.get(windowId)
  const work = (async () => {
    const results = await Promise.allSettled([...(map?.keys() ?? [])].map((id) => disconnectMcpServer(windowId, id)))
    if (results.some((item) => item.status === 'rejected')) throw new Error('MCP 子进程清理未完成，请重试')
    if (windows.get(windowId) === map) windows.delete(windowId)
  })()
  cleanups.set(windowId, work)
  void work.finally(() => { if (cleanups.get(windowId) === work) cleanups.delete(windowId) }).catch(() => undefined)
  return work
}
export async function cleanupAllMcp(): Promise<void> {
  const results = await Promise.allSettled([...windows.keys()].map(cleanupMcpWindow))
  if (results.some((item) => item.status === 'rejected')) throw new Error('MCP 子进程清理未完成，请重试退出')
}

export function registerMcpIpc(): void {
  ipcMain.handle('mcp:list', (event) => listMcpServers(getIpcWindow(event, '不支持的 MCP 来源').id))
  ipcMain.handle('mcp:configs', (event) => { getIpcWindow(event, '不支持的 MCP 来源'); return listMcpConfigs() })
  ipcMain.handle('mcp:upsert', async (event, value: unknown) => { getIpcWindow(event, '不支持的 MCP 来源'); return upsertMcpServer(value) })
  ipcMain.handle('mcp:enabled', async (event, id: unknown, enabled: unknown) => { const window = getIpcWindow(event, '不支持的 MCP 来源'); if (typeof id !== 'string' || typeof enabled !== 'boolean') throw new Error('MCP 参数无效'); return setMcpServerEnabled(id, enabled, window.id) })
  ipcMain.handle('mcp:remove', async (event, id: unknown) => { getIpcWindow(event, '不支持的 MCP 来源'); if (typeof id !== 'string') return false; return removeMcpServer(id) })
  ipcMain.handle('mcp:connect', async (event, id: unknown) => { const window = getIpcWindow(event, '不支持的 MCP 来源'); if (typeof id !== 'string') throw new Error('MCP Server 标识无效'); return connectMcpServer(window.id, id) })
  ipcMain.handle('mcp:disconnect', async (event, id: unknown) => { const window = getIpcWindow(event, '不支持的 MCP 来源'); if (typeof id !== 'string') return false; return disconnectMcpServer(window.id, id) })
  ipcMain.handle('mcp:refresh', async (event, id: unknown) => { const window = getIpcWindow(event, '不支持的 MCP 来源'); if (typeof id !== 'string') throw new Error('MCP Server 标识无效'); return refreshMcpServer(window.id, id) })
}

export function attachMcpCleanup(window: BrowserWindow): void {
  const cleanup = (): void => { void cleanupMcpWindow(window.id).catch(() => undefined) }
  window.webContents.on('zonecodex-main-navigation', cleanup); window.webContents.on('render-process-gone', cleanup); window.once('closed', cleanup)
}
