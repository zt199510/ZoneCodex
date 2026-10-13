import { ipcRenderer } from 'electron'
import type { AppAPI } from '../shared/api'
import { isGitWorkbenchId } from '../shared/git-workbench'
import { parseGitRepositoryCollectionResult } from '../shared/git-repositories'

export const gitRepositoriesAPI: Pick<AppAPI, 'getGitRepositories' | 'selectGitDirectories'> = {
  getGitRepositories: async (requestId) => {
    if (!isGitWorkbenchId(requestId)) throw new Error('Git 仓库列表请求无效')
    const result = parseGitRepositoryCollectionResult(
      await ipcRenderer.invoke('git:repositories', requestId)
    )
    if (!result || result.requestId !== requestId) throw new Error('Git 仓库列表身份无效')
    return result
  },
  selectGitDirectories: async (requestId) => {
    if (!isGitWorkbenchId(requestId)) throw new Error('Git 多目录选择请求无效')
    const result = parseGitRepositoryCollectionResult(
      await ipcRenderer.invoke('git:add-repositories', requestId)
    )
    if (!result || result.requestId !== requestId) throw new Error('Git 多目录选择结果身份无效')
    return result
  }
}
