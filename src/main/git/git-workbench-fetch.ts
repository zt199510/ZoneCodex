import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { GitActionData } from '../../shared/git-workbench'
import type { GitWorkbenchActionContext } from './git-workbench-reader'
import { GitReadError, runGitProcess } from './git-process'
import type { GitProcessObservation } from './git-process'
import {
  SourceCapture,
  assertOrdinaryPath,
  decodeGitText,
  gitSnapshotLimits,
  validRepositoryPath
} from './git-snapshot'
import { withGitRepositoryLock } from './git-workbench-lock'
import { createGitWorkbenchWriter } from './git-workbench-writer'
import { redactGitNetworkError } from './git-workbench-network'

type ProcessRunner = typeof runGitProcess
type FetchOptions = { onProcess?: (event: GitProcessObservation) => void; run?: ProcessRunner }
type Fetcher = (
  context: GitWorkbenchActionContext,
  remoteId: string,
  envOverrides?: NodeJS.ProcessEnv,
  signal?: AbortSignal
) => Promise<GitActionData>
interface FetchCopy {
  root: string
  gitdir: string
  worktree: string
  env: NodeJS.ProcessEnv
  retained: boolean
}
interface RefUpdate {
  ref: string
  oid: string
  branch: string
  expected: string | null
}
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const MAX_REFS = 2000
const blocked = new Map<string, string>()

function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new GitReadError('cancelled', 'Git 获取已取消')
}
function verifier(context: GitWorkbenchActionContext, signal?: AbortSignal): SourceCapture {
  const capture = new SourceCapture(signal)
  for (const [key, value] of context.snapshot.source.fingerprints)
    capture.fingerprints.set(key, value)
  return capture
}
function transport(raw: string): string {
  try {
    const url = new URL(raw)
    if (
      url.protocol !== 'https:' ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.hash ||
      url.search ||
      /\p{Cc}/u.test(raw)
    )
      throw Error()
    return url.toString()
  } catch {
    throw new GitReadError('unsupported', 'Git 获取只支持已展示的 HTTPS 远程地址')
  }
}
function refPath(ref: string): boolean {
  return (
    ref.startsWith('refs/remotes/') &&
    validRepositoryPath(ref) &&
    !/[\p{Cc} ~^?*]/u.test(ref) &&
    !ref.includes('[') &&
    !ref.includes('..') &&
    !ref.includes('@{') &&
    ref.split('/').every((part) => !part.startsWith('.') && !part.endsWith('.lock'))
  )
}
async function optional(
  filename: string,
  limit = gitSnapshotLimits.metadataBytes
): Promise<Buffer | null> {
  try {
    return await new SourceCapture().file(filename, limit)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}
async function currentRef(common: string, ref: string): Promise<string | null> {
  const bytes = await optional(path.join(common, ...ref.split('/')), 4096)
  if (bytes) {
    const value = decodeGitText(bytes).trim()
    if (!OID.test(value)) throw new GitReadError('unsupported', '远程 ref 内容不支持')
    return value
  }
  const packed = await optional(path.join(common, 'packed-refs'))
  if (packed)
    for (const line of decodeGitText(packed).split(/\r?\n/)) {
      if (line.endsWith(' ' + ref)) {
        const oid = line.slice(0, line.indexOf(' '))
        if (!OID.test(oid)) throw new GitReadError('error', '打包 ref 内容无效')
        return oid
      }
    }
  return null
}
async function publish(
  filename: string,
  bytes: Buffer,
  expected: Buffer | null,
  signal?: AbortSignal
): Promise<void> {
  cancelled(signal)
  await assertOrdinaryPath(path.dirname(filename), true)
  await fs.mkdir(path.dirname(filename), { recursive: true })
  const lock = filename + '.lock'
  let handle: Awaited<ReturnType<typeof fs.open>>
  try {
    handle = await fs.open(lock, 'wx', 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new GitReadError('stale', 'Git 元数据已被其他操作锁定；请刷新')
    throw error
  }
  let done = false
  try {
    const now = await optional(filename)
    if (expected === null ? now !== null : !now?.equals(expected))
      throw new GitReadError('stale', 'Git 元数据在发布前已变化')
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close()
    cancelled(signal)
    await assertOrdinaryPath(filename, true)
    await fs.rename(lock, filename)
    done = true
  } finally {
    await handle.close().catch(() => {})
    if (!done)
      await fs.unlink(lock).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      })
  }
}
async function publishRef(common: string, update: RefUpdate, signal?: AbortSignal): Promise<void> {
  const filename = path.join(common, ...update.ref.split('/'))
  await assertOrdinaryPath(path.dirname(filename), true)
  await fs.mkdir(path.dirname(filename), { recursive: true })
  const lock = filename + '.lock'
  let handle: Awaited<ReturnType<typeof fs.open>>
  try {
    handle = await fs.open(lock, 'wx', 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new GitReadError('stale', '远程分支正在更新；请刷新')
    throw error
  }
  let done = false
  try {
    if ((await currentRef(common, update.ref)) !== update.expected)
      throw new GitReadError('stale', '远程分支在发布前已变化')
    await handle.writeFile(update.oid + '\n')
    await handle.sync()
    await handle.close()
    cancelled(signal)
    await assertOrdinaryPath(filename, true)
    await fs.rename(lock, filename)
    done = true
  } finally {
    await handle.close().catch(() => {})
    if (!done)
      await fs.unlink(lock).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      })
  }
}
async function objectBudget(gitdir: string, signal?: AbortSignal): Promise<void> {
  let bytes = 0,
    files = 0
  async function walk(directory: string): Promise<void> {
    cancelled(signal)
    await assertOrdinaryPath(directory)
    for (const name of await fs.readdir(directory)) {
      const filename = path.join(directory, name)
      await assertOrdinaryPath(filename)
      const stat = await fs.lstat(filename)
      if (stat.isDirectory()) {
        await walk(filename)
        continue
      }
      if (!stat.isFile()) throw new GitReadError('unsupported', '获取的对象类型不支持')
      bytes += stat.size
      files++
      if (bytes > gitSnapshotLimits.objectBytes || files > gitSnapshotLimits.objectFiles)
        throw new GitReadError('too-large', '获取后的对象快照超过 128 MiB / 20000 文件')
    }
  }
  await walk(path.join(gitdir, 'objects'))
}

/** Injectable runner is an internal test seam, never an IPC parameter or transport grant. */
export function createGitWorkbenchFetcher(options: FetchOptions = {}): Fetcher {
  const executeProcess = options.run ?? runGitProcess
  const publisher = createGitWorkbenchWriter({ onProcess: options.onProcess })
  async function run(
    context: GitWorkbenchActionContext,
    work: FetchCopy,
    args: string[],
    signal?: AbortSignal,
    input?: Buffer
  ): Promise<Buffer> {
    cancelled(signal)
    const program = await new SourceCapture(signal).file(
      context.program.executable,
      64 * 1024 * 1024
    )
    if (createHash('sha256').update(program).digest('hex') !== context.program.sha256)
      throw new GitReadError('unavailable', 'Git 程序身份已变化')
    try {
      return await executeProcess({
        executable: context.program.executable,
        args: [
          '--no-optional-locks',
          '-c',
          'core.fsmonitor=false',
          '-c',
          'core.hooksPath=' + path.join(work.root, 'no-hooks'),
          '-c',
          'maintenance.auto=false',
          '-c',
          'gc.auto=0',
          '-c',
          'http.followRedirects=false',
          ...args
        ],
        cwd: work.worktree,
        env: work.env,
        signal,
        input,
        onProcess: options.onProcess,
        timeoutMs: 60_000,
        stdoutBytes: 1024 * 1024
      })
    } catch (error) {
      const message = redactGitNetworkError(error, work.env.GIT_CONFIG_VALUE_0)
      if (error instanceof Error && error.message.includes('退出未确认')) {
        work.retained = true
        blocked.set(context.location.common.toLowerCase(), message)
      }
      throw new GitReadError(error instanceof GitReadError ? error.status : 'error', message)
    }
  }
  return async (context, remoteId, envOverrides = {}, signal) => {
    if (context.location.scopePath)
      throw new GitReadError('unsupported', '获取远程分支需要选择仓库根目录')
    const key = context.location.common.toLowerCase()
    if (blocked.has(key)) throw new GitReadError('error', blocked.get(key)!)
    const remote = context.remotes.get(remoteId)
    if (!remote) throw new GitReadError('stale', '所选远程已失效')
    const url = transport(remote.url)
    if (!refPath('refs/remotes/' + remote.name + '/branch'))
      throw new GitReadError('unsupported', '远程名称不支持')
    return withGitRepositoryLock(context.location.common, signal, async () => {
      await verifier(context, signal).verify()
      const root = path.join(path.dirname(context.snapshot.root), 'fetch-' + randomUUID())
      const gitdir = path.join(root, 'git'),
        worktree = path.join(root, 'worktree')
      const work: FetchCopy = {
        root,
        gitdir,
        worktree,
        env: {
          ...context.snapshot.env,
          GIT_DIR: gitdir,
          GIT_COMMON_DIR: gitdir,
          GIT_INDEX_FILE: path.join(gitdir, 'index'),
          GIT_WORK_TREE: worktree,
          GIT_ALLOW_PROTOCOL: 'https',
          GIT_PROTOCOL_FROM_USER: '0',
          GIT_NO_LAZY_FETCH: '1'
        },
        retained: false
      }
      const authorization = envOverrides.GIT_CONFIG_VALUE_0
      if (authorization !== undefined) {
        if (
          envOverrides.GIT_CONFIG_COUNT !== '1' ||
          envOverrides.GIT_CONFIG_KEY_0 !== 'http.' + url + '.extraHeader' ||
          !/^Authorization: Basic [A-Za-z0-9+/]+=*$/.test(authorization)
        )
          throw new GitReadError('unsupported', '获取认证配置不符合当前远程')
        work.env.GIT_CONFIG_COUNT = '1'
        work.env.GIT_CONFIG_KEY_0 = envOverrides.GIT_CONFIG_KEY_0
        work.env.GIT_CONFIG_VALUE_0 = authorization
      }
      let publication = false,
        fetchHeadPublished = false
      let result: GitActionData | undefined
      let failure: Error | undefined
      const published: string[] = []
      const fetchHead = path.join(context.location.gitdir, 'FETCH_HEAD')
      const originalFetchHead = await optional(fetchHead)
      try {
        await fs.mkdir(worktree, { recursive: true })
        await fs.cp(context.snapshot.gitdir, gitdir, { recursive: true, dereference: false })
        await assertOrdinaryPath(gitdir)
        const packdir = path.join(gitdir, 'objects', 'pack')
        let oldPacks: string[] = []
        try {
          oldPacks = await fs.readdir(packdir)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        const namespace = 'refs/zonecodex-fetch/' + randomUUID()
        await run(
          context,
          work,
          [
            '-c',
            'fetch.unpackLimit=2147483647',
            '-c',
            'transfer.unpackLimit=2147483647',
            'fetch',
            '--atomic',
            '--no-auto-maintenance',
            '--no-write-fetch-head',
            '--no-tags',
            '--no-recurse-submodules',
            '--refmap=',
            '--',
            url,
            '+refs/heads/*:' + namespace + '/*'
          ],
          signal
        )
        await objectBudget(gitdir, signal)
        // A transport may still return a pack. Verify it in owned storage, then remove its
        // index from that store before unpacking; otherwise Git would skip packed objects.
        let packs: string[] = []
        try {
          packs = await fs.readdir(packdir)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        for (const name of packs.filter(
          (name) => /^pack-[a-f0-9]+\.pack$/.test(name) && !oldPacks.includes(name)
        )) {
          const filename = path.join(packdir, name)
          await run(context, work, ['index-pack', '--verify', '--strict', filename], signal)
          const bytes = await new SourceCapture(signal).file(
            filename,
            gitSnapshotLimits.objectBytes
          )
          const keep = path.join(root, name)
          await fs.rename(filename, keep)
          for (const suffix of ['.idx', '.rev', '.bitmap'])
            await fs.unlink(path.join(packdir, name.replace(/\.pack$/, suffix))).catch((error) => {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
            })
          await run(context, work, ['unpack-objects', '--strict'], signal, bytes)
          await fs.unlink(keep)
          await objectBudget(gitdir, signal)
        }
        const output = decodeGitText(
          await run(
            context,
            work,
            ['for-each-ref', '--format=%(objectname)%00%(refname)', namespace + '/'],
            signal
          )
        )
        const updates: RefUpdate[] = []
        for (const line of output.split(/\r?\n/).filter(Boolean)) {
          const [oid, ref] = line.split('\0')
          if (!OID.test(oid) || !ref?.startsWith(namespace + '/'))
            throw new GitReadError('error', '获取 ref 协议不完整')
          const branch = ref.slice(namespace.length + 1)
          const target = 'refs/remotes/' + remote.name + '/' + branch
          if (!refPath(target)) throw new GitReadError('unsupported', '获取的分支名称不支持')
          updates.push({
            ref: target,
            oid,
            branch,
            expected: [...context.refs.values()].find((item) => item.ref === target)?.oid ?? null
          })
          if (updates.length > MAX_REFS)
            throw new GitReadError('too-large', '获取的分支超过 2000 项')
          await run(context, work, ['cat-file', '-e', oid + '^{commit}'], signal)
        }
        await verifier(context, signal).verify()
        await run(context, work, ['fsck', '--strict', '--no-reflogs', '--no-dangling'], signal)
        cancelled(signal)
        publication = true
        await publisher.publishObjects(context, gitdir, signal)
        for (const update of updates) {
          await publishRef(context.location.common, update, signal)
          published.push(update.ref)
        }
        const fetchHeadText = updates
          .map((update) => update.oid + "\t\tbranch '" + update.branch + "' of " + url + '\n')
          .join('')
        await publish(fetchHead, Buffer.from(fetchHeadText), originalFetchHead, signal)
        fetchHeadPublished = true
        result = {
          outcome: 'success',
          stage: 'remote-fetch',
          appliedItemIds: [],
          message:
            '已获取 ' +
            remote.name +
            ' 的 ' +
            updates.length +
            ' 个分支；本地分支和工作目录保持原状'
        }
      } catch (error) {
        if (publication)
          result = {
            outcome: 'partial-success',
            stage: fetchHeadPublished
              ? 'fetch-complete'
              : published.length
                ? 'fetch-refs'
                : 'fetch-objects',
            appliedItemIds: [],
            message:
              '获取后发布未完整确认；已更新 ' +
              published.length +
              ' 个远程分支，对象库可能已追加数据。请刷新核对。' +
              (error instanceof Error ? error.message.replace(/\p{Cc}/gu, ' ').slice(0, 500) : '')
          }
        else failure = error instanceof Error ? error : new GitReadError('error', '获取失败')
      } finally {
        delete work.env.GIT_CONFIG_VALUE_0
        if (!work.retained) {
          try {
            await fs.rm(root, { recursive: true, force: true })
          } catch {
            if (result)
              result = {
                ...result,
                outcome: 'partial-success',
                stage: 'fetch-cleanup',
                message:
                  result.message + ' 获取缓存清理失败，已保留诊断缓存；请刷新核对已发布的仓库状态。'
              }
            else
              failure = new GitReadError(
                'error',
                '获取失败，诊断缓存清理也未确认；请重启应用后重试'
              )
          }
        }
      }
      if (failure) throw failure
      if (!result) throw new GitReadError('error', '获取结果未确认')
      return result
    })
  }
}

/** Holds the shared per-repository lock internally. Callers must not acquire it again. */
export const fetchGitWorkbench: Fetcher = createGitWorkbenchFetcher()
