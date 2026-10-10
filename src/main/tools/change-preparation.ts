import { parse, relative } from 'node:path'
import { readSelectedFile, type ProjectSnapshot, type SourceBaseline } from './project-snapshot'
import type { PreparationResult } from '../../shared/change-preparation'
import { boundedChangeText, changeCapacity, WORKSPACE_PATCH_CAPACITY } from './change-capacity'

type Failure = Exclude<PreparationResult, { status: 'ready' }>
export type PreparedContent = {
  status: 'prepared'
  baseline: SourceBaseline
  proposedText: string
  candidateBytes: Uint8Array
  encoding: string
  newline: string
}
const conflict = (): Failure => ({
  status: 'conflict',
  error: '文件在生成建议后发生变化，请重新选择文件并生成建议'
})

export async function prepareChange(
  snapshot: ProjectSnapshot,
  path: string,
  raw: string,
  signal: AbortSignal
): Promise<PreparedContent | Failure> {
  signal.throwIfAborted()
  const baseline = snapshot.baselines?.get(path)
  const lines = snapshot.files.get(path)
  if (!baseline || !lines) return { status: 'error', error: '缺少原始字节基线，请重新选择文件' }
  const capacity = baseline.capacity
  const limit = changeCapacity(capacity)
  const textError =
    capacity === WORKSPACE_PATCH_CAPACITY
      ? '原文或候选内容超过 131072 个规范 LF 字符'
      : '原文或候选内容超过 80 行或 2000 字符'
  if (baseline.originalBytes.length > limit.maxBytes)
    return { status: 'error', error: `原始字节超过 ${limit.maxBytes / 1024} KiB` }
  if (
    typeof raw !== 'string' ||
    !boundedChangeText(raw, capacity) ||
    !boundedChangeText(lines.join('\n'), capacity)
  )
    return { status: 'error', error: textError }
  try {
    const root = parse(baseline.absolutePath).root
    const current = (
      await readSelectedFile(root, relative(root, baseline.absolutePath), signal, capacity)
    ).baseline
    signal.throwIfAborted()
    if (
      current.dev !== baseline.dev ||
      current.ino !== baseline.ino ||
      !Buffer.from(current.originalBytes).equals(Buffer.from(baseline.originalBytes))
    )
      return conflict()
  } catch {
    signal.throwIfAborted()
    return conflict()
  }
  if (baseline.newline === 'unsupported')
    return { status: 'unsupported', error: '本课暂不准备混合换行或孤立 CR 文件' }
  const proposedText = raw.replace(/\r\n?/g, '\n')
  if (proposedText.startsWith('\uFEFF'))
    return { status: 'unsupported', error: '候选正文不能以 U+FEFF 开头，BOM 由原文件策略保留' }
  if (!boundedChangeText(proposedText, capacity)) return { status: 'error', error: textError }
  const encoded = baseline.newline === 'crlf' ? proposedText.replace(/\n/g, '\r\n') : proposedText
  const candidateBytes = Buffer.from((baseline.hasUtf8Bom ? '\uFEFF' : '') + encoded, 'utf8')
  if (candidateBytes.length > limit.maxBytes)
    return { status: 'error', error: `候选编码超过 ${limit.maxBytes / 1024} KiB` }
  if (candidateBytes.equals(Buffer.from(baseline.originalBytes)))
    return { status: 'no_change', error: '候选与磁盘原始字节完全一致，无需准备' }
  signal.throwIfAborted()
  return {
    status: 'prepared',
    baseline,
    proposedText: raw,
    candidateBytes,
    encoding: baseline.hasUtf8Bom
      ? proposedText === ''
        ? '正文为空，保留 UTF-8 BOM'
        : 'UTF-8，保留 BOM'
      : 'UTF-8，无 BOM',
    newline:
      baseline.newline === 'crlf'
        ? '保留 CRLF'
        : baseline.newline === 'none'
          ? '原文无换行，候选采用 LF'
          : '保留 LF'
  }
}
