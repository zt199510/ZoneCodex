import { AgentError } from '../errors'
import type { ExecuteTool } from './tool-loop'
import type { ExecutionContext } from '../execution/execution-context'
import type { CommandAuthorize } from '../execution/command-plan'
import { executeTimeTool } from '../tools/current-time'
import { createWorkspaceReadExecutor, workspaceReadTools } from '../tools/workspace-files'
import {
  createWorkspaceActionExecutor,
  workspaceActionTools,
  type WorkspaceApprove
} from '../tools/workspace-actions'
import { canonicalLocalPath } from '../tools/local-path'
import type { ProjectSnapshot } from '../tools/project-snapshot'
import { projectTools } from '../tools/project-file-tools'
import { parseAgentMode, toolArgumentsLimit, type AgentMode } from '../../shared/agent'
import {
  parseAgentUserInputArguments,
  type AgentUserInputArguments
} from '../../shared/agent-user-input'

type AgentToolsOptions = {
  mode: AgentMode
  execution: ExecutionContext
  assertCurrent: () => boolean
  approve: WorkspaceApprove
  authorizeCommand: CommandAuthorize
  onEffect: () => void
  appendTrace: (message: string) => void
  onProgress: (message: string) => void
  projectSnapshot: ProjectSnapshot | null
  projectExecutor: ExecuteTool | undefined
  executeCommandProposal: ExecuteTool
  requestUserInput?: (
    input: AgentUserInputArguments,
    signal: AbortSignal,
    callId: string
  ) => Promise<string>
}

/** Full-read evidence belongs to this request only and never grants lasting file access. */
export function createAgentToolExecutor(options: AgentToolsOptions): ExecuteTool {
  const {
    mode,
    execution,
    assertCurrent,
    approve,
    authorizeCommand,
    onEffect,
    appendTrace,
    onProgress,
    projectSnapshot,
    projectExecutor,
    executeCommandProposal,
    requestUserInput
  } = options
  if (!parseAgentMode(mode)) throw new AgentError('工作方式参数无效')
  const readWorkspace = createWorkspaceReadExecutor(execution.info.cwd, assertCurrent, {
    isPathAllowed: () => assertCurrent()
  })
  const actInWorkspace =
    mode === 'execute'
      ? createWorkspaceActionExecutor(execution.info.cwd, assertCurrent, approve, {
          isPathAllowed: () => assertCurrent(),
          onEffect,
          authorizeCommand
        })
      : null
  const completeReads = new Map<string, string>()
  return async (name, args, signal, callId): Promise<string> => {
    signal.throwIfAborted()
    if (name === 'request_user_input') {
      if (mode !== 'plan') throw new AgentError('只有计划模式可以向用户提问')
      if (!requestUserInput) throw new AgentError('当前请求不支持向用户提问')
      let input: AgentUserInputArguments | null = null
      try {
        if (typeof args === 'string' && args.length <= 4096)
          input = parseAgentUserInputArguments(JSON.parse(args))
      } catch {
        // Invalid model arguments never create a pending question.
      }
      if (!input || typeof callId !== 'string' || !callId || callId.length > 200)
        throw new AgentError('提问参数或工具标识无效')
      if (!assertCurrent()) throw new AgentError('运行上下文已失效，请重新发送')
      return requestUserInput(input, signal, callId)
    }
    // This guard runs before argument parsing, approval, proposals or any action.
    if (
      mode === 'plan' &&
      name !== 'get_current_time' &&
      !workspaceReadTools.some((tool) => tool.name === name) &&
      !projectTools.some((tool) => tool.name === name)
    )
      throw new AgentError('计划模式只允许研究与读取，不能写入、运行命令或生成可执行提案')
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
            fullText?: unknown
            lines?: Array<{ line?: unknown; truncated?: unknown }>
          }
          if (
            read.ok === true &&
            request.startLine === 1 &&
            typeof read.path === 'string' &&
            typeof read.sha256 === 'string' &&
            typeof read.totalLines === 'number' &&
            read.truncated === false &&
            typeof read.fullText === 'string' &&
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
      if (name === 'apply_workspace_patch') {
        try {
          if (args.length > toolArgumentsLimit(name)) throw new AgentError('补丁参数过长')
          const edit = JSON.parse(args) as { path?: unknown; expectedSha256?: unknown }
          output =
            typeof edit.path === 'string' &&
            completeReads.get(await canonicalLocalPath(execution.info.cwd, edit.path)) ===
              edit.expectedSha256
              ? await actInWorkspace(name, args, signal)
              : JSON.stringify({ status: 'error', error: '请先完整读取目标文件' })
        } catch {
          output = JSON.stringify({ status: 'error', error: '补丁参数无效' })
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
        onProgress(message)
      }
      return output
    }
    if (name === 'propose_command' && projectSnapshot) {
      return executeCommandProposal(name, args, signal)
    }
    if (projectExecutor) return projectExecutor(name, args, signal)
    throw new AgentError('工具不在当前授权范围内')
  }
}
