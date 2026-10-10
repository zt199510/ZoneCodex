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
import { WorkspaceReadEvidence } from './workspace-read-evidence'
import type { ProjectSnapshot } from '../tools/project-snapshot'
import { projectTools } from '../tools/project-file-tools'
import { parseAgentMode, type AgentMode } from '../../shared/agent'
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

/** Visible-line evidence belongs to this request only and never grants file access. */
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
  const readEvidence = new WorkspaceReadEvidence()
  const actInWorkspace =
    mode === 'execute'
      ? createWorkspaceActionExecutor(execution.info.cwd, assertCurrent, approve, {
          isPathAllowed: () => assertCurrent(),
          onEffect,
          authorizeCommand,
          validatePatchEvidence: (...args) => readEvidence.check(...args)
        })
      : null
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
      signal.throwIfAborted()
      if (!assertCurrent()) throw new AgentError('运行上下文已失效，请重新发送')
      if (mode === 'execute' && name === 'read_workspace_file') readEvidence.observe(output)
      return output
    }
    if (actInWorkspace && workspaceActionTools.some((tool) => tool.name === name)) {
      const output = await actInWorkspace(name, args, signal)
      const parsed: unknown = JSON.parse(output)
      const status =
        parsed && typeof parsed === 'object' && 'status' in parsed
          ? (parsed as { status: unknown }).status
          : null
      if (typeof status === 'string' && /^[a-z_]+$/.test(status)) {
        if (
          name === 'apply_workspace_patch' &&
          status === 'applied' &&
          parsed &&
          typeof parsed === 'object' &&
          'path' in parsed &&
          typeof parsed.path === 'string'
        )
          readEvidence.forget(parsed.path)
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
