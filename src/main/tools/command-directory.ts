import { lstat, open, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
export type CommandDirectoryBaseline = {
  directory: string
  identity: { dev: number; ino: number }
  npmrc: 'present' | 'absent'
  fingerprint: string
}
export type DirectoryRead = CommandDirectoryBaseline & {
  scripts: { typecheck: string; pretypecheck?: string; posttypecheck?: string }
  packageManager?: string
}
const MAX = 64 * 1024
async function regular(path: string, optional = false): Promise<Buffer | null> {
  const before = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (optional && error.code === 'ENOENT') return null
    throw error
  })
  if (!before) return null
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX) {
    throw new Error('目录配置不是可读取的普通文件，或内容过长')
  }
  const handle = await open(path, 'r')
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error('目录配置已变化，请重新读取')
    }
    const buffer = Buffer.alloc(MAX + 1)
    let length = 0
    while (length < buffer.length) {
      const read = await handle.read(buffer, length, buffer.length - length, length)
      if (read.bytesRead === 0) break
      length += read.bytesRead
    }
    const after = await lstat(path)
    const current = await handle.stat()
    if (
      length > MAX ||
      !after.isFile() ||
      after.isSymbolicLink() ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      current.size !== length ||
      current.size !== opened.size ||
      current.mtimeMs !== opened.mtimeMs ||
      current.ctimeMs !== opened.ctimeMs
    ) {
      throw new Error('目录配置已变化或内容过长，请重新读取')
    }
    return buffer.subarray(0, length)
  } finally {
    await handle.close()
  }
}
export function sameCommandDirectory(
  current: CommandDirectoryBaseline,
  baseline: CommandDirectoryBaseline
): boolean {
  return (
    current.directory === baseline.directory &&
    current.identity.dev === baseline.identity.dev &&
    current.identity.ino === baseline.identity.ino &&
    current.fingerprint === baseline.fingerprint &&
    current.npmrc === baseline.npmrc
  )
}
export async function inspectCommandDirectory(input: string): Promise<DirectoryRead> {
  if (typeof input !== 'string' || input.startsWith('\\\\')) throw new Error('不支持网络目录')
  const dir = await realpath(resolve(input))
  const ds = await lstat(dir)
  if (!ds.isDirectory() || ds.isSymbolicLink()) throw new Error('目录无效或为链接')
  const pkg = await regular(join(dir, 'package.json'))
  if (!pkg) throw new Error('根目录缺少可读取的 package.json')
  let text = pkg.toString('utf8')
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('package.json 不是有效 JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('package.json 根节点必须是对象')
  const scripts = (parsed as Record<string, unknown>).scripts
  if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts))
    throw new Error('缺少 scripts')
  const scriptRecord = scripts as Record<string, unknown>
  if (typeof scriptRecord.typecheck !== 'string' || !scriptRecord.typecheck.trim())
    throw new Error('缺少非空 scripts.typecheck')
  const out: DirectoryRead = {
    directory: dir,
    identity: { dev: ds.dev, ino: ds.ino },
    scripts: { typecheck: (scripts as Record<string, string>).typecheck },
    npmrc: 'absent',
    fingerprint: ''
  }
  for (const k of ['pretypecheck', 'posttypecheck'] as const) {
    const v = (scripts as Record<string, unknown>)[k]
    if (v !== undefined && typeof v !== 'string') throw new Error(`${k} 必须是字符串`)
    if (typeof v === 'string') {
      if (v.length > 2000) throw new Error(`${k} 脚本过长`)
      out.scripts[k] = v
    }
  }
  if (out.scripts.typecheck.length > 2000) throw new Error('typecheck 脚本过长')
  const pm = (parsed as Record<string, unknown>).packageManager
  if (pm !== undefined) {
    if (typeof pm !== 'string' || pm.length > 200) throw new Error('packageManager 声明无效')
    out.packageManager = pm
  }
  const npmrc = await regular(join(dir, '.npmrc'), true)
  out.npmrc = npmrc ? 'present' : 'absent'
  out.fingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        package: createHash('sha256').update(pkg).digest('hex'),
        npmrc: npmrc === null ? null : createHash('sha256').update(npmrc).digest('hex')
      })
    )
    .digest('hex')
  const current = await lstat(dir)
  const canonical = await realpath(resolve(input))
  if (
    !current.isDirectory() ||
    current.isSymbolicLink() ||
    current.dev !== ds.dev ||
    current.ino !== ds.ino ||
    canonical !== dir
  ) {
    throw new Error('目录已变化，请重新选择并读取')
  }
  return out
}
export const newDirectoryId = (): string => randomUUID()
