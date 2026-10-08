import { ipcRenderer } from 'electron'
import type { AppAPI } from '../shared/api'
import { parseLibrary } from '../shared/conversation-library'
import { isAgentId } from '../shared/agent'
import { isAbsoluteLocalDirectory } from '../shared/settings'
import {
  parseConversationTitleOutcome,
  parseConversationTitleRequest
} from '../shared/conversation-title'

export const conversationAPI: Pick<
  AppAPI,
  | 'loadConversation'
  | 'saveConversation'
  | 'generateConversationTitle'
  | 'cancelConversationTitle'
  | 'bindConversationDirectory'
> = {
  bindConversationDirectory: async (conversationId) => {
    if (!isAgentId(conversationId)) throw new Error('会话 ID 无效')
    const directory = await ipcRenderer.invoke('conversation:bind-directory', conversationId)
    if (!isAbsoluteLocalDirectory(directory)) throw new Error('会话任务目录绑定结果格式不正确')
    return directory
  },
  loadConversation: async () => {
    const result: unknown = await ipcRenderer.invoke('conversation:load')
    if (typeof result === 'object' && result !== null && 'ok' in result) {
      if (result.ok === false && 'error' in result && typeof result.error === 'string') {
        return { ok: false, error: result.error }
      }
      if (
        result.ok === true &&
        'snapshot' in result &&
        'missing' in result &&
        typeof result.missing === 'boolean'
      ) {
        const snapshot = parseLibrary(result.snapshot)

        if (snapshot) return { ok: true, snapshot, missing: result.missing }
      }
    }
    throw new Error('读取结果格式不正确')
  },
  saveConversation: async (snapshot) => {
    const checked = parseLibrary(snapshot)
    if (!checked) return { ok: false, error: '会话库格式不正确，未发送保存请求。' }
    const result: unknown = await ipcRenderer.invoke('conversation:save', checked)
    if (typeof result === 'object' && result !== null && 'ok' in result) {
      if (result.ok === true) return { ok: true }
      if (result.ok === false && 'error' in result && typeof result.error === 'string') {
        return { ok: false, error: result.error }
      }
    }
    throw new Error('保存结果格式不正确')
  },
  generateConversationTitle: async (request) => {
    const checkedRequest = parseConversationTitleRequest(request)
    if (!checkedRequest) throw new Error('标题请求格式不正确')
    const result = parseConversationTitleOutcome(
      await ipcRenderer.invoke('conversation-title:start', checkedRequest)
    )
    if (!result) throw new Error('标题结果格式不正确')
    return result
  },
  cancelConversationTitle: async (requestId) => {
    if (!isAgentId(requestId)) return false
    const result = await ipcRenderer.invoke('conversation-title:cancel', requestId)
    if (typeof result !== 'boolean') throw new Error('标题取消结果格式不正确')
    return result
  }
}
