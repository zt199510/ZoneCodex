import { BrowserWindow, ipcMain } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { parseCommandExecutionRequest, type CommandExecutionEvent, type CommandSource } from '../../shared/command-preparation'
import { claimCommandPreparation } from './command-preparation-ipc'

type Running = { windowId: number; child: ChildProcess; timer: NodeJS.Timeout; bytes: number; truncated: boolean }
const running = new Map<string, Running>()
const confirmations = new Set<string>()
const MAX_OUTPUT = 256 * 1024
const TIMEOUT = 60_000
const textError = (value: unknown): string => (value instanceof Error ? value.message : '命令启动失败').slice(0, 500)
function owner(event: Electron.IpcMainInvokeEvent): BrowserWindow {
  const w = BrowserWindow.fromWebContents(event.sender)
  if (!w || w.isDestroyed() || event.senderFrame !== event.sender.mainFrame) throw new Error('不支持的执行来源')
  return w
}
function emit(windowId: number, event: CommandExecutionEvent): void {
  const w = BrowserWindow.fromId(windowId); if (w && !w.isDestroyed()) w.webContents.send('command-execution:event', event)
}
function stop(executionId: string, status: 'cancelled' | 'timed_out', error: string): boolean {
  const item = running.get(executionId); if (!item) return false
  clearTimeout(item.timer); running.delete(executionId); item.child.kill(); emit(item.windowId, { status, executionId, error }); return true
}
export function registerCommandExecution(isSourceAllowed: (windowId: number, source: CommandSource) => boolean = () => true): void {
  ipcMain.handle('command-execution:start', (event, raw: unknown) => {
    const w = owner(event); const req = parseCommandExecutionRequest(raw)
    if (!req || !isSourceAllowed(w.id, req.source)) return { status: 'error' as const, error: '执行来源无效' }
    const confirmationKey = `${w.id}:${req.confirmationId}`
    if (confirmations.has(confirmationKey) || [...running.values()].some(item => item.windowId === w.id)) return { status: 'error' as const, error: '当前窗口已有执行或确认已使用' }
    confirmations.add(confirmationKey)
    const claimed = claimCommandPreparation(w.id, req.preparedId, req.source)
    if (!claimed) return { status: 'error' as const, error: '准备记录已失效，请重新检查' }
    const executionId = randomUUID(); const program = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    try {
      const child = spawn(program, ['run', 'typecheck'], { cwd: claimed.directory, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      const item: Running = { windowId: w.id, child, timer: setTimeout(() => stop(executionId, 'timed_out', '执行超过 60 秒'), TIMEOUT), bytes: 0, truncated: false }
      running.set(executionId, item)
      const output = (stream: 'stdout' | 'stderr') => (chunk: Buffer | string) => {
        if (item.truncated) return
        const value = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk; const remaining = MAX_OUTPUT - item.bytes
        if (Buffer.byteLength(value, 'utf8') > remaining) { const clipped = Buffer.from(value).subarray(0, Math.max(0, remaining)).toString('utf8'); item.bytes = MAX_OUTPUT; item.truncated = true; emit(w.id, { status: 'output', executionId, stream, text: clipped, totalBytes: item.bytes, truncated: true }); return }
        item.bytes += Buffer.byteLength(value, 'utf8'); emit(w.id, { status: 'output', executionId, stream, text: value, totalBytes: item.bytes })
      }
      child.stdout?.on('data', output('stdout')); child.stderr?.on('data', output('stderr'))
      child.once('error', (error) => { if (!running.has(executionId)) return; clearTimeout(item.timer); running.delete(executionId); emit(w.id, { status: 'error', executionId, error: textError(error) }) })
      child.once('close', (code) => { if (!running.has(executionId)) return; clearTimeout(item.timer); running.delete(executionId); emit(w.id, { status: 'finished', executionId, exitCode: typeof code === 'number' ? code : -1 }) })
      emit(w.id, { status: 'started', executionId }); return { status: 'started' as const, executionId }
    } catch (error) { return { status: 'error' as const, error: textError(error) } }
  })
  ipcMain.handle('command-execution:cancel', (event, executionId: unknown) => { const w = owner(event); if (typeof executionId !== 'string') return false; const item = running.get(executionId); return !!item && item.windowId === w.id && stop(executionId, 'cancelled', '用户已取消执行') })
}
export function cleanupCommandExecution(windowId: number): void { for (const [id, item] of running) if (item.windowId === windowId) stop(id, 'cancelled', '窗口已关闭'); for (const key of confirmations) if (key.startsWith(`${windowId}:`)) confirmations.delete(key) }
export function hasCommandExecution(windowId: number): boolean { return [...running.values()].some(item => item.windowId === windowId) }
