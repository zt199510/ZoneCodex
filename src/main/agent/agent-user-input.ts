import { BrowserWindow, ipcMain } from 'electron'
import type { WebContents, WebFrameMain } from 'electron'
import { randomUUID } from 'node:crypto'
import {
  parseAgentUserInputRequest,
  parseAgentUserInputResponse,
  type AgentUserInputAnswer,
  type AgentUserInputRequest
} from '../../shared/agent-user-input'
import { getIpcWindow } from '../ipc-source'

export const requestUserInputTool = {
  type: 'function',
  name: 'request_user_input',
  description:
    '计划模式中，在关键目标、范围或偏好无法从现有证据确定时向用户提问。等待用户回答后继续研究并完成方案；答案不代表执行批准。',
  strict: true,
  parameters: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        minItems: 1,
        maxItems: 3,
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', minLength: 1, maxLength: 40, pattern: '^[a-zA-Z0-9_-]+$' },
            header: { type: 'string', minLength: 1, maxLength: 24 },
            question: { type: 'string', minLength: 1, maxLength: 500 },
            options: {
              type: 'array',
              minItems: 2,
              maxItems: 3,
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string', minLength: 1, maxLength: 80 },
                  description: { type: 'string', minLength: 1, maxLength: 200 }
                },
                required: ['label', 'description'],
                additionalProperties: false
              }
            }
          },
          required: ['id', 'header', 'question', 'options'],
          additionalProperties: false
        }
      }
    },
    required: ['questions'],
    additionalProperties: false
  }
} as const

type PendingInput = {
  owner: BrowserWindow
  sender: WebContents
  frame: WebFrameMain
  request: AgentUserInputRequest
  signal: AbortSignal
  assertCurrent: () => boolean
  cancel: () => void
  checkTimer: NodeJS.Timeout | null
  resolve: (answers: AgentUserInputAnswer[] | null) => void
}

const pending = new Map<number, PendingInput>()

function cloneRequest(request: AgentUserInputRequest): AgentUserInputRequest {
  return structuredClone(request)
}

function emit(item: PendingInput, request: AgentUserInputRequest | null): boolean {
  if (item.owner.isDestroyed() || item.sender.isDestroyed()) return false
  try {
    item.sender.send('agent:user-input-change', request ? cloneRequest(request) : null)
    return true
  } catch {
    return false
  }
}

function isCurrent(item: PendingInput): boolean {
  try {
    return (
      !item.signal.aborted &&
      !item.owner.isDestroyed() &&
      !item.sender.isDestroyed() &&
      item.sender.mainFrame === item.frame &&
      item.assertCurrent()
    )
  } catch {
    return false
  }
}

function settle(
  windowId: number,
  item: PendingInput,
  answers: AgentUserInputAnswer[] | null
): boolean {
  if (pending.get(windowId) !== item) return false
  pending.delete(windowId)
  if (item.checkTimer) clearInterval(item.checkTimer)
  item.signal.removeEventListener('abort', item.cancel)
  item.sender.removeListener('did-start-loading', item.cancel)
  item.sender.removeListener('render-process-gone', item.cancel)
  item.sender.removeListener('destroyed', item.cancel)
  item.owner.removeListener('closed', item.cancel)
  emit(item, null)
  item.resolve(answers ? structuredClone(answers) : null)
  return true
}

/** Questions are request data. This independent channel never grants execution approval. */
export function registerAgentUserInput(): void {
  ipcMain.handle('agent:user-input-get', (event): AgentUserInputRequest | null => {
    const owner = getIpcWindow(event, '不支持的提问来源', {
      windowMustBeLive: true,
      senderMustBeLive: true
    })
    const item = pending.get(owner.id)
    if (!item) return null
    if (!isCurrent(item)) {
      settle(owner.id, item, null)
      return null
    }
    return cloneRequest(item.request)
  })
  ipcMain.handle('agent:user-input-respond', (event, value: unknown): boolean => {
    const owner = getIpcWindow(event, '不支持的回答来源', {
      windowMustBeLive: true,
      senderMustBeLive: true
    })
    const item = pending.get(owner.id)
    if (!item) return false
    const response = parseAgentUserInputResponse(value, item.request)
    // A malformed, mismatched or late answer must not settle a valid question.
    if (!response) return false
    if (!isCurrent(item) || event.senderFrame !== item.frame) {
      settle(owner.id, item, null)
      return false
    }
    return settle(owner.id, item, response.answers)
  })
}

/** One pending question group belongs to the originating window, document and agent request. */
export function requestAgentUserInput(
  windowId: number,
  input: Omit<AgentUserInputRequest, 'inputId'>,
  signal: AbortSignal,
  assertCurrent: () => boolean
): Promise<AgentUserInputAnswer[] | null> {
  if (signal.aborted || pending.has(windowId)) return Promise.resolve(null)
  const owner = BrowserWindow.fromId(windowId)
  if (!owner || owner.isDestroyed() || owner.webContents.isDestroyed()) return Promise.resolve(null)
  const request = parseAgentUserInputRequest({ ...input, inputId: randomUUID() })
  if (!request) return Promise.resolve(null)
  const sender = owner.webContents
  const frame = sender.mainFrame
  return new Promise((resolve) => {
    const item: PendingInput = {
      owner,
      sender,
      frame,
      request: cloneRequest(request),
      signal,
      assertCurrent,
      resolve,
      checkTimer: null,
      cancel: () => settle(windowId, item, null)
    }
    pending.set(windowId, item)
    signal.addEventListener('abort', item.cancel, { once: true })
    sender.once('did-start-loading', item.cancel)
    sender.once('render-process-gone', item.cancel)
    sender.once('destroyed', item.cancel)
    owner.once('closed', item.cancel)
    if (!isCurrent(item)) {
      settle(windowId, item, null)
      return
    }
    // A user can take time to answer. Runtime scope changes must still release
    // the wait even when no IPC response arrives and no task deadline applies.
    item.checkTimer = setInterval(() => {
      if (!isCurrent(item)) settle(windowId, item, null)
    }, 500)
    if (!emit(item, item.request)) settle(windowId, item, null)
  })
}

export function hasAgentUserInput(windowId: number): boolean {
  return pending.has(windowId)
}
