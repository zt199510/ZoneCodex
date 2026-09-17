import { BrowserWindow, ipcMain } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import { isAgentId } from '../../shared/agent'
import {
  parsePreparationRequest,
  type PreparationRequest,
  type PreparationResult
} from '../../shared/change-preparation'
import { captureProjectAccess } from './project-access'
import { prepareChange, type PreparedContent } from '../tools/change-preparation'

type Task = { request: PreparationRequest; controller: AbortController }
type RecordEntry = {
  windowId: number
  request: PreparationRequest
  content: PreparedContent
  preparationId: string
  expiresAt: number
  timer: ReturnType<typeof setTimeout>
}
const tasks = new Map<number, Task>()
const records = new Map<number, RecordEntry>()
export const hasChangePreparation = (windowId: number): boolean => tasks.has(windowId)

export function cleanupChangePreparation(windowId: number, checkId?: string): boolean {
  let cleared = false
  const task = tasks.get(windowId)
  if (task && (!checkId || task.request.checkId === checkId)) {
    task.controller.abort()
    // Keep occupancy until the read's finally has closed its handle.
    cleared = true
  }
  const record = records.get(windowId)
  if (record && (!checkId || record.request.checkId === checkId)) {
    clearTimeout(record.timer)
    records.delete(windowId)
    cleared = true
  }
  return cleared
}

function ownerOf(event: IpcMainInvokeEvent): BrowserWindow {
  const owner = BrowserWindow.fromWebContents(event.sender)
  if (!owner || owner.isDestroyed() || event.senderFrame !== event.sender.mainFrame)
    throw new Error('不支持的准备来源')
  return owner
}

export function registerChangePreparation(isBusy: (windowId: number) => boolean): void {
  ipcMain.handle('preparation:cancel', (event, checkId: unknown) => {
    const owner = ownerOf(event)
    return isAgentId(checkId) && cleanupChangePreparation(owner.id, checkId)
  })
  ipcMain.handle('preparation:check', async (event, value: unknown): Promise<PreparationResult> => {
    const owner = ownerOf(event)
    const request = parsePreparationRequest(value)
    const error = (message: string): PreparationResult => ({ status: 'error', error: message })
    if (!request) return error('准备请求格式不正确')
    if (isBusy(owner.id) || tasks.has(owner.id)) return error('请先完成当前操作')
    const snapshot = captureProjectAccess(owner.id, request.conversationId, request.snapshotId)
    if (!snapshot) return error('附件授权已失效，请重新选择文件')
    cleanupChangePreparation(owner.id)
    const task = { request, controller: new AbortController() }
    tasks.set(owner.id, task)
    try {
      const content = await prepareChange(
        snapshot,
        request.path,
        request.proposedText,
        task.controller.signal
      )
      if (
        task.controller.signal.aborted ||
        tasks.get(owner.id) !== task ||
        owner.isDestroyed() ||
        owner.webContents.isDestroyed() ||
        captureProjectAccess(owner.id, request.conversationId, request.snapshotId) !== snapshot
      )
        return error('检查已取消或授权已失效')
      if (content.status !== 'prepared') return content
      const preparationId = randomUUID()
      const expiresAt = Date.now() + 120000
      const timer = setTimeout(() => {
        if (records.get(owner.id)?.preparationId === preparationId) records.delete(owner.id)
      }, 120000)
      timer.unref()
      records.set(owner.id, {
        windowId: owner.id,
        request,
        content,
        preparationId,
        expiresAt,
        timer
      })
      return {
        status: 'ready',
        preparationId,
        conversationId: request.conversationId,
        snapshotId: request.snapshotId,
        path: request.path,
        checkId: request.checkId,
        bytes: content.candidateBytes.length,
        encoding: content.encoding,
        newline: content.newline,
        expiresAt
      }
    } catch {
      return error('检查已取消或无法确认磁盘版本，请重新选择文件')
    } finally {
      if (tasks.get(owner.id) === task) tasks.delete(owner.id)
    }
  })
}
