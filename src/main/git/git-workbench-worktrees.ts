import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import type { GitActionRequest, GitActionData, GitMetadata } from '../../shared/git-workbench'
import type { GitWorkbenchActionContext } from './git-workbench-reader'
import { createGitReader } from './git-reader'
import { GitReadError, runGitProcess } from './git-process'
import type { GitProcessObservation } from './git-process'
import { withGitRepositoryLock } from './git-workbench-lock'
import {
  SourceCapture,
  assertOrdinaryPath,
  decodeGitText,
  validRepositoryPath,
  gitSnapshotLimits
} from './git-snapshot'

interface Ownership {
  version: 1
  id: string
  common: string
  target: string
  metadata: string
  branch: string
  createdAtUTC: string
}
const oidPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const registryLimit = 2000
const blocked = new Map<string, string>()
function equalPath(left: string, right: string): boolean {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
}
function isInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return (
    relative === '' ||
    (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
  )
}
function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new GitReadError('cancelled', 'Git 工作树操作已取消')
}
function hash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}
function fresh(context: GitWorkbenchActionContext, signal?: AbortSignal): SourceCapture {
  const capture = new SourceCapture(signal)
  for (const [name, value] of context.snapshot.source.fingerprints)
    capture.fingerprints.set(name, value)
  return capture
}
async function exists(filename: string): Promise<boolean> {
  try {
    await fs.lstat(filename)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
function note(error: unknown): string {
  return (error instanceof Error ? error.message : '工作树操作失败')
    .replace(/\p{Cc}/gu, ' ')
    .slice(0, 500)
}

/** Private app registry proves ownership; repository-supplied metadata alone never permits removal. */
export function createGitWorkbenchWorktrees(options: {
  registryRoot: string
  onProcess?: (event: GitProcessObservation) => void
}): {
  execute: (
    context: GitWorkbenchActionContext,
    request: GitActionRequest,
    parentPath?: string,
    signal?: AbortSignal
  ) => Promise<GitActionData>
  metadata: (
    context: GitWorkbenchActionContext,
    data: GitMetadata,
    signal?: AbortSignal
  ) => Promise<GitMetadata>
} {
  const registryRoot = path.resolve(options.registryRoot)
  async function ownerships(): Promise<Ownership[]> {
    await assertOrdinaryPath(registryRoot, true)
    let names: string[]
    try {
      names = await fs.readdir(registryRoot)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    if (names.length > registryLimit) throw new GitReadError('too-large', '独立工作树登记超过上限')
    const result: Ownership[] = []
    for (const name of names) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue
      const bytes = await new SourceCapture().file(path.join(registryRoot, name), 8192)
      let record: Ownership
      try {
        record = JSON.parse(decodeGitText(bytes)) as Ownership
      } catch {
        throw new GitReadError('error', '工作树私有登记损坏；拒绝删除')
      }
      if (
        record.version !== 1 ||
        record.id + '.json' !== name ||
        ![record.common, record.target, record.metadata].every(
          (value) => typeof value === 'string' && path.isAbsolute(value)
        ) ||
        record.metadata !== path.join(record.common, 'worktrees', 'zonecodex-' + record.id) ||
        typeof record.branch !== 'string' ||
        !record.branch.startsWith('refs/heads/') ||
        !validRepositoryPath(record.branch)
      )
        throw new GitReadError('error', '工作树私有登记无效；拒绝删除')
      result.push(record)
    }
    return result
  }
  async function run(
    context: GitWorkbenchActionContext,
    gitdir: string,
    worktree: string,
    args: string[],
    signal?: AbortSignal
  ): Promise<Buffer> {
    cancelled(signal)
    const executable = await new SourceCapture(signal).file(
      context.program.executable,
      64 * 1024 * 1024
    )
    if (hash(executable) !== context.program.sha256)
      throw new GitReadError('unavailable', 'Git 程序身份变化')
    try {
      return await runGitProcess({
        executable: context.program.executable,
        args: ['--no-optional-locks', ...args],
        cwd: worktree,
        env: {
          ...context.snapshot.env,
          GIT_DIR: gitdir,
          GIT_COMMON_DIR: gitdir,
          GIT_INDEX_FILE: path.join(gitdir, 'index'),
          GIT_WORK_TREE: worktree
        },
        signal,
        stdoutBytes: gitSnapshotLimits.metadataBytes,
        onProcess: options.onProcess
      })
    } catch (error) {
      if (error instanceof Error && /退出未确认/.test(error.message))
        blocked.set(path.resolve(context.location.common).toLowerCase(), error.message)
      throw error
    }
  }
  async function create(
    context: GitWorkbenchActionContext,
    request: Extract<GitActionRequest, { action: 'create-worktree' }>,
    parentPath: string | undefined,
    signal?: AbortSignal
  ): Promise<GitActionData> {
    if (context.location.scopePath)
      throw new GitReadError('unsupported', '创建独立工作树需要选择仓库根目录')
    if (!parentPath) throw new GitReadError('cancelled', '工作树位置选择已取消')
    await assertOrdinaryPath(parentPath)
    if (!(await fs.lstat(parentPath)).isDirectory())
      throw new GitReadError('unsupported', '请选择普通本地父目录')
    if (
      !request.name ||
      request.name.length > 120 ||
      /[<>:"/\\|?*\p{Cc}]/u.test(request.name) ||
      /[. ]$/.test(request.name) ||
      request.name.startsWith('-') ||
      ['.', '..'].includes(request.name)
    )
      throw new GitReadError('unsupported', '工作树目录名称不支持')
    const target = path.join(path.resolve(parentPath), request.name)
    await assertOrdinaryPath(target, true)
    if (
      isInside(context.location.repositoryPath, target) ||
      isInside(target, context.location.repositoryPath) ||
      isInside(context.location.common, target) ||
      isInside(target, context.location.common)
    )
      throw new GitReadError('unsupported', '独立工作树位置必须在原仓库之外')
    if (await exists(target)) throw new GitReadError('stale', '目标目录已经存在；不会覆盖')
    const ref = context.refs.get(request.refId)
    if (!ref || !oidPattern.test(ref.oid)) throw new GitReadError('stale', '工作树起始分支已失效')
    const prefix = request.branchPrefix ?? 'codex/'
    if (prefix.length > 120 || /[\p{Cc}\s]/u.test(prefix) || prefix.startsWith('-'))
      throw new GitReadError('unsupported', '工作树分支前缀无效')
    const branchName = prefix + request.name
    const branch = 'refs/heads/' + branchName
    if (!validRepositoryPath(branch)) throw new GitReadError('unsupported', '新分支名称不支持')
    const temporary = path.join(
      path.dirname(context.snapshot.root),
      'worktree-create-' + randomUUID()
    )
    const ownedGit = path.join(temporary, 'git'),
      ownedWorktree = path.join(temporary, 'worktree')
    let changed = false,
      stage = 'generate-worktree'
    try {
      await fs.mkdir(ownedWorktree, { recursive: true })
      await fs.cp(context.snapshot.gitdir, ownedGit, { recursive: true })
      await run(context, ownedGit, ownedWorktree, ['check-ref-format', branch], signal)
      const tree = decodeGitText(
        await run(context, ownedGit, ownedWorktree, ['ls-tree', '-rl', '-z', ref.oid], signal)
      )
      let total = 0,
        count = 0
      for (const entry of tree.split('\0').filter(Boolean)) {
        const match = /^(100644|100755) blob ([a-f0-9]{40,64})\s+(\d+)\t(.+)$/.exec(entry)
        if (!match || !validRepositoryPath(match[4]))
          throw new GitReadError('unsupported', '目标提交含不支持的文件类型或路径')
        total += Number(match[3])
        count++
        if (
          Number(match[3]) > gitSnapshotLimits.trackedFileBytes ||
          total > gitSnapshotLimits.worktreeBytes ||
          count > gitSnapshotLimits.worktreeEntries
        )
          throw new GitReadError('too-large', '目标工作树超过既有容量')
        if (match[4].endsWith('.gitattributes')) {
          const attrs = decodeGitText(
            await run(context, ownedGit, ownedWorktree, ['cat-file', 'blob', match[2]], signal)
          )
          if (/\b(filter|working-tree-encoding|ident)\b|\bdiff=|^\s*\[attr\]/m.test(attrs))
            throw new GitReadError('unsupported', '目标工作树含不支持的自定义转换属性')
        }
      }
      await run(context, ownedGit, ownedWorktree, ['read-tree', '--reset', ref.oid], signal)
      await run(context, ownedGit, ownedWorktree, ['checkout-index', '--all', '--force'], signal)
      let generatedBytes = 0,
        generatedEntries = 0
      async function verifyGenerated(directory: string): Promise<void> {
        for (const name of await fs.readdir(directory)) {
          const filename = path.join(directory, name)
          await assertOrdinaryPath(filename)
          const stat = await fs.lstat(filename)
          if (++generatedEntries > gitSnapshotLimits.worktreeEntries)
            throw new GitReadError('too-large', '生成工作树超过项数容量')
          if (stat.isDirectory()) await verifyGenerated(filename)
          else if (stat.isFile()) {
            generatedBytes += stat.size
            if (
              stat.size > gitSnapshotLimits.trackedFileBytes ||
              generatedBytes > gitSnapshotLimits.worktreeBytes
            )
              throw new GitReadError('too-large', '生成工作树超过既有容量')
          } else throw new GitReadError('unsupported', '生成工作树含非普通文件')
        }
      }
      await verifyGenerated(ownedWorktree)
      await fresh(context, signal).verify()
      cancelled(signal)
      const id = randomUUID(),
        metadata = path.join(context.location.common, 'worktrees', 'zonecodex-' + id)
      const record: Ownership = {
        version: 1,
        id,
        common: path.resolve(context.location.common),
        target: path.resolve(target),
        metadata,
        branch,
        createdAtUTC: new Date().toISOString()
      }
      await assertOrdinaryPath(path.dirname(metadata), true)
      await fs.mkdir(path.dirname(metadata), { recursive: true })
      const branchPath = path.join(context.location.common, ...branch.split('/'))
      await assertOrdinaryPath(path.dirname(branchPath), true)
      await fs.mkdir(path.dirname(branchPath), { recursive: true })
      const packed = await fs
        .readFile(path.join(context.location.common, 'packed-refs'), 'utf8')
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return ''
          throw error
        })
      if (
        (await exists(branchPath)) ||
        packed.split(/\r?\n/).some((line) => line.endsWith(' ' + branch))
      )
        throw new GitReadError('stale', branchName + ' 分支已经存在')
      const branchLock = await fs.open(branchPath + '.lock', 'wx', 0o600)
      let branchPublished = false
      try {
        if ((await exists(target)) || (await exists(branchPath)))
          throw new GitReadError('stale', '目录或分支发生变化')
        cancelled(signal)
        await assertOrdinaryPath(registryRoot, true)
        await fs.mkdir(registryRoot, { recursive: true })
        await fs.writeFile(path.join(registryRoot, id + '.json'), JSON.stringify(record) + '\n', {
          flag: 'wx'
        })
        changed = true
        stage = 'publish-worktree'
        await fs.mkdir(target)
        await fs.cp(ownedWorktree, target, { recursive: true })
        await fs.mkdir(metadata)
        await fs.writeFile(
          path.join(metadata, 'locked'),
          'ZoneCodex creating independent worktree\n',
          { flag: 'wx' }
        )
        await fs.writeFile(path.join(metadata, 'HEAD'), 'ref: ' + branch + '\n', { flag: 'wx' })
        await fs.writeFile(path.join(metadata, 'commondir'), '../..\n', { flag: 'wx' })
        await fs.writeFile(
          path.join(metadata, 'gitdir'),
          path.join(target, '.git').replace(/\\/g, '/') + '\n',
          {
            flag: 'wx'
          }
        )
        await fs.copyFile(path.join(ownedGit, 'index'), path.join(metadata, 'index'))
        await fs.writeFile(
          path.join(metadata, 'zonecodex-owned.json'),
          JSON.stringify(record) + '\n',
          { flag: 'wx' }
        )
        await fs.writeFile(
          path.join(target, '.git'),
          'gitdir: ' + metadata.replace(/\\/g, '/') + '\n',
          { flag: 'wx' }
        )
        stage = 'publish-branch'
        await branchLock.writeFile(ref.oid + '\n')
        await branchLock.sync()
        await branchLock.close()
        await fs.rename(branchPath + '.lock', branchPath)
        branchPublished = true
        await fs.unlink(path.join(metadata, 'locked'))
        return {
          outcome: 'success',
          stage: 'complete',
          appliedItemIds: [],
          message: '已创建独立工作树 ' + target + '（新分支 ' + branchName + '）',
          headSha: ref.oid
        }
      } finally {
        await branchLock.close().catch(() => {})
        if (!branchPublished) await fs.unlink(branchPath + '.lock').catch(() => {})
      }
    } catch (error) {
      if (changed)
        return {
          outcome: 'partial-success',
          stage,
          appliedItemIds: [],
          message: '工作树创建未全部完成；私有登记和已有文件保留供核对：' + note(error)
        }
      throw error
    } finally {
      if (!blocked.has(path.resolve(context.location.common).toLowerCase()))
        await fs.rm(temporary, { recursive: true, force: true })
    }
  }
  async function remove(
    context: GitWorkbenchActionContext,
    request: Extract<GitActionRequest, { action: 'remove-worktree' }>,
    signal?: AbortSignal
  ): Promise<GitActionData> {
    const item = context.worktrees.find((entry) => entry.worktreeId === request.worktreeId)
    if (!item) throw new GitReadError('stale', '工作树标识已失效')
    if (equalPath(item.path, context.location.repositoryPath))
      throw new GitReadError('unsupported', '不能移除当前工作树')
    if (item.locked) throw new GitReadError('unsupported', '工作树已锁定；保持原锁')
    const record = (await ownerships()).find(
      (entry) =>
        equalPath(entry.common, context.location.common) && equalPath(entry.target, item.path)
    )
    if (!record) throw new GitReadError('unsupported', '此工作树不是本功能创建并登记，不能移除')
    await assertOrdinaryPath(record.target)
    await assertOrdinaryPath(record.metadata)
    if (await exists(path.join(record.metadata, 'locked')))
      throw new GitReadError('unsupported', '工作树已锁定；保持原锁')
    const recorded = JSON.parse(
      decodeGitText(
        await new SourceCapture(signal).file(
          path.join(record.metadata, 'zonecodex-owned.json'),
          8192
        )
      )
    )
    if (JSON.stringify(recorded) !== JSON.stringify(record))
      throw new GitReadError('stale', '工作树登记已变化；拒绝移除')
    const dotgit = decodeGitText(
      await new SourceCapture(signal).file(path.join(record.target, '.git'), 4096)
    ).trim()
    if (!dotgit.startsWith('gitdir: ') || !equalPath(dotgit.slice(8), record.metadata))
      throw new GitReadError('stale', '工作树 Git 指针已变化')
    const backlink = decodeGitText(
      await new SourceCapture(signal).file(path.join(record.metadata, 'gitdir'), 4096)
    ).trim()
    if (!equalPath(backlink, path.join(record.target, '.git')))
      throw new GitReadError('stale', '工作树回指已变化')
    const reader = createGitReader({
      cacheRoot: path.join(path.dirname(context.snapshot.root), 'worktree-remove-' + randomUUID()),
      onProcess: options.onProcess
    })
    const view = await reader.open(record.target, signal)
    let moved = false,
      stage = 'check-clean'
    const quarantine = path.join(path.dirname(record.target), '.zonecodex-removed-' + record.id)
    const metadataQuarantine = path.join(
      path.dirname(record.metadata),
      '.zonecodex-removed-' + record.id
    )
    try {
      const list = await reader.refresh(view, signal)
      if (list.items.length)
        throw new GitReadError('unsupported', '独立工作树存在未提交改动；不能移除')
      const tracked = new Set(view.snapshot!.entries.map((entry) => entry.path))
      let worktreeEntries = 0
      async function checkOnlyTracked(directory: string, relative = ''): Promise<void> {
        await assertOrdinaryPath(directory)
        for (const name of await fs.readdir(directory)) {
          if (!relative && name === '.git') continue
          if (++worktreeEntries > gitSnapshotLimits.worktreeEntries)
            throw new GitReadError('too-large', '移除前工作树超过容量')
          const itemPath = relative ? relative + '/' + name : name
          const filename = path.join(directory, name)
          await assertOrdinaryPath(filename)
          const stat = await fs.lstat(filename)
          if (stat.isDirectory()) {
            if (![...tracked].some((value) => value.startsWith(itemPath + '/')))
              throw new GitReadError(
                'unsupported',
                '工作树含未跟踪或忽略目录；保留这些文件，不能移除'
              )
            await checkOnlyTracked(filename, itemPath)
          } else if (!stat.isFile() || !tracked.has(itemPath))
            throw new GitReadError(
              'unsupported',
              '工作树含未跟踪或忽略文件；保留这些文件，不能移除'
            )
        }
      }
      await checkOnlyTracked(record.target)
      await fresh(context, signal).verify()
      const capture = new SourceCapture(signal)
      for (const [name, value] of view.snapshot!.source.fingerprints)
        capture.fingerprints.set(name, value)
      await capture.verify()
      cancelled(signal)
      if ((await exists(quarantine)) || (await exists(metadataQuarantine)))
        throw new GitReadError('stale', '工作树移除暂存目录已存在')
      stage = 'remove-worktree'
      await fs.rename(record.target, quarantine)
      moved = true
      // Recheck captured worktree bytes after the rename, before any recursive deletion.
      for (const entry of capture.fingerprints.values()) {
        if (!isInside(record.target, entry.target)) continue
        const relocated = path.join(quarantine, path.relative(record.target, entry.target))
        await assertOrdinaryPath(relocated, entry.kind === 'missing')
        if (entry.kind === 'missing') {
          if (await exists(relocated)) throw new GitReadError('stale', '移除前文件已变化')
          continue
        }
        if (entry.digest) {
          const bytes =
            entry.kind === 'directory'
              ? Buffer.from(JSON.stringify((await fs.readdir(relocated)).sort()))
              : await new SourceCapture(signal).file(relocated, gitSnapshotLimits.trackedFileBytes)
          if (hash(bytes) !== entry.digest)
            throw new GitReadError('stale', '移除前内容已变化；保留工作树')
        }
      }
      await assertOrdinaryPath(quarantine)
      await assertOrdinaryPath(metadataQuarantine, true)
      await fs.rename(record.metadata, metadataQuarantine)
      await fs.rm(quarantine, { recursive: true, force: false })
      await fs.rm(metadataQuarantine, { recursive: true, force: false })
      await fs.unlink(path.join(registryRoot, record.id + '.json'))
      return {
        outcome: 'success',
        stage: 'complete',
        appliedItemIds: [],
        message: '已移除本功能创建的干净独立工作树；分支保留'
      }
    } catch (error) {
      if (moved) {
        if ((await exists(quarantine)) && !(await exists(record.target)))
          await fs.rename(quarantine, record.target).catch(() => {})
        if ((await exists(metadataQuarantine)) && !(await exists(record.metadata)))
          await fs.rename(metadataQuarantine, record.metadata).catch(() => {})
        return {
          outcome: 'partial-success',
          stage,
          appliedItemIds: [],
          message: '移除未全部完成；已有目录和登记保留供核对：' + note(error)
        }
      }
      throw error
    } finally {
      await reader.dispose(view)
    }
  }
  return {
    async execute(context, request, parentPath, signal) {
      return withGitRepositoryLock(context.location.common, signal, async () => {
        const unavailable = blocked.get(path.resolve(context.location.common).toLowerCase())
        if (unavailable) throw new GitReadError('error', unavailable)
        if (
          request.revision !== context.snapshot.revision &&
          request.revision !== context.review?.revision
        )
          throw new GitReadError('stale', '工作树操作版本已失效')
        await fresh(context, signal).verify()
        if (request.action === 'create-worktree')
          return create(context, request, parentPath, signal)
        if (request.action === 'remove-worktree') return remove(context, request, signal)
        throw new GitReadError('unsupported', '不支持的工作树动作')
      })
    },
    async metadata(context, data, signal) {
      cancelled(signal)
      const owned = await ownerships()
      const removable = context.worktrees.some(
        (item) =>
          !equalPath(item.path, context.location.repositoryPath) &&
          !item.locked &&
          owned.some(
            (entry) =>
              equalPath(entry.common, context.location.common) && equalPath(entry.target, item.path)
          )
      )
      const capabilities = data.capabilities.filter(
        (item) => !['create-worktree', 'remove-worktree'].includes(item.name)
      )
      capabilities.push(
        {
          name: 'create-worktree',
          available: !context.location.scopePath,
          reason: context.location.scopePath ? '请先选择仓库根目录' : null
        },
        {
          name: 'remove-worktree',
          available: removable,
          reason: removable ? null : '只移除本功能登记、非当前且未锁定的干净工作树'
        }
      )
      return { ...data, capabilities }
    }
  }
}
