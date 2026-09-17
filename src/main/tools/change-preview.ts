import type { PreviewChangeRequest, ChangePreview } from '../../shared/change-preview'
import type { ProjectSnapshot } from './project-snapshot'

const maxTextBytes = 32768
const maxLines = 500

function normalizeText(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

function lineCount(text: string): number {
  return text.split('\n').length
}

export function buildChangePreview(
  request: PreviewChangeRequest,
  snapshot: ProjectSnapshot
): ChangePreview {
  const lines = snapshot.files.get(request.path)
  if (!lines) throw new Error('文件不属于当前快照')

  if (Buffer.byteLength(request.proposedText, 'utf8') > maxTextBytes) {
    throw new Error('候选内容超过 32 KiB')
  }
  const before = lines.join('\n')
  const after = normalizeText(request.proposedText)

  if (lineCount(before) > maxLines || lineCount(after) > maxLines) {
    throw new Error('预览内容最多 500 行')
  }

  return {
    conversationId: request.conversationId,
    snapshotId: request.snapshotId,
    path: request.path,
    createdAt: new Date().toISOString(),
    before,
    after
  }
}
