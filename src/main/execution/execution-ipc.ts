import { ipcMain } from 'electron'
import { parsePermissionMode } from '../../shared/execution'
import { parseAgentRequestContext } from '../../shared/project'
import { getIpcWindow } from '../ipc-source'
import { getExecutionPermissionState, setExecutionPermissionMode } from './permission-state'
import { executionStillCurrent, resolveExecutionContext } from './execution-context'

export function registerExecutionContext(isBusy: (windowId: number) => boolean): void {
  ipcMain.handle('execution:permissions-get', (event) => {
    const window = getIpcWindow(event, '不支持的 Agent 请求来源')
    return getExecutionPermissionState(window.id)
  })
  ipcMain.handle('execution:permissions-set', (event, value: unknown) => {
    const window = getIpcWindow(event, '不支持的 Agent 请求来源')
    const mode = parsePermissionMode(value)
    if (!mode) throw new Error('权限模式无效')
    if (isBusy(window.id)) throw new Error('请等待当前任务结束后切换权限')
    return setExecutionPermissionMode(window.id, mode)
  })
  ipcMain.handle('agent:resolve-execution', async (event, value: unknown) => {
    const window = getIpcWindow(event, '不支持的 Agent 请求来源')
    const context = parseAgentRequestContext(value)
    if (!context) throw new Error('运行上下文参数无效')
    if (isBusy(window.id)) throw new Error('请等待当前操作结束')
    const execution = await resolveExecutionContext(window.id, context)
    if (event.sender.isDestroyed() || !executionStillCurrent(window.id, context, execution)) {
      throw new Error('运行上下文已变化，请重新发送')
    }
    return execution.info
  })
}
