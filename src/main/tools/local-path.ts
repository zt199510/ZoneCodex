import { lstat, realpath } from 'node:fs/promises'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
  win32
} from 'node:path'

const deviceName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i

export function sameLocalPath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

export function insideLocalPath(root: string, target: string): boolean {
  const value = relative(root, target)
  return !isAbsolute(value) && value !== '..' && !value.startsWith(`..${sep}`)
}

export function localPathParts(target: string): string[] {
  return relative(parse(target).root, target).split(sep).filter(Boolean)
}

function lexicalLocalPath(root: string, input: unknown, allowRoot: boolean): string {
  if (typeof input !== 'string' || input.length > 512 || (!input && !allowRoot)) {
    throw new Error('文件路径无效')
  }
  if (!isAbsolute(root) || root.startsWith('\\\\') || root.startsWith('//')) {
    throw new Error('运行目录不是本地绝对路径')
  }
  if (input.startsWith('\\\\') || input.startsWith('//')) {
    throw new Error('不支持网络目录或设备路径')
  }
  if (
    (process.platform === 'win32' &&
      (win32.isAbsolute(input) || /^[a-z]:/i.test(input)) &&
      !/^[a-z]:[\\/]/i.test(input)) ||
    (process.platform !== 'win32' &&
      ((win32.isAbsolute(input) && !isAbsolute(input)) || input.includes('\\')))
  ) {
    throw new Error('不支持该本地路径形式')
  }
  const body = process.platform === 'win32' ? input.replace(/^[a-z]:[\\/]/i, '') : input
  const parts = body.split(process.platform === 'win32' ? /[\\/]/ : /\//)
  if (
    parts.some(
      (part) =>
        part !== '' &&
        part !== '.' &&
        part !== '..' &&
        (/[<>:"|?*]/.test(part) ||
          /[. ]$/.test(part) ||
          deviceName.test(part) ||
          Array.from(part).some((character) => {
            const code = character.charCodeAt(0)
            return code < 32 || code === 127
          }))
    )
  ) {
    throw new Error('路径包含非法文件名、设备名或替代数据流')
  }
  const target = resolve(root, input || '.')
  if (!allowRoot && sameLocalPath(target, parse(target).root)) {
    throw new Error('文件路径不能是磁盘根目录')
  }
  return target
}

async function canonicalDirectory(directory: string): Promise<string> {
  let current = parse(directory).root
  const identities: Array<{ path: string; dev: number; ino: number }> = []
  for (const part of ['', ...localPathParts(directory)]) {
    if (part) current = join(current, part)
    const info = await lstat(current)
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error('父目录不是普通目录，或包含符号链接/联接')
    }
    identities.push({ path: current, dev: info.dev, ino: info.ino })
  }
  const actual = await realpath(directory)
  const resolved = await lstat(actual)
  const original = identities.at(-1)!
  if (
    !resolved.isDirectory() ||
    resolved.isSymbolicLink() ||
    original.dev !== resolved.dev ||
    original.ino !== resolved.ino
  ) {
    throw new Error('父目录的实际路径已变化')
  }
  for (const identity of identities) {
    const after = await lstat(identity.path)
    if (
      after.isSymbolicLink() ||
      !after.isDirectory() ||
      identity.dev !== after.dev ||
      identity.ino !== after.ino
    ) {
      throw new Error('父目录的实际路径已变化')
    }
  }
  return actual
}

// Resolving a target does not grant access to it or confine child processes.
// Missing leaf files are supported; their parent directories must already exist.
export async function canonicalLocalPath(
  root: string,
  input: unknown,
  allowRoot = false
): Promise<string> {
  const lexical = lexicalLocalPath(root, input, allowRoot)
  const parent = await canonicalDirectory(dirname(lexical))
  const target = join(parent, basename(lexical))
  const info = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (info?.isSymbolicLink()) throw new Error('不操作符号链接或目录联接')
  if (!info) return target
  const actual = await realpath(target)
  const after = await lstat(target)
  const resolved = await lstat(actual)
  if (
    after.isSymbolicLink() ||
    resolved.isSymbolicLink() ||
    info.dev !== after.dev ||
    info.ino !== after.ino ||
    after.dev !== resolved.dev ||
    after.ino !== resolved.ino
  ) {
    throw new Error('目标的实际路径已变化')
  }
  return actual
}
