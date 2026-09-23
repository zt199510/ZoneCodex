import { lstat, readFile, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
export type DirectoryRead = { directory: string; scripts: { typecheck: string; pretypecheck?: string; posttypecheck?: string }; packageManager?: string; npmrc: 'present' | 'absent'; fingerprint: string }
const MAX = 64 * 1024
async function regular(path: string): Promise<Buffer | null> { const s = await lstat(path).catch(() => null); if (!s || !s.isFile() || s.isSymbolicLink() || s.size > MAX) return null; const b = await readFile(path); if (b.length > MAX) return null; return b }
export async function inspectCommandDirectory(input: string): Promise<DirectoryRead> {
  if (typeof input !== 'string' || input.startsWith('\\\\')) throw new Error('不支持网络目录')
  const dir = await realpath(resolve(input)); const ds = await lstat(dir); if (!ds.isDirectory() || ds.isSymbolicLink()) throw new Error('目录无效或为链接')
  const pkg = await regular(join(dir, 'package.json')); if (!pkg) throw new Error('根目录缺少可读取的 package.json')
  let text = pkg.toString('utf8'); if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  let parsed: unknown; try { parsed = JSON.parse(text) } catch { throw new Error('package.json 不是有效 JSON') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('package.json 根节点必须是对象')
  const scripts = (parsed as Record<string, unknown>).scripts
  if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) throw new Error('缺少 scripts')
  const scriptRecord = scripts as Record<string, unknown>; if (typeof scriptRecord.typecheck !== 'string' || !scriptRecord.typecheck.trim()) throw new Error('缺少非空 scripts.typecheck')
  const out: DirectoryRead = { directory: dir, scripts: { typecheck: (scripts as Record<string, string>).typecheck }, npmrc: 'absent', fingerprint: '' }
  for (const k of ['pretypecheck', 'posttypecheck'] as const) { const v = (scripts as Record<string, unknown>)[k]; if (v !== undefined && typeof v !== 'string') throw new Error(`${k} 必须是字符串`); if (typeof v === 'string') { if (v.length > 2000) throw new Error(`${k} 脚本过长`); out.scripts[k] = v } }
  if (out.scripts.typecheck.length > 2000) throw new Error('typecheck 脚本过长')
  const pm = (parsed as Record<string, unknown>).packageManager; if (pm !== undefined) { if (typeof pm !== 'string' || pm.length > 200) throw new Error('packageManager 声明无效'); out.packageManager = pm }
  const npmrc = await regular(join(dir, '.npmrc')); out.npmrc = npmrc ? 'present' : 'absent'
  out.fingerprint = createHash('sha256').update(pkg).update(npmrc ?? Buffer.from('absent')).digest('hex')
  return out
}
export const newDirectoryId = (): string => randomUUID()
