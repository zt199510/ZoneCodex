import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import type { GitChangeItem } from '../../shared/git-view'
import type { GitMetadata, GitReviewData, GitDiffData } from '../../shared/git-workbench'
import type { GitReaderView } from './git-reader'
import { GitReadError, runGitProcess } from './git-process'
import { redactGitNetworkError } from './git-workbench-network'
import type { GitProcessObservation } from './git-process'
import {
  SourceCapture,
  assertOrdinaryPath,
  decodeGitText,
  gitSnapshotLimits,
  validRepositoryPath,
  withinScope
} from './git-snapshot'
import { parseGitStatus } from './git-status'
import type { GitWorkbenchTurns } from './git-workbench-turns'

type Snapshot = NonNullable<GitReaderView['snapshot']>
export type WorkbenchSource =
  'branch' | 'commit' | 'uncommitted' | 'staged' | 'unstaged' | 'last-turn'
export interface WorkbenchProgram {
  executable: string
  sha256: string
}
export interface WorkbenchRef {
  name: string
  ref: string
  oid: string
  remote: boolean
}
export interface WorkbenchRemote {
  name: string
  url: string
}
export interface WorkbenchFile {
  itemId: string
  path: string
  previousPath: string | null
  change: GitChangeItem['change']
  additions: number
  deletions: number
  binary: boolean
  actions: ('stage' | 'unstage' | 'revert')[]
}
export interface WorkbenchHunk {
  hunkId: string
  header: string
  startLine: number
  endLine: number
  actions: ('stage' | 'unstage' | 'revert')[]
}
export interface WorkbenchReviewItem {
  publicItem: WorkbenchFile
  path: string
  previousPath: string | null
  untracked: boolean
  patch?: string
  hunks: Map<string, string>
}
interface ReviewState {
  revision: string
  source: WorkbenchSource
  hideWhitespace: boolean
  args: string[]
  baseLabel: string
  items: Map<string, WorkbenchReviewItem>
}
export interface GitWorkbenchActionContext {
  view: GitReaderView
  location: GitReaderView['location']
  snapshot: Snapshot
  program: WorkbenchProgram
  refs: Map<string, WorkbenchRef>
  commits: Map<string, string>
  remotes: Map<string, WorkbenchRemote>
  worktrees: {
    worktreeId: string
    path: string
    branch: string | null
    headSha: string | null
    locked: boolean
  }[]
  config: Map<string, string>
  run: (
    args: string[],
    signal?: AbortSignal,
    extra?: Partial<Parameters<typeof runGitProcess>[0]>
  ) => Promise<Buffer>
  identity?: { name: string; email: string }
  review?: ReviewState
}
interface WorkbenchState extends GitWorkbenchActionContext {
  snapshotRevision: string
  currentBranch: string | null
  headSha: string | null
  upstreamRefId: string | null
  defaultBaseRefId: string | null
  commitRecords: {
    commitId: string
    sha: string
    subject: string
    author: string
    timestamp: number
  }[]
  stagedItems: GitChangeItem[]
  metadataReady: boolean
  untrackedReady: boolean
}
export interface GitWorkbenchReader {
  captureWorktree: (view: GitReaderView, signal?: AbortSignal) => Promise<GitWorkbenchActionContext>
  metadata: (view: GitReaderView, signal?: AbortSignal) => Promise<GitMetadata>
  review: (
    view: GitReaderView,
    request: {
      source: WorkbenchSource
      baseRefId?: string
      commitId?: string
      hideWhitespace?: boolean
    },
    signal?: AbortSignal
  ) => Promise<GitReviewData>
  diff: (
    view: GitReaderView,
    request: { revision: string; itemId: string },
    signal?: AbortSignal
  ) => Promise<GitDiffData>
  context: (
    view: GitReaderView,
    revision?: string,
    signal?: AbortSignal
  ) => Promise<GitWorkbenchActionContext>
}

const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const DIFF_BYTES = 32 * 1024 * 1024
const ITEM_LIMIT = 2000
const META_BYTES = 16 * 1024 * 1024
const DIFF_OPTIONS = [
  '--no-ext-diff',
  '--no-textconv',
  '--no-color',
  '--src-prefix=a/',
  '--dst-prefix=b/',
  '--ignore-submodules=all',
  '--find-renames',
  '--full-index'
]

function freshCapture(snapshot: Snapshot, signal?: AbortSignal): SourceCapture {
  const capture = new SourceCapture(signal)
  for (const [key, value] of snapshot.source.fingerprints) capture.fingerprints.set(key, value)
  capture.metadataBytes = snapshot.source.metadataBytes
  capture.worktreeBytes = snapshot.source.worktreeBytes
  capture.worktreeEntries = snapshot.source.worktreeEntries
  return capture
}
function retainCapture(snapshot: Snapshot, capture: SourceCapture): void {
  for (const [key, value] of capture.fingerprints) snapshot.source.fingerprints.set(key, value)
  snapshot.source.metadataBytes = capture.metadataBytes
  snapshot.source.worktreeBytes = capture.worktreeBytes
}
function validRef(ref: string): boolean {
  return (
    /^refs\/(heads|remotes|tags)\//.test(ref) &&
    validRepositoryPath(ref) &&
    !/[\p{Cc} ~^?*]/u.test(ref) &&
    !ref.includes('[') &&
    !ref.includes('..') &&
    !ref.includes('@{') &&
    !ref.endsWith('.') &&
    ref.split('/').every((part) => !part.startsWith('.') && !part.endsWith('.lock'))
  )
}
function label(value: string, maximum = 2048): string {
  return value.replace(/\p{Cc}/gu, ' ').slice(0, maximum)
}
function count(value: string): number | null {
  if (value === '-') return null
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new GitReadError('error', 'Git 行数协议不完整')
  return Number(value)
}
function change(code: string): GitChangeItem['change'] {
  return (
    (
      {
        A: 'added',
        M: 'modified',
        D: 'deleted',
        R: 'renamed',
        C: 'copied',
        U: 'unmerged',
        T: 'type-changed'
      } as const
    )[code as 'A'] ?? 'unknown'
  )
}

/** Git -z records preserve spaces, literal pathspec characters, and rename pairs. */
function names(
  bytes: Buffer
): { path: string; previousPath: string | null; change: GitChangeItem['change'] }[] {
  if (bytes.length && bytes[bytes.length - 1] !== 0)
    throw new GitReadError('error', 'Git 文件列表协议不完整')
  const records = decodeGitText(bytes).split('\0')
  const result: { path: string; previousPath: string | null; change: GitChangeItem['change'] }[] =
    []
  for (let index = 0; index < records.length - 1; index++) {
    const status = records[index]
    if (!/^[AMDTRCU](?:\d+)?$/.test(status)) throw new GitReadError('error', 'Git 文件状态不支持')
    const first = records[++index]
    const second = status[0] === 'R' || status[0] === 'C' ? records[++index] : null
    if (!first || (second !== null && !second))
      throw new GitReadError('error', 'Git 重命名协议不完整')
    result.push({
      path: second ?? first,
      previousPath: second ? first : null,
      change: change(status[0])
    })
    if (result.length > ITEM_LIMIT) throw new GitReadError('too-large', 'Git 改动超过 2000 项')
  }
  return result
}
function stats(bytes: Buffer): Map<string, { additions: number | null; deletions: number | null }> {
  const records = decodeGitText(bytes).split('\0')
  const result = new Map<string, { additions: number | null; deletions: number | null }>()
  for (let index = 0; index < records.length - 1; index++) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(records[index])
    if (!match) throw new GitReadError('error', 'Git 行数协议不完整')
    let filename = match[3]
    if (!filename) {
      const old = records[++index]
      filename = records[++index]
      if (!old || !filename) throw new GitReadError('error', 'Git 重命名行数协议不完整')
    }
    result.set(filename, { additions: count(match[1]), deletions: count(match[2]) })
  }
  return result
}

/** Only main-held hunk IDs can resolve to a patch, never renderer-provided patch text. */
function splitHunks(
  text: string,
  actionable: boolean
): { publicHunks: WorkbenchHunk[]; patches: Map<string, string> } {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? []
  const starts: number[] = []
  for (let index = 0; index < lines.length; index++)
    if (/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(lines[index])) starts.push(index)
  const header = lines.slice(0, starts[0] ?? lines.length).join('')
  const patches = new Map<string, string>()
  const publicHunks = starts.map((start, index) => {
    const end = starts[index + 1] ?? lines.length
    const hunkId = randomUUID()
    if (actionable) patches.set(hunkId, header + lines.slice(start, end).join(''))
    return {
      hunkId,
      header: label(lines[start].trimEnd()),
      startLine: start + 1,
      endLine: end,
      actions: [] as WorkbenchHunk['actions']
    }
  })
  return { publicHunks, patches }
}

export function createGitWorkbenchReader(
  options: {
    onProcess?: (event: GitProcessObservation) => void
    turns?: GitWorkbenchTurns
  } = {}
): GitWorkbenchReader {
  const states = new WeakMap<GitReaderView, WorkbenchState>()
  let programPromise: Promise<WorkbenchProgram> | undefined
  let blocked: string | undefined

  async function program(): Promise<WorkbenchProgram> {
    programPromise ??= (async () => {
      for (const base of [process.env.ProgramW6432, process.env.ProgramFiles]) {
        if (!base) continue
        const executable = path.join(base, 'Git', 'cmd', 'git.exe')
        try {
          await assertOrdinaryPath(executable)
          const bytes = await new SourceCapture().file(executable, 64 * 1024 * 1024)
          return { executable, sha256: createHash('sha256').update(bytes).digest('hex') }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
      throw new GitReadError('unavailable', '未找到受支持的系统 Git')
    })()
    return programPromise
  }
  async function run(
    state: WorkbenchState,
    args: string[],
    signal?: AbortSignal,
    extra: Partial<Parameters<typeof runGitProcess>[0]> = {}
  ): Promise<Buffer> {
    if (blocked) throw new GitReadError('error', blocked)
    const current = await new SourceCapture(signal).file(state.program.executable, 64 * 1024 * 1024)
    if (createHash('sha256').update(current).digest('hex') !== state.program.sha256)
      throw new GitReadError('unavailable', 'Git 程序身份已变化')
    try {
      return await runGitProcess({
        executable: state.program.executable,
        args: [
          '--no-optional-locks',
          '--literal-pathspecs',
          '-c',
          'core.fsmonitor=false',
          '-c',
          'core.hooksPath=' + path.join(state.snapshot.root, 'no-hooks'),
          '-c',
          'diff.mnemonicPrefix=false',
          '-c',
          'diff.noprefix=false',
          '-c',
          'core.quotePath=false',
          ...args
        ],
        cwd: state.snapshot.worktree,
        env: state.snapshot.env,
        signal,
        onProcess: options.onProcess,
        ...extra
      })
    } catch (error) {
      const message = redactGitNetworkError(error, extra.env?.GIT_CONFIG_VALUE_0)
      if (error instanceof Error && error.message.includes('退出未确认')) {
        blocked = message
        state.snapshot.retained = true
      }
      throw new GitReadError(error instanceof GitReadError ? error.status : 'error', message)
    }
  }
  function stateFor(view: GitReaderView): WorkbenchState {
    const state = states.get(view)
    if (!state || !view.snapshot || state.snapshotRevision !== view.snapshot.revision)
      throw new GitReadError('stale', 'Git 查看快照已变化，请刷新')
    return state
  }
  async function operation<T>(
    view: GitReaderView,
    signal: AbortSignal | undefined,
    body: (current: AbortSignal) => Promise<T>
  ): Promise<T> {
    if (view.disposed || !view.snapshot) throw new GitReadError('stale', 'Git 查看范围已释放')
    if (blocked || view.snapshot.retained)
      throw new GitReadError('error', blocked ?? 'Git 进程退出未确认')
    const generation = (view.generation ?? 0) + 1
    view.generation = generation
    view.controller?.abort()
    await view.settled?.catch(() => {})
    if (view.disposed || view.generation !== generation)
      throw new GitReadError('stale', 'Git 请求已替换')
    const controller = new AbortController()
    const abort = (): void => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) controller.abort()
    view.controller = controller
    const timer = setTimeout(abort, 10000)
    const work = body(controller.signal)
    view.settled = work
    try {
      return await work
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (view.controller === controller) view.controller = undefined
    }
  }
  async function verified<T>(
    state: WorkbenchState,
    signal: AbortSignal | undefined,
    body: (capture: SourceCapture) => Promise<T>
  ): Promise<T> {
    const capture = freshCapture(state.snapshot, signal)
    await capture.verify()
    const result = await body(capture)
    await capture.verify()
    if (state.view.snapshot !== state.snapshot || state.view.disposed)
      throw new GitReadError('stale', 'Git 查看快照已变化')
    retainCapture(state.snapshot, capture)
    return result
  }

  async function configData(
    state: WorkbenchState,
    capture: SourceCapture,
    signal?: AbortSignal
  ): Promise<Map<string, string>> {
    const values = new Map<string, string>()
    for (const filename of [
      path.resolve(path.dirname(state.program.executable), '../etc/gitconfig'),
      path.join(os.homedir(), '.config/git/config'),
      path.join(os.homedir(), '.gitconfig'),
      path.join(state.location.common, 'config'),
      path.join(state.location.gitdir, 'config.worktree')
    ]) {
      // Data parser receives captured bytes; original config never drives a Git command.
      const bytes = await capture.optionalFile(filename, META_BYTES)
      if (!bytes) continue
      const data = path.join(state.snapshot.root, 'workbench-config-' + randomUUID())
      await fs.writeFile(data, bytes)
      try {
        const output = await run(
          state,
          ['config', '--file', data, '--no-includes', '--null', '--list'],
          signal,
          { stdoutBytes: META_BYTES }
        )
        for (const record of decodeGitText(output).split('\0').filter(Boolean)) {
          const end = record.indexOf('\n')
          const rawKey = end < 0 ? record : record.slice(0, end)
          const firstDot = rawKey.indexOf('.')
          const lastDot = rawKey.lastIndexOf('.')
          const key =
            firstDot >= 0 && firstDot !== lastDot
              ? rawKey.slice(0, firstDot).toLowerCase() +
                rawKey.slice(firstDot, lastDot + 1) +
                rawKey.slice(lastDot + 1).toLowerCase()
              : rawKey.toLowerCase()
          const value = end < 0 ? 'true' : record.slice(end + 1)
          if (
            key === 'user.name' ||
            key === 'user.email' ||
            /^remote\..*\.url$/.test(key) ||
            /^branch\..*\.(remote|merge)$/.test(key)
          )
            values.set(key, value)
        }
      } finally {
        if (!state.snapshot.retained) await fs.unlink(data)
      }
    }
    return values
  }
  async function captureRefs(
    state: WorkbenchState,
    capture: SourceCapture
  ): Promise<Map<string, WorkbenchRef>> {
    const discovered = new Map<string, string>()
    const symbolic = new Map<string, string>()
    const packed = await capture.optionalFile(
      path.join(state.location.common, 'packed-refs'),
      META_BYTES
    )
    if (packed)
      for (const line of decodeGitText(packed).split(/\r?\n/)) {
        if (!line || line.startsWith('#') || line.startsWith('^')) continue
        const space = line.indexOf(' ')
        const oid = line.slice(0, space)
        const ref = line.slice(space + 1)
        if (space < 0 || !OID.test(oid) || !validRef(ref))
          throw new GitReadError('unsupported', 'Git ref 格式不支持')
        discovered.set(ref, oid)
        if (discovered.size > ITEM_LIMIT)
          throw new GitReadError('too-large', 'Git 分支超过 2000 项')
      }
    async function walk(relative: string): Promise<void> {
      const directory = path.join(state.location.common, ...relative.split('/'))
      let entries: string[]
      try {
        entries = await capture.directory(directory)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          capture.fingerprints.set(directory, { target: directory, kind: 'missing', identity: '' })
          return
        }
        throw error
      }
      for (const name of entries) {
        const ref = relative + '/' + name
        if (!validRepositoryPath(ref)) throw new GitReadError('unsupported', 'Git ref 路径不支持')
        const file = path.join(state.location.common, ...ref.split('/'))
        await assertOrdinaryPath(file)
        const stat = await fs.lstat(file)
        if (stat.isDirectory()) {
          await walk(ref)
          continue
        }
        if (!validRef(ref)) throw new GitReadError('unsupported', 'Git ref 名称不支持')
        const value = decodeGitText(await capture.file(file, 4096, 'metadata')).trim()
        if (OID.test(value)) discovered.set(ref, value)
        else if (value.startsWith('ref: ') && validRef(value.slice(5)))
          symbolic.set(ref, value.slice(5))
        else throw new GitReadError('unsupported', 'Git ref 内容不支持')
        if (discovered.size + symbolic.size > ITEM_LIMIT)
          throw new GitReadError('too-large', 'Git 分支超过 2000 项')
      }
    }
    for (const group of ['heads', 'remotes', 'tags']) await walk('refs/' + group)
    for (const [ref, target] of symbolic) {
      const oid = discovered.get(target)
      if (oid) discovered.set(ref, oid)
    }
    const refs = new Map<string, WorkbenchRef>()
    for (const [ref, oid] of discovered) {
      const target = path.join(state.snapshot.gitdir, ...ref.split('/'))
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, oid + '\n')
      const name = ref.replace(/^refs\/(heads|remotes|tags)\//, '')
      refs.set(randomUUID(), { name, ref, oid, remote: ref.startsWith('refs/remotes/') })
    }
    return refs
  }
  async function captureWorktrees(
    state: WorkbenchState,
    capture: SourceCapture
  ): Promise<GitWorkbenchActionContext['worktrees']> {
    const result: GitWorkbenchActionContext['worktrees'] = []
    const mainHead = await capture.optionalFile(path.join(state.location.common, 'HEAD'), 4096)
    const mainRoot = path.dirname(state.location.common)
    const headValue = mainHead ? decodeGitText(mainHead).trim() : ''
    result.push({
      worktreeId: randomUUID(),
      path: state.location.linked ? mainRoot : state.location.repositoryPath,
      branch: headValue.startsWith('ref: refs/heads/') ? headValue.slice(16) : null,
      headSha: OID.test(headValue) ? headValue : null,
      locked: false
    })
    const directory = path.join(state.location.common, 'worktrees')
    let children: string[]
    try {
      children = await capture.directory(directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      capture.fingerprints.set(directory, { target: directory, kind: 'missing', identity: '' })
      return result
    }
    for (const child of children) {
      if (!validRepositoryPath(child))
        throw new GitReadError('unsupported', '工作树元数据路径不支持')
      const root = path.join(directory, child)
      await capture.directory(root)
      const [head, pointer, locked] = await Promise.all([
        capture.file(path.join(root, 'HEAD'), 4096, 'metadata'),
        capture.file(path.join(root, 'gitdir'), 32768, 'metadata'),
        capture.optionalFile(path.join(root, 'locked'), 4096)
      ])
      const value = decodeGitText(head).trim()
      const worktree = path.dirname(decodeGitText(pointer).trim())
      if (!path.isAbsolute(worktree) || /\p{Cc}/u.test(worktree))
        throw new GitReadError('unsupported', '工作树位置不支持')
      result.push({
        worktreeId: randomUUID(),
        path: worktree,
        branch: value.startsWith('ref: refs/heads/') ? value.slice(16) : null,
        headSha: OID.test(value) ? value : null,
        locked: !!locked
      })
      if (result.length > 200) throw new GitReadError('too-large', '工作树超过 200 项')
    }
    return result
  }
  async function hydrateUntracked(state: WorkbenchState, capture: SourceCapture): Promise<void> {
    if (state.untrackedReady) return
    for (const item of state.stagedItems.filter((item) => item.group === 'untracked')) {
      if (!item.previewable) continue
      const source = path.join(state.location.repositoryPath, ...item.path.split('/'))
      const bytes = await capture.file(source, gitSnapshotLimits.trackedFileBytes, 'worktree')
      const target = path.join(state.snapshot.worktree, ...item.path.split('/'))
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, bytes)
    }
    state.untrackedReady = true
  }

  async function prepareMetadata(state: WorkbenchState, signal?: AbortSignal): Promise<void> {
    if (state.metadataReady) return
    await verified(state, signal, async (capture) => {
      const values = await configData(state, capture, signal)
      state.config = values
      state.refs = await captureRefs(state, capture)
      const head = decodeGitText(
        await capture.file(path.join(state.location.gitdir, 'HEAD'), 4096, 'metadata')
      ).trim()
      state.currentBranch = head.startsWith('ref: refs/heads/') ? head.slice(16) : null
      const ownedHead = decodeGitText(
        await run(state, ['rev-parse', '--verify', '--quiet', 'HEAD'], signal, {
          acceptedCodes: [0, 1, 128]
        })
      ).trim()
      state.headSha = OID.test(ownedHead) ? ownedHead : null
      state.remotes.clear()
      for (const [key, value] of values) {
        const match = /^remote\.(.*)\.url$/.exec(key)
        if (match) state.remotes.set(randomUUID(), { name: match[1], url: value })
      }
      const remote = state.currentBranch
        ? values.get('branch.' + state.currentBranch + '.remote')
        : null
      const merge = state.currentBranch
        ? values.get('branch.' + state.currentBranch + '.merge')
        : null
      const upstream =
        remote && merge?.startsWith('refs/heads/')
          ? remote === '.'
            ? merge
            : 'refs/remotes/' + remote + '/' + merge.slice(11)
          : null
      state.upstreamRefId = [...state.refs].find(([, ref]) => ref.ref === upstream)?.[0] ?? null
      state.defaultBaseRefId =
        [...state.refs].find(([, ref]) => ref.ref === 'refs/remotes/origin/HEAD')?.[0] ??
        [...state.refs].find(([, ref]) => ref.ref === 'refs/remotes/origin/main')?.[0] ??
        [...state.refs].find(([, ref]) => ref.ref === 'refs/remotes/origin/master')?.[0] ??
        [...state.refs].find(([, ref]) => ref.ref === 'refs/heads/main')?.[0] ??
        [...state.refs].find(([, ref]) => ref.ref === 'refs/heads/master')?.[0] ??
        null
      const name = values.get('user.name'),
        email = values.get('user.email')
      if (name && email && !/[\r\n\0<>]/.test(name + email)) state.identity = { name, email }
      state.worktrees = await captureWorktrees(state, capture)
      state.stagedItems = parseGitStatus(
        await run(
          state,
          [
            'status',
            '--porcelain=v2',
            '-z',
            '--untracked-files=all',
            '--ignore-submodules=all',
            '--renames',
            '--',
            ...state.snapshot.pathspecs
          ],
          signal
        ),
        state.location.scopePath,
        state.snapshot.ignoreCase
      )
      // A newly selected view has not necessarily called the legacy list API yet.
      // The writer still needs its trusted full status when committing or checking a clean tree.
      if (!state.snapshot.items.length) state.snapshot.items = state.stagedItems
      const commits = state.headSha
        ? decodeGitText(
            await run(
              state,
              [
                'log',
                '--max-count=100',
                '--format=%H%x00%ct%x00%s%x00%an%x1e',
                state.headSha,
                '--'
              ],
              signal,
              { stdoutBytes: 1024 * 1024 }
            )
          )
        : ''
      state.commitRecords = []
      for (const record of commits.split('\x1e')) {
        const [sha, timestamp, subject, author] = record.trim().split('\0')
        if (!sha) continue
        if (
          !OID.test(sha) ||
          timestamp === undefined ||
          subject === undefined ||
          author === undefined ||
          !/^\d+$/.test(timestamp)
        )
          throw new GitReadError('error', 'Git 提交记录协议不完整')
        const commitId = randomUUID()
        state.commits.set(commitId, sha)
        state.commitRecords.push({
          commitId,
          sha,
          subject: label(subject, 4096),
          author: label(author, 1024),
          timestamp: Number(timestamp)
        })
      }
    })
    state.metadataReady = true
  }
  async function newState(view: GitReaderView): Promise<WorkbenchState> {
    if (!view.snapshot) throw new GitReadError('stale', 'Git 查看范围已释放')
    const previous = states.get(view)
    if (previous?.snapshot === view.snapshot) return previous
    const state: WorkbenchState = {
      view,
      location: view.location,
      snapshot: view.snapshot,
      program: await program(),
      config: new Map(),
      run: (args, signal, extra) => run(state, args, signal, extra),
      snapshotRevision: view.snapshot.revision,
      refs: new Map(),
      commits: new Map(),
      remotes: new Map(),
      worktrees: [],
      currentBranch: null,
      headSha: null,
      upstreamRefId: null,
      defaultBaseRefId: null,
      commitRecords: [],
      stagedItems: [],
      metadataReady: false,
      untrackedReady: false
    }
    states.set(view, state)
    return state
  }
  async function untrackedDiff(
    state: WorkbenchState,
    item: WorkbenchReviewItem,
    signal?: AbortSignal
  ): Promise<string> {
    const output = await run(
      state,
      [
        'diff',
        ...DIFF_OPTIONS,
        '--no-index',
        '--',
        process.platform === 'win32' ? 'NUL' : '/dev/null',
        item.path
      ],
      signal,
      { acceptedCodes: [0, 1], stdoutBytes: DIFF_BYTES }
    )
    try {
      return decodeGitText(output)
    } catch (error) {
      if (!(error instanceof GitReadError) || error.status !== 'unsupported') throw error
      // Diff content can contain arbitrary blob bytes even when Git's NUL heuristic
      // treats the file as text. Keep filename/status parsing strict, but summarize
      // a non-UTF-8 blob so one untracked file cannot disable the entire review.
      return 'Binary files /dev/null and b/' + item.path + ' differ\n'
    }
  }
  async function loadDiff(
    state: WorkbenchState,
    item: WorkbenchReviewItem,
    signal?: AbortSignal
  ): Promise<string> {
    if (item.patch !== undefined) return item.patch
    if (!state.review) throw new GitReadError('stale', 'Git 改动列表已失效')
    const output = item.untracked
      ? await untrackedDiff(state, item, signal)
      : decodeGitText(
          await run(
            state,
            [
              'diff',
              ...DIFF_OPTIONS,
              ...state.review.args,
              ...(state.review.hideWhitespace ? ['--ignore-all-space'] : []),
              '--unified=3',
              '--',
              item.path,
              ...(item.previousPath ? [item.previousPath] : [])
            ],
            signal,
            { stdoutBytes: DIFF_BYTES }
          )
        )
    if (Buffer.byteLength(output) > DIFF_BYTES)
      throw new GitReadError('too-large', 'Diff 超过 32 MiB')
    item.patch = output
    return output
  }

  return {
    async captureWorktree(view, signal): Promise<GitWorkbenchActionContext> {
      return operation(view, signal, async (current) => {
        const state = await newState(view)
        await prepareMetadata(state, current)
        return verified(state, current, async (capture) => {
          await hydrateUntracked(state, capture)
          return state
        })
      })
    },
    async metadata(view: GitReaderView, signal?: AbortSignal): Promise<GitMetadata> {
      return operation(view, signal, async (current) => {
        const state = await newState(view)
        await prepareMetadata(state, current)
        return verified(state, current, async () => {
          let ahead = 0,
            behind = 0
          const upstream = state.upstreamRefId ? state.refs.get(state.upstreamRefId) : null
          if (state.headSha && upstream) {
            const counts = decodeGitText(
              await run(
                state,
                ['rev-list', '--left-right', '--count', state.headSha + '...' + upstream.oid, '--'],
                current
              )
            )
              .trim()
              .split(/\s+/)
            ahead = count(counts[0]) ?? 0
            behind = count(counts[1]) ?? 0
          }
          return {
            ...(options.turns ? { lastTurn: options.turns.state(view) } : {}),
            revision: state.snapshotRevision,
            branch: state.currentBranch,
            headSha: state.headSha,
            ahead,
            behind,
            branches: [...state.refs]
              .filter(([, ref]) => !ref.ref.startsWith('refs/tags/'))
              .map(([refId, ref]) => ({
                refId,
                name: label(ref.name, 1024),
                oid: ref.oid,
                remote: ref.remote,
                current: ref.ref === 'refs/heads/' + state.currentBranch
              })),
            commits: state.commitRecords.map((record) => ({ ...record })),
            remotes: [...state.remotes].map(([remoteId, remote]) => ({
              remoteId,
              name: label(remote.name, 1024),
              url: label(remote.url, 4096),
              pushable: false,
              reason: '网络操作由独立托管模块检查'
            })),
            worktrees: state.worktrees.map((worktree) => ({
              worktreeId: worktree.worktreeId,
              path: worktree.path,
              branch: worktree.branch,
              head:
                worktree.headSha ??
                [...state.refs.values()].find((ref) => ref.ref === 'refs/heads/' + worktree.branch)
                  ?.oid ??
                '',
              current:
                path.resolve(worktree.path).toLowerCase() ===
                path.resolve(state.location.repositoryPath).toLowerCase(),
              locked: worktree.locked
            })),
            capabilities: [
              { name: 'review', available: true, reason: null },
              { name: 'stage', available: true, reason: null },
              { name: 'unstage', available: true, reason: null },
              { name: 'revert', available: true, reason: null },
              {
                name: 'commit',
                available: !state.location.scopePath,
                reason: state.location.scopePath ? '提交需要选择仓库根目录' : null
              },
              {
                name: 'create-branch',
                available: !state.location.scopePath,
                reason: state.location.scopePath ? '创建分支需要选择仓库根目录' : null
              },
              {
                name: 'checkout',
                available: !state.location.scopePath,
                reason: state.location.scopePath ? '切换分支需要选择仓库根目录' : null
              },
              {
                name: 'last-turn',
                available: !!options.turns?.hasCapture(view),
                reason: options.turns?.hasCapture(view)
                  ? null
                  : '等待所选仓库的独立回合捕获；不读取聊天或 checkpoint'
              },
              { name: 'push', available: false, reason: '网络操作需要独立托管模块检查' },
              { name: 'fetch', available: false, reason: '网络操作需要独立托管模块检查' },
              { name: 'create-pr', available: false, reason: '需要 GitHub CLI 和账户检查' },
              {
                name: 'create-worktree',
                available: false,
                reason: '工作树管理需要独立生命周期实现'
              },
              {
                name: 'remove-worktree',
                available: false,
                reason: '工作树管理需要独立生命周期实现'
              }
            ]
          }
        })
      })
    },
    async review(
      view: GitReaderView,
      request: {
        source: WorkbenchSource
        baseRefId?: string
        commitId?: string
        hideWhitespace?: boolean
      },
      signal?: AbortSignal
    ): Promise<GitReviewData> {
      if (request.source === 'last-turn' && options.turns)
        return options.turns.review(view, !!request.hideWhitespace, signal)
      return operation(view, signal, async (current) => {
        const state = await newState(view)
        await prepareMetadata(state, current)
        return verified(state, current, async (capture) => {
          const args: string[] = []
          let baseLabel = ''
          switch (request.source) {
            case 'last-turn':
              throw new GitReadError(
                'unsupported',
                '最近回合需要独立回合捕获，本项目人工 Git 查看不读取 Agent checkpoint'
              )
            case 'staged':
              args.push('--cached')
              baseLabel = 'HEAD → 暂存区'
              break
            case 'unstaged':
              baseLabel = '暂存区 → 工作目录'
              break
            case 'uncommitted': {
              const base =
                state.headSha ??
                decodeGitText(
                  await run(state, ['hash-object', '-w', '-t', 'tree', '--stdin'], current, {
                    input: Buffer.alloc(0)
                  })
                ).trim()
              if (!OID.test(base)) throw new GitReadError('error', 'Git 空树身份无效')
              args.push(base)
              baseLabel = state.headSha ? 'HEAD → 工作目录' : '空树 → 工作目录'
              break
            }
            case 'branch': {
              const ref = state.refs.get(request.baseRefId ?? state.defaultBaseRefId ?? '')
              if (!ref) throw new GitReadError('stale', '对比分支不可用，请选择分支')
              if (!state.headSha)
                throw new GitReadError('unsupported', '未创建首次提交，暂不能比较分支')
              const base = decodeGitText(
                await run(state, ['merge-base', state.headSha, ref.oid], current, {
                  acceptedCodes: [0, 1]
                })
              ).trim()
              if (!OID.test(base)) throw new GitReadError('unsupported', '分支没有共同基点')
              args.push(base)
              baseLabel = ref.name + ' 共同基点 → 工作目录'
              break
            }
            case 'commit': {
              const sha = state.commits.get(request.commitId ?? '')
              if (!sha) throw new GitReadError('stale', '提交记录已失效')
              let parent = decodeGitText(
                await run(state, ['rev-parse', '--verify', '--quiet', sha + '^'], current, {
                  acceptedCodes: [0, 1, 128]
                })
              ).trim()
              if (!OID.test(parent))
                parent = decodeGitText(
                  await run(state, ['hash-object', '-w', '-t', 'tree', '--stdin'], current, {
                    input: Buffer.alloc(0)
                  })
                ).trim()
              if (!OID.test(parent)) throw new GitReadError('error', 'Git 提交父树无效')
              args.push(parent, sha)
              baseLabel = sha.slice(0, 8) + ' 的提交'
              break
            }
          }
          const hide = request.hideWhitespace ? ['--ignore-all-space'] : []
          const listed = names(
            await run(
              state,
              [
                'diff',
                ...DIFF_OPTIONS,
                ...args,
                ...hide,
                '--name-status',
                '-z',
                '--',
                ...state.snapshot.pathspecs
              ],
              current
            )
          )
          const numbers = stats(
            await run(
              state,
              [
                'diff',
                ...DIFF_OPTIONS,
                ...args,
                ...hide,
                '--numstat',
                '-z',
                '--',
                ...state.snapshot.pathspecs
              ],
              current
            )
          )
          const includeUntracked =
            request.source === 'branch' ||
            request.source === 'uncommitted' ||
            request.source === 'unstaged'
          if (includeUntracked) await hydrateUntracked(state, capture)
          const review: ReviewState = {
            revision: randomUUID(),
            source: request.source,
            hideWhitespace: !!request.hideWhitespace,
            args,
            baseLabel,
            items: new Map()
          }
          const add = (
            entry: { path: string; previousPath: string | null; change: GitChangeItem['change'] },
            untracked = false
          ): void => {
            if (
              !validRepositoryPath(entry.path) ||
              !withinScope(entry.path, state.location.scopePath, state.snapshot.ignoreCase)
            )
              throw new GitReadError('error', 'Git 文件超出所选范围')
            const previousSafe =
              !entry.previousPath ||
              (validRepositoryPath(entry.previousPath) &&
                withinScope(
                  entry.previousPath,
                  state.location.scopePath,
                  state.snapshot.ignoreCase
                ))
            const stat = numbers.get(entry.path)
            const binary = stat?.additions === null || stat?.deletions === null
            const unsupportedStatus = state.stagedItems.some(
              (item) => item.path === entry.path && !item.previewable
            )
            const actionable =
              previousSafe &&
              entry.change !== 'unmerged' &&
              !/[\p{Cc}]/u.test(entry.path) &&
              !request.hideWhitespace &&
              !unsupportedStatus
            const actions: WorkbenchFile['actions'] = !actionable
              ? []
              : request.source === 'staged'
                ? ['unstage', 'revert']
                : request.source === 'unstaged'
                  ? ['stage', 'revert']
                  : request.source === 'uncommitted'
                    ? ['stage', 'revert']
                    : []
            const publicItem: WorkbenchFile = {
              itemId: randomUUID(),
              ...entry,
              additions: stat?.additions ?? 0,
              deletions: stat?.deletions ?? 0,
              binary,
              actions
            }
            review.items.set(publicItem.itemId, {
              publicItem,
              path: entry.path,
              previousPath: entry.previousPath,
              untracked,
              hunks: new Map()
            })
          }
          listed.forEach((entry) => add(entry))
          if (includeUntracked)
            for (const entry of state.stagedItems.filter((item) => item.group === 'untracked')) {
              if (!listed.some((item) => item.path === entry.path))
                add({ path: entry.path, previousPath: null, change: 'added' }, true)
            }
          if (review.items.size > ITEM_LIMIT)
            throw new GitReadError('too-large', 'Git 改动超过 2000 项')
          state.review = review
          // Untracked contents have no numstat in the tracked comparison; count their real owned patch.
          for (const item of review.items.values())
            if (item.untracked) {
              const patch = await loadDiff(state, item, current)
              item.publicItem.binary = /^Binary files |^GIT binary patch$/m.test(patch)
              item.publicItem.additions = item.publicItem.binary
                ? 0
                : patch
                    .split('\n')
                    .filter((line) => line.startsWith('+') && !line.startsWith('+++')).length
              item.publicItem.deletions = 0
            }
          return {
            revision: review.revision,
            source: review.source,
            baseLabel,
            files: [...review.items.values()].map((item) => ({
              ...item.publicItem,
              actions: [...item.publicItem.actions]
            })),
            stageCounts: {
              staged: state.stagedItems.filter((item) => item.group === 'staged').length,
              unstaged: state.stagedItems.filter((item) => item.group === 'unstaged').length,
              untracked: state.stagedItems.filter((item) => item.group === 'untracked').length
            },
            warnings: ['只读取所选范围；跨范围重命名和冲突项不能执行文件动作。']
          }
        })
      })
    },
    async diff(
      view: GitReaderView,
      request: { revision: string; itemId: string },
      signal?: AbortSignal
    ): Promise<GitDiffData> {
      if (options.turns?.ownsRevision(view, request.revision))
        return options.turns.diff(view, request, signal)
      const before = stateFor(view)
      if (before.review?.revision !== request.revision || !before.review.items.has(request.itemId))
        throw new GitReadError('stale', 'Git 改动列表已失效')
      return operation(view, signal, async (current) => {
        const state = stateFor(view)
        return verified(state, current, async () => {
          const review = state.review
          const item = review?.items.get(request.itemId)
          if (!review || review.revision !== request.revision || !item)
            throw new GitReadError('stale', 'Git 文件记录已失效')
          if (
            item.previousPath &&
            !withinScope(item.previousPath, state.location.scopePath, state.snapshot.ignoreCase)
          )
            throw new GitReadError('unsupported', '跨范围重命名不能预览')
          const patch = await loadDiff(state, item, current)
          const binary = item.publicItem.binary || /^Binary files |^GIT binary patch$/m.test(patch)
          const mixedIndex =
            review.source === 'uncommitted' &&
            state.stagedItems.some(
              (candidate) =>
                candidate.group === 'staged' &&
                (candidate.path === item.path || candidate.path === item.previousPath)
            )
          const { publicHunks, patches } = splitHunks(
            patch,
            !binary &&
              !review.hideWhitespace &&
              !mixedIndex &&
              item.publicItem.actions.length > 0 &&
              item.publicItem.change === 'modified'
          )
          for (const hunk of publicHunks)
            hunk.actions = patches.has(hunk.hunkId) ? [...item.publicItem.actions] : []
          item.hunks = patches
          const text = patch.replace(
            // eslint-disable-next-line no-control-regex -- Keep control bytes visible; original patch stays in main only.
            /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,
            (character) => '\\x' + character.charCodeAt(0).toString(16).padStart(2, '0')
          )
          if (Buffer.byteLength(text) > DIFF_BYTES)
            throw new GitReadError('too-large', '可见 Diff 超过 32 MiB')
          return { itemId: request.itemId, text, binary, hunks: publicHunks }
        })
      })
    },
    async context(
      view: GitReaderView,
      revision?: string,
      signal?: AbortSignal
    ): Promise<GitWorkbenchActionContext> {
      if (revision && options.turns?.ownsRevision(view, revision))
        throw new GitReadError('unsupported', '最近回合是独立历史快照，不能执行 Git 写入或生成')
      const state = stateFor(view)
      if (revision && revision !== state.snapshotRevision && revision !== state.review?.revision)
        throw new GitReadError('stale', 'Git 动作记录已失效')
      return verified(state, signal, async () => state)
    }
  }
}
