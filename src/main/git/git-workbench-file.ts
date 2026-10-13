import path from 'node:path'
import type { GitFullFileData, GitFullFileRequest } from '../../shared/git-workbench'
import type { GitWorkbenchActionContext } from './git-workbench-reader'
import { SourceCapture, validRepositoryPath, withinScope, gitSnapshotLimits } from './git-snapshot'
import { GitReadError } from './git-process'

function verifier(context: GitWorkbenchActionContext, signal?: AbortSignal): SourceCapture {
  const result = new SourceCapture(signal)
  for (const [key, value] of context.snapshot.source.fingerprints)
    result.fingerprints.set(key, value)
  return result
}
function imageMime(bytes: Buffer): 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif'
  if (
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  )
    return 'image/webp'
  return null
}
export async function readGitFullFile(
  context: GitWorkbenchActionContext,
  request: GitFullFileRequest,
  signal?: AbortSignal
): Promise<GitFullFileData> {
  const review = context.review
  const item = review?.items.get(request.itemId)
  if (!review || review.revision !== request.revision || !item)
    throw new GitReadError('stale', '完整文件来源已失效，请刷新')
  const filename = request.side === 'base' ? (item.previousPath ?? item.path) : item.path
  if (
    !validRepositoryPath(filename) ||
    !withinScope(filename, context.location.scopePath, context.snapshot.ignoreCase)
  )
    throw new GitReadError('unsupported', '完整文件超出所选目录')
  const identity = { itemId: request.itemId, path: filename, side: request.side }
  await verifier(context, signal).verify()
  let bytes: Buffer | null = null
  if (item.untracked && request.side === 'base') return { ...identity, format: 'missing' }
  const worktree =
    request.side === 'current' && review.source !== 'commit' && review.source !== 'staged'
  if (worktree) {
    try {
      bytes = await new SourceCapture(signal).file(
        path.join(context.snapshot.worktree, ...filename.split('/')),
        gitSnapshotLimits.trackedFileBytes
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  } else {
    let tree: string
    if (request.side === 'current') tree = review.source === 'staged' ? '' : review.args[1]
    else if (review.source === 'unstaged') tree = ''
    else if (review.source === 'staged')
      tree = context.snapshot.head === 'unborn' ? 'empty' : 'HEAD'
    else tree = review.args[0] ?? 'HEAD'
    if (tree !== 'empty') {
      const object = tree + ':' + filename
      const type = await context.run(['cat-file', '-t', object], signal, {
        acceptedCodes: [0, 128],
        stdoutBytes: 100
      })
      if (type.toString('ascii').trim() === 'blob')
        bytes = await context.run(['cat-file', 'blob', object], signal, {
          stdoutBytes: gitSnapshotLimits.trackedFileBytes
        })
    }
  }
  await verifier(context, signal).verify()
  if (bytes === null) return { ...identity, format: 'missing' }
  const mime = imageMime(bytes)
  if (mime) return { ...identity, format: 'image', mime, base64: bytes.toString('base64') }
  if (bytes.includes(0)) return { ...identity, format: 'binary' }
  try {
    const text = new TextDecoder('utf-8', { fatal: true })
      .decode(bytes)
      .replace(/\p{Cc}/gu, (character) => (/[\t\r\n]/.test(character) ? character : '\uFFFD'))
    return { ...identity, format: 'text', text }
  } catch {
    return { ...identity, format: 'binary' }
  }
}
