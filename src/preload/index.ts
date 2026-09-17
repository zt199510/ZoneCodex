// preload 通过 contextBridge 暴露业务接口；页面不直接使用 Node API。
import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { AppAPI } from '../shared/api'
import { parseWindowState } from '../shared/window'
import { parseLibrary } from '../shared/conversation-library'
import { parseTerminalEvent, parseTerminalResult } from '../shared/terminal'
import { isAgentId, parseAgentProgress, parseAgentResult } from '../shared/agent'
import { parseToolHistory } from '../shared/agent-history'
import { parseAgentContext, parseProjectSelectionResult, parseToolScope } from '../shared/project'

// Custom APIs for renderer
const api: AppAPI = {
  // 窗口控制
  controlWindow: async (action) => {
    await ipcRenderer.invoke('window:command', action)
  },
  // 获取窗口状态
  getWindowState: async () => {
    const state = parseWindowState(await ipcRenderer.invoke('window:state'))
    if (!state) throw new Error('窗口状态格式不正确')
    return state
  },
  // 监听窗口状态变化
  onWindowStateChanged: (listener) => {
    const handler = (_event: IpcRendererEvent, value: unknown): void => {
      const state = parseWindowState(value)
      if (state) listener(state)
    }
    ipcRenderer.on('window:state-changed', handler)
    return () => {
      ipcRenderer.removeListener('window:state-changed', handler)
    }
  },
  // 模型请求
  askModel: async (history) => {
    // 通过 IPC 调用主进程的模型请求处理函数
    const result: unknown = await ipcRenderer.invoke('chat:ask', history)
    // 检查返回结果的格式是否符合预期
    if (typeof result !== 'object' || result === null) {
      throw new Error('模型请求结果格式不正确')
    }
    // 根据返回结果的类型，返回相应的 ModelReply 对象
    if (
      'ok' in result &&
      result.ok === true &&
      'content' in result &&
      typeof result.content === 'string'
    ) {
      return { ok: true, content: result.content }
    }
    // 如果返回结果表示请求失败，返回包含错误信息的 ModelReply 对象
    if (
      'ok' in result &&
      result.ok === false &&
      'error' in result &&
      typeof result.error === 'string'
    ) {
      return { ok: false, error: result.error }
    }
    throw new Error('模型请求结果格式不正确')
  },
  // 模型流请求
  startModelStream: async (requestId, history) => {
    const result: unknown = await ipcRenderer.invoke('model-stream:start', requestId, history)
    if (typeof result === 'object' && result !== null && 'status' in result) {
      if (result.status === 'done' || result.status === 'cancelled') {
        return { status: result.status }
      }
      if (result.status === 'error' && 'error' in result && typeof result.error === 'string') {
        return { status: 'error', error: result.error }
      }
    }
    throw new Error('真实流结束结果格式不正确')
  },
  //  取消模型流
  cancelModelStream: async (requestId) => {
    await ipcRenderer.invoke('model-stream:cancel', requestId)
  },
  // 监听模型流增量事件
  onModelDelta: (listener) => {
    const handler = (_event: IpcRendererEvent, value: unknown): void => {
      if (
        typeof value !== 'object' ||
        value === null ||
        !('requestId' in value) ||
        typeof value.requestId !== 'string' ||
        !('delta' in value) ||
        typeof value.delta !== 'string'
      )
        return
      listener({ requestId: value.requestId, delta: value.delta })
    }
    ipcRenderer.on('model-stream:delta', handler)
    return () => {
      ipcRenderer.removeListener('model-stream:delta', handler)
    }
  },
  // 加载会话
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
  // 保存会话
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
  // 监听关闭请求
  onCloseRequested: (listener) => {
    const handler = (_event: IpcRendererEvent, requestId: unknown): void => {
      if (typeof requestId === 'string' && requestId.length > 0 && requestId.length <= 80) {
        listener(requestId)
      }
    }
    ipcRenderer.on('window:close-requested', handler)
    return () => {
      ipcRenderer.removeListener('window:close-requested', handler)
    }
  },
  // 完成关闭操作
  finishClose: async (requestId, allow) => {
    const result: unknown = await ipcRenderer.invoke('window:finish-close', requestId, allow)
    if (typeof result !== 'boolean') throw new Error('关闭确认结果格式不正确')
    return result
  },
  // 终端相关接口
  startTerminal: async (sessionId, size) =>
    parseTerminalResult(await ipcRenderer.invoke('terminal:start', sessionId, size)),
  // 向终端发送数据
  writeTerminal: async (sessionId, data) =>
    parseTerminalResult(await ipcRenderer.invoke('terminal:write', sessionId, data)),
  // 调整终端大小
  resizeTerminal: async (sessionId, size) =>
    parseTerminalResult(await ipcRenderer.invoke('terminal:resize', sessionId, size)),
  // 关闭终端
  closeTerminal: async (sessionId) =>
    parseTerminalResult(await ipcRenderer.invoke('terminal:close', sessionId)),
  // 监听终端事件
  onTerminalEvent: (listener) => {
    const handler = (_event: IpcRendererEvent, value: unknown): void => {
      const parsed = parseTerminalEvent(value)
      if (parsed) listener(parsed)
    }
    ipcRenderer.on('terminal:event', handler)
    return () => ipcRenderer.removeListener('terminal:event', handler)
  },
  // 练习工具相关接口
  startAgentPractice: async (requestId, prompt, mode, history = [], context = { kind: 'time' }) => {
    const checkedContext = parseAgentContext(context)
    if (!checkedContext) throw new Error('工具上下文格式不正确')
    const checkedScope = parseToolScope(
      checkedContext.kind === 'time'
        ? checkedContext
        : { kind: 'project', snapshotId: checkedContext.snapshotId }
    )
    if (!checkedScope) throw new Error('工具范围格式不正确')
    const checkedHistory = parseToolHistory(history, checkedScope)
    if (!checkedHistory) throw new Error('工具历史参数格式不正确')
    return parseAgentResult(
      await ipcRenderer.invoke(
        'agent:start',
        requestId,
        prompt,
        mode,
        checkedHistory,
        checkedContext
      ),
      checkedScope
    )
  },
  // 选择当前窗口与会话绑定的项目快照
  selectProjectFiles: async (conversationId, replaceExisting = false) => {
    if (!isAgentId(conversationId)) throw new Error('会话 ID 格式不正确')
    if (typeof replaceExisting !== 'boolean') throw new Error('附件选择参数无效')
    const parsed = parseProjectSelectionResult(
      await ipcRenderer.invoke('project:select', conversationId, replaceExisting)
    )
    if (!parsed) throw new Error('项目选择结果格式不正确')
    return parsed
  },
  removeProjectFile: async (conversationId, snapshotId, path) => {
    if (
      !isAgentId(conversationId) ||
      !isAgentId(snapshotId) ||
      typeof path !== 'string' ||
      path.length > 240
    )
      throw new Error('附件参数无效')
    const result = parseProjectSelectionResult(
      await ipcRenderer.invoke('project:remove', conversationId, snapshotId, path)
    )
    if (!result) throw new Error('附件移除结果无效')
    return result
  },
  // 撤销当前窗口的指定项目快照授权
  revokeProjectFiles: async (snapshotId) => {
    if (!isAgentId(snapshotId)) return false
    const result: unknown = await ipcRenderer.invoke('project:revoke', snapshotId)
    if (typeof result !== 'boolean') throw new Error('项目撤销结果格式不正确')
    return result
  },
  //  取消练习工具任务
  cancelAgentPractice: async (requestId) => {
    const result: unknown = await ipcRenderer.invoke('agent:cancel', requestId)
    if (typeof result !== 'boolean') throw new Error('取消结果格式不正确')
    return result
  },
  // 监听练习工具进度事件
  onAgentProgress: (listener) => {
    const handler = (_event: IpcRendererEvent, value: unknown): void => {
      const progress = parseAgentProgress(value)
      if (progress) listener(progress)
    }
    ipcRenderer.on('agent:progress', handler)
    return () => ipcRenderer.removeListener('agent:progress', handler)
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
