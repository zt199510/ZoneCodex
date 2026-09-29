import { BrowserWindow, ipcMain } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import {
  parseConversationTitleRequest,
  type ConversationTitleOutcome
} from '../../shared/conversation-title'
import { isAgentId } from '../../shared/agent'
import { AgentError } from './tool-loop'
import { requestConversationTitle } from '../model/title-response'

type TitleJob = { requestId: string; controller: AbortController }
const jobs = new Map<number, Map<string, TitleJob>>()

function checkSource(event: IpcMainInvokeEvent): void {
  if (
    !BrowserWindow.fromWebContents(event.sender) ||
    event.senderFrame !== event.sender.mainFrame
  ) {
    throw new Error('不支持的标题请求来源')
  }
}

export function hasConversationTitleJob(windowId: number): boolean {
  return (jobs.get(windowId)?.size ?? 0) > 0
}

export function cancelConversationTitleJob(windowId: number): boolean {
  const windowJobs = jobs.get(windowId)
  if (!windowJobs || windowJobs.size === 0) return false
  for (const job of windowJobs.values()) job.controller.abort()
  return true
}

export function registerConversationTitleRequest(): void {
  ipcMain.handle(
    'conversation-title:start',
    async (event, rawRequest: unknown): Promise<ConversationTitleOutcome> => {
      checkSource(event)
      const windowId = BrowserWindow.fromWebContents(event.sender)!.id
      const request = parseConversationTitleRequest(rawRequest)
      if (!request) {
        return { status: 'error', requestId: 'invalid', error: '标题请求参数无效' }
      }
      const windowJobs = jobs.get(windowId) ?? new Map<string, TitleJob>()
      if (windowJobs.has(request.requestId)) {
        return {
          status: 'error',
          requestId: request.requestId,
          error: '标题请求标识已使用，请重新发起'
        }
      }
      const controller = new AbortController()
      const job: TitleJob = { requestId: request.requestId, controller }
      windowJobs.set(request.requestId, job)
      jobs.set(windowId, windowJobs)
      const sender = event.sender
      const cancel = (): void => controller.abort()
      let timedOut = false
      const timer = setTimeout(() => {
        if (controller.signal.aborted) return
        timedOut = true
        controller.abort()
      }, 30_000)
      sender.once('did-start-loading', cancel)
      sender.once('render-process-gone', cancel)
      sender.once('destroyed', cancel)
      try {
        return await requestConversationTitle(request, controller.signal)
      } catch (error) {
        if (timedOut) {
          return { status: 'error', requestId: request.requestId, error: '标题请求超时，请重试' }
        }
        if (controller.signal.aborted) return { status: 'cancelled', requestId: request.requestId }
        return {
          status: 'error',
          requestId: request.requestId,
          error: error instanceof AgentError ? error.message : '标题请求失败，请重试'
        }
      } finally {
        clearTimeout(timer)
        if (windowJobs.get(request.requestId) === job) windowJobs.delete(request.requestId)
        if (windowJobs.size === 0 && jobs.get(windowId) === windowJobs) jobs.delete(windowId)
        sender.removeListener('did-start-loading', cancel)
        sender.removeListener('render-process-gone', cancel)
        sender.removeListener('destroyed', cancel)
      }
    }
  )
  ipcMain.handle('conversation-title:cancel', (event, requestId: unknown): boolean => {
    checkSource(event)
    if (!isAgentId(requestId)) return false
    const windowId = BrowserWindow.fromWebContents(event.sender)!.id
    const windowJobs = jobs.get(windowId)
    const job = windowJobs?.get(requestId)
    if (!job) return false
    job.controller.abort()
    return true
  })
}
