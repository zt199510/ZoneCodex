import { BrowserWindow, ipcMain } from 'electron'
import { startCommandProcess, type CommandProcess } from './command-runner'
import { discardCommandExecution, type CommandExecutionPlan } from './command-plan'
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
  stopping?: Promise<boolean>
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
  signal: AbortSignal,
  assertCurrent: () => boolean
) => Promise<CommandExecutionPlan | null>

function waitForAuthorization(
  approval: Promise<CommandExecutionPlan | null>,
  signal: AbortSignal
): Promise<CommandExecutionPlan | null> {
  if (signal.aborted) {
    void approval.then(
      (plan) => {
        if (plan) discardCommandExecution(plan)
      },
      () => undefined
    )
    return Promise.resolve(null)
  }
  return new Promise<CommandExecutionPlan | null>((resolve, reject) => {
    const aborted = (): void => resolve(null)
    signal.addEventListener('abort', aborted, { once: true })
    void approval.then(
      (allowed) => {
        signal.removeEventListener('abort', aborted)
        if (signal.aborted && allowed) discardCommandExecution(allowed)
        resolve(signal.aborted ? null : allowed)
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
function stop(
  executionId: string,
  status: 'cancelled' | 'timed_out',
  error: string
): Promise<boolean> {
  const item = running.get(executionId)
  if (!item) return Promise.resolve(false)
  if (item.stopping) return item.stopping
  // Hold this window's reservation until termination has actually settled.
  item.stopping = Promise.resolve().then(async () => {
    const outcome = item.process ? await item.process.stop() : { treeExited: true }
    if (running.get(executionId) !== item) return false
    running.delete(executionId)
    const message = outcome.treeExited
      ? error
      : `${error}；已请求终止，进程树退出未确认，请核对本地结果`
    updateTask(item.windowId, item.taskId, status, { error: message })
    emit(item.windowId, { status, executionId, error: message })
    return true
  })
  item.controller.abort()
  return item.stopping
}
export function registerCommandExecution(
  isSourceAllowed: (windowId: number, source: CommandSource) => boolean = () => true,
  authorizeCommand: CommandAuthorization = async () => null
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
      queueMicrotask(() => {
        void stop(executionId, 'cancelled', '用户已取消执行')
      })
    }
    const sourceCurrent = (): boolean => {
      try {
        if (
          controller.signal.aborted ||
          w.isDestroyed() ||
          event.sender.isDestroyed() ||
          event.sender.mainFrame !== event.senderFrame ||
          !isSourceAllowed(w.id, req.source)
        )
          return false
        const current = getExecutionPermissionState(w.id)
        return (
          current.mode === permissionState.mode && current.revision === permissionState.revision
        )
      } catch {
        return false
      }
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
    let plan: CommandExecutionPlan | null = null
    try {
      plan = await waitForAuthorization(
        authorizeCommand(
          w.id,
          {
            requestId: req.source.requestId,
            conversationId: req.source.conversationId,
            cwd: claimed.directory,
            program,
            args: [...template.args]
          },
          controller.signal,
          sourceCurrent
        ),
        controller.signal
      )
      if (controller.signal.aborted || running.get(executionId) !== item) {
        await stop(executionId, 'cancelled', '用户已取消执行')
        return { status: 'error' as const, error: '执行已取消' }
      }
      if (!plan) {
        running.delete(executionId)
        controller.abort()
        updateTask(w.id, taskId, 'failed', { error: '未批准本次命令执行' })
        emit(w.id, { status: 'error', executionId, error: '未批准本次命令执行' })
        return { status: 'error' as const, error: '未批准本次命令执行' }
      }
      // Approval applies to this concrete command, and its source must still be current.
      if (!sourceCurrent()) {
        await stop(executionId, 'cancelled', '执行来源已失效，请重新发起')
        return { status: 'error' as const, error: '执行来源已失效，请重新发起' }
      }
      const fresh = await inspectCommandDirectory(claimed.directory)
      if (controller.signal.aborted || running.get(executionId) !== item) {
        await stop(executionId, 'cancelled', '用户已取消执行')
        return { status: 'error' as const, error: '执行已取消' }
      }
      if (!sourceCurrent()) {
        await stop(executionId, 'cancelled', '执行来源已失效，请重新发起')
        return { status: 'error' as const, error: '执行来源已失效，请重新发起' }
      }
      if (!sameCommandDirectory(fresh, claimed)) {
        throw new Error('目录或配置已变化，请重新选择并准备')
      }
      if (!updateTask(w.id, taskId, 'running')) {
        await stop(executionId, 'cancelled', '任务已结束，请重新发起')
        return { status: 'error' as const, error: '任务已结束，请重新发起' }
      }
      item.process = startCommandProcess({
        plan,
        timeoutMs: TIMEOUT,
        outputLimit: MAX_OUTPUT,
        outputMode: 'text',
        signal: controller.signal,
        access: { check: sourceCurrent, intervalMs: 250 },
        onAbort: () => {
          void stop(executionId, 'cancelled', '用户已取消执行')
        },
        onAccessLost: () => {
          void stop(executionId, 'cancelled', '执行来源或权限已失效')
        },
        onTimeout: () => {
          void stop(executionId, 'timed_out', '执行超过 60 秒')
        },
        onOutput: (stream, text, output) => {
          if (!running.has(executionId) || item.stopping) return
          emit(w.id, {
            status: 'output',
            executionId,
            stream,
            text,
            totalBytes: output.totalBytes,
            ...(output.truncated ? { truncated: true } : {})
          })
        },
        onError: (error, _output, outcome) => {
          if (!running.has(executionId) || item.stopping) return
          running.delete(executionId)
          const message = textError(error) + (outcome.treeExited ? '' : '；进程树退出未确认')
          updateTask(w.id, taskId, 'failed', { error: message })
          emit(w.id, { status: 'error', executionId, error: message })
        },
        onClose: (code, _signal, _output, outcome) => {
          if (!running.has(executionId) || item.stopping) return
          if (!outcome.treeExited) {
            running.delete(executionId)
            updateTask(w.id, taskId, 'failed', { error: '命令结束，进程树退出未确认，请核对结果' })
            emit(w.id, {
              status: 'error',
              executionId,
              error: '命令结束，进程树退出未确认，请核对结果'
            })
            return
          }
          if (!sourceCurrent()) {
            void stop(executionId, 'cancelled', '执行来源或权限已失效')
            return
          }
          if (outcome.stopped && code === 124) {
            void stop(executionId, 'timed_out', '执行超过 60 秒')
            return
          }
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
        await stop(executionId, 'cancelled', '用户已取消执行')
        return { status: 'error' as const, error: '执行已取消' }
      }
      if (item.process) await item.process.stop()
      running.delete(executionId)
      controller.abort()
      updateTask(w.id, taskId, 'failed', { error: textError(error) })
      emit(w.id, { status: 'error', executionId, error: textError(error) })
      return { status: 'error' as const, error: textError(error) }
    } finally {
      if (plan) discardCommandExecution(plan)
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
    if (item.windowId === windowId) void stop(id, 'cancelled', '执行来源已撤销或窗口已关闭')
  for (const key of confirmations) if (key.startsWith(`${windowId}:`)) confirmations.delete(key)
}
export function hasCommandExecution(windowId: number): boolean {
  return [...running.values()].some((item) => item.windowId === windowId)
}
