import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { AgentError, isRecord } from '../agent/tool-loop'
import type { SendResponse } from '../agent/tool-loop'
import type { ProjectSelection } from '../../shared/project'

type SearchMatch = { path: string; line: number; text: string }

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
}

function finalResponse(text: string): unknown {
  return {
    status: 'completed',
    output: [
      {
        type: 'message',
        role: 'assistant',
        phase: 'final_answer',
        content: [{ type: 'output_text', text }]
      }
    ]
  }
}

function outputForCall(input: unknown[], callId: string): string {
  const item = input[input.length - 1]
  if (
    !isRecord(item) ||
    item.type !== 'function_call_output' ||
    item.call_id !== callId ||
    typeof item.output !== 'string'
  ) {
    throw new AgentError('项目模拟服务没有收到匹配的工具结果')
  }
  return item.output
}

function parseJsonOutput(output: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(output)
    if (!isRecord(value)) throw new Error()
    return value
  } catch {
    throw new AgentError('项目模拟服务收到无效的工具结果')
  }
}

function parseSearchOutput(output: string): SearchMatch[] {
  const value = parseJsonOutput(output)
  if (!Array.isArray(value.matches)) {
    if (typeof value.error === 'string') throw new AgentError(`项目搜索失败：${value.error}`)
    throw new AgentError('项目模拟服务收到无效的搜索结果')
  }
  const matches: SearchMatch[] = []
  for (const item of value.matches) {
    if (
      !isRecord(item) ||
      typeof item.path !== 'string' ||
      !isInteger(item.line) ||
      item.line < 1 ||
      typeof item.text !== 'string'
    ) {
      throw new AgentError('项目模拟服务收到无效的搜索命中')
    }
    matches.push({ path: item.path, line: item.line, text: item.text })
  }
  return matches
}

function parseReadOutput(output: string): {
  path: string
  startLine: number
  endLine: number
  text: string
} {
  const value = parseJsonOutput(output)
  if (typeof value.error === 'string') throw new AgentError(`项目读取失败：${value.error}`)
  if (
    typeof value.path !== 'string' ||
    !isInteger(value.startLine) ||
    !isInteger(value.endLine) ||
    value.startLine < 1 ||
    value.endLine < value.startLine ||
    typeof value.text !== 'string'
  ) {
    throw new AgentError('项目模拟服务收到无效的读取结果')
  }
  return {
    path: value.path,
    startLine: value.startLine,
    endLine: value.endLine,
    text: value.text
  }
}

function findFile(selection: ProjectSelection, path: string): { lines: number } | null {
  return selection.files.find((file) => file.path === path) ?? null
}

function chooseMatch(matches: readonly SearchMatch[]): SearchMatch {
  return matches.find((match) => /\.(?:ts|tsx|js|jsx)$/.test(match.path)) ?? matches[0]
}

export function createProjectMock(selection: ProjectSelection): SendResponse {
  let step = 0
  const searchCallId = `call_project_mock_${randomUUID()}`
  const readCallId = `call_project_mock_${randomUUID()}`

  return async (input, signal) => {
    await delay(80, undefined, { signal })
    signal.throwIfAborted()

    if (step === 0) {
      step = 1
      return {
        status: 'completed',
        output: [
          {
            type: 'function_call',
            call_id: searchCallId,
            name: 'search_project_text',
            arguments: JSON.stringify({ query: 'greet' })
          }
        ]
      }
    }

    if (step === 1) {
      const matches = parseSearchOutput(outputForCall(input, searchCallId))
      step = 2
      if (matches.length === 0) return finalResponse('所选文件未找到 greet。')

      const match = chooseMatch(matches)
      const file = findFile(selection, match.path)
      if (!file || match.line > file.lines) {
        throw new AgentError('项目模拟服务收到超出清单范围的搜索命中')
      }
      const startLine = match.line
      const endLine = Math.min(startLine + 2, file.lines)
      return {
        status: 'completed',
        output: [
          {
            type: 'function_call',
            call_id: readCallId,
            name: 'read_project_file',
            arguments: JSON.stringify({ path: match.path, startLine, endLine })
          }
        ]
      }
    }

    if (step === 2) {
      const result = parseReadOutput(outputForCall(input, readCallId))
      const file = findFile(selection, result.path)
      if (
        !file ||
        result.startLine > file.lines ||
        result.endLine > file.lines ||
        result.endLine - result.startLine + 1 > 80
      ) {
        throw new AgentError('项目模拟服务收到超出清单范围的读取结果')
      }
      step = 3
      return finalResponse(
        `greet 函数位于 ${result.path}:${result.startLine}-${result.endLine}。\n${result.text}`
      )
    }

    throw new AgentError('项目模拟服务收到超出本轮范围的请求')
  }
}
