import { ipcRenderer } from 'electron'
import type { AppAPI } from '../shared/api'
import { isAgentId } from '../shared/agent'
import { parseCommitRequest, parseCommitResult } from '../shared/change-commit'
import { parsePreparationRequest, parsePreparationResult } from '../shared/change-preparation'
import {
  parseProjectSelectionResult,
  parseWorkspaceInstructionResult,
  parseWorkspaceSelectionResult
} from '../shared/project'
import { parsePreviewChangeRequest, parsePreviewChangeResult } from '../shared/change-preview'
import { parseFileViewRequest, parseFileViewResult, sameFileViewRequest } from '../shared/file-view'

export const projectAPI: Pick<
  AppAPI,
  | 'selectProjectFiles'
  | 'removeProjectFile'
  | 'selectWorkspace'
  | 'clearWorkspace'
  | 'readWorkspaceInstruction'
  | 'commitChange'
  | 'cancelCommit'
  | 'revealBackup'
  | 'prepareChange'
  | 'cancelPreparation'
  | 'previewChange'
  | 'revokeProjectFiles'
  | 'readFileView'
> = {
  readFileView: async (request) => {
    const checked = parseFileViewRequest(request)
    if (!checked) throw new Error('文件查看请求格式不正确')
    const result = parseFileViewResult(await ipcRenderer.invoke('project:read-file-view', checked))
    if (!result || !sameFileViewRequest(checked, result))
      throw new Error('文件查看结果无效，请重新打开')
    return result
  },
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
    if (!isAgentId(conversationId) || !isAgentId(operationId)) throw new Error('工作区选择参数无效')
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
  revokeProjectFiles: async (snapshotId) => {
    if (!isAgentId(snapshotId)) return false
    const result: unknown = await ipcRenderer.invoke('project:revoke', snapshotId)
    if (typeof result !== 'boolean') throw new Error('项目撤销结果格式不正确')
    return result
  }
}
