import { ipcMain } from 'electron'
import type { AgentResult } from '../../shared/agent'
import { isAgentId } from '../../shared/agent'
import { parseAgentRequestContext } from '../../shared/project'
import { getIpcWindow } from '../ipc-source'
import { runAgentRequest, cancelAgentJob } from './desktop-agent-host'
import { registerAgentUserInput } from './agent-user-input'
import { getResumableAgentTask } from './desktop-checkpoints'
import { agentResumePrompt, type ResumableAgentTask } from '../../shared/agent-resume'
import { isTaskId } from '../../shared/task'
import { readSkillMessage } from './skill-message'
import type { SkillMessageResult } from '../../shared/skills'

export function registerAgentRequest(
  isPreparationActive: (windowId: number) => boolean = () => false
): void {
  registerAgentUserInput()
  ipcMain.handle(
    'agent:skill-message',
    async (event, conversationId: unknown, messageId: unknown): Promise<SkillMessageResult> => {
      const window = getIpcWindow(event, '不支持的技能消息来源', {
        windowMustBeLive: true,
        senderMustBeLive: true
      })
      if (!isAgentId(conversationId) || !isAgentId(messageId))
        return { status: 'error', error: '技能消息标识无效' }
      try {
        const assertCurrent = (): void => {
          getIpcWindow(event, '技能消息来源已失效', {
            windowMustBeLive: true,
            senderMustBeLive: true
          })
        }
        const snapshot = await readSkillMessage(window.id, conversationId, messageId, assertCurrent)
        getIpcWindow(event, '技能消息来源已失效', {
          windowMustBeLive: true,
          senderMustBeLive: true
        })
        return { status: 'ready', snapshot }
      } catch (error) {
        return {
          status: 'error',
          error: error instanceof Error ? error.message : '无法读取原技能快照'
        }
      }
    }
  )
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
  ipcMain.handle(
    'agent:resume-info',
    async (event, conversationId: unknown): Promise<ResumableAgentTask | null> => {
      getIpcWindow(event, '不支持的任务续接来源')
      if (!isAgentId(conversationId)) throw new Error('会话标识无效')
      return getResumableAgentTask(conversationId)
    }
  )
  ipcMain.handle(
    'agent:resume',
    async (event, id: unknown, checkpointTaskId: unknown, context: unknown, taskId?: unknown) => {
      const window = getIpcWindow(event, '不支持的任务续接来源')
      const checkedContext = parseAgentRequestContext(context)
      if (
        !isAgentId(id) ||
        !isTaskId(checkpointTaskId) ||
        !checkedContext ||
        checkedContext.images?.length ||
        checkedContext.imageHistory?.length
      )
        return { status: 'error', error: '任务续接参数无效', trace: [] }
      return runAgentRequest(
        window.id,
        event.sender,
        id,
        agentResumePrompt,
        [],
        checkedContext,
        taskId,
        isPreparationActive,
        checkpointTaskId
      )
    }
  )
}
