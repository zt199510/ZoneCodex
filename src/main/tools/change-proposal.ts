import { buildChangePreview } from './change-preview'
import { createProjectExecutor } from './project-snapshot'
import type { ProjectSnapshot, ProjectExecutor } from './project-snapshot'
import { parseChangeProposalArgs } from '../../shared/change-proposal'

export const changeProposalTool = {
  type: 'function',
  name: 'propose_file_change',
  description:
    '为已完整读取的附件提交一份完整的新文件内容，只创建供用户审查的建议，不写入磁盘。每次任务最多接收一份。',
  strict: true,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', minLength: 1, maxLength: 240 },
      proposedText: { type: 'string', maxLength: 2000 }
    },
    required: ['path', 'proposedText'],
    additionalProperties: false
  }
} as const

const maxArgumentsLength = 4096
const maxProposalLines = 80
const maxProposalTextLength = 2000

function normalizeText(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

function errorResult(error: string): string {
  return JSON.stringify({ status: 'error', error: error.slice(0, 500) })
}

function proposalReady(path: string): string {
  return JSON.stringify({ status: 'proposal_ready', path })
}

function isCompleteReadResult(
  value: unknown,
  path: string,
  expectedText: string,
  expectedLineCount: number
): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const result = value as Record<string, unknown>
  return (
    result.path === path &&
    result.startLine === 1 &&
    result.endLine === expectedLineCount &&
    result.truncated === false &&
    result.text === expectedText
  )
}

function parseJson(value: string): unknown | null {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return null
  }
}

export function createChangeProposalExecutor(
  snapshot: ProjectSnapshot,
  conversationId: string
): ProjectExecutor {
  const executeProject = createProjectExecutor(snapshot)
  const fullyReadPaths = new Set<string>()
  let accepted = false

  return async (name, rawArguments, signal) => {
    signal.throwIfAborted()

    if (name === 'read_project_file') {
      const output = await executeProject(name, rawArguments, signal)
      signal.throwIfAborted()
      if (typeof rawArguments !== 'string' || rawArguments.length > maxArgumentsLength)
        return output
      const args = parseJson(rawArguments)
      if (
        typeof args === 'object' &&
        args !== null &&
        !Array.isArray(args) &&
        typeof (args as Record<string, unknown>).path === 'string'
      ) {
        const path = (args as Record<string, unknown>).path as string
        const lines = snapshot.files.get(path)
        if (
          lines &&
          lines.length <= maxProposalLines &&
          isCompleteReadResult(parseJson(output), path, lines.join('\n'), lines.length)
        ) {
          fullyReadPaths.add(path)
        }
      }
      return output
    }

    if (name !== 'propose_file_change') return executeProject(name, rawArguments, signal)

    if (typeof rawArguments !== 'string' || rawArguments.length > maxArgumentsLength) {
      return errorResult('参数过长')
    }
    const args = parseChangeProposalArgs(parseJson(rawArguments))
    if (!args) return errorResult('参数无效')

    const lines = snapshot.files.get(args.path)
    if (!lines) return errorResult('文件不在当前快照中')
    const before = lines.join('\n')
    const proposedText = normalizeText(args.proposedText)
    if (
      lines.length > maxProposalLines ||
      proposedText.split('\n').length > maxProposalLines ||
      normalizeText(before).length > maxProposalTextLength ||
      proposedText.length > maxProposalTextLength
    ) {
      return errorResult('原文或候选内容超过 80 行或 2000 字符')
    }
    if (!fullyReadPaths.has(args.path)) return errorResult('提交建议前必须完整读取文件')
    if (accepted) return errorResult('每次任务最多接收一份建议')

    try {
      buildChangePreview(
        {
          conversationId,
          snapshotId: snapshot.selection.snapshotId,
          path: args.path,
          proposedText
        },
        snapshot
      )
    } catch (error) {
      if (signal.aborted) throw error
      return errorResult(error instanceof Error ? error.message : '建议内容无效')
    }

    signal.throwIfAborted()
    accepted = true
    return proposalReady(args.path)
  }
}
