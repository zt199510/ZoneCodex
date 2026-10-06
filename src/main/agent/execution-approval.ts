import { BrowserWindow, ipcMain } from 'electron'
import type { IpcMainInvokeEvent, WebContents, WebFrameMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { parseExecutionApproval } from '../../shared/execution'
import type { ExecutionApproval, ExecutionApprovalInput } from '../../shared/execution'

type PendingApproval = {
  owner: BrowserWindow
  sender: WebContents
  frame: WebFrameMain
  approval: ExecutionApproval
  signal: AbortSignal
  cancel: () => void
  resolve: (approved: boolean) => void
}

const pending = new Map<number, PendingApproval>()

function cloneApproval(approval: ExecutionApproval): ExecutionApproval {
  return approval.kind === 'command' ? { ...approval, args: [...approval.args] } : { ...approval }
}

function ownerOf(event: IpcMainInvokeEvent): BrowserWindow {
  const owner = BrowserWindow.fromWebContents(event.sender)
  if (
    !owner ||
    owner.isDestroyed() ||
    event.sender.isDestroyed() ||
    event.senderFrame !== event.sender.mainFrame
  ) {
    throw new Error('不支持的审批来源')
  }
  return owner
}

function emit(item: PendingApproval, approval: ExecutionApproval | null): boolean {
  if (item.owner.isDestroyed() || item.sender.isDestroyed()) return false
  try {
    item.sender.send('execution:approval-change', approval ? cloneApproval(approval) : null)
    return true
  } catch {
    // Teardown can destroy the renderer between the state check and send.
    return false
  }
}

function isCurrent(item: PendingApproval): boolean {
  return (
    !item.signal.aborted &&
    !item.owner.isDestroyed() &&
    !item.sender.isDestroyed() &&
    item.sender.mainFrame === item.frame
  )
}

function settle(windowId: number, item: PendingApproval, approved: boolean): boolean {
  if (pending.get(windowId) !== item) return false
  pending.delete(windowId)
  item.signal.removeEventListener('abort', item.cancel)
  item.sender.removeListener('did-start-loading', item.cancel)
  item.sender.removeListener('render-process-gone', item.cancel)
  item.sender.removeListener('destroyed', item.cancel)
  item.owner.removeListener('closed', item.cancel)
  emit(item, null)
  item.resolve(approved)
  return true
}

function parseResponse(value: unknown): { approvalId: string; approved: boolean } | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return null
  const keys = Reflect.ownKeys(value)
  if (keys.length !== 2 || !keys.includes('approvalId') || !keys.includes('approved')) return null
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (
    !('value' in descriptors.approvalId) ||
    !('value' in descriptors.approved) ||
    typeof descriptors.approvalId.value !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
      descriptors.approvalId.value
    ) ||
    typeof descriptors.approved.value !== 'boolean'
  ) {
    return null
  }
  return {
    approvalId: descriptors.approvalId.value,
    approved: descriptors.approved.value
  }
}

/** Only the originating window and document can answer its current one-time approval. */
export function registerExecutionApproval(): void {
  ipcMain.handle('execution:approval-get', (event): ExecutionApproval | null => {
    const owner = ownerOf(event)
    const item = pending.get(owner.id)
    if (!item) return null
    if (!isCurrent(item)) {
      settle(owner.id, item, false)
      return null
    }
    return cloneApproval(item.approval)
  })
  ipcMain.handle('execution:approval-respond', (event, value: unknown): boolean => {
    const owner = ownerOf(event)
    const response = parseResponse(value)
    if (!response) return false
    const item = pending.get(owner.id)
    if (!item || response.approvalId !== item.approval.approvalId) return false
    if (!isCurrent(item) || event.senderFrame !== item.frame) {
      settle(owner.id, item, false)
      return false
    }
    return settle(owner.id, item, response.approved)
  })
}

/** Approval is held only for this pending operation and is never saved to disk. */
export function requestExecutionApproval(
  windowId: number,
  input: ExecutionApprovalInput,
  signal: AbortSignal
): Promise<boolean> {
  if (signal.aborted || pending.has(windowId)) return Promise.resolve(false)
  const owner = BrowserWindow.fromId(windowId)
  if (!owner || owner.isDestroyed() || owner.webContents.isDestroyed()) {
    return Promise.resolve(false)
  }
  const approval = parseExecutionApproval({ ...input, approvalId: randomUUID() })
  if (!approval) return Promise.resolve(false)
  const sender = owner.webContents
  const frame = sender.mainFrame
  return new Promise<boolean>((resolve) => {
    const item: PendingApproval = {
      owner,
      sender,
      frame,
      approval: cloneApproval(approval),
      signal,
      resolve,
      cancel: () => settle(windowId, item, false)
    }
    pending.set(windowId, item)
    signal.addEventListener('abort', item.cancel, { once: true })
    sender.once('did-start-loading', item.cancel)
    sender.once('render-process-gone', item.cancel)
    sender.once('destroyed', item.cancel)
    owner.once('closed', item.cancel)
    if (!isCurrent(item)) {
      settle(windowId, item, false)
      return
    }
    if (!emit(item, item.approval)) settle(windowId, item, false)
  })
}

export function hasExecutionApproval(windowId: number): boolean {
  return pending.has(windowId)
}

export function clearExecutionApproval(windowId: number): void {
  const item = pending.get(windowId)
  if (item) settle(windowId, item, false)
}
