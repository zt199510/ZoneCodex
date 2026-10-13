import { randomUUID } from 'node:crypto'
import type { GitChangeItem } from '../../shared/git-view'
import { GitReadError } from './git-process'
import { decodeGitText, validRepositoryPath, withinScope } from './git-snapshot'

function change(code: string): GitChangeItem['change'] {
  const values: Record<string, GitChangeItem['change']> = {
    A: 'added',
    M: 'modified',
    D: 'deleted',
    R: 'renamed',
    C: 'copied',
    U: 'unmerged',
    T: 'type-changed'
  }
  return values[code] ?? 'unknown'
}

/** Parse NUL records without splitting filenames on whitespace or newlines. */
export function parseGitStatus(bytes: Buffer, scope: string, ignoreCase = false): GitChangeItem[] {
  if (bytes.length > 1048576) throw new GitReadError('too-large', '状态输出超过 1 MiB')
  if (bytes.length && bytes[bytes.length - 1] !== 0)
    throw new GitReadError('error', 'Git 状态协议不完整')
  const records = decodeGitText(bytes).split('\0')
  const items: GitChangeItem[] = []
  function add(
    group: GitChangeItem['group'],
    code: string,
    filename: string,
    previous: string | null,
    modes: string[],
    conflict = false
  ): void {
    if (!validRepositoryPath(filename) || !withinScope(filename, scope, ignoreCase))
      throw new GitReadError('error', 'Git 状态路径超出查看范围')
    let reason: string | null = null
    if (previous && (!validRepositoryPath(previous) || !withinScope(previous, scope, ignoreCase)))
      reason = '跨查看范围的重命名不支持预览'
    if (conflict) reason = '冲突项暂不支持预览'
    if (modes.some((mode) => mode === '120000' || mode === '160000'))
      reason = '符号链接或子模块暂不支持预览；未检查子模块内容'
    if (/\p{Cc}/u.test(filename)) reason = '此平台不支持控制字符文件名预览'
    items.push({
      itemId: randomUUID(),
      group,
      change: conflict ? 'unmerged' : change(code),
      path: filename,
      previousPath: previous,
      previewable: reason === null,
      reason
    })
    if (items.length > 2000)
      throw new GitReadError('too-large', 'Git 改动超过 2000 项，请选择更小范围')
  }
  for (let n = 0; n < records.length - 1; n++) {
    const record = records[n]
    if (record.startsWith('? ')) {
      add('untracked', 'A', record.slice(2), null, [])
      continue
    }
    const fields = record[0] === '1' ? 8 : record[0] === '2' ? 9 : record[0] === 'u' ? 10 : 0
    if (!fields) throw new GitReadError('error', '未知 Git 状态记录')
    let offset = 0
    const header: string[] = []
    for (let i = 0; i < fields; i++) {
      const end = record.indexOf(' ', offset)
      if (end < 0) throw new GitReadError('error', 'Git 状态记录不完整')
      header.push(record.slice(offset, end))
      offset = end + 1
    }
    const filename = record.slice(offset)
    const xy = header[1]
    if (!/^[.MADRCUT?!]{2}$/.test(xy)) throw new GitReadError('error', 'Git 状态标记不正确')
    const previous = record[0] === '2' ? records[++n] : null
    if (record[0] === '2' && !previous) throw new GitReadError('error', '重命名原路径缺失')
    const modes = header.slice(3, record[0] === 'u' ? 7 : 6)
    if (record[0] === 'u') {
      add('unstaged', 'U', filename, null, modes, true)
      continue
    }
    if (xy[0] !== '.') add('staged', xy[0], filename, previous, modes)
    if (xy[1] !== '.') add('unstaged', xy[1], filename, null, modes)
  }
  return items
}
