import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { SourceCapture, assertOrdinaryPath, decodeGitText } from './git-snapshot'
import { GitReadError, runGitProcess } from './git-process'
import type { GitProcessObservation } from './git-process'

/** Initializes only the explicitly chosen ordinary directory; no global Git configuration or template. */
export async function initializeGitDirectory(
  selectedPath: string,
  cacheRoot: string,
  signal?: AbortSignal,
  onProcess?: (event: GitProcessObservation) => void
): Promise<void> {
  const source = new SourceCapture(signal)
  const sourceNames = await source.directory(selectedPath)
  if (sourceNames.some((name) => name.toLowerCase() === '.git'))
    throw new GitReadError('stale', '此目录已有 Git 元数据，请选择仓库查看')
  const candidates = [process.env.ProgramW6432, process.env.ProgramFiles].filter(
    (value): value is string => !!value
  )
  let executable = ''
  for (const base of candidates) {
    const candidate = path.join(base, 'Git', 'cmd', 'git.exe')
    try {
      await assertOrdinaryPath(candidate)
      if ((await fs.lstat(candidate)).isFile()) {
        executable = candidate
        break
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  if (!executable) throw new GitReadError('unavailable', '请先安装 Git for Windows')
  const identity = createHash('sha256')
    .update(await new SourceCapture(signal).file(executable, 64 * 1024 * 1024))
    .digest('hex')
  await fs.mkdir(cacheRoot, { recursive: true })
  await assertOrdinaryPath(cacheRoot)
  const root = path.join(cacheRoot, 'init-' + randomUUID())
  await fs.mkdir(path.join(root, 'template'), { recursive: true })
  const owned = path.join(root, 'worktree')
  await fs.mkdir(owned)
  const empty = path.join(root, 'empty.config')
  await fs.writeFile(empty, '')
  const env: NodeJS.ProcessEnv = {}
  for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'ComSpec'])
    if (process.env[key]) env[key] = process.env[key]
  Object.assign(env, {
    PATH: path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: empty,
    GIT_CONFIG_GLOBAL: empty,
    GIT_ATTR_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ALLOW_PROTOCOL: '',
    GIT_NO_LAZY_FETCH: '1'
  })
  let retained = false,
    installed = false
  let failure: unknown
  try {
    const version = decodeGitText(
      await runGitProcess({ executable, args: ['--version'], cwd: root, env, signal, onProcess })
    ).trim()
    const match = /^git version (\d+)\.(\d+)/.exec(version)
    if (!match || Number(match[1]) < 2 || (Number(match[1]) === 2 && Number(match[2]) < 56))
      throw new GitReadError('unavailable', '需要 Git 2.56 或更新版本')
    if (
      createHash('sha256')
        .update(await new SourceCapture(signal).file(executable, 64 * 1024 * 1024))
        .digest('hex') !== identity
    )
      throw new GitReadError('unavailable', 'Git 程序身份已变化')
    await runGitProcess({
      executable,
      args: ['init', '--initial-branch=main', '--template=' + path.join(root, 'template')],
      cwd: owned,
      env,
      signal,
      onProcess
    })
    await source.verify()
    signal?.throwIfAborted()
    // Exclusive creation never overwrites an existing repository, even if another process raced.
    const target = path.join(selectedPath, '.git')
    await fs.mkdir(target)
    installed = true
    await fs.cp(path.join(owned, '.git'), target, {
      recursive: true,
      force: false,
      errorOnExist: true
    })
  } catch (error) {
    if (error instanceof Error && error.message.includes('退出未确认')) retained = true
    if (installed)
      failure = new GitReadError(
        'error',
        'Git 元数据已创建，但初始化未完整确认；请检查所选目录后重新选择。' +
          (error instanceof Error ? error.message.slice(0, 300) : '')
      )
    else if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      failure = new GitReadError('stale', '目录中已出现 Git 元数据，未覆盖；请重新选择')
    else failure = error
  } finally {
    if (!retained) {
      try {
        await fs.rm(root, { recursive: true, force: true })
      } catch {
        failure = new GitReadError(
          'error',
          (installed ? 'Git 元数据已创建；' : '') + '初始化缓存清理失败，请关闭查看并核对目录'
        )
      }
    }
  }
  if (failure) throw failure
}
