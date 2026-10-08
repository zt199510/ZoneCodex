import { ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type { AppAPI } from '../shared/api'
import { getImageTurnNoticeCount, stripImageTurnNotice } from '../shared/image-input'
import {
  parseExecutionApproval,
  parseExecutionInfo,
  parsePermissionMode,
  parsePermissionsState
} from '../shared/execution'
import {
  isAgentId,
  parseAgentDelta,
  parseAgentMessageEvent,
  parseAgentProgress,
  parseAgentResult,
  parseAgentToolEvent
} from '../shared/agent'
import { parseToolHistory } from '../shared/agent-history'
import {
  parseAgentRequestContext,
  parseToolScope,
  toolScopeForAgentRequest
} from '../shared/project'
import {
  parseCommandPreparationResult,
  parseCommandSource,
  parseCommandExecutionRequest
} from '../shared/command-preparation'
import { isTaskId, parseTaskRecord, parseTaskRecords } from '../shared/task'

export const agentAPI: Pick<
  AppAPI,
  | 'listTasks'
  | 'cancelTask'
  | 'onTaskState'
  | 'selectCommandDirectory'
  | 'prepareCommand'
  | 'releaseCommandDirectory'
  | 'cancelCommandPreparation'
  | 'startCommandExecution'
  | 'cancelCommandExecution'
  | 'onCommandExecutionEvent'
  | 'onModelDelta'
  | 'resolveAgentExecution'
  | 'getExecutionPermissions'
  | 'setExecutionPermissions'
  | 'getPendingExecutionApproval'
  | 'respondToExecutionApproval'
  | 'onExecutionApprovalChange'
  | 'startAgentRequest'
  | 'cancelAgentRequest'
  | 'onAgentProgress'
  | 'onAgentToolEvent'
  | 'onAgentMessageEvent'
> = {
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
  resolveAgentExecution: async (context) => {
    const checkedContext = parseAgentRequestContext(context)
    if (!checkedContext) throw new Error('工具上下文格式不正确')
    const result = parseExecutionInfo(
      await ipcRenderer.invoke('agent:resolve-execution', checkedContext)
    )
    if (!result) throw new Error('运行信息格式不正确')
    return result
  },
  getExecutionPermissions: async () => {
    const result = parsePermissionsState(await ipcRenderer.invoke('execution:permissions-get'))
    if (!result) throw new Error('权限设置格式不正确')
    return result
  },
  setExecutionPermissions: async (mode) => {
    const checkedMode = parsePermissionMode(mode)
    if (!checkedMode) throw new Error('权限选项无效')
    const result = parsePermissionsState(
      await ipcRenderer.invoke('execution:permissions-set', checkedMode)
    )
    if (!result) throw new Error('权限设置格式不正确')
    return result
  },
  getPendingExecutionApproval: async () => {
    const value: unknown = await ipcRenderer.invoke('execution:approval-get')
    if (value === null) return null
    const approval = parseExecutionApproval(value)
    if (!approval) throw new Error('确认请求格式不正确')
    return approval
  },
  respondToExecutionApproval: async (approvalId, approved) => {
    if (!isAgentId(approvalId) || typeof approved !== 'boolean') {
      throw new Error('确认操作参数无效')
    }
    const result: unknown = await ipcRenderer.invoke('execution:approval-respond', {
      approvalId,
      approved
    })
    if (typeof result !== 'boolean') throw new Error('确认操作结果格式不正确')
    return result
  },
  onExecutionApprovalChange: (listener) => {
    const handler = (_event: IpcRendererEvent, value: unknown): void => {
      if (value === null) {
        listener(null)
        return
      }
      const approval = parseExecutionApproval(value)
      if (approval) listener(approval)
    }
    ipcRenderer.on('execution:approval-change', handler)
    return () => ipcRenderer.removeListener('execution:approval-change', handler)
  },
  startAgentRequest: async (requestId, prompt, history, context, taskId) => {
    const checkedContext = parseAgentRequestContext(context)
    if (!checkedContext) throw new Error('工具上下文格式不正确')
    if (
      typeof prompt !== 'string' ||
      !prompt.trim() ||
      prompt.trim().length > 2000 ||
      (checkedContext.images?.length ?? (checkedContext.image ? 1 : null)) !==
        getImageTurnNoticeCount(prompt) ||
      !stripImageTurnNotice(prompt)
    )
      throw new Error('图片与本轮问题不一致，或文字超过上限')
    const checkedScope = parseToolScope(toolScopeForAgentRequest(checkedContext))
    if (!checkedScope) throw new Error('工具范围格式不正确')
    const checkedHistory = parseToolHistory(history, checkedScope, checkedContext.imageHistory)
    if (!checkedHistory) throw new Error('工具历史参数格式不正确')
    return parseAgentResult(
      await ipcRenderer.invoke(
        'agent:start',
        requestId,
        prompt,
        checkedHistory,
        checkedContext,
        taskId
      ),
      checkedScope,
      prompt.trim()
    )
  },
  cancelAgentRequest: async (requestId) => {
    const result: unknown = await ipcRenderer.invoke('agent:cancel', requestId)
    if (typeof result !== 'boolean') throw new Error('取消结果格式不正确')
    return result
  },
  onAgentProgress: (listener) => {
    const handler = (_event: IpcRendererEvent, value: unknown): void => {
      const progress = parseAgentProgress(value)
      if (progress) listener(progress)
    }
    ipcRenderer.on('agent:progress', handler)
    return () => ipcRenderer.removeListener('agent:progress', handler)
  },
  onAgentToolEvent: (listener) => {
    const handler = (_event: IpcRendererEvent, value: unknown): void => {
      const toolEvent = parseAgentToolEvent(value)
      if (toolEvent) listener(toolEvent)
    }
    ipcRenderer.on('agent:tool-event', handler)
    return () => ipcRenderer.removeListener('agent:tool-event', handler)
  },
  onAgentMessageEvent: (listener) => {
    const handler = (_event: IpcRendererEvent, value: unknown): void => {
      const message = parseAgentMessageEvent(value)
      if (message) listener(message)
    }
    ipcRenderer.on('agent:message-event', handler)
    return () => ipcRenderer.removeListener('agent:message-event', handler)
  }
}
