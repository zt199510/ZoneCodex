import type { WebContents } from 'electron'
import type { AgentResult } from '../../shared/agent'
import { parseToolHistory } from '../../shared/agent-history'
import {
  toolScopeForAgentRequest,
  type AgentRequestContext,
  type ToolScope
} from '../../shared/project'
import { sameExecutionInfo } from '../../shared/execution'
import { isTaskId } from '../../shared/task'
import { AgentError } from '../errors'
import { runToolLoop } from './tool-loop'
import { createLiveResponse } from '../model/response-client'
import { buildAgentRequest } from './agent-instructions'
import { createAgentToolExecutor } from './agent-tools'
import { captureProjectAccess, hasProjectSelection } from '../project/attachment-access'
import { captureWorkspaceAccess, hasWorkspaceSelection } from '../project/workspace-access'
import { readProjectInstruction } from '../project/project-instruction'
import { createChangeProposalExecutor } from '../tools/change-proposal'
import { createCommandProposalExecutor } from '../tools/command-proposal'
import type { ProjectSnapshot } from '../tools/project-snapshot'
import { createTask, newTaskId, updateTask } from '../execution/task-registry'
import { hasExecutionApproval } from '../execution/execution-approval'
import {
  executionStillCurrent,
  resolveExecutionContext,
  type ExecutionContext
} from '../execution/execution-context'
import {
  createWorkspaceAuthorization,
  createWorkspaceCommandAuthorization
} from '../execution/action-authorization'
import { inspectWindowsCommandBackend } from '../execution/windows-command-backend'

type Job = { id: string; controller: AbortController; snapshotId?: string }
const jobs = new Map<number, Job>()

export function hasAgentJob(windowId: number): boolean {
  return jobs.has(windowId)
}

export function abortProjectJob(windowId: number, snapshotId: string): void {
  const job = jobs.get(windowId)
  if (job?.snapshotId === snapshotId) job.controller.abort()
}

export function isAgentBusy(
  windowId: number,
  isPreparationActive: (windowId: number) => boolean
): boolean {
  return (
    jobs.has(windowId) ||
    hasExecutionApproval(windowId) ||
    isPreparationActive(windowId) ||
    hasProjectSelection(windowId) ||
    hasWorkspaceSelection(windowId)
  )
}

export function cancelAgentJob(windowId: number, requestId: string): boolean {
  const job = jobs.get(windowId)
  if (!job || job.id !== requestId) return false
  job.controller.abort()
  return true
}

export async function runAgentRequest(
  windowId: number,
  sender: WebContents,
  id: string,
  prompt: string,
  history: unknown,
  checkedContext: AgentRequestContext,
  taskId: unknown,
  isPreparationActive: (windowId: number) => boolean
): Promise<AgentResult> {
  const trace: string[] = []
  const appendTrace = (message: string): void => {
    trace.push(message.slice(0, 500))
    if (trace.length > 30) trace.shift()
  }
  if (
    jobs.has(windowId) ||
    hasExecutionApproval(windowId) ||
    hasProjectSelection(windowId) ||
    hasWorkspaceSelection(windowId) ||
    isPreparationActive(windowId)
  )
    return { status: 'error', error: '请先完成当前操作', trace }
  const controller = new AbortController()
  const job: Job = {
    id,
    controller,
    snapshotId: checkedContext.attachment?.snapshotId
  }
  const cancel = (): void => controller.abort()
  jobs.set(windowId, job)
  sender.once('did-start-loading', cancel)
  sender.once('render-process-gone', cancel)
  sender.once('destroyed', cancel)
  try {
    const workspaceId = checkedContext.workspaceId
    const workspace =
      workspaceId !== undefined
        ? captureWorkspaceAccess(windowId, checkedContext.conversationId)
        : null
    let execution: ExecutionContext
    try {
      execution = await resolveExecutionContext(windowId, checkedContext)
      controller.signal.throwIfAborted()
      if (
        !checkedContext.execution ||
        !sameExecutionInfo(checkedContext.execution, execution.info)
      ) {
        return { status: 'error', error: '运行目录或权限已变化，请重新发送', trace }
      }
    } catch (error) {
      if (controller.signal.aborted) return { status: 'cancelled', trace }
      return {
        status: 'error',
        error: error instanceof Error ? error.message : '无法确定运行目录',
        trace
      }
    }
    let workspaceInstruction: string | null = null
    if (workspaceId !== undefined) {
      if (!workspace || workspace.workspaceId !== workspaceId) {
        return { status: 'error', error: '工作区授权已失效，请重新选择文件夹', trace }
      }
      const instructionResult = await readProjectInstruction(workspace.root)
      controller.signal.throwIfAborted()
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
      const instruction = instructionResult.status === 'read' ? instructionResult.instruction : null
      workspaceInstruction = instruction?.content ?? null
    }
    if (!workspace) {
      const instruction = await readProjectInstruction(execution.info.cwd)
      controller.signal.throwIfAborted()
      if (instruction.status === 'error')
        return { status: 'error', error: instruction.error, trace }
      workspaceInstruction = instruction.status === 'read' ? instruction.instruction.content : null
    }
    if (!executionStillCurrent(windowId, checkedContext, execution)) {
      return { status: 'error', error: '运行上下文已失效，请重新发送', trace }
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
    if (
      jobs.get(windowId) !== job ||
      isPreparationActive(windowId) ||
      hasProjectSelection(windowId) ||
      hasWorkspaceSelection(windowId)
    ) {
      return { status: 'error', error: '运行上下文已变化，请重新发送', trace }
    }
    controller.signal.throwIfAborted()
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
    updateTask(windowId, lifecycleId, 'running')
    let timedOut = false
    let workspaceActionApproved = false
    const armTimeout = (): NodeJS.Timeout =>
      setTimeout(() => {
        if (controller.signal.aborted) return
        timedOut = true
        cancel()
      }, 240_000)
    let timer = armTimeout()
    try {
      appendTrace('模式：真实模型 SSE')
      const assertWorkspaceAccess = (): boolean => {
        return (
          !controller.signal.aborted && executionStillCurrent(windowId, checkedContext, execution)
        )
      }
      const commandBackend = await inspectWindowsCommandBackend()
      controller.signal.throwIfAborted()
      if (!assertWorkspaceAccess()) throw new AgentError('运行上下文已失效，请重新发送')
      const agentRequest = buildAgentRequest({
        snapshot: projectSnapshot,
        workspaceInstruction,
        workspaceId,
        execution: execution.info,
        commandSandboxAvailable: commandBackend?.networkReady === true
      })
      const authorizationOptions: Parameters<typeof createWorkspaceAuthorization>[0] = {
        windowId,
        requestId: id,
        conversationId: checkedContext.conversationId,
        userRequest: prompt.trim(),
        execution,
        assertCurrent: assertWorkspaceAccess,
        beginApproval: () => {
          if (!updateTask(windowId, lifecycleId, 'waiting_approval')) {
            controller.abort()
            return false
          }
          clearTimeout(timer)
          return true
        },
        onApproved: (request) => {
          workspaceActionApproved = true
          const message = `工作区操作已批准：${request.kind}`
          appendTrace(message)
          if (!sender.isDestroyed()) sender.send('agent:progress', { requestId: id, message })
        },
        finishApproval: () => {
          if (!controller.signal.aborted) {
            if (updateTask(windowId, lifecycleId, 'running')) timer = armTimeout()
            else controller.abort()
          }
        }
      }
      const approveWorkspaceAction = createWorkspaceAuthorization(authorizationOptions)
      const authorizeWorkspaceCommand = createWorkspaceCommandAuthorization(authorizationOptions)
      const executeTools = createAgentToolExecutor({
        execution,
        assertCurrent: assertWorkspaceAccess,
        approve: approveWorkspaceAction,
        authorizeCommand: authorizeWorkspaceCommand,
        projectSnapshot,
        projectExecutor,
        executeCommandProposal,
        appendTrace,
        onProgress: (message) => {
          if (!sender.isDestroyed()) sender.send('agent:progress', { requestId: id, message })
        },
        onEffect: () => {
          workspaceActionApproved = true
          const message = '本地操作已开始：文件或命令'
          appendTrace(message)
          if (!sender.isDestroyed()) sender.send('agent:progress', { requestId: id, message })
        }
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
        executeTools,
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
      if (
        workspaceActionApproved &&
        !trace.some(
          (line) => line.startsWith('工作区操作已批准：') || line.startsWith('本地操作已开始：')
        )
      ) {
        appendTrace('本地操作已开始：结果待核对')
      }
      const actionWarning = workspaceActionApproved
        ? '本地操作可能已经执行。请先核对文件或命令结果，再决定是否重新请求。'
        : null
      const terminationWarning =
        error instanceof Error && error.message.includes('进程树是否退出未确认')
          ? error.message
          : null
      if (terminationWarning) appendTrace(`命令停止结果：${terminationWarning}`)
      if (timedOut) {
        const message = ['任务超过 4 分钟，已停止请求', terminationWarning, actionWarning]
          .filter(Boolean)
          .join('。')
        updateTask(windowId, lifecycleId, 'timed_out', { error: message })
        return { status: 'error', error: message, trace }
      }
      if (controller.signal.aborted) {
        updateTask(windowId, lifecycleId, 'cancelled', {
          error: ['用户已取消任务', terminationWarning, actionWarning].filter(Boolean).join('。')
        })
        return { status: 'cancelled', trace }
      }
      const message = [
        error instanceof AgentError ? error.message : '请求或工具处理失败，请检查网络和响应格式',
        actionWarning
      ]
        .filter(Boolean)
        .join('。')
      updateTask(windowId, lifecycleId, 'failed', {
        error: message
      })
      return { status: 'error', error: message, trace }
    } finally {
      clearTimeout(timer)
    }
  } catch (error) {
    return controller.signal.aborted
      ? { status: 'cancelled', trace }
      : {
          status: 'error',
          error: error instanceof Error ? error.message : '无法准备运行上下文',
          trace
        }
  } finally {
    controller.abort()
    if (jobs.get(windowId) === job) jobs.delete(windowId)
    sender.removeListener('did-start-loading', cancel)
    sender.removeListener('render-process-gone', cancel)
    sender.removeListener('destroyed', cancel)
  }
}
