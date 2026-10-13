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

const evidence = await createEvidence('reader-native')
const harness = checksFor(evidence, {
  actualGit: true,
  actualDisk: true,
  actualElectron: false,
  realModelTransport: false,
  actualPTY: false,
  fixtureGitWrites:
    'Only newly created UUID evidence fixture repositories; product read APIs make no source repository writes.'
})
const output = path.join(evidence, 'current-reader.cjs')
const bundle = await build({
  stdin: {
    contents:
      'export * from "./src/main/git/git-reader.ts"; export * from "./src/main/git/git-workbench-reader.ts"; export * from "./src/shared/git-workbench.ts";',
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
await fs.mkdir(fixture, { recursive: true })
const empty = assertOwnedPath(evidence, path.join(evidence, 'empty-global.config'))
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
const preparation = []
async function prepare(directory, args) {
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
      'user.name=Workbench Fixture',
      '-c',
      'user.email=workbench@example.invalid',
      ...args
    ],
    { cwd: directory, env: environment },
    15000
  )
  preparation.push(result)
  assert.equal(result.exitCode, 0, result.stderr)
  return result.stdout.trim()
}
async function write(name, value) {
  const filename = assertOwnedPath(evidence, path.join(fixture, name))
  await fs.mkdir(path.dirname(filename), { recursive: true })
  await fs.writeFile(filename, value)
}
await prepare(fixture, ['init', '--initial-branch=main'])
await prepare(fixture, ['config', 'core.filemode', 'false'])
await prepare(fixture, ['config', 'user.name', 'Workbench Fixture'])
await prepare(fixture, ['config', 'user.email', 'workbench@example.invalid'])
await write('dual.txt', 'HEAD A\n')
const initialLines = Array.from({ length: 30 }, (_, i) => 'initial line ' + i)
await write('multi.txt', initialLines.join('\n') + '\n')
await write('rename-old.txt', 'stable rename body\n')
await write('subtree/inside.txt', 'inside HEAD\n')
await write('sibling/outside.txt', 'outside HEAD\n')
await write('中文 空格.txt', 'old chinese\n')
await write('-leading.txt', 'old leading\n')
await write('[literal].txt', 'old literal\n')
await prepare(fixture, ['add', '--all'])
await prepare(fixture, ['commit', '-m', 'fixture initial'])
const baseSha = await prepare(fixture, ['rev-parse', 'HEAD'])
await prepare(fixture, ['switch', '-c', 'feature'])
await write('committed.txt', 'feature committed body\n')
await prepare(fixture, ['add', '--all'])
await prepare(fixture, ['commit', '-m', 'feature commit'])
const headSha = await prepare(fixture, ['rev-parse', 'HEAD'])
await prepare(fixture, ['remote', 'add', 'origin', 'https://example.invalid/reference.git'])
await prepare(fixture, ['update-ref', 'refs/remotes/origin/main', baseSha])
await prepare(fixture, ['config', 'branch.feature.remote', 'origin'])
await prepare(fixture, ['config', 'branch.feature.merge', 'refs/heads/main'])
const linked = assertOwnedPath(evidence, path.join(evidence, 'linked'))
await prepare(fixture, ['worktree', 'add', '-b', 'linked-fixture', linked, baseSha])
await write('dual.txt', 'INDEX B\n')
await prepare(fixture, ['add', '--', 'dual.txt'])
await write('dual.txt', 'WORKTREE C\n')
await write('new 中文.txt', 'untracked actual body\nsecond line\n')
await write('binary.dat', Buffer.from([0, 1, 2, 255, 0, 4]))
await write('中文 空格.txt', 'new chinese\n')
await write('-leading.txt', 'new leading\n')
await write('[literal].txt', 'new literal\n')
const changedLines = [...initialLines]
changedLines[1] = 'changed first'
changedLines[27] = 'changed second'
await write('multi.txt', changedLines.join('\n') + '\n')
await prepare(fixture, ['mv', 'rename-old.txt', 'renamed.txt'])
await fs.writeFile(path.join(evidence, 'preparation.json'), JSON.stringify(preparation, null, 2))
const before = await diskIdentity(fixture)
const events = []
const observe = (event) => events.push({ ...event, atUTC: new Date().toISOString() })
const reader = api.createGitReader({
  cacheRoot: path.join(evidence, 'reader-cache'),
  onProcess: observe
})
const workbench = api.createGitWorkbenchReader({ onProcess: observe })
const views = []
const open = async (directory) => {
  const view = await reader.open(directory)
  views.push(view)
  return view
}
let view, metadata
function response(data) {
  return { requestId: randomUUID(), viewId: view.info.viewId, status: 'ready', data }
}
async function detail(source, filename, extra = {}) {
  const review = await workbench.review(view, { source, ...extra })
  assert(api.parseGitReviewResult(response(review)), JSON.stringify(review))
  const item = review.files.find((item) => item.path === filename)
  assert(item, 'Source ' + source + ' contains ' + filename)
  const diff = await workbench.diff(view, { revision: review.revision, itemId: item.itemId })
  assert(api.parseGitDiffResult(response(diff)))
  return { review, item, diff }
}
try {
  await harness.check(
    'metadata uses captured refs/config and owned Git, with current/ahead/commits/linked worktrees',
    async () => {
      view = await open(fixture)
      metadata = await workbench.metadata(view)
      assert(api.parseGitMetadataResult(response(metadata)))
      assert.equal(metadata.revision, view.snapshot.revision)
      assert.equal(metadata.branch, 'feature')
      assert.equal(metadata.headSha, headSha)
      assert.equal(metadata.ahead, 1)
      assert.equal(metadata.behind, 0)
      assert(metadata.branches.find((ref) => ref.name === 'main' && !ref.remote))
      assert(metadata.branches.find((ref) => ref.name === 'origin/main' && ref.remote))
      assert(metadata.commits.find((commit) => commit.sha === headSha))
      assert(metadata.worktrees.find((tree) => path.resolve(tree.path) === path.resolve(linked)))
      const context = await workbench.context(view, metadata.revision)
      assert.equal(context.identity.name, 'Workbench Fixture')
      assert.equal([...context.remotes.values()][0].url, 'https://example.invalid/reference.git')
      assert(context.snapshot.items.length > 0, 'new selection still provides writer status')
      return { metadata, ownedGit: context.program }
    }
  )
  await harness.check(
    'staged and unstaged compare independent HEAD A/index B/worktree C baselines',
    async () => {
      const staged = await detail('staged', 'dual.txt')
      assert(staged.diff.text.includes('-HEAD A\n'))
      assert(staged.diff.text.includes('+INDEX B\n'))
      assert(!staged.diff.text.includes('WORKTREE C'))
      assert.deepEqual(staged.item.actions, ['unstage', 'revert'])
      assert(staged.diff.hunks.length > 0)
      assert(staged.diff.hunks.every((hunk) => hunk.actions.join(',') === 'unstage,revert'))
      const unstaged = await detail('unstaged', 'dual.txt')
      assert(unstaged.diff.text.includes('-INDEX B\n'))
      assert(unstaged.diff.text.includes('+WORKTREE C\n'))
      assert(!unstaged.diff.text.includes('HEAD A'))
      assert.deepEqual(unstaged.item.actions, ['stage', 'revert'])
      assert(unstaged.diff.hunks.length > 0)
      assert(unstaged.diff.hunks.every((hunk) => hunk.actions.join(',') === 'stage,revert'))
      return { staged: staged.diff, unstaged: unstaged.diff }
    }
  )
  await harness.check(
    'uncommitted shows net HEAD-to-worktree and real untracked unified diff/binary',
    async () => {
      const net = await detail('uncommitted', 'dual.txt')
      assert(net.diff.text.includes('-HEAD A\n'))
      assert(net.diff.text.includes('+WORKTREE C\n'))
      assert(!net.diff.text.includes('INDEX B'))
      assert(net.diff.hunks.length > 0)
      assert(net.diff.hunks.every((hunk) => hunk.actions.length === 0))
      const mixedContext = await workbench.context(view, net.review.revision)
      assert.equal(mixedContext.review.items.get(net.item.itemId).hunks.size, 0)
      const untracked = await detail('uncommitted', 'new 中文.txt')
      assert(untracked.diff.text.includes('+untracked actual body\n'))
      assert.equal(untracked.item.additions, 2)
      const binary = await detail('uncommitted', 'binary.dat')
      assert.equal(binary.diff.binary, true)
      return { net: net.diff, untracked: untracked.diff, binary: binary.diff }
    }
  )
  await harness.check(
    'branch compares merge base to worktree; commit compares first parent to selected opaque commit',
    async () => {
      const main = metadata.branches.find((ref) => ref.name === 'main' && !ref.remote)
      const branch = await detail('branch', 'committed.txt', { baseRefId: main.refId })
      assert(branch.diff.text.includes('+feature committed body'))
      assert.deepEqual(branch.item.actions, [])
      assert(branch.diff.hunks.every((hunk) => hunk.actions.length === 0))
      const commit = metadata.commits.find((commit) => commit.sha === headSha)
      const committed = await detail('commit', 'committed.txt', { commitId: commit.commitId })
      assert.equal(committed.review.files.length, 1)
      assert(committed.diff.text.includes('+feature committed body'))
      assert.deepEqual(committed.item.actions, [])
      assert(committed.diff.hunks.every((hunk) => hunk.actions.length === 0))
      return { branch: branch.review, commit: committed.review }
    }
  )
  await harness.check(
    'hunk IDs resolve main-held independent patches and stale/forged IDs are refused',
    async () => {
      const result = await detail('unstaged', 'multi.txt')
      assert.equal(result.diff.hunks.length, 2)
      const context = await workbench.context(view, result.review.revision)
      const held = context.review.items.get(result.item.itemId)
      assert.equal(held.hunks.size, 2)
      const patches = [...held.hunks.values()]
      assert(patches[0].includes('+changed first'))
      assert(!patches[0].includes('changed second'))
      assert(patches[1].includes('+changed second'))
      assert(!patches[1].includes('changed first'))
      assert.equal(held.hunks.has('forged-hunk'), false)
      await assert.rejects(
        workbench.diff(view, { revision: 'forged-revision', itemId: result.item.itemId }),
        (error) => error.status === 'stale'
      )
      await workbench.review(view, { source: 'staged' })
      await assert.rejects(
        workbench.diff(view, { revision: result.review.revision, itemId: result.item.itemId }),
        (error) => error.status === 'stale'
      )
      return { hunks: result.diff.hunks, patches }
    }
  )
  await harness.check(
    'root commit uses an empty tree; hiding whitespace offers inspection without patch authority',
    async () => {
      const first = metadata.commits.find((commit) => commit.sha === baseSha)
      const initial = await detail('commit', 'dual.txt', { commitId: first.commitId })
      assert(initial.diff.text.includes('+HEAD A\n'))
      assert(!initial.diff.text.includes('-HEAD A\n'))
      const whitespace = await detail('unstaged', 'multi.txt', { hideWhitespace: true })
      assert(whitespace.review.files.every((item) => item.actions.length === 0))
      assert(whitespace.diff.hunks.every((hunk) => hunk.actions.length === 0))
      const context = await workbench.context(view, whitespace.review.revision)
      assert.equal(context.review.items.get(whitespace.item.itemId).hunks.size, 0)
      return { initial: initial.diff, hideWhitespace: whitespace.review }
    }
  )
  await harness.check(
    'literal paths, rename pairs and subtree scope preserve real Git semantics',
    async () => {
      for (const filename of ['中文 空格.txt', '-leading.txt', '[literal].txt'])
        assert((await detail('unstaged', filename)).diff.text.includes('+new '))
      const renamed = await detail('staged', 'renamed.txt')
      assert.equal(renamed.item.previousPath, 'rename-old.txt')
      assert.equal(renamed.item.change, 'renamed')
      const subtree = await open(path.join(fixture, 'subtree'))
      const subMeta = await workbench.metadata(subtree)
      assert(
        subMeta.capabilities.find(
          (capability) => capability.name === 'commit' && !capability.available
        )
      )
      const review = await workbench.review(subtree, {
        source: 'branch',
        baseRefId: subMeta.branches.find((ref) => ref.name === 'main' && !ref.remote).refId
      })
      assert(review.files.every((file) => file.path.startsWith('subtree/')))
      return { renamed: renamed.item, subtree: review }
    }
  )
  await harness.check(
    'latest-turn, arbitrary SHA/ref IDs and pre-aborted operations reject without widening scope',
    async () => {
      await assert.rejects(
        workbench.review(view, { source: 'last-turn' }),
        (error) => error.status === 'unsupported'
      )
      await assert.rejects(
        workbench.review(view, { source: 'branch', baseRefId: 'main' }),
        (error) => error.status === 'stale'
      )
      await assert.rejects(
        workbench.review(view, { source: 'commit', commitId: headSha }),
        (error) => error.status === 'stale'
      )
      const controller = new AbortController()
      controller.abort()
      await assert.rejects(
        workbench.metadata(view, controller.signal),
        (error) => error.status === 'cancelled'
      )
      return { lastTurn: 'explicit unsupported', opaqueIds: 'verified', cancellation: 'verified' }
    }
  )
  await harness.check(
    'all read operations leave source worktree/index/config/refs/objects byte-identical and never run Git against original repository',
    async () => {
      assert.deepEqual(await diskIdentity(fixture), before)
      const workbenchSpawns = events.filter(
        (event) => event.event === 'spawn' && event.args.includes('core.fsmonitor=false')
      )
      assert(workbenchSpawns.length > 0)
      assert(
        workbenchSpawns.every((event) =>
          path.resolve(event.cwd).startsWith(path.resolve(evidence, 'reader-cache'))
        )
      )
      assert(
        !workbenchSpawns.some(
          (event) =>
            event.args.includes('fetch') ||
            event.args.includes('push') ||
            event.args.includes('commit')
        )
      )
      return { sourceIdentity: before, workbenchSpawns: workbenchSpawns.length }
    }
  )
  await harness.check(
    'real waiting beyond the snapshot clock retains fresh verified inspection and action context',
    async () => {
      const result = await detail('unstaged', 'dual.txt')
      await delay(11000)
      const context = await workbench.context(view, result.review.revision)
      assert.equal(context.review.revision, result.review.revision)
      assert(
        (
          await workbench.diff(view, {
            revision: result.review.revision,
            itemId: result.item.itemId
          })
        ).text.includes('+WORKTREE C\n')
      )
      return { waitMs: 11000, revision: result.review.revision }
    }
  )
  await harness.check(
    'unborn HEAD metadata and empty-tree review return real untracked contents',
    async () => {
      const unborn = assertOwnedPath(evidence, path.join(evidence, 'unborn'))
      await fs.mkdir(unborn)
      await prepare(unborn, ['init', '--initial-branch=UnbornCase'])
      await fs.writeFile(path.join(unborn, 'pending.txt'), 'pending actual body\n')
      const unbornView = await open(unborn)
      const info = await workbench.metadata(unbornView)
      assert.equal(info.branch, 'UnbornCase')
      assert.equal(info.headSha, null)
      const review = await workbench.review(unbornView, { source: 'uncommitted' })
      const item = review.files.find((file) => file.path === 'pending.txt')
      assert(item)
      const diff = await workbench.diff(unbornView, {
        revision: review.revision,
        itemId: item.itemId
      })
      assert(diff.text.includes('+pending actual body\n'))
      return { metadata: info, review, diff }
    }
  )
  await harness.check(
    'changed real source rejects old contexts/diffs; refresh replaces opaque metadata and review authority',
    async () => {
      const result = await detail('unstaged', 'dual.txt')
      await write('dual.txt', 'changed after snapshot\n')
      await assert.rejects(
        workbench.context(view, result.review.revision),
        (error) => error.status === 'stale'
      )
      await assert.rejects(
        workbench.diff(view, { revision: result.review.revision, itemId: result.item.itemId }),
        (error) => error.status === 'stale'
      )
      await reader.refresh(view)
      const newer = await workbench.metadata(view)
      assert.notEqual(newer.revision, metadata.revision)
      await assert.rejects(
        workbench.context(view, metadata.revision),
        (error) => error.status === 'stale'
      )
      assert((await detail('unstaged', 'dual.txt')).diff.text.includes('+changed after snapshot'))
      return { oldRevision: metadata.revision, newRevision: newer.revision }
    }
  )
} finally {
  for (const owned of views) await reader.dispose(owned)
  const spawned = events.filter((event) => event.event === 'spawn')
  const closed = events.filter((event) => event.event === 'close')
  await fs.writeFile(
    path.join(evidence, 'process-observations.json'),
    JSON.stringify(events, null, 2)
  )
  await harness.check('owned Git processes close and owned query caches are removed', async () => {
    assert(!events.some((event) => event.event === 'unconfirmed'))
    for (const event of spawned) assert(closed.some((close) => close.pid === event.pid))
    const retired = await verifyProcessRetirement(
      closed.map((close) => ({ ...close, closedAtUTC: close.atUTC }))
    )
    const cache = await fs.readdir(path.join(evidence, 'reader-cache'))
    assert(!cache.some((name) => name.startsWith('query-')))
    return { spawned: spawned.length, closed: closed.length, retired, cache }
  })
  await harness.finish({
    sources,
    compiledSHA256: hash(await fs.readFile(output)),
    gitPath: git,
    gitSha256: hash(await fs.readFile(git))
  })
}
