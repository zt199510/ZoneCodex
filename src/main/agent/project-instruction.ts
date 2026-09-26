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
    if (!(await stat(canonicalRoot)).isDirectory()) return { status: 'error', error: '工作区目录无效' }
    const candidate = join(canonicalRoot, instructionName)
    const info = await lstat(candidate).catch(() => null)
    if (!info) return { status: 'absent' }
    if (!info.isFile() || info.nlink !== 1) return { status: 'error', error: 'AGENTS.md 不是普通文件' }
    const candidateReal = await realpath(candidate)
    if (candidateReal !== candidate) return { status: 'error', error: 'AGENTS.md 不得是符号链接' }
    const bytes = await readFile(candidate)
    const truncated = bytes.byteLength > maxInstructionBytes
    const selected = bytes.subarray(0, maxInstructionBytes)
    let content: string
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(selected)
    } catch {
      return { status: 'error', error: 'AGENTS.md 必须是 UTF-8 文本' }
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
