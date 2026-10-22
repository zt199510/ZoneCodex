import { ipcMain } from 'electron'
import { getIpcWindow } from '../ipc-source'
import { getModelStatus } from './model-session'

export function registerModelIpc(): void {
  ipcMain.handle('model:status', (event) => {
    getIpcWindow(event, '不支持的模型状态来源')
    return getModelStatus()
  })
}
