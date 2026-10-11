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
import { createLiveResponse, readModelConfiguration } from '../model/response-client'
import { createContextSummaryResponse } from '../model/context-summary'
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
import { buildAgentRequest } from './agent-instructions'
import { createAgentToolExecutor } from './agent-tools'
import { captureProjectAccess, hasProjectSelection } from '../project/attachment-access'
import { captureWorkspaceAccess, hasWorkspaceSelection } from '../project/workspace-access'
import { readProjectInstruction } from '../project/project-instruction'
import { createChangeProposalExecutor } from '../tools/change-proposal'
import { createProjectExecutor } from '../tools/project-file-tools'
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
  isPreparationActive: (windowId: number) => boolean
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
    const projectExecutor = projectSnapshot
      ? mode === 'plan'
        ? createProjectExecutor(projectSnapshot)
        : createChangeProposalExecutor(projectSnapshot, checkedContext.conversationId)
      : undefined
    const checkedHistory = parseToolHistory(
      history,
      checkedScope,
      checkedContext.imageHistory,
      mode
    )
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
      const agentRequest = buildAgentRequest({
        mode,
        snapshot: projectSnapshot,
        workspaceInstruction,
        workspaceId,
        execution: execution.info,
        commandSandboxAvailable: commandBackend !== null,
        imagePresent: capturedImages.length > 0 || historyImages.length > 0
      })
      const configuration = readModelConfiguration()
      const liveResponse = createLiveResponse(
        agentRequest.tools,
        agentRequest.instructions,
        configuration
      )
      const send =
        capturedImages.length || historyImages.length
          ? withConversationImageInput(
              liveResponse,
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
          : liveResponse
      const outcome = await runAgentCore(
        {
          requestId: id,
          conversationId: checkedContext.conversationId,
          prompt,
          history: checkedHistory,
          scope: checkedScope,
          mode,
          imageHistory: checkedContext.imageHistory
        },
        {
          signal: controller.signal,
          send,
          summarize: createContextSummaryResponse(configuration),
          networkOverhead: {
            instructionsCharacters: agentRequest.instructions.length,
            toolSchemaCharacters: JSON.stringify(agentRequest.tools).length,
            imageCount: capturedImages.length + historyImages.length,
            imageBytes
          },
          assertCurrent: assertWorkspaceAccess,
          onEvent: deliver,
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
            return createAgentToolExecutor({
              mode,
              execution,
              assertCurrent: assertWorkspaceAccess,
              approve: createWorkspaceAuthorization(authorizationOptions),
              authorizeCommand: createWorkspaceCommandAuthorization(authorizationOptions),
              projectSnapshot,
              projectExecutor,
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
              },
              appendTrace: observer.appendTrace,
              onProgress: observer.progress,
              onEffect: observer.effectStarted
            })
          }
        }
      )
      trace = outcome.result.trace
      coreHandledTiming = true
      observedItems = outcome.result.items ?? []
      updateTask(windowId, lifecycleId, outcome.task.state, {
        ...(outcome.task.result !== undefined ? { result: outcome.task.result } : {}),
        ...(outcome.task.error !== undefined ? { error: outcome.task.error } : {})
      })
      return outcome.result
    } catch (error) {
      // Preparation after task registration has no tool effects; execution
      // failures and their truthful evidence are owned by the core above.
      const cancelled = controller.signal.aborted
      const message = error instanceof Error ? error.message : '无法准备运行上下文'
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
          error: error instanceof Error ? error.message : '无法准备运行上下文',
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
