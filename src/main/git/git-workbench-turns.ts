import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { GitReaderView } from './git-reader'
import { createGitReader } from './git-reader'
import { createGitWorkbenchReader } from './git-workbench-reader'
import type { GitWorkbenchActionContext } from './git-workbench-reader'
import { withGitRepositoryLock } from './git-workbench-lock'
import { GitReadError } from './git-process'
import type { GitProcessObservation } from './git-process'
import {
  SourceCapture,
  decodeGitText,
  validRepositoryPath,
  withinScope,
  gitSnapshotLimits
} from './git-snapshot'
import type { GitReviewData, GitDiffData, GitFullFileData } from '../../shared/git-workbench'
import type { GitTurnCaptureState } from '../../shared/git-observation'

type TurnStatus = 'completed' | 'interrupted' | 'failed'
interface Captured {
  view: GitReaderView
  context: GitWorkbenchActionContext
  tree: string
}
interface TurnReview {
  revision: string
  data: GitReviewData
  items: Map<string, GitReviewData['files'][number]>
  hideWhitespace: boolean
}
interface TurnRecord {
  owner: GitReaderView
  state: GitTurnCaptureState
  base?: Captured
  current?: Captured
  review?: TurnReview
  controller?: AbortController
  settled?: Promise<void>
  reads: Map<AbortController, Promise<unknown>>
  closed: boolean
}
export interface GitWorkbenchTurns {
  start: (views: GitReaderView[]) => Promise<string>
  complete: (token: string, status: TurnStatus) => Promise<void>
  state: (view: GitReaderView) => GitTurnCaptureState
  hasCapture: (view: GitReaderView) => boolean
  ownsRevision: (view: GitReaderView, revision: string) => boolean
  review: (
    view: GitReaderView,
    hideWhitespace?: boolean,
    signal?: AbortSignal
  ) => Promise<GitReviewData>
  diff: (
    view: GitReaderView,
    request: { revision: string; itemId: string },
    signal?: AbortSignal
  ) => Promise<GitDiffData>
  fullFile: (
    view: GitReaderView,
    request: { revision: string; itemId: string; side: 'base' | 'current' },
    signal?: AbortSignal
  ) => Promise<GitFullFileData>
  release: (view: GitReaderView) => Promise<void>
  close: () => Promise<void>
}
export const gitTurnCaptureLimits = {
  views: 8,
  milliseconds: 15000,
  files: 2000,
  diffBytes: 32 * 1024 * 1024
} as const
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const DIFF_ARGS = [
  '--no-ext-diff',
  '--no-textconv',
  '--no-color',
  '--src-prefix=a/',
  '--dst-prefix=b/',
  '--ignore-submodules=all',
  '--find-renames',
  '--full-index'
]
const unavailable = (): GitTurnCaptureState => ({
  turnNumber: 0,
  state: 'unavailable',
  startedAt: null,
  completedAt: null,
  message: '选择仓库后，下一次 Agent 回合将独立捕获 Git 差异。'
})

/** A window owns at most one before/after pair per selected scope. No conversation IDs,
 * model requests, tools, PTY text, grants, tickets, raw or checkpoint enter this service.
 */
export function createGitWorkbenchTurns(options: {
  cacheRoot: string
  onChanged?: (view: GitReaderView) => void
  onProcess?: (event: GitProcessObservation) => void
}): GitWorkbenchTurns {
  const reader = createGitReader({
    cacheRoot: path.join(options.cacheRoot, 'turns'),
    onProcess: options.onProcess
  })
  const workbench = createGitWorkbenchReader({ onProcess: options.onProcess })
  const records = new Map<GitReaderView, TurnRecord>()
  const groups = new Map<string, TurnRecord[]>()
  const retainedViews = new Set<GitReaderView>()
  let turnNumber = 0
  let closed = false
  let blocked: string | undefined
  let unconfirmed = false
  const retirementError = (error: unknown): string =>
    (
      '回合 Git 缓存清理未确认；保留缓存，请重启应用后重试。' +
      (error instanceof Error ? ' ' + error.message : '')
    )
      .replace(/\p{Cc}/gu, ' ')
      .slice(0, 2048)
  function changed(record: TurnRecord): void {
    if (closed || record.closed || record.owner.disposed || records.get(record.owner) !== record)
      return
    try {
      options.onChanged?.(record.owner)
    } catch {
      /* A retired document cannot publish. */
    }
  }
  async function disposeCaptured(captured?: Captured): Promise<void> {
    if (!captured) return
    try {
      await reader.dispose(captured.view)
      retainedViews.delete(captured.view)
    } catch (error) {
      retainedViews.add(captured.view)
      blocked = retirementError(error)
      if (error instanceof Error && error.message.includes('退出未确认')) unconfirmed = true
      throw new GitReadError('error', blocked)
    }
  }
  async function clear(record: TurnRecord): Promise<void> {
    const base = record.base,
      current = record.current
    if (current?.view.snapshot?.retained && base?.view.snapshot) base.view.snapshot.retained = true
    const results = await Promise.allSettled([disposeCaptured(base), disposeCaptured(current)])
    const failed = results.find((result) => result.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
    record.base = record.current = undefined
    record.review = undefined
  }
  async function capture(owner: GitReaderView, signal: AbortSignal): Promise<Captured> {
    if (blocked) throw new GitReadError('error', blocked)
    if (owner.disposed || signal.aborted) throw new GitReadError('cancelled', '回合 Git 捕获已取消')
    return withGitRepositoryLock(owner.location.common, signal, async () => {
      if (blocked) throw new GitReadError('error', blocked)
      if (owner.disposed || signal.aborted)
        throw new GitReadError('cancelled', '回合 Git 捕获已取消')
      // A separate reader view cannot abort or replace a user review/write operation.
      const view = await reader.open(owner.location.selectedPath, signal)
      try {
        if (JSON.stringify(view.location) !== JSON.stringify(owner.location))
          throw new GitReadError('stale', '回合开始时仓库位置已变化，请重新选择')
        const context = await workbench.captureWorktree(view, signal)
        if (
          context.snapshot.entries.some(
            (entry) =>
              withinScope(entry.path, owner.location.scopePath, context.snapshot.ignoreCase) &&
              (entry.stage !== 0 || entry.mode === '160000')
          )
        )
          throw new GitReadError('unsupported', '冲突或子模块范围暂不能捕获完整回合差异')
        const env = {
          ...context.snapshot.env,
          GIT_INDEX_FILE: path.join(context.snapshot.gitdir, 'turn-index')
        }
        await context.run(['read-tree', '--empty'], signal, { env })
        // Only copied files within this scope become an independent cache tree.
        await context.run(
          ['add', '--force', '--all', '--', ...context.snapshot.pathspecs],
          signal,
          { env }
        )
        const tree = decodeGitText(
          await context.run(['write-tree'], signal, { env, stdoutBytes: 100 })
        ).trim()
        if (!OID.test(tree)) throw new GitReadError('error', '回合 Git 快照树身份无效')
        return { view, context, tree }
      } catch (error) {
        try {
          await reader.dispose(view)
        } catch (cleanupError) {
          retainedViews.add(view)
          blocked = retirementError(cleanupError)
          if (cleanupError instanceof Error && cleanupError.message.includes('退出未确认'))
            unconfirmed = true
          throw new GitReadError('error', blocked)
        }
        throw error
      }
    })
  }
  async function bounded(
    record: TurnRecord,
    body: (signal: AbortSignal) => Promise<void>
  ): Promise<void> {
    const controller = new AbortController()
    record.controller = controller
    const timer = setTimeout(() => controller.abort(), gitTurnCaptureLimits.milliseconds)
    const work = (async () => {
      try {
        await body(controller.signal)
      } catch (error) {
        if (error instanceof Error && /退出未确认|清理未确认|清理失败/.test(error.message))
          blocked ??= retirementError(error)
        if (error instanceof Error && error.message.includes('退出未确认')) unconfirmed = true
        if (!record.closed && !closed) {
          record.state.state = 'error'
          record.state.completedAt = Date.now()
          record.state.message =
            blocked ??
            (error instanceof GitReadError
              ? error.message.replace(/\p{Cc}/gu, ' ').slice(0, 2048)
              : '独立回合 Git 捕获失败，请刷新后重试。')
          changed(record)
        }
      } finally {
        clearTimeout(timer)
        if (record.controller === controller) record.controller = undefined
      }
    })()
    record.settled = work
    await work
  }
  function recordFor(view: GitReaderView): TurnRecord {
    const record = records.get(view)
    if (
      closed ||
      blocked ||
      view.disposed ||
      !record ||
      record.closed ||
      !record.base ||
      !record.current ||
      record.state.state === 'capturing' ||
      record.state.state === 'error'
    )
      throw new GitReadError('unavailable', record?.state.message ?? '此仓库尚无完整回合 Git 捕获')
    return record
  }
  async function run(
    record: TurnRecord,
    args: string[],
    signal?: AbortSignal,
    stdoutBytes = gitTurnCaptureLimits.diffBytes
  ): Promise<Buffer> {
    if (closed || blocked || record.closed || record.owner.disposed)
      throw new GitReadError('stale', '回合 Git 捕获已释放')
    const base = record.base!,
      current = record.current!
    const controller = new AbortController()
    const abort = (): void => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) controller.abort()
    const work = current.context.run(args, controller.signal, {
      env: {
        ...current.context.snapshot.env,
        GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(base.context.snapshot.gitdir, 'objects')
      },
      stdoutBytes
    })
    record.reads.set(controller, work)
    try {
      const output = await work
      if (closed || record.closed || record.owner.disposed || records.get(record.owner) !== record)
        throw new GitReadError('stale', '回合 Git 捕获已释放')
      return output
    } catch (error) {
      if (current.view.snapshot?.retained && base.view.snapshot) base.view.snapshot.retained = true
      if (error instanceof Error && error.message.includes('退出未确认')) {
        unconfirmed = true
        blocked = retirementError(error)
        record.state.state = 'error'
        record.state.completedAt = Date.now()
        record.state.message = blocked
        changed(record)
      }
      throw error
    } finally {
      signal?.removeEventListener('abort', abort)
      record.reads.delete(controller)
    }
  }
  function reviewed(
    view: GitReaderView,
    request: { revision: string; itemId: string }
  ): { record: TurnRecord; item: GitReviewData['files'][number]; review: TurnReview } {
    const record = recordFor(view),
      review = record.review,
      item = review?.items.get(request.itemId)
    if (!review || review.revision !== request.revision || !item)
      throw new GitReadError('stale', '回合 Git 文件记录已失效')
    return { record, item, review }
  }
  async function release(view: GitReaderView): Promise<void> {
    const record = records.get(view)
    if (!record) {
      if (unconfirmed) throw new GitReadError('error', blocked ?? '回合 Git 进程退出未确认')
      return
    }
    record.closed = true
    record.controller?.abort()
    for (const controller of record.reads.keys()) controller.abort()
    await record.settled?.catch(() => {})
    await Promise.allSettled([...record.reads.values()])
    if (unconfirmed) throw new GitReadError('error', blocked ?? '回合 Git 进程退出未确认')
    await clear(record)
    records.delete(view)
  }
  function publishBlocked(owner: GitReaderView, number: number): void {
    if (closed || owner.disposed) return
    const record = records.get(owner) ?? {
      owner,
      reads: new Map(),
      closed: false,
      state: {
        turnNumber: number,
        state: 'error' as const,
        startedAt: Date.now(),
        completedAt: Date.now(),
        message: blocked!
      }
    }
    record.closed = false
    record.state.state = 'error'
    record.state.completedAt = Date.now()
    record.state.message = blocked!
    records.set(owner, record)
    changed(record)
  }
  return {
    async start(views): Promise<string> {
      const token = randomUUID()
      if (closed || !views.length) return token
      const number = ++turnNumber
      const selected = [...new Set(views)]
        .filter((view) => !view.disposed && !!view.snapshot)
        .slice(0, gitTurnCaptureLimits.views)
      const group: TurnRecord[] = []
      groups.set(token, group)
      await Promise.all(
        selected.map(async (owner) => {
          if (blocked) {
            publishBlocked(owner, number)
            return
          }
          try {
            await release(owner)
          } catch (error) {
            blocked ??= retirementError(error)
            publishBlocked(owner, number)
            return
          }
          if (closed || owner.disposed) return
          const record: TurnRecord = {
            owner,
            closed: false,
            reads: new Map(),
            state: {
              turnNumber: number,
              state: 'capturing',
              startedAt: Date.now(),
              completedAt: null,
              message: '正在捕获本回合之前的 Git 工作目录。'
            }
          }
          records.set(owner, record)
          group.push(record)
          changed(record)
          await bounded(record, async (signal) => {
            const base = await capture(owner, signal)
            if (closed || record.closed || owner.disposed) {
              await disposeCaptured(base)
              return
            }
            record.base = base
            record.state.message = '已捕获回合起点，等待 Agent 回合结束。'
            changed(record)
          })
        })
      )
      return token
    },
    async complete(token, status): Promise<void> {
      const group = groups.get(token)
      groups.delete(token)
      if (!group || closed) return
      await Promise.all(
        group.map(async (record) => {
          if (
            record.closed ||
            record.owner.disposed ||
            records.get(record.owner) !== record ||
            !record.base ||
            record.state.state === 'error'
          )
            return
          await bounded(record, async (signal) => {
            const current = await capture(record.owner, signal)
            if (closed || record.closed || record.owner.disposed) {
              await disposeCaptured(current)
              return
            }
            record.current = current
            record.state.state = status
            record.state.completedAt = Date.now()
            record.state.message =
              status === 'completed'
                ? null
                : '本回合未正常完成；显示捕获时实际留下的 Git 工作目录差异。'
            changed(record)
          })
        })
      )
    },
    state(view): GitTurnCaptureState {
      return { ...(records.get(view)?.state ?? unavailable()) }
    },
    hasCapture(view): boolean {
      const record = records.get(view)
      return (
        !!record &&
        !closed &&
        !blocked &&
        !record.closed &&
        !view.disposed &&
        !!record.base &&
        !!record.current &&
        record.state.state !== 'error'
      )
    },
    ownsRevision(view, revision): boolean {
      return records.get(view)?.review?.revision === revision
    },
    async review(view, hideWhitespace = false, signal): Promise<GitReviewData> {
      const record = recordFor(view)
      const args = [
        'diff',
        ...DIFF_ARGS,
        ...(hideWhitespace ? ['--ignore-all-space'] : []),
        record.base!.tree,
        record.current!.tree
      ]
      const recordsText = decodeGitText(
        await run(record, [...args, '--name-status', '-z', '--'], signal)
      )
      if (recordsText && !recordsText.endsWith('\0'))
        throw new GitReadError('error', '回合 Git 文件协议不完整')
      const values = recordsText.split('\0')
      const numberRecords = decodeGitText(
        await run(record, [...args, '--numstat', '-z', '--'], signal)
      ).split('\0')
      const numbers = new Map<string, { additions: number; deletions: number; binary: boolean }>()
      for (let i = 0; i < numberRecords.length - 1; i++) {
        const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(numberRecords[i])
        if (!match) throw new GitReadError('error', '回合 Git 行数协议不完整')
        let filename = match[3]
        if (!filename) {
          i++
          filename = numberRecords[++i]
        }
        if (!filename) throw new GitReadError('error', '回合 Git 重命名协议不完整')
        numbers.set(filename, {
          additions: match[1] === '-' ? 0 : Number(match[1]),
          deletions: match[2] === '-' ? 0 : Number(match[2]),
          binary: match[1] === '-' || match[2] === '-'
        })
      }
      const files: GitReviewData['files'] = []
      for (let index = 0; index < values.length - 1; index++) {
        const status = values[index],
          first = values[++index]
        if (!/^[AMDTRC](?:\d+)?$/.test(status) || !first)
          throw new GitReadError('error', '回合 Git 文件状态不完整')
        const previousPath = /^[RC]/.test(status) ? first : null
        const filename = previousPath ? values[++index] : first
        for (const candidate of [filename, previousPath].filter(
          (value): value is string => !!value
        ))
          if (
            !validRepositoryPath(candidate) ||
            !withinScope(
              candidate,
              view.location.scopePath,
              record.current!.context.snapshot.ignoreCase
            )
          )
            throw new GitReadError('unsupported', '回合 Git 路径超出所选范围')
        const change = (
          {
            A: 'added',
            M: 'modified',
            D: 'deleted',
            R: 'renamed',
            C: 'copied',
            T: 'type-changed'
          } as const
        )[status[0] as 'A']
        files.push({
          itemId: randomUUID(),
          path: filename,
          previousPath,
          change,
          ...(numbers.get(filename) ?? { additions: 0, deletions: 0, binary: false }),
          actions: []
        })
        if (files.length > gitTurnCaptureLimits.files)
          throw new GitReadError('too-large', '回合 Git 改动超过 2000 项')
      }
      const state = record.state
      const data: GitReviewData = {
        revision: randomUUID(),
        source: 'last-turn',
        baseLabel: `第 ${state.turnNumber} 回合 · ${state.state === 'completed' ? '已完成' : state.state === 'interrupted' ? '已停止' : '失败'} · 开始 → 结束`,
        files,
        stageCounts: { staged: 0, unstaged: 0, untracked: 0 },
        warnings: [
          '独立 Git 工作目录快照，可能包含回合期间的人工改动；不表示改动均由 Agent 产生。最近回合不提供写入动作。'
        ]
      }
      record.review = {
        revision: data.revision,
        data,
        hideWhitespace,
        items: new Map(files.map((item) => [item.itemId, item]))
      }
      return data
    },
    async diff(view, request, signal): Promise<GitDiffData> {
      const { record, item, review } = reviewed(view, request)
      const bytes = await run(
        record,
        [
          'diff',
          ...DIFF_ARGS,
          ...(review.hideWhitespace ? ['--ignore-all-space'] : []),
          '--unified=3',
          record.base!.tree,
          record.current!.tree,
          '--',
          item.path,
          ...(item.previousPath ? [item.previousPath] : [])
        ],
        signal
      )
      let text: string
      try {
        text = decodeGitText(bytes)
      } catch {
        text = `Binary files a/${item.previousPath ?? item.path} and b/${item.path} differ\n`
      }
      const binary = item.binary || /^Binary files |^GIT binary patch$/m.test(text)
      const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? []
      const starts = lines.flatMap((line, index) =>
        /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(line) ? [index] : []
      )
      const hunks = starts.map((start, index) => ({
        hunkId: randomUUID(),
        header: lines[start].trimEnd().replace(/\p{Cc}/gu, ' '),
        startLine: start + 1,
        endLine: starts[index + 1] ?? lines.length,
        actions: []
      }))
      text = text.replace(/\p{Cc}/gu, (character) =>
        /[\t\r\n]/.test(character)
          ? character
          : '\\x' + character.charCodeAt(0).toString(16).padStart(2, '0')
      )
      if (Buffer.byteLength(text) > gitTurnCaptureLimits.diffBytes)
        throw new GitReadError('too-large', '回合 Git Diff 超过 32 MiB')
      return { itemId: item.itemId, text, binary, hunks }
    },
    async fullFile(view, request, signal): Promise<GitFullFileData> {
      const { record, item } = reviewed(view, request)
      const controller = new AbortController()
      const abort = (): void => controller.abort()
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) controller.abort()
      const work = (async (): Promise<GitFullFileData> => {
        const captured = request.side === 'base' ? record.base! : record.current!
        const filename = request.side === 'base' ? (item.previousPath ?? item.path) : item.path
        const identity = { itemId: item.itemId, path: filename, side: request.side }
        if (closed || record.closed || view.disposed)
          throw new GitReadError('stale', '回合 Git 捕获已释放')
        let bytes: Buffer
        try {
          bytes = await new SourceCapture(controller.signal).file(
            path.join(captured.context.snapshot.worktree, ...filename.split('/')),
            gitSnapshotLimits.trackedFileBytes
          )
        } catch (error) {
          if (closed || record.closed || view.disposed)
            throw new GitReadError('stale', '回合 Git 捕获已释放')
          if ((error as NodeJS.ErrnoException).code === 'ENOENT')
            return { ...identity, format: 'missing' }
          throw error
        }
        if (closed || record.closed || view.disposed)
          throw new GitReadError('stale', '回合 Git 捕获已释放')
        let mime: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | undefined
        if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
          mime = 'image/png'
        else if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) mime = 'image/jpeg'
        else if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) mime = 'image/gif'
        else if (
          bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
          bytes.subarray(8, 12).toString('ascii') === 'WEBP'
        )
          mime = 'image/webp'
        if (mime) return { ...identity, format: 'image', mime, base64: bytes.toString('base64') }
        if (bytes.includes(0)) return { ...identity, format: 'binary' }
        try {
          return {
            ...identity,
            format: 'text',
            text: decodeGitText(bytes).replace(/\p{Cc}/gu, (character) =>
              /[\t\r\n]/.test(character) ? character : '\uFFFD'
            )
          }
        } catch {
          return { ...identity, format: 'binary' }
        }
      })()
      record.reads.set(controller, work)
      try {
        return await work
      } finally {
        signal?.removeEventListener('abort', abort)
        record.reads.delete(controller)
      }
    },
    release,
    async close(): Promise<void> {
      closed = true
      groups.clear()
      const results = await Promise.allSettled([...records.keys()].map(release))
      if (unconfirmed) throw new GitReadError('error', blocked ?? '回合 Git 进程退出未确认')
      const orphaned = await Promise.allSettled(
        [...retainedViews].map(async (view) => {
          await reader.dispose(view)
          retainedViews.delete(view)
        })
      )
      const failed = [...results, ...orphaned].find((result) => result.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
    }
  }
}
