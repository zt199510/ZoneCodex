import { ipcRenderer } from 'electron'
import type { AppAPI } from '../shared/api'
import {
  isGitViewId,
  parseGitListRequest,
  parseGitItemRequest,
  parseGitSelectionResult,
  parseGitListResult,
  parseGitItemResult,
  parseGitControlResult,
  sameGitListRequest,
  sameGitItemRequest
} from '../shared/git-view'

export const gitAPI: Pick<
  AppAPI,
  'selectGitDirectory' | 'refreshGitView' | 'readGitItem' | 'cancelGitRead' | 'releaseGitView'
> = {
  selectGitDirectory: async (requestId) => {
    if (!isGitViewId(requestId)) throw new Error('Git 查看请求标识无效')
    const result = parseGitSelectionResult(await ipcRenderer.invoke('git:select', requestId))
    if (!result || result.requestId !== requestId) throw new Error('Git 目录选择结果无效')
    return result
  },
  refreshGitView: async (request) => {
    const checked = parseGitListRequest(request)
    if (!checked) throw new Error('Git 列表请求无效')
    const result = parseGitListResult(await ipcRenderer.invoke('git:list', checked))
    if (!result || !sameGitListRequest(checked, result)) throw new Error('Git 列表结果无效')
    return result
  },
  readGitItem: async (request) => {
    const checked = parseGitItemRequest(request)
    if (!checked) throw new Error('Git 项目请求无效')
    const result = parseGitItemResult(await ipcRenderer.invoke('git:read', checked))
    if (!result || !sameGitItemRequest(checked, result)) throw new Error('Git 项目结果无效')
    return result
  },
  cancelGitRead: async (requestId) => {
    if (!isGitViewId(requestId)) throw new Error('Git 取消请求标识无效')
    const result = parseGitControlResult(await ipcRenderer.invoke('git:cancel', requestId))
    if (!result) throw new Error('Git 取消结果无效')
    return result
  },
  releaseGitView: async (viewId) => {
    if (!isGitViewId(viewId)) throw new Error('Git 查看标识无效')
    const result = parseGitControlResult(await ipcRenderer.invoke('git:release', viewId))
    if (!result) throw new Error('Git 释放结果无效')
    return result
  }
}
