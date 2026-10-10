import type { WorkspaceReadFormat } from '../tools/workspace-files'
import type { LocatedPatchHunk } from '../tools/workspace-patch'

type FileEvidence = {
  sha256: string
  totalLines: number
  format: WorkspaceReadFormat
  lines: Map<number, string>
  characters: number
}

function pathKey(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readFormat(value: unknown): WorkspaceReadFormat | null {
  if (
    !isRecord(value) ||
    value.encoding !== 'utf-8' ||
    typeof value.hasUtf8Bom !== 'boolean' ||
    !['lf', 'crlf', 'none', 'unsupported'].includes(value.newline as string) ||
    !Number.isInteger(value.trailingNewlines) ||
    (value.trailingNewlines as number) < 0 ||
    (value.trailingNewlines as number) > 131072
  )
    return null
  return {
    encoding: 'utf-8',
    hasUtf8Bom: value.hasUtf8Bom,
    newline: value.newline as WorkspaceReadFormat['newline'],
    trailingNewlines: value.trailingNewlines as number
  }
}

function sameFormat(left: WorkspaceReadFormat, right: WorkspaceReadFormat): boolean {
  return (
    left.encoding === right.encoding &&
    left.hasUtf8Bom === right.hasUtf8Bom &&
    left.newline === right.newline &&
    left.trailingNewlines === right.trailingNewlines
  )
}

/** Request-local evidence from the final bounded JSON, never from history or a requested range. */
export class WorkspaceReadEvidence {
  private readonly files = new Map<string, FileEvidence>()

  observe(output: string): void {
    // The tool loop accepts this exact string without further trimming/replacement.
    if (output.length > 12000) return
    let read: unknown
    try {
      read = JSON.parse(output)
    } catch {
      return
    }
    if (
      !isRecord(read) ||
      read.ok !== true ||
      typeof read.path !== 'string' ||
      !read.path ||
      typeof read.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(read.sha256) ||
      !Number.isInteger(read.totalLines) ||
      (read.totalLines as number) < 1 ||
      (read.totalLines as number) > 131073 ||
      !Array.isArray(read.lines) ||
      read.lines.length > 100
    )
      return
    const format = readFormat(read.format)
    if (!format) return
    const key = pathKey(read.path)
    let evidence = this.files.get(key)
    if (evidence && evidence.sha256 !== read.sha256) {
      this.files.delete(key)
      evidence = undefined
    }
    if (
      evidence &&
      (evidence.totalLines !== read.totalLines || !sameFormat(evidence.format, format))
    ) {
      this.files.delete(key)
      return
    }
    if (!evidence) {
      // Request-local reads remain bounded by the tool loop's protocol capacity.
      evidence = {
        sha256: read.sha256,
        totalLines: read.totalLines as number,
        format,
        lines: new Map(),
        characters: 0
      }
      this.files.set(key, evidence)
    }
    for (const line of read.lines) {
      if (
        !isRecord(line) ||
        !Number.isInteger(line.line) ||
        (line.line as number) < 1 ||
        (line.line as number) > evidence.totalLines ||
        typeof line.text !== 'string' ||
        line.text.length > 2000 ||
        /[\r\n]/.test(line.text) ||
        line.truncated !== false
      )
        continue
      const number = line.line as number
      const previous = evidence.lines.get(number)
      if (previous !== undefined && previous !== line.text) {
        this.files.delete(key)
        return
      }
      if (previous !== undefined) continue
      if (evidence.characters + line.text.length + 1 > 131073) continue
      evidence.lines.set(number, line.text)
      evidence.characters += line.text.length + 1
    }
  }

  forget(path: string): void {
    this.files.delete(pathKey(path))
  }

  check(
    path: string,
    sha256: string,
    originalText: string,
    format: WorkspaceReadFormat,
    hunks: readonly LocatedPatchHunk[]
  ): string | null {
    const evidence = this.files.get(pathKey(path))
    if (!evidence || evidence.sha256 !== sha256)
      return '请在本执行请求读取目标附近片段，取得当前 hash 后再提交补丁'
    if (
      evidence.totalLines !== originalText.split('\n').length ||
      !sameFormat(evidence.format, format)
    )
      return '读取的行数或格式与当前版本不一致，请重读目标附近片段'
    // startLine comes from the same unique matcher that generated the candidate.
    // It maps body lines directly; tool totalLines also includes trailing empty lines.
    for (const hunk of hunks) {
      const missing = hunk.before.flatMap((text, index) => {
        const line = hunk.startLine + index
        return evidence.lines.get(line) === text ? [] : [line]
      })
      if (missing.length > 0)
        return `补丁所需旧文尚未完整可见，请读取第 ${missing[0]}–${missing.at(-1)} 行附近（每次最多100行）；截断行不能作为依据`
    }
    return null
  }
}
