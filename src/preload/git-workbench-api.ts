import { ipcRenderer } from 'electron'
import type { AppAPI } from '../shared/api'
import {
  parseGitWorkbenchRequest,
  parseGitReviewRequest,
  parseGitDiffRequest,
  parseGitActionRequest,
  parseGitMetadataResult,
  parseGitReviewResult,
  parseGitDiffResult,
  parseGitActionResult,
  sameGitWorkbenchRequest,
  parseGitGenerateRequest,
  parseGitGenerateResult,
  parseGitFullFileRequest,
  parseGitFullFileResult
} from '../shared/git-workbench'
import { isGitWorkbenchId } from '../shared/git-workbench'
import { parseGitSelectionResult } from '../shared/git-view'

export const gitWorkbenchAPI: Pick<
  AppAPI,
  | 'getGitMetadata'
  | 'reviewGitChanges'
  | 'readGitDiff'
  | 'executeGitAction'
  | 'generateGitText'
  | 'readGitFullFile'
  | 'initializeGitRepository'
> = {
  getGitMetadata: async (request) => {
    const checked = parseGitWorkbenchRequest(request)
    if (!checked) throw new Error('Git 仓库请求无效')
    const result = parseGitMetadataResult(await ipcRenderer.invoke('git:metadata', checked))
    if (!result || !sameGitWorkbenchRequest(checked, result))
      throw new Error('Git 仓库结果身份无效')
    return result
  },
  reviewGitChanges: async (request) => {
    const checked = parseGitReviewRequest(request)
    if (!checked) throw new Error('Git 比较请求无效')
    const result = parseGitReviewResult(await ipcRenderer.invoke('git:review', checked))
    if (
      !result ||
      !sameGitWorkbenchRequest(checked, result) ||
      (result.status === 'ready' && result.data.source !== checked.source)
    )
      throw new Error('Git 比较结果身份无效')
    return result
  },
  readGitDiff: async (request) => {
    const checked = parseGitDiffRequest(request)
    if (!checked) throw new Error('Git 差异请求无效')
    const result = parseGitDiffResult(await ipcRenderer.invoke('git:diff', checked))
    if (
      !result ||
      !sameGitWorkbenchRequest(checked, result) ||
      (result.status === 'ready' && result.data.itemId !== checked.itemId)
    )
      throw new Error('Git 差异结果身份无效')
    return result
  },
  executeGitAction: async (request) => {
    const checked = parseGitActionRequest(request)
    if (!checked) throw new Error('Git 操作请求无效')
    const result = parseGitActionResult(await ipcRenderer.invoke('git:action', checked))
    if (!result || !sameGitWorkbenchRequest(checked, result))
      throw new Error('Git 操作结果身份无效；请刷新确认仓库现状')
    return result
  },
  generateGitText: async (request) => {
    const checked = parseGitGenerateRequest(request)
    if (!checked) throw new Error('Git 生成请求无效')
    const result = parseGitGenerateResult(await ipcRenderer.invoke('git:generate', checked))
    if (!result || !sameGitWorkbenchRequest(checked, result))
      throw new Error('Git 生成结果身份无效')
    return result
  },
  readGitFullFile: async (request) => {
    const checked = parseGitFullFileRequest(request)
    if (!checked) throw new Error('Git 完整文件请求无效')
    const result = parseGitFullFileResult(await ipcRenderer.invoke('git:full-file', checked))
    if (
      !result ||
      !sameGitWorkbenchRequest(checked, result) ||
      (result.status === 'ready' &&
        (result.data.itemId !== checked.itemId || result.data.side !== checked.side))
    )
      throw new Error('Git 完整文件结果身份无效')
    return result
  },
  initializeGitRepository: async (requestId) => {
    if (!isGitWorkbenchId(requestId)) throw new Error('Git 初始化请求标识无效')
    const result = parseGitSelectionResult(await ipcRenderer.invoke('git:init', requestId))
    if (!result || result.requestId !== requestId)
      throw new Error('Git 初始化结果身份无效；请重新选择目录确认')
    return result
  }
}
