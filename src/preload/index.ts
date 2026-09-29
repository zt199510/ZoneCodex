import { parseCommitRequest, parseCommitResult } from '../shared/change-commit'
import { parsePreparationRequest, parsePreparationResult } from '../shared/change-preparation'
// preload 通过 contextBridge 暴露业务接口；页面不直接使用 Node API。
import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { AppAPI } from '../shared/api'
import { parseWindowState } from '../shared/window'
import { parseLibrary } from '../shared/conversation-library'
import { parseTerminalEvent, parseTerminalResult } from '../shared/terminal'
import { isAgentId, parseAgentDelta, parseAgentProgress, parseAgentResult } from '../shared/agent'
import { parseToolHistory } from '../shared/agent-history'
import {
  parseAgentContext,
  parseProjectSelectionResult,
  parseToolScope,
  parseWorkspaceInstructionResult,
  parseWorkspaceSelectionResult
} from '../shared/project'
import { parsePreviewChangeRequest, parsePreviewChangeResult } from '../shared/change-preview'
import {
  parseCommandPreparationResult,
  parseCommandSource,
  parseCommandExecutionRequest
} from '../shared/command-preparation'
import { isTaskId, parseTaskRecord, parseTaskRecords } from '../shared/task'
import {
  parseConversationTitleOutcome,
  parseConversationTitleRequest
} from '../shared/conversation-title'

// Custom APIs for renderer
const api: AppAPI = {
  listTasks: async () => {
    try {
      const result = parseTaskRecords(await ipcRenderer.invoke('task:list'))
      return result ?? []
    } catch {
      return []
    }
  },
  cancelTask: async (taskId) => {
    if (!isTaskId(taskId)) return false
    return Boolean(await ipcRenderer.invoke('task:cancel', taskId))
  },
  onTaskState: (listener) => {
    const handler = (_event: IpcRendererEvent, value: unknown): void => {
      if (typeof value !== 'object' || value === null || !('record' in value)) return
      const record = parseTaskRecord(value.record)
      if (record) listener(record)
    }
    ipcRenderer.on('task:state', handler)
    return () => ipcRenderer.removeListener('task:state', handler)
  },
  selectCommandDirectory: async (source, operationId) => {
    const checked = parseCommandSource(source)
    if (!checked) throw new Error('目录来源无效')
    const result = parseCommandPreparationResult(
      await ipcRenderer.invoke('command-directory:select', { source: checked, operationId })
    )
    if (!result) throw new Error('目录选择结果无效')
    return result
  },
  prepareCommand: async (source, grantId, checkId) => {
    const checked = parseCommandSource(source)
    if (!checked) throw new Error('目录来源无效')
    const result = parseCommandPreparationResult(
      await ipcRenderer.invoke('command-directory:prepare', { source: checked, grantId, checkId })
    )
    if (!result) throw new Error('准备结果无效')
    return result
  },
  releaseCommandDirectory: async (grantId) =>
    Boolean(await ipcRenderer.invoke('command-directory:release', grantId)),
  cancelCommandPreparation: async (operationId) =>
    Boolean(await ipcRenderer.invoke('command-directory:cancel', operationId)),
  startCommandExecution: async (request) => {
    const checked = parseCommandExecutionRequest(request)
    if (!checked) throw new Error('执行请求无效')
    const result = await ipcRenderer.invoke('command-execution:start', checked)
    if (
      !result ||
      typeof result !== 'object' ||
      (result.status !== 'started' && result.status !== 'error')
    )
      throw new Error('执行结果无效')
    return result
  },
  cancelCommandExecution: async (executionId) =>
    Boolean(await ipcRenderer.invoke('command-execution:cancel', executionId)),
  onCommandExecutionEvent: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, value: unknown): void =>
      listener(value as never)
    ipcRenderer.on('command-execution:event', wrapped)
    return (): void => {
      ipcRenderer.removeListener('command-execution:event', wrapped)
    }
  },
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
  // 监听模型与 Agent 共用的流式增量事件
  onModelDelta: (listener) => {
    const handler = (_event: IpcRendererEvent, value: unknown): void => {
      const delta = parseAgentDelta(value)
      if (delta) listener(delta)
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
  // 真实 Agent 请求接口
  startAgentRequest: async (
    requestId,
    prompt,
    history = [],
    context = { kind: 'time' },
    taskId,
    conversationId,
    workspaceId
  ) => {
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
    if (workspaceId !== undefined && !isAgentId(workspaceId)) {
      throw new Error('工作区 ID 格式不正确')
    }
    return parseAgentResult(
      await ipcRenderer.invoke(
        'agent:start',
        requestId,
        prompt,
        checkedHistory,
        checkedContext,
        taskId,
        conversationId,
        workspaceId
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
  selectWorkspace: async (conversationId, operationId) => {
    if (!isAgentId(conversationId) || !isAgentId(operationId))
      throw new Error('工作区选择参数无效')
    const result = parseWorkspaceSelectionResult(
      await ipcRenderer.invoke('workspace:select', conversationId, operationId)
    )
    if (!result) throw new Error('工作区选择结果格式不正确')
    return result
  },
  clearWorkspace: async (conversationId) => {
    if (!isAgentId(conversationId)) throw new Error('会话 ID 格式不正确')
    const result = await ipcRenderer.invoke('workspace:clear', conversationId)
    if (typeof result !== 'boolean') throw new Error('工作区清除结果格式不正确')
    return result
  },
  readWorkspaceInstruction: async (conversationId) => {
    if (!isAgentId(conversationId)) throw new Error('会话 ID 格式不正确')
    const result = parseWorkspaceInstructionResult(
      await ipcRenderer.invoke('workspace:instruction', conversationId)
    )
    if (!result) throw new Error('工作区指令结果格式不正确')
    return result
  },
  // 从当前已授权快照生成只读修改预览
  commitChange: async (request) => {
    const checked = parseCommitRequest(request)
    if (!checked) throw new Error('提交请求无效')
    const result = parseCommitResult(await ipcRenderer.invoke('commit:apply', checked))
    if (!result || Object.keys(checked).some((key) => result[key] !== checked[key]))
      throw new Error('提交回执无效，请检查文件')
    return result
  },
  cancelCommit: async (id) => {
    if (!isAgentId(id)) return false
    const result: unknown = await ipcRenderer.invoke('commit:cancel', id)
    if (typeof result !== 'boolean') throw new Error('取消回执无效')
    return result
  },
  revealBackup: async (id) => {
    if (!isAgentId(id)) return false
    const result: unknown = await ipcRenderer.invoke('commit:reveal-backup', id)
    if (typeof result !== 'boolean') throw new Error('备份定位回执无效')
    return result
  },
  prepareChange: async (request) => {
    const checked = parsePreparationRequest(request)
    if (!checked) throw new Error('准备请求无效')
    const result = parsePreparationResult(await ipcRenderer.invoke('preparation:check', checked))
    if (
      !result ||
      (result.status === 'ready' &&
        (result.checkId !== checked.checkId ||
          result.conversationId !== checked.conversationId ||
          result.snapshotId !== checked.snapshotId ||
          result.path !== checked.path))
    )
      throw new Error('准备结果无效')
    return result
  },
  cancelPreparation: async (checkId) => {
    if (!isAgentId(checkId)) return false
    const result: unknown = await ipcRenderer.invoke('preparation:cancel', checkId)
    if (typeof result !== 'boolean') throw new Error('取消结果无效')
    return result
  },
  previewChange: async (request) => {
    const checkedRequest = parsePreviewChangeRequest(request)
    if (!checkedRequest) throw new Error('修改预览请求格式不正确')
    const result = parsePreviewChangeResult(
      await ipcRenderer.invoke('preview:change', checkedRequest)
    )
    if (!result) throw new Error('修改预览结果格式不正确')
    if (
      result.status === 'ready' &&
      (result.preview.conversationId !== checkedRequest.conversationId ||
        result.preview.snapshotId !== checkedRequest.snapshotId ||
        result.preview.path !== checkedRequest.path)
    ) {
      throw new Error('修改预览归属不一致')
    }
    return result
  },
  // 撤销当前窗口的指定项目快照授权
  revokeProjectFiles: async (snapshotId) => {
    if (!isAgentId(snapshotId)) return false
    const result: unknown = await ipcRenderer.invoke('project:revoke', snapshotId)
    if (typeof result !== 'boolean') throw new Error('项目撤销结果格式不正确')
    return result
  },
  // 取消真实 Agent 请求
  cancelAgentRequest: async (requestId) => {
    const result: unknown = await ipcRenderer.invoke('agent:cancel', requestId)
    if (typeof result !== 'boolean') throw new Error('取消结果格式不正确')
    return result
  },
  // 监听 Agent 进度事件
  onAgentProgress: (listener) => {
    const handler = (_event: IpcRendererEvent, value: unknown): void => {
      const progress = parseAgentProgress(value)
      if (progress) listener(progress)
    }
    ipcRenderer.on('agent:progress', handler)
    return () => ipcRenderer.removeListener('agent:progress', handler)
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
