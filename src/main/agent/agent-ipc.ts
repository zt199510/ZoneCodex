import { BrowserWindow, dialog, ipcMain } from 'electron'
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
      const armTimeout = (): NodeJS.Timeout =>
        setTimeout(() => {
          if (controller.signal.aborted) return
          timedOut = true
          cancel()
        }, 90_000)
      let timer = armTimeout()
      sender.once('did-start-loading', cancel)
      sender.once('render-process-gone', cancel)
      sender.once('destroyed', cancel)
      try {
        trace.push('模式：真实模型 SSE')
        const agentRequest = buildAgentRequest({
          snapshot: projectSnapshot,
          workspaceInstruction,
          workspaceId
        })
        const assertWorkspaceAccess = (): boolean => {
          if (!workspace || controller.signal.aborted) return false
          const current = captureWorkspaceAccess(windowId, checkedContext.conversationId)
          return current?.workspaceId === workspace.workspaceId && current.root === workspace.root
        }
        const approveWorkspaceAction = async (
          request: WorkspaceApprovalRequest,
          signal: AbortSignal
        ): Promise<boolean> => {
          signal.throwIfAborted()
          if (!assertWorkspaceAccess()) return false
          const owner = BrowserWindow.fromWebContents(sender)
          if (!owner || owner.isDestroyed()) return false
          const detail =
            request.kind === 'edit'
              ? `工作区：${request.cwd}\n文件：${request.path}\n\n当前内容：\n${request.before}\n\n修改后内容：\n${request.after}`
              : `工作目录：${request.cwd}\n程序：${request.program}\n参数：${JSON.stringify(request.args)}\n\n当前版本没有命令沙箱；此程序可能访问工作区以外的文件、网络或启动子进程。`
          clearTimeout(timer)
          updateTask(windowId, lifecycleId, 'waiting_approval')
          try {
            const answer = await dialog.showMessageBox(owner, {
              type: 'question',
              title: request.kind === 'edit' ? '确认修改工作区文件' : '确认运行工作区命令',
              message:
                request.kind === 'edit'
                  ? '请核对完整原文和修改后内容'
                  : '请核对程序、参数和工作目录',
              detail,
              buttons: ['拒绝', '允许本次'],
              defaultId: 0,
              cancelId: 0,
              noLink: true
            })
            signal.throwIfAborted()
            return answer.response === 1 && assertWorkspaceAccess()
          } finally {
            if (!controller.signal.aborted) {
              updateTask(windowId, lifecycleId, 'running')
              timer = armTimeout()
            }
          }
        }
        const readWorkspace = workspace
          ? createWorkspaceReadExecutor(workspace.root, assertWorkspaceAccess)
          : null
        const actInWorkspace = workspace
          ? createWorkspaceActionExecutor(
              workspace.root,
              assertWorkspaceAccess,
              approveWorkspaceAction
            )
          : null
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
                    request.path === read.path &&
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
                    completeReads.get(edit.path) === edit.expectedSha256
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
                trace.push(message)
                if (!sender.isDestroyed()) sender.send('agent:progress', { requestId: id, message })
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
