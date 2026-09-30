import { BrowserWindow, ipcMain } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import type { AgentResult } from '../../shared/agent'
import { isAgentId } from '../../shared/agent'
import { parseToolHistory } from '../../shared/agent-history'
import { parseAgentRequestContext, toolScopeForAgentRequest } from '../../shared/project'
import type { ToolScope } from '../../shared/project'
import { AgentError, runToolLoop } from './tool-loop'
import { createLiveResponse } from '../model/tool-response'
import { buildAgentRequest } from './agent-instructions'
import {
  captureProjectAccess,
  captureWorkspaceAccess,
  hasProjectSelection,
  hasWorkspaceSelection
} from './project-access'
import { createChangeProposalExecutor } from '../tools/change-proposal'
import { createCommandProposalExecutor } from '../tools/command-proposal'
import { executeTimeTool } from '../tools/current-time'
import type { ProjectSnapshot } from '../tools/project-snapshot'
import { createTask, newTaskId, updateTask } from './task-registry'
import { isTaskId } from '../../shared/task'
import { readProjectInstruction } from './project-instruction'

type Job = { id: string; controller: AbortController; snapshotId?: string }
const jobs = new Map<number, Job>()

export function hasAgentJob(windowId: number): boolean {
  return jobs.has(windowId)
}

export function abortProjectJob(windowId: number, snapshotId: string): void {
  const job = jobs.get(windowId)
  if (job?.snapshotId === snapshotId) job.controller.abort()
}

function checkSource(event: IpcMainInvokeEvent): void {
  if (
    !BrowserWindow.fromWebContents(event.sender) ||
    event.senderFrame !== event.sender.mainFrame
  ) {
    throw new Error('不支持的 Agent 请求来源')
  }
}

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
      checkSource(event)
      const windowId = BrowserWindow.fromWebContents(event.sender)!.id
      const trace: string[] = []
      if (!isAgentId(id) || typeof prompt !== 'string' || !prompt.trim() || prompt.length > 2000) {
        return { status: 'error', error: '任务参数无效', trace }
      }
      const checkedContext = parseAgentRequestContext(context)
      if (!checkedContext) return { status: 'error', error: '工具上下文参数无效', trace }
      const sender = event.sender
      if (
        hasProjectSelection(windowId) ||
        hasWorkspaceSelection(windowId) ||
        isPreparationActive(windowId)
      )
        return { status: 'error', error: '请先完成文件选择', trace }
      const workspaceId = checkedContext.workspaceId
      const workspace =
        workspaceId !== undefined
          ? captureWorkspaceAccess(windowId, checkedContext.conversationId)
          : null
      let workspaceInstruction: string | null = null
      if (workspaceId !== undefined) {
        if (!workspace || workspace.workspaceId !== workspaceId) {
          return { status: 'error', error: '工作区授权已失效，请重新选择文件夹', trace }
        }
        const instructionResult = await readProjectInstruction(workspace.root)
        const currentWorkspace = captureWorkspaceAccess(windowId, checkedContext.conversationId)
        if (!currentWorkspace || currentWorkspace.workspaceId !== workspaceId) {
          return { status: 'error', error: '工作区授权已失效，请重新选择文件夹', trace }
        }
        if (instructionResult.status === 'error') {
          return { status: 'error', error: instructionResult.error, trace }
        }
        if (
          workspace.instruction &&
          (instructionResult.status !== 'read' ||
            instructionResult.instruction.fingerprint !== workspace.instruction.fingerprint)
        ) {
          return { status: 'error', error: 'AGENTS.md 已变化，请重新读取工作区指令', trace }
        }
        const instruction =
          instructionResult.status === 'read' ? instructionResult.instruction : null
        workspaceInstruction = instruction?.content ?? null
      }
      let projectSnapshot: ProjectSnapshot | null = null
      if (checkedContext.attachment) {
        projectSnapshot = captureProjectAccess(
          windowId,
          checkedContext.conversationId,
          checkedContext.attachment.snapshotId
        )
        if (!projectSnapshot) return { status: 'error', error: '项目快照授权已失效', trace }
      }
      const checkedScope: ToolScope = toolScopeForAgentRequest(checkedContext)
      const projectExecutor = projectSnapshot
        ? createChangeProposalExecutor(projectSnapshot, checkedContext.conversationId)
        : undefined
      const checkedHistory = parseToolHistory(history, checkedScope)
      const executeCommandProposal = createCommandProposalExecutor()
      if (!checkedHistory) return { status: 'error', error: '工具历史参数无效', trace }
      if (jobs.has(windowId)) return { status: 'error', error: '请等待上一次工具任务结束', trace }
      const controller = new AbortController()
      const lifecycleId = isTaskId(taskId) ? taskId : newTaskId()
      const task = createTask({
        taskId: lifecycleId,
        requestId: id,
        conversationId: checkedContext.conversationId,
        kind: 'agent',
        windowId,
        snapshotId: projectSnapshot?.selection.snapshotId,
        cancel: () => controller.abort()
      })
      if (!task) return { status: 'error', error: '任务标识已使用，请重新发起', trace }
      const job: Job = {
        id,
        controller,
        snapshotId: projectSnapshot?.selection.snapshotId
      }
      jobs.set(windowId, job)
      updateTask(windowId, lifecycleId, 'running')
      let timedOut = false
      const cancel = (): void => {
        controller.abort()
      }
      const timer = setTimeout(() => {
        if (controller.signal.aborted) return
        timedOut = true
        cancel()
      }, 90_000)
      sender.once('did-start-loading', cancel)
      sender.once('render-process-gone', cancel)
      sender.once('destroyed', cancel)
      try {
        trace.push('模式：真实模型 SSE')
        const agentRequest = buildAgentRequest({
          snapshot: projectSnapshot,
          workspaceInstruction
        })
        const completed = await runToolLoop(
          prompt.trim(),
          createLiveResponse(agentRequest.tools, agentRequest.instructions),
          controller.signal,
          trace,
          (message) => {
            if (controller.signal.aborted || sender.isDestroyed()) return
            sender.send('agent:progress', { requestId: id, message })
          },
          checkedHistory,
          projectSnapshot
            ? ((executeFile) => {
                return async (name: string, args: string, signal: AbortSignal): Promise<string> => {
                  signal.throwIfAborted()
                  if (name === 'propose_command') return executeCommandProposal(name, args, signal)
                  return name === 'get_current_time'
                    ? executeTimeTool(name, args)
                    : executeFile(name, args, signal)
                }
              })(projectExecutor!)
            : undefined,
          checkedScope,
          (delta) => {
            if (controller.signal.aborted || sender.isDestroyed()) return
            sender.send('model-stream:delta', { requestId: id, delta })
          }
        )

        controller.signal.throwIfAborted()
        const needsApproval = completed.items.some(
          (item) => item.type === 'function_call' && item.name === 'propose_command'
        )
        updateTask(windowId, lifecycleId, needsApproval ? 'waiting_approval' : 'completed', {
          result: completed.answer
        })
        return { status: 'done', answer: completed.answer, items: completed.items, trace }
      } catch (error) {
        if (timedOut) {
          updateTask(windowId, lifecycleId, 'timed_out', { error: '任务超过 90 秒，已停止' })
          return { status: 'error', error: '任务超过 90 秒，已停止', trace }
        }
        if (controller.signal.aborted) {
          updateTask(windowId, lifecycleId, 'cancelled', { error: '用户已取消任务' })
          return { status: 'cancelled', trace }
        }
        updateTask(windowId, lifecycleId, 'failed', {
          error:
            error instanceof AgentError ? error.message : '请求或工具处理失败，请检查网络和响应格式'
        })
        return {
          status: 'error',
          error:
            error instanceof AgentError
              ? error.message
              : '请求或工具处理失败，请检查网络和响应格式',
          trace
        }
      } finally {
        clearTimeout(timer)
        controller.abort()
        if (jobs.get(windowId) === job) jobs.delete(windowId)
        sender.removeListener('did-start-loading', cancel)
        sender.removeListener('render-process-gone', cancel)
        sender.removeListener('destroyed', cancel)
      }
    }
  )
  ipcMain.handle('agent:cancel', (event, id: unknown): boolean => {
    checkSource(event)
    if (!isAgentId(id)) return false
    const job = jobs.get(BrowserWindow.fromWebContents(event.sender)!.id)
    if (!job || job.id !== id) return false
    job.controller.abort()
    return true
  })
}
