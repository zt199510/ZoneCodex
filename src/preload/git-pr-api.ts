import { ipcRenderer } from 'electron'
import type { GitPullRequestAPI } from '../shared/git-pr'
import {
  parseGitPullRequestListRequest,
  parseGitPullRequestDetailRequest,
  parseGitPullRequestMergeRequest,
  parseGitPullRequestListResult,
  parseGitPullRequestDetailResult,
  parseGitPullRequestMergeResult
} from '../shared/git-pr'
import { sameGitWorkbenchRequest } from '../shared/git-workbench'

export const gitPullRequestAPI: GitPullRequestAPI = {
  getGitPullRequests: async (request) => {
    const checked = parseGitPullRequestListRequest(request)
    if (!checked) throw new Error('PR 列表请求无效')
    const result = parseGitPullRequestListResult(await ipcRenderer.invoke('git:pr-list', checked))
    if (!result || !sameGitWorkbenchRequest(checked, result)) throw new Error('PR 列表结果身份无效')
    return result
  },
  getGitPullRequest: async (request) => {
    const checked = parseGitPullRequestDetailRequest(request)
    if (!checked) throw new Error('PR 详情请求无效')
    const result = parseGitPullRequestDetailResult(
      await ipcRenderer.invoke('git:pr-detail', checked)
    )
    if (
      !result ||
      !sameGitWorkbenchRequest(checked, result) ||
      (result.status === 'ready' && result.data.prId !== checked.prId)
    )
      throw new Error('PR 详情结果身份无效')
    return result
  },
  mergeGitPullRequest: async (request) => {
    const checked = parseGitPullRequestMergeRequest(request)
    if (!checked) throw new Error('PR 合并请求无效')
    const result = parseGitPullRequestMergeResult(await ipcRenderer.invoke('git:pr-merge', checked))
    if (
      !result ||
      !sameGitWorkbenchRequest(checked, result) ||
      (result.status === 'ready' && result.data.prId !== checked.prId)
    )
      throw new Error('PR 合并结果身份无效；请刷新远程状态后再操作')
    return result
  }
}
