import { performance } from 'node:perf_hooks'
import type { WebContents } from 'electron'
import type { AgentResult } from '../../shared/agent'
import { parseAgentMode, parseAgentContextEvent } from '../../shared/agent'
import { parseAgentUserInputResult } from '../../shared/agent-user-input'
import { parseToolHistory } from '../../shared/agent-history'
import type { ProtocolItem } from '../../shared/agent-history'
import {
  toolScopeForAgentRequest,
  type AgentRequestContext,
  type ToolScope
} from '../../shared/project'
import { sameExecutionInfo } from '../../shared/execution'
import {
  getImageTurnNoticeCount,
  stripImageTurnNotice,
  maxRequestImageBytes,
  maxRequestImages
} from '../../shared/image-input'
import { isTaskId } from '../../shared/task'
import { AgentError } from '../errors'
import { runAgentCore } from './agent-core'
import type { AgentCoreEvent } from './agent-core-contract'
import { withConversationImageInput, type CapturedImageInput } from '../model/image-input'
import {
  captureImageAccess,
  captureSavedImageAccess,
  bindImageMessageGroup,
  verifyImageRequestGroup,
  verifyImageMessageGroup,
  hasImageSelection,
  type CapturedImage
} from '../project/image-access'
import { createAgentRuntime, createAgentRuntimeTools } from './agent-runtime'
import { captureProjectAccess, hasProjectSelection } from '../project/attachment-access'
import { captureWorkspaceAccess, hasWorkspaceSelection } from '../project/workspace-access'
import { readProjectInstruction } from '../project/project-instruction'
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
import { requestAgentUserInput } from './agent-user-input'
import { desktopCheckpointStore } from './desktop-checkpoints'
import { captureTaskDirectoryBinding, createTaskCheckpoint } from '../storage/task-checkpoint-store'
import { TaskCheckpointError, type TaskCheckpoint } from '../../shared/task-checkpoint'
import { agentResumeSafetyNotice } from '../../shared/agent-resume'

type Job = { id: string; controller: AbortController; snapshotId?: string; imageIds: Set<string> }
const jobs = new Map<number, Job>()

export function hasAgentJob(windowId: number): boolean {
  return jobs.has(windowId)
}

export function abortProjectJob(windowId: number, snapshotId: string): void {
  const job = jobs.get(windowId)
  if (job?.snapshotId === snapshotId) job.controller.abort()
}

export function abortImageJob(windowId: number, imageId: string): void {
  const job = jobs.get(windowId)
  if (job?.imageIds.has(imageId)) job.controller.abort()
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
    hasImageSelection(windowId) ||
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
  isPreparationActive: (windowId: number) => boolean,
  checkpointTaskId?: string
): Promise<AgentResult> {
  const startedAt = performance.now()
  let trace: string[] = []
  let coreHandledTiming = false
  // Capture once after IPC validation; later UI changes cannot alter this turn.
  const mode = parseAgentMode(checkedContext.mode)
  if (!mode) return { status: 'error', error: '工作方式参数无效', trace }
  let observedItems: ProtocolItem[] = []
  const appendTrace = (message: string): void => {
    trace.push(message.slice(0, 500))
    if (trace.length > 30) trace.shift()
  }
  if (
    jobs.has(windowId) ||
    hasExecutionApproval(windowId) ||
    hasProjectSelection(windowId) ||
    hasImageSelection(windowId) ||
    hasWorkspaceSelection(windowId) ||
    isPreparationActive(windowId)
  ) {
    appendTrace(`用时：${Math.max(0, Math.round(performance.now() - startedAt))}毫秒`)
    return { status: 'error', error: '请先完成当前操作', trace }
  }
  const controller = new AbortController()
  const imageReferences = checkedContext.images ?? []
  const capturedImages: CapturedImage[] = []
  const historyImages: CapturedImageInput[] = []
  const job: Job = {
    id,
    controller,
    snapshotId: checkedContext.attachment?.snapshotId,
    imageIds: new Set([
      ...imageReferences.map((image) => image.imageId),
      ...(checkedContext.imageHistory ?? []).map((image) => image.imageId)
    ])
  }
  const cancel = (): void => controller.abort()
  jobs.set(windowId, job)
  sender.once('did-start-loading', cancel)
  sender.once('render-process-gone', cancel)
  sender.once('destroyed', cancel)
  try {
    if (
      getImageTurnNoticeCount(prompt) !== (imageReferences.length || null) ||
      imageReferences.length + (checkedContext.imageHistory?.length ?? 0) > maxRequestImages ||
      !stripImageTurnNotice(prompt)
    )
      return { status: 'error', error: '图片与本轮问题不一致，请重新添加后发送', trace }
    if (
      imageReferences.length &&
      !verifyImageRequestGroup(
        windowId,
        checkedContext.conversationId,
        imageReferences.map((image) => image.imageId)
      )
    )
      return { status: 'error', error: '原图片组与本轮请求不一致，请重新添加后发送', trace }
    for (const reference of imageReferences) {
      const captured = captureImageAccess(
        windowId,
        checkedContext.conversationId,
        reference.imageId
      )
      if (!captured)
        return { status: 'error', error: '原图片组未全部确认或已失效，请重新添加后发送', trace }
      capturedImages.push(captured)
    }
    if (imageReferences.length && imageReferences[0].messageId) {
      if (
        !bindImageMessageGroup(
          windowId,
          checkedContext.conversationId,
          imageReferences.map((image) => image.imageId),
          imageReferences[0].messageId
        )
      )
        return { status: 'error', error: '图片组与用户消息不一致，请重新发送', trace }
    }
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
    // Both hosts load through the same schema/raw/directory validator before
    // constructing a transport. Current captured scope describes fresh grants.
    const resumed = checkpointTaskId
      ? await desktopCheckpointStore().load(checkpointTaskId, {
          cwd: execution.info.cwd,
          workspace: workspace?.root ?? null,
          mode,
          scope: checkedScope
        })
      : null
    if (resumed && resumed.checkpoint.conversationId !== checkedContext.conversationId)
      return { status: 'error', error: '任务续接记录不属于当前会话', trace }
    if (resumed) prompt = resumed.checkpoint.prompt
    const checkedHistory = resumed
      ? resumed.history
      : parseToolHistory(history, checkedScope, checkedContext.imageHistory, mode)
    const executeCommandProposal = createCommandProposalExecutor()
    if (!checkedHistory) return { status: 'error', error: '工具历史参数无效', trace }
    let imageBytes = capturedImages.reduce((total, captured) => total + captured.image.bytes, 0)
    const historicalGroups = new Map<number, { messageId: string; imageIds: string[] }>()
    for (const reference of checkedContext.imageHistory ?? []) {
      const group = historicalGroups.get(reference.index)
      if (group) group.imageIds.push(reference.imageId)
      else
        historicalGroups.set(reference.index, {
          messageId: reference.messageId,
          imageIds: [reference.imageId]
        })
    }
    for (const group of historicalGroups.values()) {
      if (
        !(await verifyImageMessageGroup(
          windowId,
          checkedContext.conversationId,
          group.imageIds,
          group.messageId
        ))
      )
        return { status: 'error', error: '历史图片组与原消息不一致，请重新添加后发送', trace }
    }
    for (const reference of checkedContext.imageHistory ?? []) {
      const captured = await captureSavedImageAccess(
        windowId,
        checkedContext.conversationId,
        reference.imageId,
        reference.messageId
      )
      if (!captured)
        return { status: 'error', error: '历史图片不可用，请重新添加图片后发送', trace }
      historyImages.push({
        index: reference.index,
        prompt: checkedHistory[reference.index].content as string,
        captured
      })
      controller.signal.throwIfAborted()
      imageBytes += captured.image.bytes
      if (imageBytes > maxRequestImageBytes)
        return {
          status: 'error',
          error: '本次图片上下文超过20 MiB，请新建会话后添加所需图片',
          trace
        }
    }
    if (
      jobs.get(windowId) !== job ||
      isPreparationActive(windowId) ||
      hasProjectSelection(windowId) ||
      hasImageSelection(windowId) ||
      hasWorkspaceSelection(windowId)
    ) {
      return { status: 'error', error: '运行上下文已变化，请重新发送', trace }
    }
    controller.signal.throwIfAborted()
    const lifecycleId = isTaskId(taskId) ? taskId : newTaskId()
    const checkpointId = resumed?.checkpoint.taskId ?? lifecycleId
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
    try {
      const canCheckpoint = !capturedImages.length && !historyImages.length
      const bindings = canCheckpoint
        ? {
            cwd: await captureTaskDirectoryBinding(execution.info.cwd),
            workspace: workspace ? await captureTaskDirectoryBinding(workspace.root) : null
          }
        : null
      let savedRaw: ProtocolItem[] | null = null
      let savedComplete = false
      let savedSummary: TaskCheckpoint['summary']
      const checkpointCreatedAt = resumed?.checkpoint.createdAt ?? new Date().toISOString()
      const saveCheckpoint = async (
        raw: ProtocolItem[],
        progress: TaskCheckpoint['progress'] = 'resumable',
        reason: TaskCheckpoint['reason'] = 'saved',
        summary?: TaskCheckpoint['summary']
      ): Promise<void> => {
        if (!bindings) return
        const checkpoint = createTaskCheckpoint({
          taskId: checkpointId,
          conversationId: checkedContext.conversationId,
          createdAt: checkpointCreatedAt,
          mode,
          prompt: resumed?.checkpoint.prompt ?? prompt,
          scope: checkedScope,
          bindings,
          history: raw,
          ...(summary ? { summary } : {}),
          progress,
          reason
        })
        const saved = await desktopCheckpointStore().save(checkpoint, raw)
        if (!saved.ok) throw new AgentError(`${saved.code}: ${saved.error}`)
        savedRaw = structuredClone(raw)
        savedSummary = summary
      }
      const sourceFrame = sender.mainFrame
      const assertWorkspaceAccess = (): boolean => {
        for (const captured of capturedImages) captured.assertCurrent()
        for (const image of historyImages) image.captured.assertCurrent()
        return (
          jobs.get(windowId) === job &&
          !controller.signal.aborted &&
          !sender.isDestroyed() &&
          sender.mainFrame === sourceFrame &&
          executionStillCurrent(windowId, checkedContext, execution)
        )
      }
      const deliver = (event: AgentCoreEvent): void => {
        if (
          jobs.get(windowId) !== job ||
          controller.signal.aborted ||
          sender.isDestroyed() ||
          sender.mainFrame !== sourceFrame
        )
          return
        switch (event.type) {
          case 'resume':
            sender.send('agent:progress', {
              requestId: event.requestId,
              message: `已校验原记录，正在显式继续任务；操作使用当前权限。${agentResumeSafetyNotice}`
            })
            break
          case 'progress':
            sender.send('agent:progress', { requestId: event.requestId, message: event.message })
            break
          case 'delta':
            sender.send('model-stream:delta', { requestId: event.requestId, delta: event.delta })
            break
          case 'tool':
            sender.send('agent:tool-event', event.event)
            break
          case 'message':
            sender.send('agent:message-event', event.event)
            break
          case 'retry':
            sender.send('agent:retry', event.event)
            break
          case 'context': {
            const checked = parseAgentContextEvent(event.event)
            if (!checked) throw new AgentError('上下文状态格式不正确')
            sender.send('agent:context', checked)
            break
          }
        }
      }
      const commandBackend = mode === 'execute' ? await inspectWindowsCommandBackend() : null
      controller.signal.throwIfAborted()
      if (!assertWorkspaceAccess()) throw new AgentError('运行上下文已失效，请重新发送')
      const runtime = createAgentRuntime({
        capabilities: {
          mode,
          snapshot: projectSnapshot,
          workspaceInstruction,
          workspaceId,
          execution: execution.info,
          commandSandboxAvailable: commandBackend !== null,
          imagePresent: capturedImages.length > 0 || historyImages.length > 0,
          resuming: Boolean(resumed)
        },
        imageCount: capturedImages.length + historyImages.length,
        imageBytes
      })
      const send =
        capturedImages.length || historyImages.length
          ? withConversationImageInput(
              runtime.send,
              [
                ...historyImages,
                ...capturedImages.map((captured) => ({
                  index: checkedHistory.length,
                  prompt: prompt.trim(),
                  captured
                }))
              ],
              checkedHistory.length,
              prompt.trim(),
              assertWorkspaceAccess
            )
          : runtime.send
      const outcome = await runAgentCore(
        {
          requestId: id,
          conversationId: checkedContext.conversationId,
          prompt,
          history: checkedHistory,
          scope: checkedScope,
          mode,
          imageHistory: checkedContext.imageHistory,
          ...(resumed
            ? {
                resume: resumed.resume,
                ...(resumed.summary ? { contextSummary: resumed.summary } : {})
              }
            : {})
        },
        {
          signal: controller.signal,
          ...runtime,
          send,
          assertCurrent: assertWorkspaceAccess,
          onEvent: deliver,
          onRawCheckpoint: canCheckpoint
            ? async (raw, summary, completed) => {
                await saveCheckpoint(
                  raw,
                  completed ? 'completed' : 'resumable',
                  completed ? 'completed' : 'saved',
                  summary
                )
                savedComplete = Boolean(completed)
              }
            : undefined,
          startedAt,
          transportLabel: '真实模型 SSE',
          createTools: (observer) => {
            const authorizationOptions: Parameters<typeof createWorkspaceAuthorization>[0] = {
              windowId,
              requestId: id,
              conversationId: checkedContext.conversationId,
              userRequest: stripImageTurnNotice(prompt),
              execution,
              assertCurrent: assertWorkspaceAccess,
              beginApproval: () => {
                if (!updateTask(windowId, lifecycleId, 'waiting_approval')) {
                  controller.abort()
                  return false
                }
                return true
              },
              onApproved: (request) => observer.actionApproved(request.kind),
              finishApproval: () => {
                if (!controller.signal.aborted) {
                  if (!updateTask(windowId, lifecycleId, 'running')) controller.abort()
                }
              }
            }
            return createAgentRuntimeTools(
              {
                conversationId: checkedContext.conversationId,
                mode,
                execution,
                assertCurrent: assertWorkspaceAccess,
                approve: createWorkspaceAuthorization(authorizationOptions),
                authorizeCommand: createWorkspaceCommandAuthorization(authorizationOptions),
                projectSnapshot,
                executeCommandProposal,
                requestUserInput: async (input, signal, callId) => {
                  signal.throwIfAborted()
                  if (mode !== 'plan' || !assertWorkspaceAccess())
                    throw new AgentError('当前请求不允许提问或上下文已失效')
                  if (!updateTask(windowId, lifecycleId, 'waiting_input')) {
                    controller.abort()
                    signal.throwIfAborted()
                  }
                  const message = '等待用户补充计划信息'
                  observer.appendTrace(message)
                  observer.progress(message)
                  try {
                    const answers = await requestAgentUserInput(
                      windowId,
                      {
                        requestId: id,
                        conversationId: checkedContext.conversationId,
                        callId,
                        questions: input.questions
                      },
                      signal,
                      assertWorkspaceAccess
                    )
                    signal.throwIfAborted()
                    if (!answers || !assertWorkspaceAccess())
                      throw new AgentError('提问或运行上下文已失效，请重新发送')
                    const result = parseAgentUserInputResult({ answers }, input.questions)
                    if (!result) throw new AgentError('用户回答与计划问题不一致')
                    const resumed = '用户已补充，继续制定方案'
                    observer.appendTrace(resumed)
                    observer.progress(resumed)
                    return JSON.stringify(result)
                  } finally {
                    if (!controller.signal.aborted) {
                      if (!updateTask(windowId, lifecycleId, 'running')) controller.abort()
                    }
                  }
                }
              },
              observer
            )
          }
        }
      )
      trace = outcome.result.trace
      coreHandledTiming = true
      observedItems = outcome.result.items ?? []
      if (savedRaw && !savedComplete) {
        try {
          await saveCheckpoint(
            savedRaw,
            outcome.result.status === 'done' ? 'completed' : 'interrupted',
            outcome.result.status === 'done'
              ? 'completed'
              : outcome.result.status === 'cancelled'
                ? 'user_cancelled'
                : /容量|预算|上限/.test(outcome.result.error)
                  ? 'budget_stop'
                  : 'failure',
            savedSummary
          )
        } catch (cause) {
          const failure =
            cause instanceof TaskCheckpointError
              ? `${cause.code}: ${cause.message}`
              : cause instanceof Error
                ? cause.message
                : 'STORAGE: 任务续接记录保存失败'
          const warning = outcome.effects.started
            ? '本地操作可能已经执行，请先核对当前文件或命令结果。'
            : ''
          const message = `${failure}${warning ? ` ${warning}` : ''}`
          appendTrace(`任务续接记录保存失败${warning ? `：${warning}` : ''}`)
          updateTask(windowId, lifecycleId, 'failed', { error: message })
          return { status: 'error', error: message, trace, items: observedItems }
        }
      }
      updateTask(windowId, lifecycleId, outcome.task.state, {
        ...(outcome.task.result !== undefined ? { result: outcome.task.result } : {}),
        ...(outcome.task.error !== undefined ? { error: outcome.task.error } : {})
      })
      return outcome.result
    } catch (error) {
      // Preparation after task registration has no tool effects; execution
      // failures and their truthful evidence are owned by the core above.
      const cancelled = controller.signal.aborted
      const message =
        error instanceof TaskCheckpointError
          ? `${error.code}: ${error.message}`
          : error instanceof Error
            ? error.message
            : '无法准备运行上下文'
      updateTask(windowId, lifecycleId, cancelled ? 'cancelled' : 'failed', {
        error: cancelled ? '用户已取消任务' : message
      })
      return cancelled
        ? { status: 'cancelled', trace, items: observedItems }
        : { status: 'error', error: message, trace, items: observedItems }
    }
  } catch (error) {
    return controller.signal.aborted
      ? { status: 'cancelled', trace, items: observedItems }
      : {
          status: 'error',
          error:
            error instanceof TaskCheckpointError
              ? `${error.code}: ${error.message}`
              : error instanceof Error
                ? error.message
                : '无法准备运行上下文',
          trace,
          items: observedItems
        }
  } finally {
    controller.abort()
    for (const captured of capturedImages) captured.finish()
    for (const image of historyImages) image.captured.finish()
    if (jobs.get(windowId) === job) jobs.delete(windowId)
    sender.removeListener('did-start-loading', cancel)
    sender.removeListener('render-process-gone', cancel)
    sender.removeListener('destroyed', cancel)
    if (!coreHandledTiming)
      appendTrace(`用时：${Math.max(0, Math.round(performance.now() - startedAt))}毫秒`)
  }
}
