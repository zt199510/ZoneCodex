import { BrowserWindow, ipcMain } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  parseCommandExecutionRequest,
  type CommandExecutionEvent,
  type CommandSource
} from '../../shared/command-preparation'
import { claimCommandPreparation } from './command-preparation-ipc'
import { getCommandTemplate } from '../../shared/permission-policy'
import {
  attachTaskRuntime,
  createTask,
  findTaskByRequest,
  newTaskId,
  updateTask
} from './task-registry'

type Running = {
  windowId: number
  child: ChildProcess
  timer: NodeJS.Timeout
  bytes: number
  truncated: boolean
  taskId: string
}
const running = new Map<string, Running>()
const confirmations = new Set<string>()
const MAX_OUTPUT = 256 * 1024
const TIMEOUT = 60_000
const textError = (value: unknown): string =>
  (value instanceof Error ? value.message : '命令启动失败').slice(0, 500)
function owner(event: Electron.IpcMainInvokeEvent): BrowserWindow {
  const w = BrowserWindow.fromWebContents(event.sender)
  if (!w || w.isDestroyed() || event.senderFrame !== event.sender.mainFrame)
    throw new Error('不支持的执行来源')
  return w
}
function emit(windowId: number, event: CommandExecutionEvent): void {
  const w = BrowserWindow.fromId(windowId)
  if (w && !w.isDestroyed()) w.webContents.send('command-execution:event', event)
}
function stop(executionId: string, status: 'cancelled' | 'timed_out', error: string): boolean {
  const item = running.get(executionId)
  if (!item) return false
  clearTimeout(item.timer)
  running.delete(executionId)
  item.child.kill()
  updateTask(item.windowId, item.taskId, status, { error })
  emit(item.windowId, { status, executionId, error })
  return true
}
export function registerCommandExecution(
  isSourceAllowed: (windowId: number, source: CommandSource) => boolean = () => true
): void {
  ipcMain.handle('command-execution:start', (event, raw: unknown) => {
    const w = owner(event)
    const req = parseCommandExecutionRequest(raw)
    if (!req || !isSourceAllowed(w.id, req.source))
      return { status: 'error' as const, error: '执行来源无效' }
    const confirmationKey = `${w.id}:${req.confirmationId}`
    if (
      confirmations.has(confirmationKey) ||
      [...running.values()].some((item) => item.windowId === w.id)
    )
      return { status: 'error' as const, error: '当前窗口已有执行或确认已使用' }
    confirmations.add(confirmationKey)
    const claimed = claimCommandPreparation(w.id, req.preparedId, req.source)
    if (!claimed) return { status: 'error' as const, error: '准备记录已失效，请重新检查' }
    const template = getCommandTemplate(req.source.template)
    if (!template) return { status: 'error' as const, error: '命令模板无效' }
    const executionId = randomUUID()
    const waitingTask = findTaskByRequest(w.id, req.source.requestId)
    const taskId = waitingTask?.taskId ?? newTaskId()
    const program = process.platform === 'win32' ? `${template.program}.cmd` : template.program
    let childRef: ChildProcess | null = null
    const task =
      waitingTask ??
      createTask({
        taskId,
        requestId: req.source.requestId,
        conversationId: req.source.conversationId,
        kind: 'command',
        windowId: w.id,
        snapshotId: req.source.snapshotId,
        cancel: () => childRef?.kill()
      })
    if (!task) return { status: 'error' as const, error: '任务创建失败，请重新发起' }
    try {
      const child = spawn(program, [...template.args], {
        cwd: claimed.directory,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      childRef = child
      if (!attachTaskRuntime(w.id, taskId, () => childRef?.kill(), req.source.snapshotId)) {
        child.kill()
        updateTask(w.id, taskId, 'failed', { error: '任务运行时已失效，请重新发起' })
        return { status: 'error' as const, error: '任务运行时已失效，请重新发起' }
      }
      const item: Running = {
        windowId: w.id,
        child,
        timer: setTimeout(() => stop(executionId, 'timed_out', '执行超过 60 秒'), TIMEOUT),
        bytes: 0,
        truncated: false,
        taskId
      }
      running.set(executionId, item)
      updateTask(w.id, taskId, 'running')
      const output = (stream: 'stdout' | 'stderr') => (chunk: Buffer | string) => {
        if (item.truncated) return
        const value = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk
        const remaining = MAX_OUTPUT - item.bytes
        if (Buffer.byteLength(value, 'utf8') > remaining) {
          const clipped = Buffer.from(value).subarray(0, Math.max(0, remaining)).toString('utf8')
          item.bytes = MAX_OUTPUT
          item.truncated = true
          emit(w.id, {
            status: 'output',
            executionId,
            stream,
            text: clipped,
            totalBytes: item.bytes,
            truncated: true
          })
          return
        }
        item.bytes += Buffer.byteLength(value, 'utf8')
        emit(w.id, { status: 'output', executionId, stream, text: value, totalBytes: item.bytes })
      }
      child.stdout?.on('data', output('stdout'))
      child.stderr?.on('data', output('stderr'))
      child.once('error', (error) => {
        if (!running.has(executionId)) return
        clearTimeout(item.timer)
        running.delete(executionId)
        updateTask(w.id, taskId, 'failed', { error: textError(error) })
        emit(w.id, { status: 'error', executionId, error: textError(error) })
      })
      child.once('close', (code) => {
        if (!running.has(executionId)) return
        clearTimeout(item.timer)
        running.delete(executionId)
        const exitCode = typeof code === 'number' ? code : -1
        if (exitCode === 0) updateTask(w.id, taskId, 'completed', { result: '命令执行完成' })
        else updateTask(w.id, taskId, 'failed', { error: `进程退出码：${exitCode}` })
        emit(w.id, { status: 'finished', executionId, exitCode })
      })
      emit(w.id, { status: 'started', executionId })
      return { status: 'started' as const, executionId }
    } catch (error) {
      updateTask(w.id, taskId, 'failed', { error: textError(error) })
      return { status: 'error' as const, error: textError(error) }
    }
  })
  ipcMain.handle('command-execution:cancel', (event, executionId: unknown) => {
    const w = owner(event)
    if (typeof executionId !== 'string') return false
    const item = running.get(executionId)
    return !!item && item.windowId === w.id && stop(executionId, 'cancelled', '用户已取消执行')
  })
}
export function cleanupCommandExecution(windowId: number): void {
  for (const [id, item] of running)
    if (item.windowId === windowId) stop(id, 'cancelled', '窗口已关闭')
  for (const key of confirmations) if (key.startsWith(`${windowId}:`)) confirmations.delete(key)
}
export function hasCommandExecution(windowId: number): boolean {
  return [...running.values()].some((item) => item.windowId === windowId)
}
