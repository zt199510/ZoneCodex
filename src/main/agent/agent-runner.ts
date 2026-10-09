import { performance } from 'node:perf_hooks'
import type { WebContents } from 'electron'
import type { AgentMessageEvent, AgentResult, ToolCallEvent } from '../../shared/agent'
import { parseAgentMode } from '../../shared/agent'
import { parseAgentUserInputResult } from '../../shared/agent-user-input'
import { parseIncompleteToolTurn, parseToolHistory } from '../../shared/agent-history'
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
import { runToolLoop } from './tool-loop'
import { createLiveResponse } from '../model/response-client'
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
  const trace: string[] = []
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
    let timedOut = false
    let workspaceActionApproved = false
    let timeoutBudgetMs = 240_000
    let timeoutArmedAt = performance.now()
    const armTimeout = (budgetMs = 240_000): NodeJS.Timeout => {
      timeoutBudgetMs = budgetMs
      timeoutArmedAt = performance.now()
      return setTimeout(() => {
        if (controller.signal.aborted) return
        timedOut = true
        cancel()
      }, budgetMs)
    }
    let timer = armTimeout()
    try {
      appendTrace(`工作方式：${mode === 'plan' ? '计划' : '执行'}；真实模型 SSE`)
      const assertWorkspaceAccess = (): boolean => {
        for (const captured of capturedImages) captured.assertCurrent()
        for (const image of historyImages) image.captured.assertCurrent()
        return (
          jobs.get(windowId) === job &&
          !controller.signal.aborted &&
          executionStillCurrent(windowId, checkedContext, execution)
        )
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
        mode,
        execution,
        assertCurrent: assertWorkspaceAccess,
        approve: approveWorkspaceAction,
        authorizeCommand: authorizeWorkspaceCommand,
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
          // Only the model's active work consumes the four-minute budget.
          // Unlike a fresh request, a resumed question keeps its remaining time.
          const remainingMs = Math.max(0, timeoutBudgetMs - (performance.now() - timeoutArmedAt))
          clearTimeout(timer)
          const message = '等待用户补充计划信息'
          appendTrace(message)
          if (!sender.isDestroyed()) sender.send('agent:progress', { requestId: id, message })
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
            appendTrace(resumed)
            if (!sender.isDestroyed())
              sender.send('agent:progress', { requestId: id, message: resumed })
            return JSON.stringify(result)
          } finally {
            if (!controller.signal.aborted) {
              if (updateTask(windowId, lifecycleId, 'running')) timer = armTimeout(remainingMs)
              else controller.abort()
            }
          }
        },
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
      const commentaryPositions = new Map<string, number>()
      const publicMessages = new Map<string, { phase: AgentMessageEvent['phase']; text: string }>()
      const observeMessage = (event: Omit<AgentMessageEvent, 'requestId'>): void => {
        if (controller.signal.aborted || sender.isDestroyed()) return
        const previous = publicMessages.get(event.messageId)
        if (previous?.phase === event.phase && previous.text === event.text) return
        if (previous && previous.phase !== event.phase) throw new AgentError('公开消息阶段不一致')
        if (event.phase === 'final_answer') {
          const finalTexts = [...publicMessages]
            .filter(
              ([messageId, message]) =>
                messageId !== event.messageId && message.phase === 'final_answer'
            )
            .map(([, message]) => message.text)
          finalTexts.push(event.text)
          if (finalTexts.join('\n').length > 16000)
            throw new AgentError('最终回答超过本轮显示长度上限')
        }
        if (event.phase === 'commentary') {
          const candidate: ProtocolItem[] =
            observedItems.length > 0
              ? [...observedItems]
              : [{ role: 'user', content: prompt.trim() }]
          const position = commentaryPositions.get(event.messageId)
          if (position === undefined) {
            let pendingCall = false
            for (const item of candidate) {
              if (item.type === 'function_call') pendingCall = true
              else if (item.type === 'function_call_output') pendingCall = false
            }
            // A late stream callback cannot insert a new message between an
            // actual invocation and its still-missing result.
            if (pendingCall) return
          }
          const message: ProtocolItem = {
            type: 'message',
            role: 'assistant',
            phase: 'commentary',
            content: [{ type: 'output_text', text: event.text }]
          }
          if (position === undefined) candidate.push(message)
          else candidate[position] = message
          const checked = parseIncompleteToolTurn(candidate, checkedScope, prompt.trim(), mode)
          if (!checked) throw new AgentError('公开过程文字超过本轮保存上限')
          observedItems = checked
          if (position === undefined) commentaryPositions.set(event.messageId, candidate.length - 1)
        }
        publicMessages.set(event.messageId, { phase: event.phase, text: event.text })
        sender.send('agent:message-event', { requestId: id, ...event })
      }
      const observeToolCall = (event: ToolCallEvent): void => {
        const candidate: ProtocolItem[] =
          observedItems.length > 0 ? [...observedItems] : [{ role: 'user', content: prompt.trim() }]
        if (event.phase === 'start') {
          if (event.commentary) {
            candidate.push({
              type: 'message',
              role: 'assistant',
              phase: 'commentary',
              content: [{ type: 'output_text', text: event.commentary }]
            })
          }
          candidate.push({
            type: 'function_call',
            call_id: event.callId,
            name: event.name,
            arguments: event.arguments
          })
        } else {
          candidate.push({
            type: 'function_call_output',
            call_id: event.callId,
            output: event.output
          })
        }
        const checked = parseIncompleteToolTurn(candidate, checkedScope, prompt.trim(), mode)
        if (checked) observedItems = checked
        else if (event.phase === 'start') {
          throw new AgentError('调用记录已超过本轮保存上限，未继续执行工具')
        } else {
          // A valid tool result can push a failing turn over its save budget.
          // Keep prior evidence and the pending call rather than inventing an output.
          appendTrace('工具结果超过本轮保存上限：最后结果未保存')
        }
        if (!sender.isDestroyed()) sender.send('agent:tool-event', { requestId: id, ...event })
      }
      const liveResponse = createLiveResponse(agentRequest.tools, agentRequest.instructions)
      const completed = await runToolLoop(
        prompt.trim(),
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
          : liveResponse,
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
        },
        observeToolCall,
        observeMessage,
        mode
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
        return { status: 'error', error: message, trace, items: observedItems }
      }
      if (controller.signal.aborted) {
        updateTask(windowId, lifecycleId, 'cancelled', {
          error: ['用户已取消任务', terminationWarning, actionWarning].filter(Boolean).join('。')
        })
        return { status: 'cancelled', trace, items: observedItems }
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
      return { status: 'error', error: message, trace, items: observedItems }
    } finally {
      clearTimeout(timer)
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
    appendTrace(`用时：${Math.max(0, Math.round(performance.now() - startedAt))}毫秒`)
  }
}
