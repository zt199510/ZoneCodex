import { spawn } from 'node:child_process'
import { lstat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const script = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$paths = [object[]](ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd()))
if ($paths.Count -gt 129) { throw 'too many paths' }
$results = foreach ($path in $paths) {
  $ordinary = $true
  $current = [IO.Path]::GetFullPath([string]$path)
  try {
    while ($current) {
      $attributes = [IO.File]::GetAttributes($current)
      if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { $ordinary = $false; break }
      $parent = [IO.Path]::GetDirectoryName($current)
      if (-not $parent -or $parent -eq $current) { break }
      $current = $parent
    }
  } catch { $ordinary = $false }
  [pscustomobject]@{ path = [string]$path; ordinary = $ordinary }
}
ConvertTo-Json -InputObject @($results) -Compress
`
export type SkillObjectProof = Map<string, { ordinary: boolean; identity: string | null }>
export function skillObjectIdentity(info: Awaited<ReturnType<typeof lstat>>): string {
  return JSON.stringify([
    info.dev,
    info.ino,
    info.birthtimeMs,
    info.size,
    info.mtimeMs,
    info.ctimeMs,
    info.nlink
  ])
}

/** One fixed helper checks a bounded batch. Paths arrive as JSON stdin, never as program text. */
export async function checkWindowsSkillObjects(
  paths: string[],
  signal?: AbortSignal
): Promise<SkillObjectProof | null> {
  if (process.platform !== 'win32') return null
  signal?.throwIfAborted()
  const unique = [...new Set(paths.map((item) => resolve(item)))]
  if (!unique.length || unique.length > 129 || unique.some((item) => item.length > 4096))
    throw new Error('技能对象检查超过路径上限')
  const input = JSON.stringify(unique)
  if (Buffer.byteLength(input, 'utf8') > 256 * 1024) throw new Error('技能对象检查数据过大')
  const program = join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32/WindowsPowerShell/v1.0/powershell.exe'
  )
  const raw = await new Promise<string>((yes, no) => {
    const child = spawn(program, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const output: Buffer[] = []
    let failure: Error | null = null,
      size = 0
    const stop = (message: string): void => {
      failure ??= new Error(message)
      child.kill()
    }
    const abort = (): void => stop('技能对象检查已取消')
    const timer = setTimeout(() => stop('技能对象检查超时'), 8000)
    signal?.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', (bytes: Buffer) => {
      size += bytes.length
      if (size > 256 * 1024) stop('技能对象检查输出过大')
      else output.push(bytes)
    })
    child.stderr.on('data', (bytes: Buffer) => {
      size += bytes.length
      if (size > 256 * 1024) stop('技能对象检查输出过大')
    })
    child.once('error', () => {
      failure = new Error('无法启动 Windows 技能属性检查')
    })
    child.stdin.on('error', () => {
      failure ??= new Error('Windows 技能属性检查数据传输失败')
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (failure || code !== 0) no(failure ?? new Error('Windows 技能属性检查失败'))
      else
        yes(
          Buffer.concat(output)
            .toString('utf8')
            .replace(/^\ufeff/, '')
        )
    })
    child.stdin.end(input, 'utf8')
    if (signal?.aborted) abort()
  })
  let result: unknown
  try {
    result = JSON.parse(raw)
  } catch {
    throw new Error('Windows 技能属性检查返回无效数据')
  }
  if (!Array.isArray(result) || result.length !== unique.length)
    throw new Error('Windows 技能属性检查条数无效')
  const proof: SkillObjectProof = new Map()
  for (let index = 0; index < result.length; index++) {
    const item = result[index]
    if (
      !item ||
      typeof item !== 'object' ||
      Object.keys(item).length !== 2 ||
      item.path !== unique[index] ||
      typeof item.ordinary !== 'boolean'
    )
      throw new Error('Windows 技能属性检查记录无效')
    const info = await lstat(unique[index]).catch(() => null)
    proof.set(unique[index], {
      ordinary: item.ordinary,
      identity: info ? skillObjectIdentity(info) : null
    })
  }
  signal?.throwIfAborted()
  return proof
}
export function assertSkillObjectProof(
  proof: SkillObjectProof | null,
  filename: string,
  info: Awaited<ReturnType<typeof lstat>>
): void {
  if (process.platform !== 'win32') return
  const object = proof?.get(resolve(filename))
  if (!object?.ordinary || object.identity !== skillObjectIdentity(info))
    throw new Error('技能对象含 Windows reparse point 或在属性检查后已变化')
}
