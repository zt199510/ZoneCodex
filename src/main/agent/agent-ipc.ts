import { ipcMain } from 'electron'
import type { AgentResult } from '../../shared/agent'
import { isAgentId } from '../../shared/agent'
import { parseAgentRequestContext } from '../../shared/project'
import { getIpcWindow } from '../ipc-source'
import { runAgentRequest, cancelAgentJob } from './agent-runner'

export function registerAgentRequest(
  isPreparationActive: (windowId: number) => boolean = () => false
): void {
  ipcMain.handle(
    'agent:start',
    async (
      event,
      id: unknown,
      prompt: unknown,
      history: unknown,
      context: unknown,
      taskId: unknown = undefined
    ): Promise<AgentResult> => {
      const window = getIpcWindow(event, '不支持的 Agent 请求来源')
      const trace: string[] = []
      if (!isAgentId(id) || typeof prompt !== 'string' || !prompt.trim() || prompt.length > 2000) {
        return { status: 'error', error: '任务参数无效', trace }
      }
      const checkedContext = parseAgentRequestContext(context)
      if (!checkedContext) return { status: 'error', error: '工具上下文参数无效', trace }
      return runAgentRequest(
        window.id,
        event.sender,
        id,
        prompt,
        history,
        checkedContext,
        taskId,
        isPreparationActive
      )
    }
  )
  ipcMain.handle('agent:cancel', (event, id: unknown): boolean => {
    const window = getIpcWindow(event, '不支持的 Agent 请求来源')
    if (!isAgentId(id)) return false
    return cancelAgentJob(window.id, id)
  })
}
