import { BrowserWindow, ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { isTerminalTaskStatus, maxTaskRecords, parseTaskRecord } from '../../shared/task'
import type { TaskKind, TaskRecord, TaskRecordStatus } from '../../shared/task'

type RuntimeTask = {
  windowId: number
  snapshotId?: string
  cancel: () => void
}

type TaskSeed = {
  taskId: string
  requestId: string
  conversationId: string
  kind: TaskKind
  windowId: number
  snapshotId?: string
  cancel?: () => void
}

const records = new Map<number, Map<string, TaskRecord>>()
const runtimes = new Map<string, RuntimeTask>()
const byRequest = new Map<number, Set<string>>()

const allowedTransitions: Record<TaskRecordStatus, readonly TaskRecordStatus[]> = {
  created: ['running', 'waiting_approval', 'cancelled', 'failed', 'interrupted'],
  running: ['waiting_approval', 'completed', 'cancelled', 'failed', 'timed_out', 'interrupted'],
  waiting_approval: ['running', 'cancelled', 'failed', 'timed_out', 'interrupted'],
  completed: [],
  cancelled: [],
  failed: [],
  timed_out: [],
  interrupted: []
}

export function canTransitionTaskStatus(from: TaskRecordStatus, to: TaskRecordStatus): boolean {
  return allowedTransitions[from].includes(to)
}

function validId(value: string): boolean {
  return /^[a-zA-Z0-9-]{1,80}$/.test(value)
}

function now(): string {
  return new Date().toISOString()
}

function send(windowId: number, record: TaskRecord): void {
  const fromId = (
    BrowserWindow as typeof BrowserWindow & {
      fromId?: (id: number) => BrowserWindow | null
    }
  ).fromId
  if (typeof fromId !== 'function') return
  const window = fromId(windowId)
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return
  window.webContents.send('task:state', { record })
}

function store(windowId: number, record: TaskRecord): void {
  let current = records.get(windowId)
  if (!current) {
    current = new Map()
    records.set(windowId, current)
  }
  current.set(record.taskId, record)
  send(windowId, record)
}

function get(windowId: number, taskId: string): TaskRecord | null {
  return records.get(windowId)?.get(taskId) ?? null
}

function removeRequestIndex(windowId: number, taskId: string): void {
  const requests = byRequest.get(windowId)
  if (!requests) return
  requests.delete(taskId)
  if (requests.size === 0) byRequest.delete(windowId)
}

export function createTask(seed: TaskSeed): TaskRecord | null {
  if (
    !validId(seed.taskId) ||
    !validId(seed.requestId) ||
    !validId(seed.conversationId) ||
    get(seed.windowId, seed.taskId) ||
    [...(byRequest.get(seed.windowId) ?? [])].some((id) => {
      const record = get(seed.windowId, id)
      return (
        record?.requestId === seed.requestId &&
        record !== undefined &&
        !isTerminalTaskStatus(record.status)
      )
    })
  ) {
    return null
  }
  const current = records.get(seed.windowId)
  if (current && current.size >= maxTaskRecords) {
    const oldestTerminal = [...current.values()].find((candidate) =>
      isTerminalTaskStatus(candidate.status)
    )
    if (!oldestTerminal) return null
    current.delete(oldestTerminal.taskId)
    removeRequestIndex(seed.windowId, oldestTerminal.taskId)
  }
  const record: TaskRecord = {
    taskId: seed.taskId,
    requestId: seed.requestId,
    conversationId: seed.conversationId,
    kind: seed.kind,
    status: 'created',
    createdAt: now(),
    startedAt: null,
    finishedAt: null,
    result: null,
    error: null
  }
  store(seed.windowId, record)
  let requests = byRequest.get(seed.windowId)
  if (!requests) {
    requests = new Set()
    byRequest.set(seed.windowId, requests)
  }
  requests.add(seed.taskId)
  runtimes.set(seed.taskId, {
    windowId: seed.windowId,
    snapshotId: seed.snapshotId,
    cancel: seed.cancel ?? (() => undefined)
  })
  return record
}

export function updateTask(
  windowId: number,
  taskId: string,
  status: TaskRecordStatus,
  details: { result?: string | null; error?: string | null } = {}
): TaskRecord | null {
  const previous = get(windowId, taskId)
  if (!previous || isTerminalTaskStatus(previous.status)) return null
  if (status === previous.status) return { ...previous }
  if (!canTransitionTaskStatus(previous.status, status)) return null
  const active = status === 'running' || status === 'waiting_approval'
  const next: TaskRecord = {
    ...previous,
    status,
    startedAt: active ? (previous.startedAt ?? now()) : previous.startedAt,
    finishedAt: isTerminalTaskStatus(status) ? now() : null,
    result: details.result === undefined ? previous.result : details.result,
    error: details.error === undefined ? previous.error : details.error
  }
  if (!parseTaskRecord(next)) return null
  store(windowId, next)
  if (isTerminalTaskStatus(status)) {
    runtimes.delete(taskId)
    removeRequestIndex(windowId, taskId)
  }
  return next
}

export function findTaskByRequest(windowId: number, requestId: string): TaskRecord | null {
  for (const record of records.get(windowId)?.values() ?? []) {
    if (record.requestId === requestId && record.status === 'waiting_approval') return { ...record }
  }
  return null
}

export function attachTaskRuntime(
  windowId: number,
  taskId: string,
  cancel: () => void,
  snapshotId?: string
): boolean {
  const record = get(windowId, taskId)
  if (!record || isTerminalTaskStatus(record.status)) return false
  runtimes.set(taskId, { windowId, snapshotId, cancel })
  return true
}

export function cancelTask(windowId: number, taskId: string): boolean {
  const runtime = runtimes.get(taskId)
  const record = get(windowId, taskId)
  if (!runtime || runtime.windowId !== windowId || !record || isTerminalTaskStatus(record.status))
    return false
  // Cancellation is a request. The underlying stream/process owns the reliable
  // terminal transition and will publish `cancelled` after it has stopped.
  try {
    runtime.cancel()
    if (record.status === 'waiting_approval') {
      return updateTask(windowId, taskId, 'cancelled', { error: '用户已取消任务' }) !== null
    }
    return true
  } catch {
    return false
  }
}

export function cleanupTasksForSnapshot(windowId: number, snapshotId: string): void {
  for (const [taskId, runtime] of runtimes) {
    if (runtime.windowId !== windowId || runtime.snapshotId !== snapshotId) continue
    try {
      runtime.cancel()
      const record = get(windowId, taskId)
      if (record?.status === 'waiting_approval') {
        updateTask(windowId, taskId, 'cancelled', { error: '工作区授权已撤销' })
      }
    } catch {
      // The task's owner still performs the terminal transition. A failed
      // cancellation callback must not make the persisted record look settled.
    }
  }
}

export function listTasks(windowId: number): TaskRecord[] {
  return [...(records.get(windowId)?.values() ?? [])].map((record) => ({ ...record }))
}

/** Cancel runtime handles and mark non-terminal records interrupted on window teardown. */
export function cleanupTaskWindow(windowId: number): void {
  for (const [taskId, runtime] of runtimes) {
    if (runtime.windowId !== windowId) continue
    try {
      runtime.cancel()
    } catch {
      // Window teardown still records interruption even if a handle is already gone.
    }
    updateTask(windowId, taskId, 'interrupted', { error: '窗口已关闭，任务未继续运行' })
  }
  runtimes.forEach((runtime, taskId) => {
    if (runtime.windowId === windowId) runtimes.delete(taskId)
  })
  byRequest.delete(windowId)
}

export function discardTaskWindow(windowId: number): void {
  cleanupTaskWindow(windowId)
  records.delete(windowId)
}

export function registerTaskLifecycle(): void {
  ipcMain.handle('task:list', (event): TaskRecord[] => {
    const owner = BrowserWindow.fromWebContents(event.sender)
    if (!owner || owner.isDestroyed() || event.senderFrame !== event.sender.mainFrame) {
      throw new Error('不支持的任务来源')
    }
    return listTasks(owner.id)
  })
  ipcMain.handle('task:cancel', (event, taskId: unknown): boolean => {
    const owner = BrowserWindow.fromWebContents(event.sender)
    if (!owner || owner.isDestroyed() || event.senderFrame !== event.sender.mainFrame) {
      throw new Error('不支持的任务来源')
    }
    return typeof taskId === 'string' && cancelTask(owner.id, taskId)
  })
}

export function newTaskId(): string {
  return randomUUID()
}
