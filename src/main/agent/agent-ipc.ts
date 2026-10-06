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
import { createWorkspaceReadExecutor, workspaceReadTools } from '../tools/workspace-files'
import {
  createWorkspaceActionExecutor,
  workspaceActionTools,
  type WorkspaceApprovalRequest
} from '../tools/workspace-actions'
import type { ProjectSnapshot } from '../tools/project-snapshot'
import { createTask, newTaskId, updateTask } from './task-registry'
import { isTaskId } from '../../shared/task'
import { readProjectInstruction } from './project-instruction'
import {
  parsePermissionMode,
  sameExecutionInfo,
  type ExecutionApprovalInput
} from '../../shared/execution'
import { hasExecutionApproval, requestExecutionApproval } from './execution-approval'
import {
  executionStillCurrent,
  getExecutionPermissionState,
  localPermission,
  resolveExecutionContext,
  setExecutionPermissionMode,
  type ExecutionContext
} from './execution-context'
import { canonicalLocalPath } from '../tools/local-path'

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
  const isBusy = (windowId: number): boolean =>
    jobs.has(windowId) ||
    hasExecutionApproval(windowId) ||
    isPreparationActive(windowId) ||
    hasProjectSelection(windowId) ||
    hasWorkspaceSelection(windowId)
  ipcMain.handle('execution:permissions-get', (event) => {
    checkSource(event)
    return getExecutionPermissionState(BrowserWindow.fromWebContents(event.sender)!.id)
  })
  ipcMain.handle('execution:permissions-set', (event, value: unknown) => {
    checkSource(event)
    const windowId = BrowserWindow.fromWebContents(event.sender)!.id
    const mode = parsePermissionMode(value)
    if (!mode) throw new Error('权限模式无效')
    if (mode === 'auto-approve') throw new Error('“帮我批准”尚未启用')
    if (isBusy(windowId)) throw new Error('请等待当前任务结束后切换权限')
    return setExecutionPermissionMode(windowId, mode)
  })
  ipcMain.handle('agent:resolve-execution', async (event, value: unknown) => {
    checkSource(event)
    const windowId = BrowserWindow.fromWebContents(event.sender)!.id
    const context = parseAgentRequestContext(value)
    if (!context) throw new Error('运行上下文参数无效')
    if (isBusy(windowId)) throw new Error('请等待当前操作结束')
    const execution = await resolveExecutionContext(windowId, context)
    if (event.sender.isDestroyed() || !executionStillCurrent(windowId, context, execution)) {
      throw new Error('运行上下文已变化，请重新发送')
    }
    return execution.info
  })
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
      const appendTrace = (message: string): void => {
        trace.push(message.slice(0, 500))
        if (trace.length > 30) trace.shift()
      }
      if (!isAgentId(id) || typeof prompt !== 'string' || !prompt.trim() || prompt.length > 2000) {
        return { status: 'error', error: '任务参数无效', trace }
      }
      const checkedContext = parseAgentRequestContext(context)
      if (!checkedContext) return { status: 'error', error: '工具上下文参数无效', trace }
      const sender = event.sender
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
          const instruction =
            instructionResult.status === 'read' ? instructionResult.instruction : null
          workspaceInstruction = instruction?.content ?? null
        }
        if (!workspace) {
          const instruction = await readProjectInstruction(execution.info.cwd)
          controller.signal.throwIfAborted()
          if (instruction.status === 'error')
            return { status: 'error', error: instruction.error, trace }
          workspaceInstruction =
            instruction.status === 'read' ? instruction.instruction.content : null
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
          const agentRequest = buildAgentRequest({
            snapshot: projectSnapshot,
            workspaceInstruction,
            workspaceId,
            execution: execution.info
          })
          const assertWorkspaceAccess = (): boolean => {
            return (
              !controller.signal.aborted &&
              executionStillCurrent(windowId, checkedContext, execution)
            )
          }
          const approveWorkspaceAction = async (
            request: WorkspaceApprovalRequest,
            signal: AbortSignal
          ): Promise<boolean> => {
            signal.throwIfAborted()
            if (!assertWorkspaceAccess()) return false
            const target = request.kind === 'command' ? request.cwd : request.path
            if (!target) return false
            const decision = localPermission(
              execution,
              request.kind === 'command' ? 'command' : 'write',
              target
            )
            if (decision === 'allow') return true
            if (decision === 'deny') return false
            const common = {
              requestId: id,
              conversationId: checkedContext.conversationId,
              cwd: request.cwd
            }
            const approval: ExecutionApprovalInput =
              request.kind === 'create'
                ? { ...common, kind: 'create', path: request.path, content: request.after }
                : request.kind === 'edit'
                  ? {
                      ...common,
                      kind: 'edit',
                      path: request.path,
                      before: request.before,
                      after: request.after
                    }
                  : { ...common, kind: 'command', program: request.program, args: request.args }
            clearTimeout(timer)
            updateTask(windowId, lifecycleId, 'waiting_approval')
            try {
              const answer = await requestExecutionApproval(windowId, approval, signal)
              signal.throwIfAborted()
              const approved = answer && assertWorkspaceAccess()
              if (approved) {
                workspaceActionApproved = true
                const message = `工作区操作已批准：${request.kind}`
                appendTrace(message)
                if (!sender.isDestroyed()) sender.send('agent:progress', { requestId: id, message })
              }
              return approved
            } finally {
              if (!controller.signal.aborted) {
                updateTask(windowId, lifecycleId, 'running')
                timer = armTimeout()
              }
            }
          }
          const readWorkspace = createWorkspaceReadExecutor(
            execution.info.cwd,
            assertWorkspaceAccess,
            {
              isPathAllowed: () => assertWorkspaceAccess()
            }
          )
          const actInWorkspace = createWorkspaceActionExecutor(
            execution.info.cwd,
            assertWorkspaceAccess,
            approveWorkspaceAction,
            {
              isPathAllowed: () => assertWorkspaceAccess(),
              onEffect: () => {
                workspaceActionApproved = true
                const message = '本地操作已开始：文件或命令'
                appendTrace(message)
                if (!sender.isDestroyed()) sender.send('agent:progress', { requestId: id, message })
              }
            }
          )
          const completeReads = new Map<string, string>()
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
            async (name: string, args: string, signal: AbortSignal): Promise<string> => {
              signal.throwIfAborted()
              if (name === 'get_current_time') return executeTimeTool(name, args)
              if (readWorkspace && workspaceReadTools.some((tool) => tool.name === name)) {
                const output = await readWorkspace(name, args, signal)
                if (name === 'read_workspace_file') {
                  try {
                    const request = JSON.parse(args) as { path?: unknown; startLine?: unknown }
                    const read = JSON.parse(output) as {
                      ok?: unknown
                      path?: unknown
                      sha256?: unknown
                      totalLines?: unknown
                      truncated?: unknown
                      lines?: Array<{ line?: unknown; truncated?: unknown }>
                    }
                    if (
                      read.ok === true &&
                      request.startLine === 1 &&
                      typeof read.path === 'string' &&
                      typeof read.sha256 === 'string' &&
                      typeof read.totalLines === 'number' &&
                      read.truncated === false &&
                      Array.isArray(read.lines) &&
                      read.lines.length === read.totalLines &&
                      read.lines.every((line, index) => line.line === index + 1 && !line.truncated)
                    ) {
                      completeReads.set(read.path, read.sha256)
                    }
                  } catch {
                    // The executor reports malformed requests; they do not count as a full read.
                  }
                }
                return output
              }
              if (actInWorkspace && workspaceActionTools.some((tool) => tool.name === name)) {
                let output: string
                if (name === 'edit_workspace_file') {
                  try {
                    const edit = JSON.parse(args) as { path?: unknown; expectedSha256?: unknown }
                    output =
                      typeof edit.path === 'string' &&
                      completeReads.get(await canonicalLocalPath(execution.info.cwd, edit.path)) ===
                        edit.expectedSha256
                        ? await actInWorkspace(name, args, signal)
                        : JSON.stringify({ status: 'error', error: '请先完整读取目标文件' })
                  } catch {
                    output = JSON.stringify({ status: 'error', error: '编辑参数无效' })
                  }
                } else {
                  output = await actInWorkspace(name, args, signal)
                }
                const parsed: unknown = JSON.parse(output)
                const status =
                  parsed && typeof parsed === 'object' && 'status' in parsed
                    ? (parsed as { status: unknown }).status
                    : null
                if (typeof status === 'string' && /^[a-z_]+$/.test(status)) {
                  const message = `工作区结果：${name}：${status}`
                  appendTrace(message)
                  if (!sender.isDestroyed())
                    sender.send('agent:progress', { requestId: id, message })
                }
                return output
              }
              if (name === 'propose_command' && projectSnapshot) {
                return executeCommandProposal(name, args, signal)
              }
              if (projectExecutor) return projectExecutor(name, args, signal)
              throw new AgentError('工具不在当前授权范围内')
            },
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
          if (timedOut) {
            const message = ['任务超过 4 分钟，已停止', actionWarning].filter(Boolean).join('。')
            updateTask(windowId, lifecycleId, 'timed_out', { error: message })
            return { status: 'error', error: message, trace }
          }
          if (controller.signal.aborted) {
            updateTask(windowId, lifecycleId, 'cancelled', {
              error: actionWarning ? `用户已取消任务。${actionWarning}` : '用户已取消任务'
            })
            return { status: 'cancelled', trace }
          }
          const message = [
            error instanceof AgentError
              ? error.message
              : '请求或工具处理失败，请检查网络和响应格式',
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
