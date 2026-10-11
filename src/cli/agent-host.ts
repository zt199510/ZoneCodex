import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { parseAgentMode, parseAgentToolEvent } from '../shared/agent'
import type { ProtocolItem } from '../shared/agent-history'
import { parsePermissionMode } from '../shared/execution'
import { parseAgentUserInputRequest, parseAgentUserInputResult } from '../shared/agent-user-input'
import { runAgentCore } from '../main/agent/agent-core'
import { buildAgentRequest } from '../main/agent/agent-instructions'
import { createAgentToolExecutor } from '../main/agent/agent-tools'
import { readProjectInstruction } from '../main/project/project-instruction'
import { createLiveResponse, readModelConfiguration } from '../main/model/response-client'
import { createApprovalReviewer } from '../main/execution/approval-reviewer'
import type { ExecutionContext } from '../main/execution/execution-context-policy'
import {
  createHostWorkspaceAuthorization,
  createHostWorkspaceCommandAuthorization,
  type HostWorkspaceAuthorizationOptions
} from '../main/execution/workspace-authorization'
import { inspectWindowsCommandBackend } from '../main/execution/windows-command-backend'
import {
  CLIInputError,
  InteractionUnavailableError,
  type AgentHostInput,
  type AgentHostOptions,
  type AgentHostResult
} from './host-contract'

export { CLIInputError, InteractionUnavailableError } from './host-contract'
export type { AgentHostInput, AgentHostOptions, AgentHostResult } from './host-contract'
export type { AgentCoreEvent } from '../main/agent/agent-core-contract'
export type { AgentUserInputRequest, AgentUserInputAnswer } from '../shared/agent-user-input'
export type { ExecutionApprovalInput } from '../shared/execution'

function digest(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function directory(path: string): { selected: string; canonical: string; identity: string } {
  if (
    typeof path !== 'string' ||
    !path ||
    path.length > 4096 ||
    Array.from(path).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    )
  )
    throw new CLIInputError('工作目录或工作区参数无效')
  try {
    const selected = resolve(path)
    const canonical = realpathSync(selected)
    const info = statSync(canonical)
    if (!info.isDirectory()) throw new Error()
    return { selected, canonical, identity: `${info.dev}:${info.ino}:${info.birthtimeMs}` }
  } catch {
    throw new CLIInputError('工作目录或工作区必须是当前可访问的目录')
  }
}

function instructionFingerprint(root: string): string | null {
  const path = join(root, 'AGENTS.md')
  try {
    const info = lstatSync(path)
    if (!info.isFile() || info.nlink !== 1 || realpathSync(path) !== path) throw new Error()
    return digest(readFileSync(path))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/** Preserve actual tool returns even if cancellation prevented their live delivery. */
function projectToolResults(
  items: ProtocolItem[],
  requestId: string
): AgentHostResult['toolResults'] {
  const calls = new Map<string, string>()
  const results: AgentHostResult['toolResults'] = []
  for (const item of items) {
    if (
      item.type === 'function_call' &&
      typeof item.call_id === 'string' &&
      typeof item.name === 'string'
    )
      calls.set(item.call_id, item.name)
    if (item.type !== 'function_call_output' || typeof item.call_id !== 'string') continue
    const checked = parseAgentToolEvent({
      requestId,
      callId: item.call_id,
      name: calls.get(item.call_id),
      phase: 'finish',
      output: item.output,
      durationMs: 0
    })
    if (checked && checked.phase === 'finish')
      results.push({ callId: checked.callId, name: checked.name, output: checked.output })
  }
  return results
}

/** One explicit invocation; module import performs no I/O or model request. */
export async function runAgentTask(
  supplied: AgentHostInput,
  options: AgentHostOptions = {}
): Promise<AgentHostResult> {
  const startedAt = performance.now()
  // Capture primitive input and callback identities before the first await.
  const { mode: rawMode, prompt, cwd, workspace, permission: rawPermission } = supplied
  const mode = parseAgentMode(rawMode)
  const permission = parsePermissionMode(rawPermission ?? 'default')
  if (!mode || !permission || typeof prompt !== 'string' || !prompt.trim() || prompt.length > 2000)
    throw new CLIInputError('必须提供明确的工作方式、有效权限及非空、最多2000字符的原始任务')
  const { signal: externalSignal, onEvent, approve, answer } = options
  if (onEvent !== undefined && typeof onEvent !== 'function')
    throw new CLIInputError('公开事件回调无效')
  if (
    (approve !== undefined && typeof approve !== 'function') ||
    (answer !== undefined && typeof answer !== 'function')
  )
    throw new CLIInputError('审批或计划问答回调无效')
  const directories = [directory(cwd ?? process.cwd())]
  if (workspace !== undefined) directories.push(directory(workspace))
  let configuration: ReturnType<typeof readModelConfiguration>
  try {
    configuration = readModelConfiguration()
  } catch (cause) {
    throw new CLIInputError(cause instanceof Error ? cause.message : '模型配置无效')
  }
  const controller = new AbortController()
  const abort = (): void => {
    controller.abort(externalSignal?.reason)
  }
  externalSignal?.addEventListener('abort', abort, { once: true })
  if (externalSignal?.aborted) abort()
  const requestId = randomUUID()
  const conversationId = randomUUID()
  const runId = randomUUID()
  const runtimeRoot = resolve(__dirname, 'windows-command-runtime')
  let active = true
  let pending: string | null = null
  let hostFailure: { code: 1 | 3; message: string } | null = null
  let timer: ReturnType<typeof setInterval> | undefined
  const fail = (code: 1 | 3, message: string): never => {
    hostFailure ??= { code, message }
    const error = code === 3 ? new InteractionUnavailableError(message) : new Error(message)
    controller.abort(error)
    throw error
  }
  const wait = async <T>(id: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    controller.signal.throwIfAborted()
    // The authorization service already owns its outer pending approval.
    if (pending !== null && pending !== 'approval') fail(3, '本次请求已有未解决的交互等待')
    pending = id
    let remove = (): void => {}
    try {
      return await Promise.race([
        Promise.resolve().then(() => work(controller.signal)),
        new Promise<never>((_, reject) => {
          const cancelled = (): void => reject(controller.signal.reason)
          controller.signal.addEventListener('abort', cancelled, { once: true })
          remove = () => controller.signal.removeEventListener('abort', cancelled)
          if (controller.signal.aborted) cancelled()
        })
      ])
    } catch (cause) {
      if (cause instanceof InteractionUnavailableError)
        hostFailure ??= { code: 3, message: '当前请求缺少交互能力，或审批/问答输入已结束' }
      else if (!controller.signal.aborted)
        hostFailure ??= { code: 3, message: '本次审批或计划问答回调失败' }
      controller.abort(cause)
      throw cause
    } finally {
      remove()
      if (pending === id) pending = null
    }
  }
  try {
    controller.signal.throwIfAborted()
    const roots = [...new Set(directories.map((item) => item.canonical))]
    const instructions = await Promise.all(roots.map(readProjectInstruction))
    controller.signal.throwIfAborted()
    const fingerprints = instructions.map((item) => {
      if (item.status === 'error') throw new CLIInputError(item.error)
      return item.status === 'read' ? item.instruction.fingerprint : null
    })
    const assertCurrent = (): boolean => {
      if (!active || controller.signal.aborted) return false
      try {
        const valid =
          directories.every((item) => {
            const current = directory(item.selected)
            return current.canonical === item.canonical && current.identity === item.identity
          }) && roots.every((root, index) => instructionFingerprint(root) === fingerprints[index])
        if (valid) return true
      } catch {
        /* A replaced directory or instruction invalidates this exact request. */
      }
      hostFailure ??= {
        code: 1,
        message: '运行目录或 AGENTS.md 已变化，本次请求已停止；请核对副作用后重新发送'
      }
      controller.abort(new Error(hostFailure.message))
      return false
    }
    if (!assertCurrent()) controller.signal.throwIfAborted()
    timer = setInterval(assertCurrent, 250)
    timer.unref()
    const execution: ExecutionContext = Object.freeze({
      info: Object.freeze({
        cwd: directories[0].canonical,
        mode: permission,
        revision: 0,
        scopeId: digest(JSON.stringify({ runId, roots, fingerprints, permission }))
      }),
      writableRoots: Object.freeze([directories[0].canonical])
    })
    const workspaceId = workspace === undefined ? undefined : randomUUID()
    const backend = await inspectWindowsCommandBackend(runtimeRoot)
    controller.signal.throwIfAborted()
    const request = buildAgentRequest({
      mode,
      execution: execution.info,
      workspaceId,
      workspaceInstruction: instructions
        .map((item, index) =>
          item.status === 'read'
            ? `目录 ${roots[index]} 的 AGENTS.md：\n${item.instruction.content}`
            : ''
        )
        .filter(Boolean)
        .join('\n\n'),
      commandSandboxAvailable: backend !== null
    })
    const send = createLiveResponse(request.tools, request.instructions, configuration)
    const reviewApproval = createApprovalReviewer(configuration)
    const outcome = await runAgentCore(
      {
        requestId,
        conversationId,
        mode,
        prompt,
        history: [],
        scope: {
          kind: 'time',
          executionId: execution.info.scopeId,
          ...(workspaceId ? { workspaceId } : {})
        }
      },
      {
        signal: controller.signal,
        send,
        assertCurrent,
        startedAt,
        transportLabel: '普通 Node 真实模型 SSE',
        onEvent: onEvent
          ? (event) => {
              try {
                onEvent(event)
              } catch {
                fail(1, '公开输出回调失败；请核对当前文件与命令结果')
              }
            }
          : undefined,
        createTools: (observer) => {
          const authorization: HostWorkspaceAuthorizationOptions = {
            owner: { kind: 'cli', runId, requestId, conversationId },
            userRequest: prompt,
            execution,
            assertCurrent,
            runtimeRoot,
            reviewApproval,
            beginApproval: () => {
              if (!assertCurrent() || pending !== null) return false
              pending = 'approval'
              return true
            },
            finishApproval: () => {
              if (pending === 'approval') pending = null
            },
            onApproved: (operation) => observer.actionApproved(operation.kind),
            requestApproval: async (operation) => {
              if (!approve) fail(3, '本次操作需要批准，但当前入口未提供审批能力')
              const accepted = await wait(randomUUID(), (signal) => approve!(operation, signal))
              if (!assertCurrent()) controller.signal.throwIfAborted()
              return accepted === true
            }
          }
          return createAgentToolExecutor({
            mode,
            execution,
            assertCurrent,
            approve: createHostWorkspaceAuthorization(authorization),
            authorizeCommand: createHostWorkspaceCommandAuthorization(authorization),
            projectSnapshot: null,
            projectExecutor: undefined,
            executeCommandProposal: async () => {
              throw new Error('脚本入口不支持桌面命令提案')
            },
            requestUserInput: async (input, signal, callId) => {
              signal.throwIfAborted()
              if (!answer) fail(3, '计划需要补充信息，但当前入口未提供问答能力')
              const question = parseAgentUserInputRequest({
                requestId,
                conversationId,
                inputId: randomUUID(),
                callId,
                questions: input.questions
              })
              if (!question) fail(3, '当前计划提问参数无效')
              // A callback may inspect, but cannot mutate the pending canonical request.
              question!.questions.forEach((q) => {
                q.options.forEach(Object.freeze)
                Object.freeze(q.options)
                Object.freeze(q)
              })
              Object.freeze(question!.questions)
              Object.freeze(question)
              observer.progress('等待用户补充计划信息')
              const answers = await wait(question!.inputId, (signal) => answer!(question!, signal))
              if (!assertCurrent()) signal.throwIfAborted()
              const result = parseAgentUserInputResult({ answers }, input.questions)
              if (!result) fail(3, '用户回答与当前计划问题不一致，未继续请求')
              observer.progress('用户已补充，继续制定方案')
              return JSON.stringify(result)
            },
            onEffect: observer.effectStarted,
            appendTrace: observer.appendTrace,
            onProgress: observer.progress
          })
        }
      }
    )
    const failure = hostFailure as { code: 1 | 3; message: string } | null
    const task = failure
      ? {
          state: 'failed' as const,
          error: [failure.message, outcome.task.error].filter(Boolean).join('。')
        }
      : outcome.task
    return {
      requestId,
      conversationId,
      task,
      answer: task.state === 'completed' ? (outcome.task.result ?? '') : '',
      effects: { ...outcome.effects },
      toolResults: projectToolResults(outcome.result.items ?? [], requestId),
      elapsedMs: outcome.elapsedMs,
      exitCode:
        failure?.code ??
        (task.state === 'completed'
          ? 0
          : task.state === 'cancelled'
            ? 130
            : task.state === 'waiting_approval'
              ? 3
              : 1)
    }
  } catch (cause) {
    if (cause instanceof CLIInputError) throw cause
    const failure = hostFailure as { code: 1 | 3; message: string } | null
    return {
      requestId,
      conversationId,
      task: {
        state: !failure && controller.signal.aborted ? 'cancelled' : 'failed',
        error:
          failure?.message ?? (controller.signal.aborted ? '用户已取消任务' : '任务宿主准备失败')
      },
      answer: '',
      effects: { approved: false, started: false },
      toolResults: [],
      elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
      exitCode: failure?.code ?? (controller.signal.aborted ? 130 : 1)
    }
  } finally {
    active = false
    pending = null
    if (timer !== undefined) clearInterval(timer)
    externalSignal?.removeEventListener('abort', abort)
  }
}
