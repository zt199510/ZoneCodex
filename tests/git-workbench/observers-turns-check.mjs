import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import { randomUUID } from 'node:crypto'
import {
  createEvidence,
  checksFor,
  root,
  runProcess,
  hash,
  assertOwnedPath,
  delay
} from './runtime.mjs'
import { findFixtureGit } from '../lesson61/materials.mjs'
import { diskIdentity, verifyProcessRetirement } from '../lesson61/runtime.mjs'

const evidence = await createEvidence('observers-turns-native')
const harness = checksFor(evidence, {
  actualGit: true,
  actualDisk: true,
  actualFilesystemWatchers: true,
  actualElectron: false,
  realModelTransport: false,
  actualAgent: false,
  actualPTY: false,
  synthetic: [
    'Strict parser adversarial records',
    'Agent before/after lifecycle invokes independent capture directly',
    'watcher limit uses synthetic reader fingerprint map over real directories',
    'Owned query cache cleanup failure is an injected fs.rm EPERM; existing snapshots and Git processes are actual'
  ],
  fixtureGitWrites:
    'Only new UUID fixture repositories; independent turn trees/index/objects write owned query caches, never source .git.'
})
const output = path.join(evidence, 'current-observers-turns.cjs')
const bundle = await build({
  stdin: {
    contents:
      'export * from "./src/main/git/git-reader.ts"; export * from "./src/main/git/git-workbench-reader.ts"; export * from "./src/main/git/git-workbench-observers.ts"; export * from "./src/main/git/git-workbench-turns.ts"; export * from "./src/main/git/git-workbench-lock.ts"; export * from "./src/shared/git-workbench.ts"; export * from "./src/shared/git-observation.ts";',
    resolveDir: root
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: output,
  metafile: true,
  logLevel: 'silent'
})
const sources = Object.fromEntries(
  await Promise.all(
    Object.keys(bundle.metafile.inputs)
      .filter((name) => name !== '<stdin>')
      .map(async (name) => [name, hash(await fs.readFile(path.join(root, name)))])
  )
)
await fs.writeFile(path.join(evidence, 'source-identity.json'), JSON.stringify(sources, null, 2))
const api = createRequire(import.meta.url)(output)
const git = await findFixtureGit()
const fixture = assertOwnedPath(evidence, path.join(evidence, 'fixture'))
const second = assertOwnedPath(evidence, path.join(evidence, 'second'))
await fs.mkdir(fixture, { recursive: true })
await fs.mkdir(second, { recursive: true })
const empty = path.join(evidence, 'empty-global.config')
await fs.writeFile(empty, '')
const environment = { ...process.env }
for (const key of Object.keys(environment))
  if (/^GIT_|^NODE_OPTIONS$|^ELECTRON_RUN_AS_NODE$/i.test(key)) delete environment[key]
Object.assign(environment, {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: empty,
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_NO_LAZY_FETCH: '1'
})
async function gitAt(directory, args) {
  assertOwnedPath(evidence, directory)
  const result = await runProcess(
    git,
    [
      '--no-optional-locks',
      '-c',
      'core.hooksPath=' + path.join(evidence, 'no-hooks'),
      '-c',
      'core.autocrlf=false',
      '-c',
      'user.name=Turn Fixture',
      '-c',
      'user.email=turn@example.invalid',
      ...args
    ],
    { cwd: directory, env: environment },
    15000
  )
  assert.equal(result.exitCode, 0, result.stderr)
  return result.stdout.trim()
}
async function write(directory, name, text) {
  const filename = assertOwnedPath(evidence, path.join(directory, name))
  await fs.mkdir(path.dirname(filename), { recursive: true })
  await fs.writeFile(filename, text)
}
for (const directory of [fixture, second]) {
  await gitAt(directory, ['init', '--initial-branch=main'])
  await write(directory, '.gitignore', 'node_modules/\n.owned-cache/\n')
  await write(directory, 'tracked.txt', 'HEAD baseline\n')
  await write(directory, 'deleted.txt', 'deleted before\n')
  await write(directory, 'renamed-before.txt', 'stable rename body\n')
  await write(directory, 'binary.dat', Buffer.from([0, 1, 2, 3]))
  await write(directory, 'sub/inside.txt', 'inside baseline\n')
  await write(directory, 'other/outside.txt', 'outside baseline\n')
  await gitAt(directory, ['add', '--all'])
  await gitAt(directory, ['commit', '-m', 'fixture baseline'])
}
await write(fixture, 'tracked.txt', 'preexisting dirty baseline\n')
await write(fixture, 'preexisting.txt', 'preexisting untracked\n')
await write(fixture, 'node_modules/deep/ignored.txt', 'ignored\n')
await write(fixture, '.owned-cache/noise.txt', 'cache noise\n')
const processes = [],
  notifications = [],
  turnNotifications = []
const observe = (event) => processes.push({ ...event, atUTC: new Date().toISOString() })
const reader = api.createGitReader({
  cacheRoot: path.join(evidence, 'reader-cache'),
  onProcess: observe
})
const turns = api.createGitWorkbenchTurns({
  cacheRoot: path.join(evidence, 'turn-cache'),
  onProcess: observe,
  onChanged: (view) =>
    turnNotifications.push({ viewId: view.info.viewId, state: turns.state(view) })
})
const workbench = api.createGitWorkbenchReader({ onProcess: observe, turns })
const watchers = api.createGitWorkbenchObservers({
  onInvalidate: (view, event) => notifications.push({ viewId: view.info.viewId, ...event }),
  excludeRoots: [
    path.join(fixture, '.owned-cache'),
    path.join(evidence, 'reader-cache'),
    path.join(evidence, 'turn-cache')
  ]
})
const views = []
let view, scoped, other, review
const open = async (directory) => {
  const opened = await reader.open(directory)
  views.push(opened)
  await workbench.metadata(opened)
  return opened
}
const response = (view, data) => ({
  requestId: randomUUID(),
  viewId: view.info.viewId,
  status: 'ready',
  data
})
async function until(test, timeout = 3000) {
  const deadline = Date.now() + timeout
  while (!test()) {
    if (Date.now() > deadline) assert.fail('Timed out waiting for observed invalidation')
    await delay(30)
  }
}
try {
  await harness.check(
    'strict observations reject accessors, extra fields, invalid UUID/sequence and inconsistent turn states',
    async () => {
      const event = { viewId: randomUUID(), reason: 'turn', sequence: 1, status: 'watching' }
      assert(api.parseGitInvalidatedEvent(event))
      assert.equal(api.parseGitInvalidatedEvent({ ...event, path: fixture }), null)
      const hidden = { ...event }
      Object.defineProperty(hidden, 'command', { value: 'git push', enumerable: false })
      assert.equal(api.parseGitInvalidatedEvent(hidden), null)
      assert.equal(api.parseGitInvalidatedEvent({ ...event, sequence: 0 }), null)
      assert.equal(api.parseGitInvalidatedEvent({ ...event, viewId: 'local' }), null)
      assert.equal(api.parseGitInvalidatedEvent({ ...event, message: 'secret\n' }), null)
      let touched = false
      const bad = { ...event }
      Object.defineProperty(bad, 'status', {
        get() {
          touched = true
          return 'watching'
        }
      })
      assert.equal(api.parseGitInvalidatedEvent(bad), null)
      assert.equal(touched, false)
      const state = {
        turnNumber: 1,
        state: 'completed',
        startedAt: 10,
        completedAt: 20,
        message: null
      }
      assert(api.parseGitTurnCaptureState(state))
      assert.equal(api.parseGitTurnCaptureState({ ...state, completedAt: 9 }), null)
      assert.equal(api.parseGitTurnCaptureState({ ...state, state: 'capturing' }), null)
      assert.equal(api.parseGitTurnCaptureState({ ...state, checkpoint: 'foreign' }), null)
      const hiddenState = { ...state }
      Object.defineProperty(hiddenState, 'checkpoint', { value: 'foreign', enumerable: false })
      assert.equal(api.parseGitTurnCaptureState(hiddenState), null)
    }
  )
  await harness.check(
    'empty selection starts/completes instantly with zero Git and no turn publication',
    async () => {
      const before = processes.length
      const token = await turns.start([])
      await turns.complete(token, 'completed')
      assert.equal(processes.length, before)
      assert.equal(turnNotifications.length, 0)
    }
  )
  await harness.check(
    'cancelled lock waiter returns before the holder, but a later writer cannot skip the held common-directory lock',
    async () => {
      const order = []
      let unlock
      const gate = new Promise((resolve) => {
        unlock = resolve
      })
      const held = api.withGitRepositoryLock(path.join(fixture, '.git'), undefined, async () => {
        order.push('holder')
        await gate
        order.push('holder-finished')
      })
      await delay(30)
      const controller = new AbortController()
      const cancelled = api.withGitRepositoryLock(
        path.join(fixture, '.git'),
        controller.signal,
        async () => order.push('cancelled-body')
      )
      const assertion = assert.rejects(cancelled, (error) => error.status === 'cancelled')
      const started = Date.now()
      controller.abort()
      await assertion
      assert(Date.now() - started < 500)
      const later = api.withGitRepositoryLock(path.join(fixture, '.git'), undefined, async () =>
        order.push('later-writer')
      )
      await delay(120)
      assert.deepEqual(order, ['holder'])
      unlock()
      await held
      await later
      assert.deepEqual(order, ['holder', 'holder-finished', 'later-writer'])
      return order
    }
  )
  view = await open(fixture)
  scoped = await open(path.join(fixture, 'sub'))
  other = await open(second)
  await harness.check(
    'real watcher tracks worktree edits and coalesces a burst; repeated watch causes zero Git',
    async () => {
      const count = processes.length
      await watchers.watch(view)
      await watchers.watch(view)
      assert.equal(processes.length, count)
      const start = notifications.length
      await write(fixture, 'tracked.txt', 'watch burst 1\n')
      await write(fixture, 'tracked.txt', 'watch burst 2\n')
      await write(fixture, 'tracked.txt', 'watch final baseline\n')
      await until(() => notifications.length > start)
      await delay(400)
      const arrived = notifications.slice(start)
      assert.equal(arrived.length, 1)
      assert.equal(arrived[0].reason, 'worktree')
      assert(api.parseGitInvalidatedEvent(arrived[0]))
      return arrived
    }
  )
  await harness.check(
    'ignored dependency contents and owned cache writes cannot create refresh feedback',
    async () => {
      const start = notifications.length
      const count = processes.length
      await write(fixture, 'node_modules/deep/ignored.txt', 'ignored later\n')
      await write(fixture, '.owned-cache/noise.txt', 'cache later\n')
      await delay(600)
      assert.equal(notifications.length, start)
      assert.equal(processes.length, count)
    }
  )
  await harness.check(
    'real external index/ref changes publish metadata invalidation, without watcher-spawned Git',
    async () => {
      const start = notifications.length
      const count = processes.length
      await gitAt(fixture, ['add', '--', 'tracked.txt'])
      await until(() => notifications.slice(start).some((event) => event.reason === 'metadata'))
      await delay(300)
      const refStart = notifications.length
      await gitAt(fixture, ['branch', 'watch-created'])
      await until(() => notifications.slice(refStart).some((event) => event.reason === 'metadata'))
      assert.equal(processes.length, count)
      return notifications.slice(start)
    }
  )
  await harness.check(
    'subdirectory view ignores sibling changes while retaining its own notifications',
    async () => {
      await watchers.watch(scoped)
      const start = notifications.length
      await write(fixture, 'other/outside.txt', 'outside changed\n')
      await delay(450)
      assert(!notifications.slice(start).some((event) => event.viewId === scoped.info.viewId))
      await write(fixture, 'sub/inside.txt', 'inside before turn\n')
      await until(() =>
        notifications.slice(start).some((event) => event.viewId === scoped.info.viewId)
      )
    }
  )
  const sourceGitBefore = await diskIdentity(path.join(fixture, '.git'))
  const originalController = new AbortController()
  view.controller = originalController
  const originalGeneration = view.generation
  let token
  await harness.check(
    'independent baseline captures selected repositories in parallel without aborting user operations',
    async () => {
      token = await turns.start([view, scoped, other])
      assert.equal(turns.state(view).state, 'capturing')
      assert(api.parseGitTurnCaptureState(turns.state(view)))
      assert.equal(originalController.signal.aborted, false)
      assert.equal(view.generation, originalGeneration)
      assert.equal(turns.hasCapture(view), false)
      assert.equal(turns.state(view).turnNumber, turns.state(other).turnNumber)
      await assert.rejects(turns.review(view), (error) => error.status === 'unavailable')
    }
  )
  view.controller = undefined
  await write(fixture, 'tracked.txt', 'during turn change\n')
  await fs.unlink(path.join(fixture, 'deleted.txt'))
  await fs.rename(path.join(fixture, 'renamed-before.txt'), path.join(fixture, 'renamed-after.txt'))
  await write(fixture, 'new 中文.txt', 'new during turn\n')
  await write(fixture, 'binary.dat', Buffer.from([0, 9, 8, 7]))
  await write(fixture, 'sub/inside.txt', 'inside after turn\n')
  await write(second, 'tracked.txt', 'second repo after turn\n')
  await harness.check(
    'completed Last Turn contains actual before/after edits, deletes, rename, new text and binary with no write actions',
    async () => {
      await turns.complete(token, 'completed')
      assert.equal(turns.state(view).state, 'completed')
      assert(turns.hasCapture(view))
      review = await workbench.review(view, { source: 'last-turn' })
      assert(api.parseGitReviewResult(response(view, review)))
      for (const name of [
        'tracked.txt',
        'deleted.txt',
        'renamed-after.txt',
        'new 中文.txt',
        'binary.dat',
        'sub/inside.txt'
      ])
        assert(
          review.files.some((file) => file.path === name),
          name
        )
      assert(!review.files.some((file) => file.path === 'preexisting.txt'))
      assert(
        !review.files.some(
          (file) => file.path.includes('node_modules') || file.path.includes('.owned-cache')
        )
      )
      assert(review.files.every((file) => file.actions.length === 0))
      assert(review.files.find((file) => file.path === 'binary.dat').binary)
      const scopedReview = await turns.review(scoped)
      assert.deepEqual(
        scopedReview.files.map((file) => file.path),
        ['sub/inside.txt']
      )
      const secondReview = await turns.review(other)
      assert(secondReview.files.some((file) => file.path === 'tracked.txt'))
      return { state: turns.state(view), review, scopedReview, secondReview }
    }
  )
  await harness.check(
    'Last Turn diff/full-file stay frozen after later source edits and historical IDs cannot become actions',
    async () => {
      const item = review.files.find((file) => file.path === 'tracked.txt')
      await write(fixture, 'tracked.txt', 'later outside captured turn\n')
      const diff = await workbench.diff(view, { revision: review.revision, itemId: item.itemId })
      assert(diff.text.includes('-watch final baseline\n'))
      assert(diff.text.includes('+during turn change\n'))
      assert(!diff.text.includes('later outside'))
      assert(diff.hunks.length)
      assert(diff.hunks.every((hunk) => !hunk.actions.length))
      const base = await turns.fullFile(view, {
        revision: review.revision,
        itemId: item.itemId,
        side: 'base'
      })
      const current = await turns.fullFile(view, {
        revision: review.revision,
        itemId: item.itemId,
        side: 'current'
      })
      assert.equal(base.text, 'watch final baseline\n')
      assert.equal(current.text, 'during turn change\n')
      const deleted = review.files.find((file) => file.path === 'deleted.txt')
      const added = review.files.find((file) => file.path === 'new 中文.txt')
      const binary = review.files.find((file) => file.path === 'binary.dat')
      assert.equal(
        (
          await turns.fullFile(view, {
            revision: review.revision,
            itemId: deleted.itemId,
            side: 'current'
          })
        ).format,
        'missing'
      )
      assert.equal(
        (
          await turns.fullFile(view, {
            revision: review.revision,
            itemId: added.itemId,
            side: 'base'
          })
        ).format,
        'missing'
      )
      assert.equal(
        (
          await turns.fullFile(view, {
            revision: review.revision,
            itemId: binary.itemId,
            side: 'current'
          })
        ).format,
        'binary'
      )
      await assert.rejects(
        workbench.context(view, review.revision),
        (error) => error.status === 'unsupported'
      )
      await assert.rejects(
        turns.diff(other, { revision: review.revision, itemId: item.itemId }),
        (error) => error.status === 'stale'
      )
      assert.deepEqual(await diskIdentity(path.join(fixture, '.git')), sourceGitBefore)
      return { diff, base, current }
    }
  )
  await harness.check(
    'next interrupted turn replaces old authority, distinguishes stop status and retains actual disk delta',
    async () => {
      const oldRevision = review.revision
      const token = await turns.start([view])
      assert.equal(turns.state(view).turnNumber, 2)
      await write(fixture, 'tracked.txt', 'stopped turn actual result\n')
      await turns.complete(token, 'interrupted')
      assert.equal(turns.state(view).state, 'interrupted')
      assert(api.parseGitTurnCaptureState(turns.state(view)))
      await assert.rejects(
        turns.diff(view, { revision: oldRevision, itemId: review.files[0].itemId }),
        (error) => error.status === 'stale'
      )
      const current = await turns.review(view)
      assert(current.baseLabel.includes('已停止'))
      assert(current.warnings[0].includes('人工改动'))
      return { state: turns.state(view), review: current }
    }
  )
  await harness.check(
    'capture retains existing per-file limits and reports oversized untracked content without partial Last Turn',
    async () => {
      await write(fixture, 'oversized-turn.txt', Buffer.alloc(8 * 1024 * 1024 + 1, 65))
      const token = await turns.start([view])
      await turns.complete(token, 'completed')
      assert.equal(turns.state(view).state, 'error')
      assert(turns.state(view).message.includes('限额'))
      assert.equal(turns.hasCapture(view), false)
      await fs.unlink(path.join(fixture, 'oversized-turn.txt'))
      return turns.state(view)
    }
  )
  await harness.check(
    'unsupported scoped symlink yields visible capture error without rejecting the Agent lifecycle',
    async () => {
      await fs.symlink(
        path.join(evidence, 'second'),
        path.join(fixture, 'bad-linked-scope'),
        'junction'
      )
      const token = await turns.start([view])
      await turns.complete(token, 'failed')
      assert.equal(turns.state(view).state, 'error')
      assert(api.parseGitTurnCaptureState(turns.state(view)))
      assert.equal(turns.hasCapture(view), false)
      await fs.unlink(path.join(fixture, 'bad-linked-scope'))
      return turns.state(view)
    }
  )
  await harness.check(
    'release while waiting for a repository write lock stops late capture/publication and clears owned caches',
    async () => {
      let unlock
      const gate = new Promise((resolve) => {
        unlock = resolve
      })
      const held = api.withGitRepositoryLock(view.location.common, undefined, async () => gate)
      await delay(30)
      const pending = turns.start([view])
      await delay(80)
      const before = turnNotifications.length
      const count = processes.length
      const released = turns.release(view)
      await released
      assert.equal(processes.length, count)
      unlock()
      await held
      await pending
      await released
      assert.equal(processes.length, count)
      assert.equal(turnNotifications.length, before)
      assert.equal(turns.hasCapture(view), false)
    }
  )
  await harness.check(
    'observer directory cap is visible and release cancels queued events with real handle retirement',
    async () => {
      const limitedRoot = path.join(evidence, 'limited')
      await fs.mkdir(limitedRoot)
      const fingerprints = new Map()
      for (let i = 0; i < 270; i++) {
        const target = path.join(limitedRoot, 'dir-' + i)
        await fs.mkdir(target)
        fingerprints.set(target, { target, kind: 'directory' })
      }
      const limited = {
        ...view,
        controller: undefined,
        info: { ...view.info, viewId: randomUUID() },
        location: { ...view.location, selectedPath: limitedRoot, repositoryPath: limitedRoot },
        snapshot: { ...view.snapshot, source: { fingerprints } }
      }
      await watchers.watch(limited)
      assert(
        notifications.some(
          (event) => event.viewId === limited.info.viewId && event.status === 'limited'
        )
      )
      const limitedEvents = notifications.filter(
        (event) => event.viewId === limited.info.viewId
      ).length
      await watchers.watch(limited)
      assert.equal(
        notifications.filter((event) => event.viewId === limited.info.viewId).length,
        limitedEvents
      )
      await watchers.release(limited)
      await write(fixture, 'tracked.txt', 'closing queued watcher\n')
      const before = notifications.length
      await watchers.release(view)
      await watchers.release(scoped)
      await delay(450)
      assert.equal(notifications.length, before)
    }
  )
  await harness.check(
    'failed previous snapshot retirement blocks future capture instead of replacing retained ownership',
    async () => {
      const faultRoot = path.join(evidence, 'fault-retirement-cache')
      const faults = [],
        observed = []
      const service = api.createGitWorkbenchTurns({
        cacheRoot: faultRoot,
        onProcess: (event) => {
          observed.push(event)
          observe(event)
        }
      })
      const first = await service.start([other])
      await service.complete(first, 'completed')
      assert(service.hasCapture(other))
      const originalRemove = fs.rm
      fs.rm = async (target, options) => {
        if (
          String(target).startsWith(faultRoot) &&
          path.basename(String(target)).startsWith('query-')
        ) {
          faults.push(target)
          const error = Error('injected owned query EPERM')
          error.code = 'EPERM'
          throw error
        }
        return originalRemove(target, options)
      }
      try {
        const count = observed.length
        const failed = await service.start([other])
        await service.complete(failed, 'completed')
        assert.equal(service.state(other).state, 'error')
        assert(service.state(other).message.includes('清理未确认'))
        assert.equal(service.hasCapture(other), false)
        assert.equal(observed.length, count)
        assert(faults.length)
        assert(
          (await fs.readdir(path.join(faultRoot, 'turns'))).some((name) =>
            name.startsWith('query-')
          )
        )
        fs.rm = originalRemove
        const again = await service.start([other])
        await service.complete(again, 'completed')
        assert.equal(observed.length, count)
        assert.equal(service.state(other).state, 'error')
      } finally {
        fs.rm = originalRemove
        await service.close()
      }
      assert(
        !(await fs.readdir(path.join(faultRoot, 'turns'))).some((name) => name.startsWith('query-'))
      )
      return { faults, retainedUntilExplicitClose: true }
    }
  )
  await harness.check(
    'capture failure followed by failed cleanup retains its orphan and blocks all later Git captures',
    async () => {
      const faultRoot = path.join(evidence, 'fault-capture-cache')
      const observed = [],
        faults = []
      const service = api.createGitWorkbenchTurns({
        cacheRoot: faultRoot,
        onProcess: (event) => {
          observed.push(event)
          observe(event)
          if (event.event === 'spawn' && event.args.includes('read-tree'))
            throw Error('injected capture boundary failure')
        }
      })
      const originalRemove = fs.rm
      fs.rm = async (target, options) => {
        if (
          String(target).startsWith(faultRoot) &&
          path.basename(String(target)).startsWith('query-')
        ) {
          faults.push(target)
          const error = Error('injected owned orphan EPERM')
          error.code = 'EPERM'
          throw error
        }
        return originalRemove(target, options)
      }
      try {
        const first = await service.start([other])
        await service.complete(first, 'completed')
        assert.equal(service.state(other).state, 'error')
        assert(service.state(other).message.includes('清理未确认'))
        assert(faults.length)
        const count = observed.length
        fs.rm = originalRemove
        const later = await service.start([other])
        await service.complete(later, 'completed')
        assert.equal(observed.length, count)
        assert.equal(service.hasCapture(other), false)
      } finally {
        fs.rm = originalRemove
        await service.close()
      }
      assert(
        !(await fs.readdir(path.join(faultRoot, 'turns'))).some((name) => name.startsWith('query-'))
      )
      return { faults, observed: observed.length }
    }
  )
  await harness.check(
    'synthetic reader.open unconfirmed exit blocks retirement even before a captured view is returned',
    async () => {
      const faultOutput = path.join(evidence, 'open-unconfirmed.cjs')
      const faultBundle = await build({
        stdin: {
          contents: 'export * from "./src/main/git/git-workbench-turns.ts";',
          resolveDir: root
        },
        bundle: true,
        platform: 'node',
        format: 'cjs',
        outfile: faultOutput,
        metafile: true,
        logLevel: 'silent',
        plugins: [
          {
            name: 'unconfirmed-open-contract',
            setup(builder) {
              builder.onResolve({ filter: /git-reader$/ }, (args) =>
                args.importer.replaceAll('\\', '/').endsWith('/git-workbench-turns.ts')
                  ? { path: args.path, namespace: 'unconfirmed-reader' }
                  : undefined
              )
              builder.onLoad({ filter: /.*/, namespace: 'unconfirmed-reader' }, () => ({
                contents:
                  'globalThis.__unconfirmedTurnReaderOpens=0; export function createGitReader() { return { open: async () => { globalThis.__unconfirmedTurnReaderOpens++; const e = new Error("Git 进程退出未确认；保留查询缓存供诊断"); e.status="error"; throw e }, dispose: async () => { throw new Error("Git 进程退出未确认") } }; }',
                loader: 'js'
              }))
            }
          }
        ]
      })
      const fault = createRequire(import.meta.url)(faultOutput)
      const service = fault.createGitWorkbenchTurns({
        cacheRoot: path.join(evidence, 'open-unconfirmed-cache')
      })
      const token = await service.start([other])
      await service.complete(token, 'completed')
      assert.equal(service.state(other).state, 'error')
      assert(service.state(other).message.includes('退出未确认'))
      await assert.rejects(service.release(other), /退出未确认/)
      const again = await service.start([other])
      await service.complete(again, 'completed')
      assert.equal(service.hasCapture(other), false)
      assert.equal(globalThis.__unconfirmedTurnReaderOpens, 1)
      await assert.rejects(service.close(), /退出未确认/)
      return {
        syntheticReaderOpen: true,
        compiledSHA256: hash(await fs.readFile(faultOutput)),
        compiledInputs: Object.keys(faultBundle.metafile.inputs),
        actualUnknownProcess: false
      }
    }
  )
} finally {
  await watchers.close()
  await turns.close()
  for (const view of views) await reader.dispose(view)
  await fs.writeFile(
    path.join(evidence, 'watch-observations.json'),
    JSON.stringify(notifications, null, 2)
  )
  await fs.writeFile(
    path.join(evidence, 'turn-observations.json'),
    JSON.stringify(turnNotifications, null, 2)
  )
  await fs.writeFile(
    path.join(evidence, 'process-observations.json'),
    JSON.stringify(processes, null, 2)
  )
  await harness.check(
    'all actual Git children close and reader/turn caches retire after window close',
    async () => {
      assert(!processes.some((event) => event.event === 'unconfirmed'))
      const spawned = processes.filter((event) => event.event === 'spawn'),
        closed = processes.filter((event) => event.event === 'close')
      for (const event of spawned) assert(closed.some((close) => close.pid === event.pid))
      const retired = await verifyProcessRetirement(
        closed.map((event) => ({ ...event, closedAtUTC: event.atUTC }))
      )
      for (const directory of [
        path.join(evidence, 'reader-cache'),
        path.join(evidence, 'turn-cache/turns')
      ])
        assert(!(await fs.readdir(directory)).some((name) => name.startsWith('query-')))
      return { spawned: spawned.length, closed: closed.length, retired }
    }
  )
  await harness.finish({
    sources,
    compiledSHA256: hash(await fs.readFile(output)),
    gitPath: git,
    gitSha256: hash(await fs.readFile(git))
  })
}
