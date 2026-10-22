import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import type { McpServerConfig, McpToolDescriptor } from '../../shared/mcp'
import { qualifiedMcpToolName, validSchema, validateMcpArguments } from '../../shared/mcp'

type Json = Record<string, unknown>
type Pending = { resolve: (value: Json) => void; reject: (error: Error) => void; cleanup: () => void; cancelled: boolean }
const isRecord = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value)
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
function safeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of ['PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA'])
    if (process.env[key]) env[key] = process.env[key]
  return env
}

export class McpClient {
  private child: ChildProcessWithoutNullStreams | null = null
  private exited: Promise<void> = Promise.resolve()
  private closing?: Promise<void>
  private closed = false
  private reported = false
  private buffer = ''
  private sequence = 0
  private pending = new Map<number, Pending>()
  private tools: McpToolDescriptor[] = []
  private refreshChain: Promise<McpToolDescriptor[]> = Promise.resolve([])
  constructor(private readonly config: McpServerConfig,
    private readonly onToolsChanged: () => void = () => undefined,
    private readonly onExit: (error: Error) => void = () => undefined) {}

  getTools(): McpToolDescriptor[] { return structuredClone(this.tools) }
  async connect(): Promise<void> {
    if (this.child || this.closed) throw new Error('MCP Client 不可重复启动')
    const child = spawn(this.config.command, this.config.args, {
      cwd: this.config.cwd, env: safeEnv(), shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
    })
    this.child = child
    this.exited = new Promise((resolve) => child.once('close', () => {
      this.child = null
      if (!this.closed) this.fail(new Error('MCP Server 已退出'))
      resolve()
    }))
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => this.accept(chunk))
    child.stderr.on('data', () => undefined)
    child.stdin.on('error', () => { if (!this.closed) this.fail(new Error('MCP 输入管道已关闭')) })
    child.once('error', () => this.fail(new Error('MCP 进程启动失败')))
    const initialized = await this.request('initialize', {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ZoneCodex', version: '1.0.0' }
    })
    if (!isRecord(initialized.result) || typeof initialized.result.protocolVersion !== 'string') {
      const error = new Error('MCP 初始化响应无效'); this.fail(error); throw error
    }
    this.write({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })
    await this.refreshTools()
  }
  private accept(chunk: string): void {
    if (this.closed) return
    this.buffer += chunk
    if (Buffer.byteLength(this.buffer) > 8 * 1024 * 1024) return this.fail(new Error('MCP 响应超过容量限制'))
    for (;;) {
      const index = this.buffer.indexOf('\n')
      if (index < 0) return
      const line = this.buffer.slice(0, index).trim(); this.buffer = this.buffer.slice(index + 1)
      if (!line) continue
      try {
        const message: unknown = JSON.parse(line)
        if (!isRecord(message) || message.jsonrpc !== '2.0') throw new Error('MCP JSON-RPC 响应无效')
        if (Object.hasOwn(message, 'id')) {
          if (!Number.isInteger(message.id) || typeof message.id !== 'number' || !this.pending.has(message.id))
            throw new Error('MCP 请求 ID 不匹配')
          if (Object.hasOwn(message, 'result') === Object.hasOwn(message, 'error') ||
              (Object.hasOwn(message, 'error') && (!isRecord(message.error) || typeof message.error.code !== 'number' || typeof message.error.message !== 'string')))
            throw new Error('MCP 响应格式无效')
          const item = this.pending.get(message.id)!
          this.pending.delete(message.id); item.cleanup()
          if (item.cancelled) continue
          if (isRecord(message.error)) item.reject(new Error('MCP Server 返回请求错误（' + message.error.code + '）'))
          else item.resolve(message)
        } else if (message.method === 'notifications/tools/list_changed') {
          void this.refreshTools().catch((error: Error) => this.fail(error))
        } else if (typeof message.method !== 'string') throw new Error('MCP 通知格式无效')
      } catch (cause) { this.fail(cause instanceof Error ? cause : new Error('MCP JSON 响应无效')); return }
    }
  }
  private fail(error: Error): void {
    for (const item of this.pending.values()) { item.cleanup(); item.reject(error) }
    this.pending.clear(); this.tools = []
    if (!this.reported) { this.reported = true; this.onExit(error) }
    void this.close().catch(() => undefined)
  }
  private write(message: Json): void {
    if (!this.child || this.closed || !this.child.stdin.writable) throw new Error('MCP Server 未连接')
    this.child.stdin.write(JSON.stringify(message) + '\n')
  }
  private request(method: string, params: Json, signal?: AbortSignal): Promise<Json> {
    signal?.throwIfAborted()
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      let cancelTimer: NodeJS.Timeout | undefined
      const cancel = (reason: string): void => {
        const item = this.pending.get(id)
        if (!item || item.cancelled) return
        item.cancelled = true; clearTimeout(timer)
        try { this.write({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason } }) } catch { /* unavailable process */ }
        reject(new Error(reason === 'timeout' ? 'MCP 请求超时：' + method : 'MCP 工具调用已取消'))
        cancelTimer = setTimeout(() => {
          if (this.pending.has(id)) this.fail(new Error('MCP 请求取消后未结束，Server 已停止'))
        }, 500)
      }
      const abort = (): void => cancel('cancelled')
      const timer = setTimeout(() => cancel('timeout'), this.config.timeoutMs)
      const cleanup = (): void => { clearTimeout(timer); clearTimeout(cancelTimer); signal?.removeEventListener('abort', abort) }
      this.pending.set(id, { resolve, reject, cleanup, cancelled: false })
      signal?.addEventListener('abort', abort, { once: true })
      try { this.write({ jsonrpc: '2.0', id, method, params }) }
      catch (cause) { this.pending.delete(id); cleanup(); reject(cause) }
      if (signal?.aborted) abort()
    })
  }
  refreshTools(): Promise<McpToolDescriptor[]> {
    const work = this.refreshChain.then(async () => {
      const response = await this.request('tools/list', {})
      if (!isRecord(response.result) || !Array.isArray(response.result.tools) || response.result.tools.length > 256)
        throw new Error('MCP 工具列表无效')
      const names = new Set<string>()
      const tools: McpToolDescriptor[] = response.result.tools.map((value: unknown) => {
        if (!isRecord(value) || typeof value.name !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(value.name) || names.has(value.name) ||
            (value.description !== undefined && typeof value.description !== 'string') ||
            !validSchema(value.inputSchema) || value.inputSchema.type !== 'object') throw new Error('MCP 工具描述或 schema 无效')
        names.add(value.name)
        return { name: value.name, qualifiedName: qualifiedMcpToolName(this.config.id, value.name), serverId: this.config.id,
          description: (this.config.name + ': ' + (value.description ?? value.name)).slice(0, 4096),
          inputSchema: structuredClone(value.inputSchema), schemaFingerprint: createHash('sha256').update(JSON.stringify(value.inputSchema)).digest('hex') }
      })
      if (this.closed) throw new Error('MCP Server 已关闭')
      this.tools = tools; this.onToolsChanged(); return this.getTools()
    })
    this.refreshChain = work.catch(() => [])
    return work
  }
  async call(tool: McpToolDescriptor, args: unknown, signal: AbortSignal): Promise<string> {
    const current = (): boolean => !this.closed && tool.serverId === this.config.id && this.tools.some((item) => item.name === tool.name && item.qualifiedName === tool.qualifiedName && item.schemaFingerprint === tool.schemaFingerprint)
    if (!current()) throw new Error('MCP 工具已失效，请刷新后重试')
    if (!validateMcpArguments(args, tool.inputSchema)) throw new Error('MCP 工具参数不符合 schema，参数必须是对象')
    const response = await this.request('tools/call', { name: tool.name, arguments: args }, signal)
    signal.throwIfAborted()
    if (!current()) throw new Error('MCP 工具 schema 已变化，调用结果已丢弃')
    if (!isRecord(response.result)) throw new Error('MCP 工具结果无效')
    const text = JSON.stringify(response.result)
    const marker = '\n[结果已截断]'
    return text.length > 12000 ? text.slice(0, 12000 - marker.length) + marker : text
  }
  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    for (const item of this.pending.values()) { item.cleanup(); item.reject(new Error('MCP Server 已关闭')) }
    this.pending.clear(); this.tools = []
    const child = this.child
    if (!child) return Promise.resolve()
    const work = (async () => {
      child.stdin.end()
      await Promise.race([this.exited, delay(500)])
      if (this.child === child) {
        if (process.platform === 'win32' && child.pid) {
          const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, env: safeEnv(), stdio: 'ignore' })
          await new Promise<void>((resolve) => { killer.once('error', () => resolve()); killer.once('close', () => resolve()) })
        }
        if (this.child === child) child.kill()
        await Promise.race([this.exited, delay(3000)])
        if (this.child === child) throw new Error('MCP 子进程尚未退出，请重试关闭')
      }
    })()
    this.closing = work
    void work.catch(() => { if (this.closing === work) this.closing = undefined })
    return work
  }
}
