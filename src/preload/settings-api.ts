import { ipcRenderer } from 'electron'
import type { AppAPI } from '../shared/api'
import { parseAppSettings, parseSettingsChange, parseTaskRootSelection } from '../shared/settings'

export const settingsAPI: Pick<AppAPI, 'getSettings' | 'updateSettings' | 'selectTaskRoot'> = {
  getSettings: async () => {
    const settings = parseAppSettings(await ipcRenderer.invoke('settings:get'))
    if (!settings) throw new Error('设置读取结果格式不正确')
    return settings
  },
  updateSettings: async (change) => {
    const checked = parseSettingsChange(change)
    if (!checked) throw new Error('设置修改参数无效')
    const settings = parseAppSettings(await ipcRenderer.invoke('settings:update', checked))
    if (!settings) throw new Error('设置保存结果格式不正确')
    return settings
  },
  selectTaskRoot: async () => {
    const result = parseTaskRootSelection(await ipcRenderer.invoke('settings:select-task-root'))
    if (!result) throw new Error('文件夹选择结果格式不正确')
    return result
  }
}
