import { AgentError } from '../errors'
import type { ExecuteTool } from './tool-loop'
import type { ExecutionContext } from '../execution/execution-context'
import { executeTimeTool } from '../tools/current-time'
import { createWorkspaceReadExecutor, workspaceReadTools } from '../tools/workspace-files'
import {
  createWorkspaceActionExecutor,
  workspaceActionTools,
  type WorkspaceApprove
} from '../tools/workspace-actions'
import { canonicalLocalPath } from '../tools/local-path'
import type { ProjectSnapshot } from '../tools/project-snapshot'

type AgentToolsOptions = {
  execution: ExecutionContext
  assertCurrent: () => boolean
  approve: WorkspaceApprove
  onEffect: () => void
  appendTrace: (message: string) => void
  onProgress: (message: string) => void
  projectSnapshot: ProjectSnapshot | null
  projectExecutor: ExecuteTool | undefined
  executeCommandProposal: ExecuteTool
}

/** Full-read evidence belongs to this request only and never grants lasting file access. */
export function createAgentToolExecutor(options: AgentToolsOptions): ExecuteTool {
  const {
    execution,
    assertCurrent,
    approve,
    onEffect,
    appendTrace,
    onProgress,
    projectSnapshot,
    projectExecutor,
    executeCommandProposal
  } = options
  const readWorkspace = createWorkspaceReadExecutor(execution.info.cwd, assertCurrent, {
    isPathAllowed: () => assertCurrent()
  })
  const actInWorkspace = createWorkspaceActionExecutor(execution.info.cwd, assertCurrent, approve, {
    isPathAllowed: () => assertCurrent(),
    onEffect
  })
  const completeReads = new Map<string, string>()
  return async (name, args, signal): Promise<string> => {
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
