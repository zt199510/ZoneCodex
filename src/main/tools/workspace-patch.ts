import { boundedChangeText, WORKSPACE_PATCH_CAPACITY } from './change-capacity'

export type LocatedPatchHunk = {
  /** One-based line in the normalized original, excluding format-only trailing LF. */
  startLine: number
  before: readonly string[]
  atEnd: boolean
}

type PatchResult =
  | {
      status: 'candidate'
      text: string
      hunks: number
      locatedHunks: readonly LocatedPatchHunk[]
    }
  | { status: 'error'; error: string }

type Hunk = { before: string[]; after: string[]; atEnd: boolean }
type LocatedHunk = Hunk & { start: number }

const maxPatchLength = 6000

function failure(error: string): PatchResult {
  return { status: 'error', error }
}

/** Only LF text, tabs and valid Unicode enter the existing UTF-8 commit path. */
function validText(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code === 127 || (code < 32 && code !== 9 && code !== 10)) return false
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
    } else if (code >= 0xdc00 && code <= 0xdfff) return false
  }
  return true
}

function boundedText(value: string): boolean {
  return boundedChangeText(value, WORKSPACE_PATCH_CAPACITY)
}

/**
 * Prepare one existing file's candidate without reading or writing the filesystem.
 * The caller supplies the captured LF body without a BOM and owns hash checks,
 * authorization, encoding, cancellation and the final verified commit.
 */
export function applyWorkspacePatch(
  originalText: string,
  patch: string,
  targetPath: string
): PatchResult {
  if (
    typeof originalText !== 'string' ||
    !validText(originalText) ||
    originalText.startsWith('\uFEFF')
  )
    return failure('原文必须是无 BOM、无非法控制字符的 LF 文本')
  if (!boundedText(originalText)) return failure('原文超过 131072 个规范 LF 字符')
  if (
    typeof targetPath !== 'string' ||
    !targetPath ||
    targetPath.length > 512 ||
    !validText(targetPath) ||
    /[\t\n]/.test(targetPath)
  )
    return failure('补丁目标路径无效')
  if (typeof patch !== 'string' || patch.length > maxPatchLength)
    return failure('补丁必须是最多 6000 字符的文本')
  if (!validText(patch)) return failure('补丁含有非法控制字符、CR 或无效 Unicode')

  const patchLines = patch.split('\n')
  // Permit one conventional final LF, without trimming meaningful hunk whitespace.
  if (patchLines.at(-1) === '') patchLines.pop()
  if (
    patchLines[0] !== '*** Begin Patch' ||
    patchLines[1] !== `*** Update File: ${targetPath}` ||
    patchLines.at(-1) !== '*** End Patch'
  )
    return failure('补丁必须只更新与目标路径完全一致的已有文件')

  const hunks: Hunk[] = []
  const end = patchLines.length - 1
  let index = 2
  while (index < end) {
    if (patchLines[index++] !== '@@') return failure('补丁块必须以独立的 @@ 行开始')
    const hunk: Hunk = { before: [], after: [], atEnd: false }
    while (index < end && patchLines[index] !== '@@') {
      const line = patchLines[index++]
      if (line === '*** End of File') {
        if (index !== end) return failure('End of File 只能定位最后一个补丁块的末尾')
        hunk.atEnd = true
        break
      }
      const prefix = line[0]
      const text = line.slice(1)
      if (prefix === ' ' || prefix === '-') hunk.before.push(text)
      if (prefix === ' ' || prefix === '+') hunk.after.push(text)
      if (prefix !== ' ' && prefix !== '-' && prefix !== '+')
        return failure('补丁正文每行必须以空格、- 或 + 开始')
    }
    if (!hunk.before.length) return failure('每个补丁块必须包含可匹配的原文')
    hunks.push(hunk)
  }
  if (!hunks.length) return failure('补丁缺少有效的 @@ 修改块')

  // Trailing LF characters are file format, not independently editable blank lines.
  const tailLength = originalText.length - originalText.replace(/\n+$/, '').length
  const body = originalText.slice(0, originalText.length - tailLength)
  const originalLines = body === '' ? [] : body.split('\n')
  const located: LocatedHunk[] = []
  for (const hunk of hunks) {
    const lastStart = originalLines.length - hunk.before.length
    const firstStart = hunk.atEnd ? lastStart : 0
    let match = -1
    for (let start = firstStart; start >= 0 && start <= lastStart; start++) {
      if (!hunk.before.every((line, offset) => originalLines[start + offset] === line)) continue
      if (match !== -1) return failure('补丁原文匹配不唯一，请增加上下文')
      match = start
    }
    if (match === -1) return failure('补丁原文未匹配，文件可能已变化或尾定位不正确')
    located.push({ ...hunk, start: match })
  }
  located.sort((left, right) => left.start - right.start)
  for (let position = 1; position < located.length; position++) {
    const previous = located[position - 1]
    if (located[position].start < previous.start + previous.before.length)
      return failure('补丁块在原文中的范围重叠')
  }

  const candidateLines: string[] = []
  let cursor = 0
  for (const hunk of located) {
    // A byte-bounded file may still contain many short lines; avoid argument limits.
    for (; cursor < hunk.start; cursor++) candidateLines.push(originalLines[cursor])
    for (const line of hunk.after) candidateLines.push(line)
    cursor = hunk.start + hunk.before.length
  }
  for (; cursor < originalLines.length; cursor++) candidateLines.push(originalLines[cursor])
  const candidateBody = candidateLines.join('\n')
  // Reject an implicit tail-format change rather than trim untouched blank lines.
  if (candidateBody.endsWith('\n')) return failure('补丁不能隐式新增或改变尾换行数量')
  if (candidateBody.startsWith('\uFEFF')) return failure('补丁正文不能新增 UTF-8 BOM')
  const text = candidateBody + '\n'.repeat(tailLength)
  if (!boundedText(text)) return failure('候选内容超过 131072 个规范 LF 字符')
  return {
    status: 'candidate',
    text,
    hunks: hunks.length,
    locatedHunks: located.map((hunk) => ({
      startLine: hunk.start + 1,
      before: Object.freeze([...hunk.before]),
      atEnd: hunk.atEnd
    }))
  }
}
