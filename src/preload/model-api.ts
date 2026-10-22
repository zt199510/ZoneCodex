import { ipcRenderer } from 'electron'
import type { AppAPI } from '../shared/api'
import { parseModelStatus } from '../shared/model'

export const modelAPI: Pick<AppAPI, 'getModelStatus'> = {
  getModelStatus: async () => {
    const status = parseModelStatus(await ipcRenderer.invoke('model:status'))
    if (!status) throw new Error('模型状态格式无效')
    return status
  }
}
