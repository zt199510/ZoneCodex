import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createEvidence, checksFor, compile, runProcess, assertOwnedPath } from './runtime.mjs'
import { findFixtureGit } from '../lesson61/materials.mjs'
import { diskIdentity, verifyProcessRetirement } from '../lesson61/runtime.mjs'

const evidence = await createEvidence('file-init-native')
const suite = checksFor(evidence, {
  actualGit: true,
  actualDisk: true,
  actualElectron: false,
  realModelTransport: false,
  syntheticGenerationResponse: true,
  fixtureGitWrites:
    'Preparation and product initialization only in newly created UUID evidence directories; no project or user repository is written.'
})
const { api, sourceHashes, compiledSHA256 } = await compile(evidence, [
  'src/main/git/git-reader.ts',
  'src/main/git/git-workbench-reader.ts',
  'src/main/git/git-workbench-file.ts',
  'src/main/git/git-workbench-init.ts',
  'src/main/git/git-workbench-generation.ts',
  'src/shared/git-workbench.ts'
])
const git = await findFixtureGit()
const empty = assertOwnedPath(evidence, path.join(evidence, 'empty-global.config'))
await fs.writeFile(empty, '')
const environment = { ...process.env }
for (const key of Object.keys(environment))
  if (/^GIT_|^NODE_OPTIONS$|^ELECTRON_RUN_AS_NODE$|^MODEL_/i.test(key)) delete environment[key]
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
      'user.name=File Fixture',
      '-c',
      'user.email=file@example.invalid',
      ...args
    ],
    { cwd: directory, env: environment },
    15000
  )
  preparation.push(result)
  assert.equal(result.exitCode, 0, result.stderr)
  return result.stdout.trim()
}
const fixture = assertOwnedPath(evidence, path.join(evidence, 'fixture'))
await fs.mkdir(fixture)
const write = async (name, bytes) => {
  const filename = assertOwnedPath(evidence, path.join(fixture, name))
  await fs.mkdir(path.dirname(filename), { recursive: true })
  await fs.writeFile(filename, bytes)
}
await prepare(fixture, ['init', '--initial-branch=main'])
await prepare(fixture, ['config', 'core.filemode', 'false'])
await write('dual.txt', 'BASE A\n')
await write('rename-old.txt', 'rename content\n')
await write('deleted-staged.txt', 'staged deletion base\n')
await write('deleted-unstaged.txt', 'unstaged deletion base\n')
await write('subtree/inside.txt', 'inside original\n')
await write('.gitignore', 'ignored.txt\n')
await prepare(fixture, ['add', '--all'])
await prepare(fixture, ['commit', '-m', 'initial'])
const baseSha = await prepare(fixture, ['rev-parse', 'HEAD'])
await prepare(fixture, ['switch', '-c', 'feature'])
await write('dual.txt', 'HEAD B\n')
await prepare(fixture, ['add', '--', 'dual.txt'])
await prepare(fixture, ['commit', '-m', 'feature change'])
const headSha = await prepare(fixture, ['rev-parse', 'HEAD'])
await write('dual.txt', 'INDEX C\n')
await prepare(fixture, ['add', '--', 'dual.txt'])
await write('dual.txt', 'WORKTREE D\n')
await prepare(fixture, ['mv', 'rename-old.txt', 'renamed.txt'])
await prepare(fixture, ['rm', '--', 'deleted-staged.txt'])
await fs.unlink(path.join(fixture, 'deleted-unstaged.txt'))
await write('new 中文.txt', 'real untracked content\n')
await write('binary.dat', Buffer.from([0, 1, 2, 255]))
await write('invalid-utf8.dat', Buffer.from([0xc3, 0x28, 0xff]))
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+cF9kAAAAASUVORK5CYII=',
  'base64'
)
const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
await write('safe.png', png)
await write('safe.gif', gif)
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg"><script>untrusted text stays text</script></svg>\n'
await write('untrusted.svg', svg)
await write('controls.txt', 'start\u001b[31mtext\n')
await write('ignored.txt', 'ignored fixture content must not enter generation\n')
const beforeRead = await diskIdentity(fixture)
const events = []
const observe = (event) => events.push({ ...event, atUTC: new Date().toISOString() })
const readerCache = path.join(evidence, 'reader-cache')
const initCache = path.join(evidence, 'init-cache')
const reader = api.createGitReader({ cacheRoot: readerCache, onProcess: observe })
const workbench = api.createGitWorkbenchReader({ onProcess: observe })
const views = []
const open = async (directory) => {
  const view = await reader.open(directory)
  views.push(view)
  return view
}
const view = await open(fixture)
const metadata = await workbench.metadata(view)
const main = metadata.branches.find((ref) => ref.name === 'main' && !ref.remote)
const featureCommit = metadata.commits.find((commit) => commit.sha === headSha)
const rootCommit = metadata.commits.find((commit) => commit.sha === baseSha)
async function pair(source, filename, extra = {}) {
  const review = await workbench.review(view, { source, ...extra })
  const item = review.files.find((file) => file.path === filename)
  assert(item, source + ' exposes ' + filename)
  const context = await workbench.context(view, review.revision)
  const request = {
    requestId: randomUUID(),
    viewId: view.info.viewId,
    revision: review.revision,
    itemId: item.itemId
  }
  const read = async (side) => {
    const fullRequest = { ...request, side }
    assert(api.parseGitFullFileRequest(fullRequest))
    const result = await api.readGitFullFile(context, fullRequest)
    assert(
      api.parseGitFullFileResult({
        requestId: request.requestId,
        viewId: request.viewId,
        status: 'ready',
        data: result
      })
    )
    return result
  }
  return {
    review,
    item,
    context,
    request,
    base: await read('base'),
    current: await read('current')
  }
}
const expectText = (result, content) => {
  assert.equal(result.format, 'text')
  assert.equal(result.text, content)
}
const modelCalls = []
const syntheticResponse = async (input) => {
  modelCalls.push(input)
  return {
    status: 'completed',
    output: [
      {
        type: 'message',
        content: [
          {
            type: 'output_text',
            text: JSON.stringify({ subject: '候选说明', body: '合成响应，未提交或发布。' })
          }
        ]
      }
    ]
  }
}
try {
  await suite.check(
    'full file resolves staged HEAD/index and unstaged index/worktree as independent actual Git blobs',
    async () => {
      const staged = await pair('staged', 'dual.txt')
      expectText(staged.base, 'HEAD B\n')
      expectText(staged.current, 'INDEX C\n')
      const unstaged = await pair('unstaged', 'dual.txt')
      expectText(unstaged.base, 'INDEX C\n')
      expectText(unstaged.current, 'WORKTREE D\n')
      return {
        staged: { base: staged.base, current: staged.current },
        unstaged: { base: unstaged.base, current: unstaged.current }
      }
    }
  )
  await suite.check(
    'full file resolves net HEAD/worktree, branch merge-base/worktree and selected commit first-parent/commit',
    async () => {
      const net = await pair('uncommitted', 'dual.txt')
      expectText(net.base, 'HEAD B\n')
      expectText(net.current, 'WORKTREE D\n')
      const branch = await pair('branch', 'dual.txt', { baseRefId: main.refId })
      expectText(branch.base, 'BASE A\n')
      expectText(branch.current, 'WORKTREE D\n')
      const commit = await pair('commit', 'dual.txt', { commitId: featureCommit.commitId })
      expectText(commit.base, 'BASE A\n')
      expectText(commit.current, 'HEAD B\n')
      const first = await pair('commit', 'dual.txt', { commitId: rootCommit.commitId })
      assert.equal(first.base.format, 'missing')
      expectText(first.current, 'BASE A\n')
    }
  )
  await suite.check(
    'deleted staged/unstaged files return absent current side; staged rename preserves original and new path identities',
    async () => {
      for (const [source, name, content] of [
        ['staged', 'deleted-staged.txt', 'staged deletion base\n'],
        ['unstaged', 'deleted-unstaged.txt', 'unstaged deletion base\n']
      ]) {
        const result = await pair(source, name)
        expectText(result.base, content)
        assert.equal(result.current.format, 'missing')
      }
      const renamed = await pair('staged', 'renamed.txt')
      assert.equal(renamed.base.path, 'rename-old.txt')
      assert.equal(renamed.current.path, 'renamed.txt')
      expectText(renamed.base, 'rename content\n')
      expectText(renamed.current, 'rename content\n')
    }
  )
  await suite.check(
    'real untracked content is shown only on current side, binary and invalid UTF-8 remain summaries',
    async () => {
      const text = await pair('uncommitted', 'new 中文.txt')
      assert.equal(text.base.format, 'missing')
      expectText(text.current, 'real untracked content\n')
      for (const name of ['binary.dat', 'invalid-utf8.dat']) {
        const result = await pair('uncommitted', name)
        assert.equal(result.base.format, 'missing')
        assert.equal(result.current.format, 'binary')
        assert.equal(result.item.binary, true)
        const diff = await workbench.diff(view, {
          revision: result.review.revision,
          itemId: result.item.itemId
        })
        assert.equal(diff.binary, true)
        assert.equal(diff.hunks.length, 0)
        assert.deepEqual(Object.keys(result.current).sort(), ['format', 'itemId', 'path', 'side'])
      }
    }
  )
  await suite.check(
    'actual PNG/GIF bytes retain exact allowed raster data; SVG remains literal text and control bytes are display-safe',
    async () => {
      for (const [name, bytes, mime] of [
        ['safe.png', png, 'image/png'],
        ['safe.gif', gif, 'image/gif']
      ]) {
        const result = await pair('uncommitted', name)
        assert.equal(result.current.format, 'image')
        assert.equal(result.current.mime, mime)
        assert.deepEqual(Buffer.from(result.current.base64, 'base64'), bytes)
        assert.equal(
          api.parseGitFullFileResult({
            requestId: randomUUID(),
            viewId: view.info.viewId,
            status: 'ready',
            data: { ...result.current, mime: 'image/svg+xml' }
          }),
          null
        )
      }
      expectText((await pair('uncommitted', 'untrusted.svg')).current, svg)
      expectText((await pair('uncommitted', 'controls.txt')).current, 'start\uFFFD[31mtext\n')
    }
  )
  await suite.check(
    'old opaque review and forged item identities cannot read other files or reuse a replaced review',
    async () => {
      const old = await pair('unstaged', 'dual.txt')
      await assert.rejects(
        api.readGitFullFile(old.context, { ...old.request, itemId: randomUUID(), side: 'current' }),
        (error) => error.status === 'stale'
      )
      await workbench.review(view, { source: 'staged' })
      const currentContext = await workbench.context(view)
      await assert.rejects(
        api.readGitFullFile(currentContext, { ...old.request, side: 'base' }),
        (error) => error.status === 'stale'
      )
    }
  )
  await suite.check(
    'includeUnstaged generation receives actual tracked net diff plus actual nonignored untracked text/binary summaries; staged-only excludes them',
    async () => {
      const context = await workbench.context(view)
      const request = {
        requestId: randomUUID(),
        viewId: view.info.viewId,
        revision: metadata.revision,
        purpose: 'commit',
        includeUnstaged: true
      }
      await api.generateGitText(context, request, new AbortController().signal, syntheticResponse)
      const net = JSON.parse(modelCalls.at(-1)[0].content)
      assert(net.diff.includes('-HEAD B') && net.diff.includes('+WORKTREE D'))
      assert(!net.diff.includes('INDEX C'))
      assert(
        net.newFiles.find(
          (file) =>
            file.path === 'new 中文.txt' &&
            file.content === 'real untracked content\n' &&
            !file.binary
        )
      )
      assert(
        net.newFiles.find(
          (file) => file.path === 'binary.dat' && file.content === null && file.binary
        )
      )
      assert(!JSON.stringify(net).includes('ignored fixture content'))
      await api.generateGitText(
        context,
        { ...request, includeUnstaged: false },
        new AbortController().signal,
        syntheticResponse
      )
      const staged = JSON.parse(modelCalls.at(-1)[0].content)
      assert(staged.diff.includes('-HEAD B') && staged.diff.includes('+INDEX C'))
      assert(!Object.hasOwn(staged, 'newFiles'))
      assert(!staged.diff.includes('WORKTREE D'))
      return {
        actualGit: true,
        syntheticResponseCalls: modelCalls.length,
        netNewFilePaths: net.newFiles.map((file) => file.path)
      }
    }
  )
  await suite.check(
    'full file and generation reads preserve original source repository identities completely',
    async () => {
      assert.deepEqual(await diskIdentity(fixture), beforeRead)
    }
  )
  await suite.check(
    'source change rejects full-file authority before reading current content and produces no additional source changes',
    async () => {
      const selected = await pair('unstaged', 'dual.txt')
      await write('dual.txt', 'new user edit after selection\n')
      const afterUserEdit = await diskIdentity(fixture)
      await assert.rejects(
        api.readGitFullFile(selected.context, { ...selected.request, side: 'current' }),
        (error) => error.status === 'stale'
      )
      assert.deepEqual(await diskIdentity(fixture), afterUserEdit)
    }
  )
  await suite.check(
    'actual initialization installs unborn main metadata in chosen new directory while existing ordinary files retain identity',
    async () => {
      const directory = assertOwnedPath(evidence, path.join(evidence, 'initialize-here'))
      await fs.mkdir(path.join(directory, 'nested'), { recursive: true })
      await fs.writeFile(path.join(directory, 'nested/keep.txt'), 'keep exact contents\n')
      await fs.writeFile(path.join(directory, '.hidden'), 'keep hidden content\n')
      const before = await diskIdentity(directory)
      await api.initializeGitDirectory(directory, initCache, undefined, observe)
      const after = await diskIdentity(directory)
      for (const [name, identity] of Object.entries(before))
        assert.deepEqual(after[name], identity, name)
      for (const name of Object.keys(after))
        if (!(name in before)) assert(name === '.git' || name.startsWith('.git/'))
      const initialized = await open(directory)
      const data = await workbench.metadata(initialized)
      assert.equal(data.branch, 'main')
      assert.equal(data.headSha, null)
      assert.equal(initialized.info.head, 'unborn')
      const review = await workbench.review(initialized, { source: 'uncommitted' })
      assert(review.files.find((file) => file.path === 'nested/keep.txt'))
      const beforeRetry = await diskIdentity(directory),
        eventCount = events.length
      await assert.rejects(
        api.initializeGitDirectory(directory, initCache, undefined, observe),
        (error) => error.status === 'stale'
      )
      assert.deepEqual(await diskIdentity(directory), beforeRetry)
      assert.equal(events.length, eventCount)
      return {
        branch: data.branch,
        head: data.headSha,
        untracked: review.files.map((file) => file.path)
      }
    }
  )
  await suite.check(
    'existing Git metadata file is never overwritten; pre-cancelled init creates no metadata/cache and spawns no process',
    async () => {
      const occupied = assertOwnedPath(evidence, path.join(evidence, 'occupied'))
      await fs.mkdir(occupied)
      await fs.writeFile(path.join(occupied, '.git'), 'foreign metadata marker\n')
      const before = await diskIdentity(occupied),
        start = events.length
      await assert.rejects(
        api.initializeGitDirectory(occupied, initCache, undefined, observe),
        (error) => error.status === 'stale'
      )
      assert.deepEqual(await diskIdentity(occupied), before)
      assert.equal(events.length, start)
      const cancelled = assertOwnedPath(evidence, path.join(evidence, 'cancelled-before'))
      await fs.mkdir(cancelled)
      await fs.writeFile(path.join(cancelled, 'keep.txt'), 'unchanged\n')
      const cancelledBefore = await diskIdentity(cancelled)
      const cancelledCache = assertOwnedPath(evidence, path.join(evidence, 'cancelled-cache'))
      const controller = new AbortController()
      controller.abort()
      await assert.rejects(
        api.initializeGitDirectory(cancelled, cancelledCache, controller.signal, observe),
        (error) => error.status === 'cancelled'
      )
      assert.deepEqual(await diskIdentity(cancelled), cancelledBefore)
      assert.equal(events.length, start)
      await assert.rejects(fs.stat(cancelledCache), { code: 'ENOENT' })
    }
  )
  await suite.check(
    'cancelling at real owned git-init close keeps chosen source directory unchanged and retires owned init copy',
    async () => {
      const directory = assertOwnedPath(evidence, path.join(evidence, 'cancelled-after-owned-init'))
      await fs.mkdir(directory)
      await fs.writeFile(path.join(directory, 'keep.txt'), 'remain\n')
      const before = await diskIdentity(directory)
      const controller = new AbortController()
      let actualInitClosed = false
      const observer = (event) => {
        observe(event)
        if (event.event === 'close' && event.args.includes('init')) {
          actualInitClosed = true
          controller.abort()
        }
      }
      await assert.rejects(
        api.initializeGitDirectory(directory, initCache, controller.signal, observer),
        (error) => error.status === 'cancelled' || error.name === 'AbortError'
      )
      assert(actualInitClosed)
      assert.deepEqual(await diskIdentity(directory), before)
      assert(!(await fs.readdir(initCache)).some((name) => name.startsWith('init-')))
      return { actualOwnedGitInitClosed: actualInitClosed, sourceMetadataInstalled: false }
    }
  )
} finally {
  for (const owned of views) await reader.dispose(owned)
  await fs.writeFile(path.join(evidence, 'processes.json'), JSON.stringify(events, null, 2))
  await fs.writeFile(path.join(evidence, 'preparation.json'), JSON.stringify(preparation, null, 2))
  await fs.writeFile(
    path.join(evidence, 'synthetic-generation-inputs.json'),
    JSON.stringify(modelCalls, null, 2)
  )
  await suite.check(
    'all observed product Git processes close and owned query/init copies are cleaned',
    async () => {
      const spawned = events.filter((event) => event.event === 'spawn'),
        closed = events.filter((event) => event.event === 'close')
      assert(spawned.length > 0)
      assert.equal(spawned.length, closed.length)
      assert(!events.some((event) => event.event === 'unconfirmed'))
      for (const event of spawned) {
        const cwd = path.resolve(event.cwd)
        if (
          cwd === readerCache ||
          cwd.startsWith(readerCache + path.sep) ||
          cwd === initCache ||
          cwd.startsWith(initCache + path.sep)
        )
          continue
        assert(views.some((owned) => path.resolve(owned.info.selectedPath) === cwd))
        assert.deepEqual(event.args, ['--no-optional-locks', 'rev-parse', '--show-toplevel'])
      }
      const retired = await verifyProcessRetirement(
        closed.map((event) => ({ ...event, closedAtUTC: event.atUTC }))
      )
      const readerEntries = await fs.readdir(readerCache),
        initEntries = await fs.readdir(initCache)
      assert(!readerEntries.some((name) => name.startsWith('query-')))
      assert(!initEntries.some((name) => name.startsWith('init-')))
      return { spawned: spawned.length, closed: closed.length, retired, readerEntries, initEntries }
    }
  )
  await suite.finish({ sourceHashes, compiledSHA256, syntheticResponseCalls: modelCalls.length })
}
