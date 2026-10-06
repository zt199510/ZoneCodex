import type { ProjectSnapshot } from './project-snapshot'

export type ProjectExecutor = (
  name: string,
  argumentsText: string,
  signal: AbortSignal
) => Promise<string>

const maxResultLength = 12000

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function errorResult(error: string): string {
  return JSON.stringify({ ok: false, error })
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function isIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum
  )
}

function parseArguments(rawArguments: string): unknown | null {
  if (typeof rawArguments !== 'string' || rawArguments.length > 4096) return null
  try {
    return JSON.parse(rawArguments) as unknown
  } catch {
    return null
  }
}

function makeSearchSnippet(line: string, query: string): { text: string; truncated: boolean } {
  if (line.length <= 200) return { text: line, truncated: false }
  const position = line.indexOf(query)
  const start = Math.max(0, Math.min(position - 40, line.length - 200))
  return { text: line.slice(start, start + 200), truncated: true }
}

function serializeSearchResults(
  matches: Array<{ path: string; line: number; text: string }>,
  truncated: boolean
): string {
  let count = matches.length
  while (count > 0) {
    const result = JSON.stringify({
      matches: matches.slice(0, count),
      truncated: truncated || count < matches.length
    })
    if (result.length <= maxResultLength) return result
    count -= 1
  }
  return JSON.stringify({ matches: [], truncated: true })
}

function serializeReadResult(
  path: string,
  startLine: number,
  lines: readonly string[]
): string | null {
  for (let count = lines.length; count >= 1; count -= 1) {
    const text = lines.slice(0, count).join('\n')
    const result = JSON.stringify({
      path,
      startLine,
      endLine: startLine + count - 1,
      text,
      truncated: count < lines.length
    })
    if (result.length <= maxResultLength) return result
  }
  return null
}

export const projectTools = [
  {
    type: 'function',
    name: 'search_project_text',
    description:
      '在用户选中文件的只读快照中搜索区分大小写的字面量；只搜索清单内文件，不代表搜索整个项目。',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 100, pattern: '^[^\\r\\n]+$' }
      },
      required: ['query'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'read_project_file',
    description: '按行读取用户选中文件的只读快照；path 必须来自清单，每次最多读取 80 行。',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1, maxLength: 240 },
        startLine: { type: 'integer', minimum: 1, maximum: 32769 },
        endLine: { type: 'integer', minimum: 1, maximum: 32769 }
      },
      required: ['path', 'startLine', 'endLine'],
      additionalProperties: false
    }
  }
] as const

export function createProjectExecutor(snapshot: ProjectSnapshot): ProjectExecutor {
  return async (name, rawArguments, signal) => {
    signal.throwIfAborted()
    const args = parseArguments(rawArguments)
    if (!isPlainRecord(args)) return errorResult('INVALID_ARGUMENTS')

    if (name === 'search_project_text') {
      if (
        !exactKeys(args, ['query']) ||
        typeof args.query !== 'string' ||
        !args.query.trim() ||
        args.query.length > 100 ||
        /[\r\n]/.test(args.query)
      ) {
        return errorResult('INVALID_ARGUMENTS')
      }

      const matches: Array<{ path: string; line: number; text: string }> = []
      let truncated = false
      const paths = [...snapshot.files.keys()].sort((left, right) =>
        left < right ? -1 : left > right ? 1 : 0
      )
      for (const path of paths) {
        signal.throwIfAborted()
        const lines = snapshot.files.get(path)
        if (!lines) continue
        for (let index = 0; index < lines.length; index += 1) {
          signal.throwIfAborted()
          const line = lines[index]
          if (!line.includes(args.query)) continue
          if (matches.length >= 20) {
            truncated = true
            break
          }
          const snippet = makeSearchSnippet(line, args.query)
          matches.push({ path, line: index + 1, text: snippet.text })
          truncated ||= snippet.truncated
        }
        if (truncated && matches.length >= 20) break
      }
      return serializeSearchResults(matches, truncated)
    }

    if (name === 'read_project_file') {
      if (
        !exactKeys(args, ['path', 'startLine', 'endLine']) ||
        typeof args.path !== 'string' ||
        !args.path ||
        !isIntegerInRange(args.startLine, 1, 32769) ||
        !isIntegerInRange(args.endLine, 1, 32769) ||
        args.endLine < args.startLine ||
        args.endLine - args.startLine + 1 > 80
      ) {
        return errorResult('INVALID_ARGUMENTS')
      }
      const lines = snapshot.files.get(args.path)
      if (!lines) return errorResult('NOT_SELECTED')
      if (args.startLine > lines.length || args.endLine > lines.length) {
        return errorResult('LINE_OUT_OF_RANGE')
      }
      const selectedLines = lines.slice(args.startLine - 1, args.endLine)
      return (
        serializeReadResult(args.path, args.startLine, selectedLines) ??
        errorResult('单行过长，无法在结果上限内完整返回')
      )
    }

    return errorResult('UNKNOWN_TOOL')
  }
}
