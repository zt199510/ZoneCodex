import { BrowserWindow, ipcMain, shell } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { basename } from 'node:path'
import { isAgentId } from '../../shared/agent'
import { parseCommitRequest, type CommitResult } from '../../shared/change-commit'
import { captureProjectAccess, revokeProjectFiles } from './project-access'
import { claimPreparation, preparationLockKeys } from './change-preparation-ipc'
import {
  commitChange,
  verifyRecovery,
  type CommitPhase,
  type RecoveryFile
} from '../tools/change-commit'

type Job = { id: string; phase: CommitPhase; controller: AbortController; detached: boolean }
const jobs = new Map<number, Job>()
const locks = new Set<string>()
const recoveries = new Map<number, Map<string, RecoveryFile>>()
export const hasChangeCommit = (windowId: number): boolean => jobs.has(windowId)

export function cancelChangeCommit(windowId: number, commitId?: string): boolean {
  const job = jobs.get(windowId)
  if (!job || (commitId && commitId !== job.id)) return false
  if (job.phase === 'validating' || job.phase === 'staging') {
    job.controller.abort()
    return true
  }
  return false
}
export function cleanupChangeCommit(windowId: number): void {
  const job = jobs.get(windowId)
  if (job) {
    job.detached = true
    cancelChangeCommit(windowId)
  }
  recoveries.delete(windowId)
}
export function attachCommitCleanup(window: BrowserWindow): void {
  const cleanup = (): void => cleanupChangeCommit(window.id)
  window.webContents.on('did-start-loading', cleanup)
  window.webContents.on('render-process-gone', cleanup)
  window.webContents.once('destroyed', cleanup)
  window.once('closed', cleanup)
}
function ownerOf(event: IpcMainInvokeEvent): BrowserWindow {
  const owner = BrowserWindow.fromWebContents(event.sender)
  if (!owner || owner.isDestroyed() || event.senderFrame !== event.sender.mainFrame)
    throw new Error('不支持的提交来源')
  return owner
}
export function registerChangeCommit(isBusy: (windowId: number) => boolean): void {
  ipcMain.handle('commit:cancel', (event, id: unknown) => {
    const owner = ownerOf(event)
    return isAgentId(id) && cancelChangeCommit(owner.id, id)
  })
  ipcMain.handle('commit:reveal-backup', async (event, id: unknown): Promise<boolean> => {
    const owner = ownerOf(event)
    if (!isAgentId(id)) return false
    const file = recoveries.get(owner.id)?.get(id)
    if (
      !file ||
      !(await verifyRecovery(file)) ||
      owner.isDestroyed() ||
      recoveries.get(owner.id)?.get(id) !== file
    )
      return false
    shell.showItemInFolder(file.path)
    return true
  })
  ipcMain.handle('commit:apply', async (event, value: unknown): Promise<CommitResult> => {
    const owner = ownerOf(event)
    const request = parseCommitRequest(value)
    if (!request) throw new Error('提交请求格式不正确')
    const reject = (message: string): CommitResult => ({
      ...request,
      status: 'error',
      claimed: false,
      message,
      recovery: null,
      cleanupWarning: false
    })
    if (jobs.has(owner.id) || isBusy(owner.id)) return reject('请先完成当前操作')
    const snapshot = captureProjectAccess(owner.id, request.conversationId, request.snapshotId)
    if (!snapshot) return reject('附件授权已失效，请重新选择文件')
    const keys = preparationLockKeys(owner.id, request)
    if (!keys || keys.some((key) => locks.has(key)))
      return reject('准备记录不可用，或此文件正在提交')
    const content = claimPreparation(owner.id, request, snapshot)
    if (!content) return reject('准备记录已过期或归属不匹配，请重新检查')
    const job: Job = {
      id: request.commitId,
      phase: 'validating',
      controller: new AbortController(),
      detached: false
    }
    jobs.set(owner.id, job)
    keys.forEach((key) => locks.add(key))
    let result: CommitResult
    try {
      const outcome = await commitChange(
        snapshot,
        content,
        job.controller.signal,
        () =>
          jobs.get(owner.id) === job &&
          !job.detached &&
          !owner.isDestroyed() &&
          !owner.webContents.isDestroyed() &&
          captureProjectAccess(owner.id, request.conversationId, request.snapshotId) === snapshot,
        (phase) => {
          job.phase = phase
        }
      )
      if (outcome.recovery && !job.detached && !owner.isDestroyed()) {
        const files = recoveries.get(owner.id) ?? new Map<string, RecoveryFile>()
        files.set(outcome.recovery.id, outcome.recovery)
        if (files.size > 20) files.delete(files.keys().next().value!)
        recoveries.set(owner.id, files)
      }
      result = {
        ...request,
        status: outcome.status,
        claimed: true,
        message: outcome.message,
        recovery: outcome.recovery
          ? { id: outcome.recovery.id, name: basename(outcome.recovery.path) }
          : null,
        cleanupWarning: outcome.cleanupWarning
      }
    } finally {
      job.phase = 'finished'
      revokeProjectFiles(owner.id, request.snapshotId)
      keys.forEach((key) => locks.delete(key))
      if (jobs.get(owner.id) === job) jobs.delete(owner.id)
    }
    if (job.detached || owner.isDestroyed() || event.senderFrame !== event.sender.mainFrame)
      throw new Error('提交页面已失效，请检查文件与备份')
    return result
  })
}
