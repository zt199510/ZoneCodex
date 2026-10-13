import { watch as watchDirectory, promises as fs } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import path from 'node:path'
import type { GitReaderView } from './git-reader'
import { assertOrdinaryPath } from './git-snapshot'

export interface GitObserverEvent {
  reason: 'worktree' | 'metadata' | 'recovery'
  sequence: number
  status: 'watching' | 'limited' | 'error'
  message?: string
}
interface DirectoryWatch {
  watcher: FSWatcher
  ignored: Set<string>
  reason: 'worktree' | 'metadata'
  retired: Promise<void>
}
interface Observation {
  watchers: Map<string, DirectoryWatch>
  closed: boolean
  sequence: number
  pending?: GitObserverEvent['reason']
  timer?: ReturnType<typeof setTimeout>
  settled: Promise<void>
  generation: number
  status: GitObserverEvent['status']
  message?: string
}
export const gitObserverLimits = { views: 8, directoriesPerView: 256, debounceMs: 250 } as const

function key(filename: string): string {
  return path.resolve(filename).toLocaleLowerCase('en-US')
}
function contained(filename: string, directory: string): boolean {
  const relative = path.relative(key(directory), key(filename))
  return (
    !relative ||
    (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
  )
}

/** Watches only directories already traversed by the bounded reader, never recursive fs.watch.
 * Events invalidate a selected view; this service executes no Git commands and reads no file contents.
 */
export function createGitWorkbenchObservers(options: {
  onInvalidate: (view: GitReaderView, event: GitObserverEvent) => void
  excludeRoots?: string[]
}): {
  watch: (view: GitReaderView) => Promise<void>
  release: (view: GitReaderView) => Promise<void>
  close: () => Promise<void>
} {
  const observations = new Map<GitReaderView, Observation>()
  const excluded = (options.excludeRoots ?? []).map((directory) => path.resolve(directory))
  let closed = false
  function emit(
    view: GitReaderView,
    observation: Observation,
    reason: GitObserverEvent['reason']
  ): void {
    if (closed || observation.closed || view.disposed || observations.get(view) !== observation)
      return
    try {
      options.onInvalidate(view, {
        reason,
        sequence: ++observation.sequence,
        status: observation.status,
        ...(observation.message ? { message: observation.message } : {})
      })
    } catch {
      // A closed renderer cannot revive the observation or retain filesystem handles.
    }
  }
  function queue(
    view: GitReaderView,
    observation: Observation,
    reason: GitObserverEvent['reason']
  ): void {
    if (closed || observation.closed || view.disposed) return
    observation.pending = observation.pending === 'metadata' ? 'metadata' : reason
    if (observation.timer) return
    observation.timer = setTimeout(() => {
      observation.timer = undefined
      const pending = observation.pending
      observation.pending = undefined
      if (pending) emit(view, observation, pending)
    }, gitObserverLimits.debounceMs)
    observation.timer.unref()
  }
  async function retire(entry: DirectoryWatch): Promise<void> {
    entry.watcher.close()
    await entry.retired
  }
  async function release(view: GitReaderView): Promise<void> {
    const observation = observations.get(view)
    if (!observation) return
    observation.closed = true
    observation.generation++
    if (observation.timer) clearTimeout(observation.timer)
    await observation.settled.catch(() => {})
    await Promise.all([...observation.watchers.values()].map(retire))
    observation.watchers.clear()
    observations.delete(view)
  }
  return {
    async watch(view): Promise<void> {
      if (closed || view.disposed || !view.snapshot) return
      let observation = observations.get(view)
      if (!observation) {
        if (observations.size >= gitObserverLimits.views) return
        observation = {
          watchers: new Map(),
          closed: false,
          sequence: 0,
          settled: Promise.resolve(),
          generation: 0,
          status: 'watching'
        }
        observations.set(view, observation)
      }
      const current = observation
      const generation = ++current.generation
      const previous = current.settled
      const work = (async (): Promise<void> => {
        await previous.catch(() => {})
        if (closed || current.closed || view.disposed || current.generation !== generation) return
        const priorStatus = current.status
        const priorMessage = current.message
        const snapshot = view.snapshot!
        const desired = new Map<string, { directory: string; reason: 'worktree' | 'metadata' }>()
        const add = (directory: string, reason: 'worktree' | 'metadata'): void => {
          if (excluded.some((root) => contained(directory, root))) return
          desired.set(key(directory), { directory, reason })
        }
        add(view.location.selectedPath, 'worktree')
        // Parent root sees replacement of a .git pointer and scope directory.
        add(view.location.repositoryPath, 'worktree')
        add(view.location.gitdir, 'metadata')
        add(view.location.common, 'metadata')
        for (const fingerprint of snapshot.source.fingerprints.values()) {
          if (fingerprint.kind !== 'directory') continue
          if (
            contained(fingerprint.target, view.location.common) ||
            contained(fingerprint.target, view.location.gitdir)
          ) {
            const commonRelative = path
              .relative(view.location.common, fingerprint.target)
              .split(path.sep)
              .join('/')
            const gitRelative = path
              .relative(view.location.gitdir, fingerprint.target)
              .split(path.sep)
              .join('/')
            if (
              /^(?:refs|worktrees)(?:\/|$)/.test(commonRelative) ||
              /^(?:refs|worktrees)(?:\/|$)/.test(gitRelative)
            )
              add(fingerprint.target, 'metadata')
          } else if (contained(fingerprint.target, view.location.selectedPath))
            add(fingerprint.target, 'worktree')
        }
        const allowed = new Set(desired.keys())
        const truncated = desired.size > gitObserverLimits.directoriesPerView
        current.status = truncated ? 'limited' : 'watching'
        current.message = truncated
          ? '自动刷新目录达到 256 项；其余目录变化可手动刷新。'
          : undefined
        const selected = new Map([...desired].slice(0, gitObserverLimits.directoriesPerView))
        for (const [directory, existing] of [...current.watchers]) {
          if (selected.has(directory)) continue
          current.watchers.delete(directory)
          await retire(existing)
        }
        for (const [directoryKey, entry] of selected) {
          if (closed || current.closed || view.disposed || current.generation !== generation) return
          try {
            await assertOrdinaryPath(entry.directory)
            const ignored = new Set<string>()
            if (entry.reason === 'worktree') {
              for (const child of await fs.readdir(entry.directory, { withFileTypes: true })) {
                const childPath = path.join(entry.directory, child.name)
                const scopeChild = path
                  .relative(entry.directory, view.location.selectedPath)
                  .split(path.sep)[0]
                if (
                  child.name.toLowerCase() === '.git' ||
                  child.isSymbolicLink() ||
                  excluded.some((root) => contained(childPath, root)) ||
                  (child.isDirectory() && !allowed.has(key(childPath))) ||
                  (entry.directory !== view.location.selectedPath &&
                    !contained(entry.directory, view.location.selectedPath) &&
                    child.name !== scopeChild &&
                    !['.git', '.gitignore', '.gitattributes'].includes(child.name.toLowerCase()))
                )
                  ignored.add(child.name.toLocaleLowerCase('en-US'))
              }
            }
            const existing = current.watchers.get(directoryKey)
            if (existing) {
              existing.ignored = ignored
              continue
            }
            const watcher = watchDirectory(
              entry.directory,
              { persistent: false, recursive: false },
              (_event, filename) => {
                const currentWatch = current.watchers.get(directoryKey)
                if (!currentWatch) return
                const name = filename?.toString().toLocaleLowerCase('en-US')
                if (name && currentWatch.ignored.has(name) && name !== '.git') return
                if (
                  currentWatch.reason === 'metadata' &&
                  name &&
                  /^(objects|logs|hooks)(?:[\\/]|$)/.test(name)
                )
                  return
                queue(view, current, currentWatch.reason)
              }
            )
            watcher.on('error', () => {
              current.status = 'error'
              current.message = '自动刷新监听已中断；请刷新或重新选择仓库。'
              queue(view, current, 'recovery')
            })
            const retired = new Promise<void>((resolve) =>
              watcher.once('close', () => {
                if (current.watchers.get(directoryKey)?.watcher === watcher)
                  current.watchers.delete(directoryKey)
                resolve()
              })
            )
            current.watchers.set(directoryKey, { watcher, ignored, reason: entry.reason, retired })
          } catch {
            current.status = 'error'
            current.message = '部分自动刷新目录不可用；请刷新或重新选择仓库。'
          }
        }
        if (current.status !== priorStatus || current.message !== priorMessage)
          emit(view, current, 'recovery')
      })()
      current.settled = work
      await work
    },
    release,
    async close(): Promise<void> {
      closed = true
      await Promise.all([...observations.keys()].map(release))
    }
  }
}
