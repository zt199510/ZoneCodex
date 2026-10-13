import { promises as fs, constants } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { inflateSync } from 'node:zlib'
import { setTimeout as pause } from 'node:timers/promises'
import type { GitChangeItem } from '../../shared/git-view'
import type { GitActionRequest } from '../../shared/git-workbench'
import { gitWorkbenchLimits } from '../../shared/git-workbench'
import { GitReadError, runGitProcess } from './git-process'
import type { GitProcessObservation } from './git-process'
import { withGitRepositoryLock } from './git-workbench-lock'
import {
  SourceCapture,
  assertOrdinaryPath,
  decodeGitText,
  gitSnapshotLimits,
  validRepositoryPath,
  withinScope
} from './git-snapshot'

type WriterItem = {
  publicItem: {
    itemId: string
    path: string
    previousPath?: string | null
    group?: string
    actions?: string[]
  }
  path: string
  previousPath?: string | null
  patch?: string
  hunks: Map<string, string>
}
/** Internal context only. None of these paths, refs or executable arguments are IPC inputs. */
export interface GitWorkbenchWriterContext {
  location: {
    repositoryPath: string
    selectedPath: string
    scopePath: string
    gitdir: string
    common: string
  }
  snapshot: {
    root: string
    gitdir: string
    worktree: string
    env: NodeJS.ProcessEnv
    source: SourceCapture
    revision: string
    items: GitChangeItem[]
    head: 'present' | 'unborn'
    ignoreCase: boolean
  }
  program: { executable: string; sha256: string }
  refs: Map<string, { ref: string; oid: string; name?: string; remote?: boolean }>
  review?: {
    revision: string
    source: string
    items: Map<string, WriterItem>
  }
  identity?: { name: string; email: string }
}
export interface GitWorkbenchWriteResult {
  outcome: 'success' | 'partial-success'
  stage: string
  appliedItemIds: string[]
  message: string
  headSha?: string
}
interface WorkCopy {
  root: string
  gitdir: string
  worktree: string
  env: NodeJS.ProcessEnv
}
interface IndexValue {
  mode: string
  oid: string
  stage: number
}
interface FilePlan {
  relative: string
  bytes: Buffer | null
  mode?: number
}
interface HeldLock {
  filename: string
  target: string
  handle: Awaited<ReturnType<typeof fs.open>>
  published: boolean
}
const blocked = new Map<string, string>()
const MAX_PATCH_BYTES = gitWorkbenchLimits.patchBytes
const oidPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : 'Git 操作失败')
    .replace(/\p{Cc}/gu, ' ')
    .slice(0, 500)
}
function abort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new GitReadError('cancelled', 'Git 操作已取消')
}
function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}
function verifier(context: GitWorkbenchWriterContext, signal?: AbortSignal): SourceCapture {
  const result = new SourceCapture(signal)
  for (const [name, value] of context.snapshot.source.fingerprints)
    result.fingerprints.set(name, value)
  return result
}
function repositoryOnly(context: GitWorkbenchWriterContext): void {
  if (context.location.scopePath)
    throw new GitReadError('unsupported', '提交和分支操作需要选择仓库根目录，以显示完整作用范围')
}
function pathsOf(context: GitWorkbenchWriterContext, item: WriterItem): string[] {
  const names = [...new Set([item.path, ...(item.previousPath ? [item.previousPath] : [])])]
  for (const name of names)
    if (
      !validRepositoryPath(name) ||
      !withinScope(name, context.location.scopePath, context.snapshot.ignoreCase)
    )
      throw new GitReadError('unsupported', 'Git 项目路径超出所选范围或不是普通本地路径')
  return names
}
async function optionalBytes(
  filename: string,
  maximum = gitSnapshotLimits.metadataBytes
): Promise<Buffer | null> {
  try {
    return await new SourceCapture().file(filename, maximum)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}
function sameBytes(left: Buffer | null, right: Buffer | null): boolean {
  return left === null ? right === null : right !== null && left.equals(right)
}
async function lock(target: string): Promise<HeldLock> {
  await assertOrdinaryPath(target, true)
  await assertOrdinaryPath(path.dirname(target))
  const filename = target + '.lock'
  try {
    const handle = await fs.open(
      filename,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600
    )
    return { filename, target, handle, published: false }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new GitReadError('stale', '仓库正在被另一个 Git 操作使用；现有锁保持不动')
    throw error
  }
}
async function publish(held: HeldLock, bytes: Buffer): Promise<void> {
  await held.handle.writeFile(bytes)
  await held.handle.sync()
  await held.handle.close()
  await fs.rename(held.filename, held.target)
  held.published = true
}
async function unlock(held: HeldLock): Promise<void> {
  await held.handle.close().catch(() => {})
  if (!held.published)
    await fs.unlink(held.filename).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
}
async function checkExpected(filename: string, expected: Buffer | null): Promise<void> {
  if (!sameBytes(await optionalBytes(filename), expected))
    throw new GitReadError('stale', 'Git index、HEAD 或分支已变化，请刷新后重试')
}
async function verifyFile(context: GitWorkbenchWriterContext, relative: string): Promise<void> {
  const target = path.join(context.location.repositoryPath, ...relative.split('/'))
  const original = context.snapshot.source.fingerprints.get(target)
  // Newly tracked/deleted paths need an explicit missing capture, never an assumed absence.
  if (!original) {
    await assertOrdinaryPath(target, true)
    if (await optionalBytes(target, gitSnapshotLimits.trackedFileBytes))
      throw new GitReadError('stale', 'Git 目标文件已出现，请刷新')
    return
  }
  const capture = new SourceCapture()
  capture.fingerprints.set(target, original)
  await capture.verify()
}

export function createGitWorkbenchWriter(
  options: {
    onProcess?: (event: GitProcessObservation) => void
  } = {}
): {
  execute: (
    context: GitWorkbenchWriterContext,
    request: GitActionRequest,
    signal?: AbortSignal
  ) => Promise<GitWorkbenchWriteResult>
  /** Caller must hold withGitRepositoryLock; this never updates refs or the original index. */
  publishObjects: (
    context: GitWorkbenchWriterContext,
    ownedGitdir: string,
    signal?: AbortSignal
  ) => Promise<void>
} {
  async function run(
    context: GitWorkbenchWriterContext,
    work: WorkCopy,
    args: string[],
    signal?: AbortSignal,
    input?: Buffer,
    extraEnv?: NodeJS.ProcessEnv
  ): Promise<Buffer> {
    abort(signal)
    const executable = await new SourceCapture(signal).file(
      context.program.executable,
      64 * 1024 * 1024
    )
    if (digest(executable) !== context.program.sha256)
      throw new GitReadError('unavailable', 'Git 程序身份已变化')
    try {
      return await runGitProcess({
        executable: context.program.executable,
        args: ['--no-optional-locks', ...args],
        cwd: work.worktree,
        env: { ...work.env, ...extraEnv },
        signal,
        input,
        stdoutBytes: args.includes('diff') ? MAX_PATCH_BYTES : gitSnapshotLimits.metadataBytes,
        onProcess: options.onProcess
      })
    } catch (error) {
      if (error instanceof Error && error.message.includes('退出未确认'))
        blocked.set(context.location.common.toLowerCase(), error.message)
      throw error
    }
  }
  async function clone(
    context: GitWorkbenchWriterContext,
    signal?: AbortSignal
  ): Promise<WorkCopy> {
    abort(signal)
    const root = path.join(path.dirname(context.snapshot.root), 'write-' + randomUUID())
    const gitdir = path.join(root, 'git')
    const worktree = path.join(root, 'worktree')
    await fs.mkdir(root, { recursive: true })
    await fs.cp(context.snapshot.gitdir, gitdir, { recursive: true, dereference: false })
    await fs.cp(context.snapshot.worktree, worktree, { recursive: true, dereference: false })
    return {
      root,
      gitdir,
      worktree,
      env: {
        ...context.snapshot.env,
        GIT_DIR: gitdir,
        GIT_COMMON_DIR: gitdir,
        GIT_INDEX_FILE: path.join(gitdir, 'index'),
        GIT_WORK_TREE: worktree,
        GIT_CONFIG_COUNT: '8',
        GIT_CONFIG_KEY_0: 'core.hooksPath',
        GIT_CONFIG_VALUE_0: path.join(root, 'no-hooks'),
        GIT_CONFIG_KEY_1: 'commit.gpgSign',
        GIT_CONFIG_VALUE_1: 'false',
        GIT_CONFIG_KEY_2: 'tag.gpgSign',
        GIT_CONFIG_VALUE_2: 'false',
        GIT_CONFIG_KEY_3: 'core.fsmonitor',
        GIT_CONFIG_VALUE_3: 'false',
        GIT_CONFIG_KEY_4: 'maintenance.auto',
        GIT_CONFIG_VALUE_4: 'false',
        GIT_CONFIG_KEY_5: 'gc.auto',
        GIT_CONFIG_VALUE_5: '0',
        GIT_CONFIG_KEY_6: 'core.splitIndex',
        GIT_CONFIG_VALUE_6: 'false',
        GIT_CONFIG_KEY_7: 'index.version',
        GIT_CONFIG_VALUE_7: '2'
      }
    }
  }
  async function index(
    context: GitWorkbenchWriterContext,
    work: WorkCopy,
    signal?: AbortSignal
  ): Promise<Map<string, IndexValue>> {
    const output = await run(
      context,
      work,
      ['--literal-pathspecs', 'ls-files', '--stage', '-z'],
      signal
    )
    const values = new Map<string, IndexValue>()
    for (const entry of decodeGitText(output).split('\0').filter(Boolean)) {
      const match = /^(\d{6}) ([a-f0-9]{40,64}) ([0-3])\t(.+)$/.exec(entry)
      if (!match || !validRepositoryPath(match[4]) || !oidPattern.test(match[2]))
        throw new GitReadError('unsupported', 'Git index 含不支持的项目')
      if (match[3] !== '0') throw new GitReadError('unsupported', '冲突 index 不能执行此操作')
      if (match[1] !== '100644' && match[1] !== '100755')
        throw new GitReadError('unsupported', '此写操作不支持符号链接、子模块或特殊文件')
      values.set(match[4], { mode: match[1], oid: match[2], stage: Number(match[3]) })
    }
    return values
  }
  async function hydrate(
    context: GitWorkbenchWriterContext,
    work: WorkCopy,
    names: string[],
    signal?: AbortSignal
  ): Promise<void> {
    const capture = new SourceCapture(signal)
    for (const name of names) {
      const source = path.join(context.location.repositoryPath, ...name.split('/'))
      const bytes = await optionalBytes(source, gitSnapshotLimits.trackedFileBytes)
      if (bytes === null) continue
      await capture.file(source, gitSnapshotLimits.trackedFileBytes, 'worktree')
      const target = path.join(work.worktree, ...name.split('/'))
      await fs.mkdir(path.dirname(target), { recursive: true })
      const stat = await fs.lstat(source)
      await fs.writeFile(target, bytes, { mode: stat.mode })
    }
    await capture.verify()
    let bytes = 0,
      entries = 0
    async function checkOwned(directory: string): Promise<void> {
      for (const name of await fs.readdir(directory)) {
        const filename = path.join(directory, name)
        await assertOrdinaryPath(filename)
        const stat = await fs.lstat(filename)
        if (++entries > gitSnapshotLimits.worktreeEntries)
          throw new GitReadError('too-large', '生成工作树超过项数容量')
        if (stat.isDirectory()) await checkOwned(filename)
        else if (stat.isFile()) {
          bytes += stat.size
          if (
            stat.size > gitSnapshotLimits.trackedFileBytes ||
            bytes > gitSnapshotLimits.worktreeBytes
          )
            throw new GitReadError('too-large', '生成工作树超过既有容量')
        } else throw new GitReadError('unsupported', '生成工作树含非普通文件')
      }
    }
    await checkOwned(work.worktree)
  }
  async function transferObjects(
    context: GitWorkbenchWriterContext,
    work: Pick<WorkCopy, 'gitdir'>,
    signal?: AbortSignal
  ): Promise<void> {
    const owned = path.join(work.gitdir, 'objects')
    let ownedBytes = 0,
      ownedFiles = 0
    async function checkBudget(directory: string): Promise<void> {
      for (const name of await fs.readdir(directory)) {
        const filename = path.join(directory, name)
        await assertOrdinaryPath(filename)
        const stat = await fs.lstat(filename)
        if (stat.isDirectory()) await checkBudget(filename)
        else if (stat.isFile()) {
          ownedBytes += stat.size
          if (
            ++ownedFiles > gitSnapshotLimits.objectFiles ||
            ownedBytes > gitSnapshotLimits.objectBytes
          )
            throw new GitReadError('too-large', '生成对象快照超过既有容量')
        } else throw new GitReadError('unsupported', '生成对象库含非普通文件')
      }
    }
    await checkBudget(owned)
    let total = 0
    let count = 0
    const hashFormat = context.snapshot.env.GIT_DEFAULT_HASH === 'sha256' ? 'sha256' : undefined
    for (const fanout of await fs.readdir(owned)) {
      if (!/^[a-f0-9]{2}$/.test(fanout)) continue
      for (const name of await fs.readdir(path.join(owned, fanout))) {
        abort(signal)
        const oid = fanout + name
        if (!oidPattern.test(oid)) throw new GitReadError('error', '生成对象名称无效')
        const original = path.join(context.location.common, 'objects', fanout, name)
        if (await optionalBytes(original, gitSnapshotLimits.objectBytes)) continue
        const compressed = await new SourceCapture(signal).file(
          path.join(owned, fanout, name),
          gitSnapshotLimits.objectBytes
        )
        total += compressed.length
        if (total > gitSnapshotLimits.objectBytes || ++count > gitSnapshotLimits.objectFiles)
          throw new GitReadError('too-large', '生成 Git 对象超过既有容量')
        const inflated = inflateSync(compressed, { maxOutputLength: gitSnapshotLimits.objectBytes })
        if (
          createHash(hashFormat ?? (oid.length === 64 ? 'sha256' : 'sha1'))
            .update(inflated)
            .digest('hex') !== oid
        )
          throw new GitReadError('error', '生成对象校验失败')
        await assertOrdinaryPath(path.dirname(original), true)
        await fs.mkdir(path.dirname(original), { recursive: true })
        try {
          const handle = await fs.open(original, 'wx', 0o444)
          try {
            await handle.writeFile(compressed)
            await handle.sync()
          } finally {
            await handle.close()
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
          const concurrent = await optionalBytes(original, gitSnapshotLimits.objectBytes)
          if (!concurrent || !concurrent.equals(compressed))
            throw new GitReadError('stale', '同名 Git 对象发生竞争；未覆盖已有对象')
        }
      }
    }
  }
  async function installIndex(
    context: GitWorkbenchWriterContext,
    work: WorkCopy,
    expected: Buffer | null,
    signal?: AbortSignal
  ): Promise<void> {
    abort(signal)
    const held = await lock(path.join(context.location.gitdir, 'index'))
    try {
      await checkExpected(held.target, expected)
      abort(signal)
      const bytes = await optionalBytes(path.join(work.gitdir, 'index'))
      if (!bytes) throw new GitReadError('error', '生成 index 缺失')
      await publish(held, bytes)
    } finally {
      await unlock(held)
    }
  }
  async function filePlans(
    context: GitWorkbenchWriterContext,
    work: WorkCopy,
    names: string[],
    signal?: AbortSignal
  ): Promise<FilePlan[]> {
    const values = await index(context, work, signal)
    const plans: FilePlan[] = []
    for (const relative of names) {
      const value = values.get(relative)
      if (!value) {
        plans.push({ relative, bytes: null })
        continue
      }
      const bytes = await run(context, work, ['cat-file', 'blob', value.oid], signal)
      if (bytes.length > gitSnapshotLimits.trackedFileBytes)
        throw new GitReadError('too-large', '还原文件超过既有容量')
      // Git checkout-index applies only the captured built-in eol/text semantics.
      await run(
        context,
        work,
        ['--literal-pathspecs', 'checkout-index', '--force', '--', relative],
        signal
      )
      const checkedOut = await new SourceCapture(signal).file(
        path.join(work.worktree, ...relative.split('/')),
        gitSnapshotLimits.trackedFileBytes
      )
      plans.push({ relative, bytes: checkedOut, mode: value.mode === '100755' ? 0o755 : 0o644 })
    }
    return plans
  }
  async function installFiles(
    context: GitWorkbenchWriterContext,
    plans: FilePlan[],
    signal?: AbortSignal
  ): Promise<string[]> {
    const installed: string[] = []
    for (const plan of plans) {
      abort(signal)
      await verifyFile(context, plan.relative)
      const target = path.join(context.location.repositoryPath, ...plan.relative.split('/'))
      if (plan.bytes === null) {
        try {
          await fs.unlink(target)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      } else {
        await assertOrdinaryPath(path.dirname(target), true)
        await fs.mkdir(path.dirname(target), { recursive: true })
        const temporary = path.join(path.dirname(target), '.zonecodex-write-' + randomUUID())
        try {
          await fs.writeFile(temporary, plan.bytes, { flag: 'wx', mode: plan.mode })
          for (let attempt = 0; ; attempt++) {
            abort(signal)
            await verifyFile(context, plan.relative)
            try {
              await fs.rename(temporary, target)
              break
            } catch (error) {
              // Windows readers/scanners may briefly deny file replacement. Retry the
              // atomic rename only, and recheck the original bytes before each attempt.
              if (
                process.platform !== 'win32' ||
                attempt >= 5 ||
                !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')
              )
                throw error
              await pause(40 * (attempt + 1))
            }
          }
        } finally {
          await fs.unlink(temporary).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error
          })
        }
      }
      installed.push(plan.relative)
    }
    return installed
  }
  function selected(
    context: GitWorkbenchWriterContext,
    request: Extract<GitActionRequest, { itemIds: string[] }>
  ): WriterItem[] {
    if (
      context.snapshot.revision !== request.revision &&
      context.review?.revision !== request.revision
    )
      throw new GitReadError('stale', 'Git 列表版本已失效，请刷新')
    const source =
      context.review?.revision === request.revision
        ? context.review.items
        : new Map(
            context.snapshot.items.map((item) => [
              item.itemId,
              {
                publicItem: item,
                path: item.path,
                previousPath: item.previousPath,
                hunks: new Map<string, string>()
              }
            ])
          )
    const items = request.itemIds.map((id) => source.get(id))
    if (items.some((item) => !item)) throw new GitReadError('stale', 'Git 项目标识已失效')
    return items as WriterItem[]
  }
  async function applyItems(
    context: GitWorkbenchWriterContext,
    work: WorkCopy,
    request: Extract<GitActionRequest, { itemIds: string[] }>,
    signal?: AbortSignal
  ): Promise<{ names: string[]; itemIds: string[]; worktreeGenerated: boolean }> {
    const items = selected(context, request)
    if (!items.length) throw new GitReadError('stale', '没有可操作的 Git 项目')
    if (context.review && !['staged', 'unstaged', 'uncommitted'].includes(context.review.source))
      throw new GitReadError('unsupported', '历史提交或分支比较不能执行工作树写操作')
    for (const item of items) {
      const group = item.publicItem.group ?? context.review?.source
      if (
        (item.publicItem.actions && !item.publicItem.actions.includes(request.action)) ||
        (request.action === 'stage' && group === 'staged') ||
        (request.action === 'unstage' && group !== 'staged')
      )
        throw new GitReadError('unsupported', '此比较来源不支持所选动作')
    }
    const names = [...new Set(items.flatMap((item) => pathsOf(context, item)))]
    if (
      request.hunkIds?.length &&
      context.review?.source === 'uncommitted' &&
      context.snapshot.items.some(
        (item) =>
          item.group === 'staged' &&
          names.some((name) => item.path === name || item.previousPath === name)
      )
    )
      throw new GitReadError(
        'unsupported',
        '此文件同时存在已暂存改动；请切换到已暂存或未暂存来源，再操作差异块'
      )
    await index(context, work, signal)
    const stagedRevert =
      request.action === 'revert' &&
      items.some((item) => (item.publicItem.group ?? context.review?.source) === 'staged')
    let worktreeGenerated = false
    if (stagedRevert && !request.hunkIds?.length) {
      await hydrate(context, work, names, signal)
      const patch = await run(
        context,
        work,
        [
          '--literal-pathspecs',
          'diff',
          '--cached',
          '--binary',
          '--full-index',
          '--no-ext-diff',
          '--no-textconv',
          '--no-color',
          '--',
          ...names
        ],
        signal
      )
      if (patch.length > MAX_PATCH_BYTES)
        throw new GitReadError('too-large', '还原补丁超过既有差异容量')
      for (const cached of [true, false]) {
        const args = ['apply', '--whitespace=nowarn', '--reverse', ...(cached ? ['--cached'] : [])]
        await run(context, work, [...args, '--check', '-'], signal, patch)
        await run(context, work, [...args, '-'], signal, patch)
      }
      worktreeGenerated = true
    } else if (request.hunkIds?.length) {
      if (request.action === 'revert') await hydrate(context, work, names, signal)
      const patches = request.hunkIds.map((id) =>
        items.flatMap((item) =>
          [...item.hunks].filter(([hunkId]) => hunkId === id).map(([, patch]) => patch)
        )
      )
      if (patches.some((matches) => matches.length !== 1))
        throw new GitReadError('stale', 'Git 差异块标识已失效')
      const patch = Buffer.from(patches.flat().join(''))
      if (patch.length > MAX_PATCH_BYTES) throw new GitReadError('too-large', '差异块超过预览容量')
      const reverse = request.action !== 'stage'
      const args = [
        'apply',
        '--whitespace=nowarn',
        ...(reverse ? ['--reverse'] : []),
        ...(request.action === 'revert' ? [] : ['--cached'])
      ]
      if (
        request.action === 'revert' &&
        items.some((item) => (item.publicItem.group ?? context.review?.source) === 'staged')
      ) {
        const cached = ['apply', '--whitespace=nowarn', '--reverse', '--cached']
        await run(context, work, [...cached, '--check', '-'], signal, patch)
        await run(context, work, [...cached, '-'], signal, patch)
      }
      await run(context, work, [...args, '--check', '-'], signal, patch)
      await run(context, work, [...args, '-'], signal, patch)
      worktreeGenerated = request.action === 'revert'
    } else if (request.action === 'stage') {
      await hydrate(context, work, names, signal)
      await run(context, work, ['--literal-pathspecs', 'add', '--all', '--', ...names], signal)
    } else if (
      request.action === 'unstage' ||
      (request.action === 'revert' && context.review?.source === 'uncommitted')
    ) {
      if (context.snapshot.head === 'present')
        await run(
          context,
          work,
          ['--literal-pathspecs', 'reset', '--quiet', 'HEAD', '--', ...names],
          signal
        )
      else
        await run(
          context,
          work,
          ['--literal-pathspecs', 'rm', '--cached', '--force', '--ignore-unmatch', '--', ...names],
          signal
        )
    }
    return { names, itemIds: items.map((item) => item.publicItem.itemId), worktreeGenerated }
  }
  async function headState(
    context: GitWorkbenchWriterContext
  ): Promise<{ bytes: Buffer; oid: string | null; ref: string | null; refBytes: Buffer | null }> {
    const bytes = await optionalBytes(path.join(context.location.gitdir, 'HEAD'), 4096)
    if (!bytes) throw new GitReadError('stale', 'Git HEAD 缺失')
    const text = decodeGitText(bytes).trim()
    if (oidPattern.test(text)) return { bytes, oid: text, ref: null, refBytes: null }
    if (!text.startsWith('ref: refs/heads/'))
      throw new GitReadError('unsupported', '不支持的 Git HEAD')
    const ref = text.slice(5)
    if (!validRepositoryPath(ref)) throw new GitReadError('unsupported', 'Git 分支路径不支持')
    const refBytes = await optionalBytes(
      path.join(context.location.common, ...ref.split('/')),
      4096
    )
    let oid = refBytes ? decodeGitText(refBytes).trim() : null
    if (!oid) {
      const packed = await optionalBytes(path.join(context.location.common, 'packed-refs'))
      if (packed)
        oid =
          decodeGitText(packed)
            .split(/\r?\n/)
            .find((line) => line.endsWith(' ' + ref))
            ?.split(' ')[0] ?? null
    }
    if (oid !== null && !oidPattern.test(oid))
      throw new GitReadError('unsupported', 'Git ref 内容无效')
    return { bytes, oid, ref, refBytes }
  }
  async function currentRefOID(
    context: GitWorkbenchWriterContext,
    ref: string
  ): Promise<string | null> {
    const loose = await optionalBytes(path.join(context.location.common, ...ref.split('/')), 4096)
    const packed = loose
      ? null
      : await optionalBytes(path.join(context.location.common, 'packed-refs'))
    const oid = loose
      ? decodeGitText(loose).trim()
      : packed
        ? (decodeGitText(packed)
            .split(/\r?\n/)
            .find((line) => line.endsWith(' ' + ref))
            ?.split(' ')[0] ?? null)
        : null
    if (oid !== null && !oidPattern.test(oid))
      throw new GitReadError('unsupported', 'Git ref 内容无效')
    return oid
  }
  async function publishRef(
    context: GitWorkbenchWriterContext,
    state: Awaited<ReturnType<typeof headState>>,
    oid: string,
    newRef?: string,
    signal?: AbortSignal,
    publication?: { switchHead?: boolean; onPublish?: () => void }
  ): Promise<void> {
    abort(signal)
    const headLock = await lock(path.join(context.location.gitdir, 'HEAD'))
    let refLock: HeldLock | undefined
    try {
      await checkExpected(headLock.target, state.bytes)
      const ref = newRef ?? state.ref
      if (ref) {
        const target = path.join(context.location.common, ...ref.split('/'))
        await assertOrdinaryPath(path.dirname(target), true)
        await fs.mkdir(path.dirname(target), { recursive: true })
        refLock = await lock(target)
        await checkExpected(target, newRef ? null : state.refBytes)
        if (newRef) {
          const packed = await optionalBytes(path.join(context.location.common, 'packed-refs'))
          if (
            packed &&
            decodeGitText(packed)
              .split(/\r?\n/)
              .some((line) => line.endsWith(' ' + ref))
          )
            throw new GitReadError('stale', '分支已经存在，未覆盖')
        } else if ((await headState(context)).oid !== state.oid)
          throw new GitReadError('stale', '分支目标已变化，请刷新')
        abort(signal)
        await publish(refLock, Buffer.from(oid + '\n'))
        publication?.onPublish?.()
        if (newRef && publication?.switchHead)
          await publish(headLock, Buffer.from('ref: ' + newRef + '\n'))
      } else {
        abort(signal)
        await publish(headLock, Buffer.from(oid + '\n'))
        publication?.onPublish?.()
      }
    } finally {
      if (refLock) await unlock(refLock)
      await unlock(headLock)
    }
  }
  async function execute(
    context: GitWorkbenchWriterContext,
    request: GitActionRequest,
    signal?: AbortSignal
  ): Promise<GitWorkbenchWriteResult> {
    let work: WorkCopy | undefined
    let stage = 'preflight'
    let sourceChanged = false
    let appliedItemIds: string[] = []
    let completedHeadSha: string | undefined
    const commonKey = path.resolve(context.location.common).toLowerCase()
    return withGitRepositoryLock(
      context.location.common,
      signal,
      async (): Promise<GitWorkbenchWriteResult> => {
        const unavailable = blocked.get(commonKey)
        if (unavailable) throw new GitReadError('error', unavailable)
        abort(signal)
        if (
          request.revision !== context.snapshot.revision &&
          request.revision !== context.review?.revision
        )
          throw new GitReadError('stale', 'Git 操作版本已失效')
        await verifier(context, signal).verify()
        for (const filename of [
          'MERGE_HEAD',
          'CHERRY_PICK_HEAD',
          'REVERT_HEAD',
          'rebase-apply',
          'rebase-merge'
        ]) {
          try {
            await fs.lstat(path.join(context.location.gitdir, filename))
            throw new GitReadError('unsupported', '仓库正在合并、变基或拣选；请先完成现有操作')
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
        }
        const sourceIndex = await optionalBytes(path.join(context.location.gitdir, 'index'))
        const state = await headState(context)
        work = await clone(context, signal)
        const currentWork = work
        try {
          if (
            request.action === 'stage' ||
            request.action === 'unstage' ||
            request.action === 'revert'
          ) {
            stage = 'generate-index'
            const result = await applyItems(context, currentWork, request, signal)
            let plans: FilePlan[] = []
            if (request.action === 'revert') {
              if (result.worktreeGenerated) {
                plans = await Promise.all(
                  result.names.map(async (relative) => ({
                    relative,
                    bytes: await optionalBytes(
                      path.join(currentWork.worktree, ...relative.split('/')),
                      gitSnapshotLimits.trackedFileBytes
                    )
                  }))
                )
              } else plans = await filePlans(context, currentWork, result.names, signal)
            }
            await verifier(context, signal).verify()
            stage = 'publish-objects'
            await transferObjects(context, currentWork, signal)
            if (
              request.action !== 'revert' ||
              selected(context, request).some(
                (item) => (item.publicItem.group ?? context.review?.source) === 'staged'
              ) ||
              (context.review?.source === 'uncommitted' && sourceIndex !== null)
            ) {
              stage = 'publish-index'
              await installIndex(context, currentWork, sourceIndex, signal)
              sourceChanged = true
              appliedItemIds = result.itemIds
            }
            if (request.action === 'revert') {
              stage = 'publish-worktree'
              // installFiles handles each filename separately; any later error is an honest partial result.
              for (const plan of plans) {
                await installFiles(context, [plan], signal)
                sourceChanged = true
                for (const item of selected(context, request))
                  if (
                    pathsOf(context, item).includes(plan.relative) &&
                    !appliedItemIds.includes(item.publicItem.itemId)
                  )
                    appliedItemIds.push(item.publicItem.itemId)
              }
            }
            return {
              outcome: 'success',
              stage: 'complete',
              appliedItemIds: result.itemIds,
              message:
                request.action === 'stage'
                  ? '已暂存所选改动'
                  : request.action === 'unstage'
                    ? '已取消暂存，工作树保持现有内容'
                    : '已还原所选改动'
            }
          }
          repositoryOnly(context)
          if (request.action === 'commit') {
            stage = 'generate-commit'
            if (
              !request.message.trim() ||
              Buffer.byteLength(request.message, 'utf8') > gitWorkbenchLimits.messageBytes ||
              /\0/.test(request.message)
            )
              throw new GitReadError('unsupported', '提交消息为空或超过上限')
            const name = request.authorName ?? context.identity?.name
            const email = request.authorEmail ?? context.identity?.email
            if (
              !name ||
              !email ||
              name.length > 200 ||
              email.length > 254 ||
              /[<>\r\n\0]/.test(name + email) ||
              !/^[^\s@]+@[^\s@]+$/.test(email)
            )
              throw new GitReadError(
                'unsupported',
                '请填写提交者姓名和邮箱；不会调用凭据或外部身份程序'
              )
            if (request.includeUnstaged) {
              const names = [
                ...new Set(
                  context.snapshot.items.flatMap((item) => [
                    item.path,
                    ...(item.previousPath ? [item.previousPath] : [])
                  ])
                )
              ]
              if (names.length) {
                await hydrate(context, currentWork, names, signal)
                await run(
                  context,
                  currentWork,
                  ['--literal-pathspecs', 'add', '--all', '--', ...names],
                  signal
                )
              }
            }
            const commitIndex = await index(context, currentWork, signal)
            if (!state.oid && commitIndex.size === 0)
              throw new GitReadError('stale', '没有可提交的改动；首次提交需要至少一个已暂存文件')
            const tree = decodeGitText(
              await run(context, currentWork, ['write-tree'], signal)
            ).trim()
            if (!oidPattern.test(tree)) throw new GitReadError('error', '生成 tree 无效')
            if (!state.oid) {
              const emptyTree = decodeGitText(
                await run(
                  context,
                  currentWork,
                  ['hash-object', '-t', 'tree', '--stdin'],
                  signal,
                  Buffer.alloc(0)
                )
              ).trim()
              if (!oidPattern.test(emptyTree)) throw new GitReadError('error', '空 tree 身份无效')
              if (tree === emptyTree) throw new GitReadError('stale', '没有可提交的改动')
            }
            if (state.oid) {
              const beforeTree = decodeGitText(
                await run(context, currentWork, ['rev-parse', 'HEAD^{tree}'], signal)
              ).trim()
              if (tree === beforeTree) throw new GitReadError('stale', '没有可提交的已暂存改动')
            }
            const oid = decodeGitText(
              await run(
                context,
                currentWork,
                [
                  '-c',
                  'commit.gpgSign=false',
                  'commit-tree',
                  tree,
                  ...(state.oid ? ['-p', state.oid] : [])
                ],
                signal,
                Buffer.from(request.message.trimEnd() + '\n'),
                {
                  GIT_AUTHOR_NAME: name,
                  GIT_AUTHOR_EMAIL: email,
                  GIT_COMMITTER_NAME: name,
                  GIT_COMMITTER_EMAIL: email
                }
              )
            ).trim()
            if (!oidPattern.test(oid)) throw new GitReadError('error', '生成 commit 无效')
            await verifier(context, signal).verify()
            stage = 'publish-objects'
            await transferObjects(context, currentWork, signal)
            const heldIndex = await lock(path.join(context.location.gitdir, 'index'))
            try {
              await checkExpected(heldIndex.target, sourceIndex)
              stage = 'publish-ref'
              await publishRef(context, state, oid, undefined, signal, {
                onPublish: () => {
                  sourceChanged = true
                  completedHeadSha = oid
                }
              })
              sourceChanged = true
              completedHeadSha = oid
              if (request.includeUnstaged) {
                stage = 'publish-index'
                const generatedIndex = await optionalBytes(path.join(currentWork.gitdir, 'index'))
                if (!generatedIndex) throw new GitReadError('error', '提交 index 缺失')
                await publish(heldIndex, generatedIndex)
              }
            } finally {
              await unlock(heldIndex)
            }
            return {
              outcome: 'success',
              stage: 'complete',
              appliedItemIds: [],
              message: '手工提交已完成',
              headSha: oid
            }
          }
          if (request.action === 'create-branch') {
            stage = 'generate-branch'
            if (!state.oid) throw new GitReadError('unsupported', '请先创建首个提交，再创建分支')
            if (
              !request.name ||
              request.name.length > 200 ||
              request.name.startsWith('-') ||
              /[\p{Cc}\s]/u.test(request.name)
            )
              throw new GitReadError('unsupported', '分支名称无效')
            await run(context, currentWork, ['check-ref-format', '--branch', request.name], signal)
            const ref = 'refs/heads/' + request.name
            if (!validRepositoryPath(ref)) throw new GitReadError('unsupported', '分支路径不支持')
            await verifier(context, signal).verify()
            stage = 'publish-ref'
            await publishRef(context, state, state.oid, ref, signal, {
              switchHead: true,
              onPublish: () => {
                sourceChanged = true
              }
            })
            sourceChanged = true
            return {
              outcome: 'success',
              stage: 'complete',
              appliedItemIds: [],
              message: '已创建并切换到分支 ' + request.name,
              headSha: state.oid
            }
          }
          if (request.action === 'checkout') {
            stage = 'generate-checkout'
            const target = context.refs.get(request.refId)
            if (
              !target ||
              !target.ref.startsWith('refs/heads/') ||
              target.remote ||
              !oidPattern.test(target.oid)
            )
              throw new GitReadError('stale', '本地分支标识已失效')
            if (context.snapshot.items.length)
              throw new GitReadError(
                'unsupported',
                '存在未提交改动；请先手工提交或还原，再切换分支'
              )
            const topology = path.join(context.location.common, 'worktrees')
            try {
              for (const directory of await fs.readdir(topology)) {
                const head = await optionalBytes(path.join(topology, directory, 'HEAD'), 4096)
                if (
                  head &&
                  decodeGitText(head).trim() === 'ref: ' + target.ref &&
                  path.resolve(path.join(topology, directory)) !==
                    path.resolve(context.location.gitdir)
                )
                  throw new GitReadError('unsupported', '此分支正在另一个工作树中使用')
              }
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
            }
            const tree = decodeGitText(
              await run(context, currentWork, ['ls-tree', '-r', '-z', target.oid], signal)
            )
            const targetNames: string[] = []
            for (const record of tree.split('\0').filter(Boolean)) {
              const match = /^(100644|100755) blob ([a-f0-9]{40,64})\t(.+)$/.exec(record)
              if (!match || !validRepositoryPath(match[3]))
                throw new GitReadError('unsupported', '目标分支含不支持的文件类型或路径')
              targetNames.push(match[3])
              if (targetNames.length > gitSnapshotLimits.worktreeEntries)
                throw new GitReadError('too-large', '目标分支超过工作树容量')
              if (match[3].endsWith('.gitattributes')) {
                const attrs = decodeGitText(
                  await run(context, currentWork, ['cat-file', 'blob', match[2]], signal)
                )
                if (/\b(filter|working-tree-encoding|ident)\b|\bdiff=|^\s*\[attr\]/m.test(attrs))
                  throw new GitReadError('unsupported', '目标分支含不支持的自定义属性转换')
              }
            }
            const before = await index(context, currentWork, signal)
            await run(context, currentWork, ['read-tree', '--reset', '-u', target.oid], signal)
            const names = [...new Set([...before.keys(), ...targetNames])]
            const plans: FilePlan[] = []
            let total = 0
            for (const relative of names) {
              const bytes = targetNames.includes(relative)
                ? await optionalBytes(
                    path.join(currentWork.worktree, ...relative.split('/')),
                    gitSnapshotLimits.trackedFileBytes
                  )
                : null
              total += bytes?.length ?? 0
              if (total > gitSnapshotLimits.worktreeBytes)
                throw new GitReadError('too-large', '目标分支超过工作树容量')
              plans.push({ relative, bytes })
            }
            await verifier(context, signal).verify()
            const headLock = await lock(path.join(context.location.gitdir, 'HEAD'))
            const indexLock = await lock(path.join(context.location.gitdir, 'index')).catch(
              async (error) => {
                await unlock(headLock)
                throw error
              }
            )
            const refLocks: HeldLock[] = []
            try {
              // Hold loose refs and packed-refs while publishing the checkout. External Git
              // cannot move either branch between verification and the new HEAD/index.
              for (const ref of [
                ...new Set([target.ref, ...(state.ref ? [state.ref] : [])])
              ].sort()) {
                const filename = path.join(context.location.common, ...ref.split('/'))
                await assertOrdinaryPath(path.dirname(filename), true)
                await fs.mkdir(path.dirname(filename), { recursive: true })
                refLocks.push(await lock(filename))
              }
              refLocks.push(await lock(path.join(context.location.common, 'packed-refs')))
              await checkExpected(headLock.target, state.bytes)
              await checkExpected(indexLock.target, sourceIndex)
              if ((await currentRefOID(context, target.ref)) !== target.oid)
                throw new GitReadError('stale', '目标分支已变化')
              if (state.ref && (await currentRefOID(context, state.ref)) !== state.oid)
                throw new GitReadError('stale', '当前分支已变化')
              stage = 'publish-worktree'
              for (const plan of plans) {
                await installFiles(context, [plan], signal)
                sourceChanged = true
              }
              stage = 'publish-index'
              const bytes = await optionalBytes(path.join(currentWork.gitdir, 'index'))
              if (!bytes) throw new GitReadError('error', '目标 index 缺失')
              await publish(indexLock, bytes)
              sourceChanged = true
              stage = 'publish-head'
              await publish(headLock, Buffer.from('ref: ' + target.ref + '\n'))
              return {
                outcome: 'success',
                stage: 'complete',
                appliedItemIds: [],
                message: '已切换到 ' + (target.name ?? target.ref.slice(11)),
                headSha: target.oid
              }
            } finally {
              for (const held of refLocks.reverse()) await unlock(held)
              await unlock(indexLock)
              await unlock(headLock)
            }
          }
          throw new GitReadError('unsupported', '此手工 Git 动作尚不支持')
        } catch (error) {
          if (sourceChanged)
            return {
              outcome: 'partial-success',
              stage,
              appliedItemIds,
              message: '部分改动已应用，请刷新核对：' + errorText(error),
              ...(completedHeadSha ? { headSha: completedHeadSha } : {})
            }
          throw error
        } finally {
          if (work && !blocked.has(commonKey))
            await fs.rm(work.root, { recursive: true, force: true })
        }
      }
    )
  }
  return {
    execute,
    publishObjects: (context, ownedGitdir, signal) =>
      transferObjects(context, { gitdir: ownedGitdir }, signal)
  }
}
