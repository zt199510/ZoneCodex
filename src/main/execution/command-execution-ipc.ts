import { BrowserWindow, ipcMain } from 'electron'
import { startCommandProcess, type CommandProcess } from './command-runner'
import { getIpcWindow } from '../ipc-source'
import { randomUUID } from 'node:crypto'
import {
  parseCommandExecutionRequest,
  type CommandExecutionEvent,
  type CommandSource
} from '../../shared/command-preparation'
import { claimCommandPreparation } from './command-preparation-ipc'
import { getExecutionPermissionState } from './permission-state'
import { getCommandTemplate } from '../../shared/permission-policy'
import { inspectCommandDirectory, sameCommandDirectory } from '../tools/command-directory'
import {
  attachTaskRuntime,
  createTask,
  findTaskByRequest,
  newTaskId,
  updateTask
} from './task-registry'

type Running = {
  windowId: number
  process: CommandProcess | null
  controller: AbortController
  taskId: string
}
const running = new Map<string, Running>()
const confirmations = new Set<string>()
const MAX_OUTPUT = 256 * 1024
const TIMEOUT = 60_000
const textError = (value: unknown): string =>
  (value instanceof Error ? value.message : '命令启动失败').slice(0, 500)

export type CommandAuthorization = (
  windowId: number,
  request: {
    requestId: string
    conversationId: string
    cwd: string
    program: string
    args: string[]
  },
  signal: AbortSignal
) => Promise<boolean>

function waitForAuthorization(approval: Promise<boolean>, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) {
    void approval.catch(() => undefined)
    return Promise.resolve(false)
  }
  return new Promise<boolean>((resolve, reject) => {
    const aborted = (): void => resolve(false)
    signal.addEventListener('abort', aborted, { once: true })
    void approval.then(
      (allowed) => {
        signal.removeEventListener('abort', aborted)
        resolve(allowed)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', aborted)
        reject(error)
      }
    )
  })
}

function owner(event: Electron.IpcMainInvokeEvent): BrowserWindow {
  return getIpcWindow(event, '不支持的执行来源', { windowMustBeLive: true })
}
function emit(windowId: number, event: CommandExecutionEvent): void {
  const w = BrowserWindow.fromId(windowId)
  if (w && !w.isDestroyed()) w.webContents.send('command-execution:event', event)
}
function stop(executionId: string, status: 'cancelled' | 'timed_out', error: string): boolean {
  const item = running.get(executionId)
  if (!item) return false
  running.delete(executionId)
  item.controller.abort()
  item.process?.stop()
  updateTask(item.windowId, item.taskId, status, { error })
  emit(item.windowId, { status, executionId, error })
  return true
}
export function registerCommandExecution(
  isSourceAllowed: (windowId: number, source: CommandSource) => boolean = () => true,
  authorizeCommand: CommandAuthorization = async () => false
): void {
  ipcMain.handle('command-execution:start', async (event, raw: unknown) => {
    const w = owner(event)
    const req = parseCommandExecutionRequest(raw)
    if (!req || !isSourceAllowed(w.id, req.source))
      return { status: 'error' as const, error: '执行来源无效' }
    const permissionState = getExecutionPermissionState(w.id)
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
    const controller = new AbortController()
    const cancel = (): void => {
      controller.abort()
      // task:cancel owns the immediate waiting_approval transition; settle execution next.
      queueMicrotask(() => stop(executionId, 'cancelled', '用户已取消执行'))
    }
    const task =
      waitingTask ??
      createTask({
        taskId,
        requestId: req.source.requestId,
        conversationId: req.source.conversationId,
        kind: 'command',
        windowId: w.id,
        snapshotId: req.source.snapshotId,
        cancel
      })
    if (!task) return { status: 'error' as const, error: '任务创建失败，请重新发起' }
    const item: Running = {
      windowId: w.id,
      process: null,
      controller,
      taskId
    }
    // Reserve the window before awaiting approval so a second request cannot spawn again.
    running.set(executionId, item)
    if (
      !attachTaskRuntime(w.id, taskId, cancel, req.source.snapshotId) ||
      !updateTask(w.id, taskId, 'waiting_approval')
    ) {
      running.delete(executionId)
      controller.abort()
      updateTask(w.id, taskId, 'failed', { error: '任务运行时已失效，请重新发起' })
      return { status: 'error' as const, error: '任务运行时已失效，请重新发起' }
    }
    try {
      const allowed = await waitForAuthorization(
        authorizeCommand(
          w.id,
          {
            requestId: req.source.requestId,
            conversationId: req.source.conversationId,
            cwd: claimed.directory,
            program,
            args: [...template.args]
          },
          controller.signal
        ),
        controller.signal
      )
      if (controller.signal.aborted || running.get(executionId) !== item) {
        stop(executionId, 'cancelled', '用户已取消执行')
        return { status: 'error' as const, error: '执行已取消' }
      }
      if (!allowed) {
        running.delete(executionId)
        controller.abort()
        updateTask(w.id, taskId, 'failed', { error: '未批准本次命令执行' })
        emit(w.id, { status: 'error', executionId, error: '未批准本次命令执行' })
        return { status: 'error' as const, error: '未批准本次命令执行' }
      }
      // Approval applies to this concrete command, and its source must still be current.
      const sourceCurrent = (): boolean => {
        if (
          w.isDestroyed() ||
          event.sender.isDestroyed() ||
          event.sender.mainFrame !== event.senderFrame ||
          !isSourceAllowed(w.id, req.source)
        ) {
          return false
        }
        const current = getExecutionPermissionState(w.id)
        return (
          current.mode === permissionState.mode && current.revision === permissionState.revision
        )
      }
      if (!sourceCurrent()) {
        stop(executionId, 'cancelled', '执行来源已失效，请重新发起')
        return { status: 'error' as const, error: '执行来源已失效，请重新发起' }
      }
      const fresh = await inspectCommandDirectory(claimed.directory)
      if (controller.signal.aborted || running.get(executionId) !== item) {
        stop(executionId, 'cancelled', '用户已取消执行')
        return { status: 'error' as const, error: '执行已取消' }
      }
      if (!sourceCurrent()) {
        stop(executionId, 'cancelled', '执行来源已失效，请重新发起')
        return { status: 'error' as const, error: '执行来源已失效，请重新发起' }
      }
      if (!sameCommandDirectory(fresh, claimed)) {
        throw new Error('目录或配置已变化，请重新选择并准备')
      }
      if (!updateTask(w.id, taskId, 'running')) {
        stop(executionId, 'cancelled', '任务已结束，请重新发起')
        return { status: 'error' as const, error: '任务已结束，请重新发起' }
      }
      item.process = startCommandProcess({
        program,
        args: [...template.args],
        cwd: claimed.directory,
        timeoutMs: TIMEOUT,
        outputLimit: MAX_OUTPUT,
        outputMode: 'text',
        onTimeout: () => {
          stop(executionId, 'timed_out', '执行超过 60 秒')
        },
        onOutput: (stream, text, output) => {
          if (!running.has(executionId)) return
          emit(w.id, {
            status: 'output',
            executionId,
            stream,
            text,
            totalBytes: output.totalBytes,
            ...(output.truncated ? { truncated: true } : {})
          })
        },
        onError: (error) => {
          if (!running.has(executionId)) return
          running.delete(executionId)
          updateTask(w.id, taskId, 'failed', { error: textError(error) })
          emit(w.id, { status: 'error', executionId, error: textError(error) })
        },
        onClose: (code) => {
          if (!running.has(executionId)) return
          running.delete(executionId)
          const exitCode = typeof code === 'number' ? code : -1
          if (exitCode === 0) updateTask(w.id, taskId, 'completed', { result: '命令执行完成' })
          else updateTask(w.id, taskId, 'failed', { error: `进程退出码：${exitCode}` })
          emit(w.id, { status: 'finished', executionId, exitCode })
        }
      })
      emit(w.id, { status: 'started', executionId })
      return { status: 'started' as const, executionId }
    } catch (error) {
      if (controller.signal.aborted || running.get(executionId) !== item) {
        stop(executionId, 'cancelled', '用户已取消执行')
        return { status: 'error' as const, error: '执行已取消' }
      }
      running.delete(executionId)
      controller.abort()
      item.process?.stop()
      updateTask(w.id, taskId, 'failed', { error: textError(error) })
      emit(w.id, { status: 'error', executionId, error: textError(error) })
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
