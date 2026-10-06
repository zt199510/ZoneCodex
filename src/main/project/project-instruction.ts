import { createHash } from 'node:crypto'
import { lstat, readFile, realpath, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import type { ProjectInstruction, WorkspaceInstructionResult } from '../../shared/project'

const instructionName = 'AGENTS.md'
const maxInstructionBytes = 64 * 1024

/**
 * Read only the instruction file at the selected workspace root.
 * The root is canonicalized and the candidate is checked to remain inside it;
 * no model supplied path and no instruction content is ever executed here.
 */
export async function readProjectInstruction(root: string): Promise<WorkspaceInstructionResult> {
  if (typeof root !== 'string' || !root.trim()) return { status: 'error', error: '工作区目录无效' }
  try {
    const canonicalRoot = await realpath(resolve(root))
    if (!(await stat(canonicalRoot)).isDirectory())
      return { status: 'error', error: '工作区目录无效' }
    const candidate = join(canonicalRoot, instructionName)
    const info = await lstat(candidate).catch(() => null)
    if (!info) return { status: 'absent' }
    if (!info.isFile() || info.nlink !== 1)
      return { status: 'error', error: 'AGENTS.md 不是普通文件' }
    const candidateReal = await realpath(candidate)
    if (candidateReal !== candidate) return { status: 'error', error: 'AGENTS.md 不得是符号链接' }
    const bytes = await readFile(candidate)
    const truncated = bytes.byteLength > maxInstructionBytes
    try {
      // Validate the complete file before taking the bounded model prefix.
      new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      return { status: 'error', error: 'AGENTS.md 必须是 UTF-8 文本' }
    }
    let selected = bytes.subarray(0, maxInstructionBytes)
    let content: string
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(selected)
    } catch {
      if (!truncated) return { status: 'error', error: 'AGENTS.md 必须是 UTF-8 文本' }
      // The byte limit may split the final UTF-8 code point. Remove at most
      // three trailing bytes to find a valid prefix; failures beyond that
      // indicate malformed input rather than a truncation boundary.
      let decoded: string | null = null
      for (let trim = 1; trim <= 3 && trim < selected.byteLength; trim++) {
        const candidate = selected.subarray(0, selected.byteLength - trim)
        try {
          decoded = new TextDecoder('utf-8', { fatal: true }).decode(candidate)
          selected = candidate
          break
        } catch {
          // Try the next possible UTF-8 boundary.
        }
      }
      if (decoded === null) return { status: 'error', error: 'AGENTS.md 必须是 UTF-8 文本' }
      content = decoded
    }
    const instruction: ProjectInstruction = {
      path: join(canonicalRoot, instructionName),
      content,
      fingerprint: createHash('sha256').update(bytes).digest('hex'),
      truncated
    }
    return { status: 'read', instruction }
  } catch {
    return { status: 'error', error: '读取 AGENTS.md 失败' }
  }
}

export function workspaceLabel(root: string): string {
  return basename(root).slice(0, 80) || '工作区'
}

export const maxProjectInstructionBytes = maxInstructionBytes
