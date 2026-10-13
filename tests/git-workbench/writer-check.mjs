import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { build } from 'esbuild'

const root = path.resolve(import.meta.dirname, '../..')
const implementation = path.join(
  root,
  '.ui-check/git-codex-parity/implementation-49d0ef00-bfaf-4bb7-82aa-7e89cef59388'
)
const evidence = path.join(implementation, 'materials', 'writer-' + randomUUID())
const repos = path.join(evidence, 'repos')
const cacheRoot = path.join(root, '.ui-check', 'git-write-cache-' + randomUUID())
await fs.mkdir(repos, { recursive: true })
const git = path.join(process.env.ProgramFiles ?? 'C:/Program Files', 'Git/cmd/git.exe')
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const empty = path.join(evidence, 'empty.config')
await fs.writeFile(empty, '')
const env = {
  SystemRoot: process.env.SystemRoot,
  WINDIR: process.env.WINDIR,
  TEMP: process.env.TEMP,
  TMP: process.env.TMP,
  ComSpec: process.env.ComSpec,
  PATH: path.join(process.env.SystemRoot, 'System32'),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: empty,
  GIT_TERMINAL_PROMPT: '0',
  GIT_NO_LAZY_FETCH: '1'
}
const fixtureEvents = []
async function fixture(directory, args, allowed = [0]) {
  const relative = path.relative(repos, path.resolve(directory))
  assert(
    !relative.startsWith('..') && !path.isAbsolute(relative),
    'Fixture Git is confined to new UUID material repositories'
  )
  const child = spawn(
    git,
    [
      '-c',
      'core.autocrlf=false',
      '-c',
      'user.name=Workbench Fixture',
      '-c',
      'user.email=workbench@example.invalid',
      ...args
    ],
    { cwd: directory, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  const stdout = [],
    stderr = []
  child.stdout.on('data', (chunk) => stdout.push(chunk))
  child.stderr.on('data', (chunk) => stderr.push(chunk))
  const timer = setTimeout(() => child.kill(), 15000)
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  }).finally(() => clearTimeout(timer))
  const result = {
    code,
    stdout: Buffer.concat(stdout).toString('utf8'),
    stderr: Buffer.concat(stderr).toString('utf8')
  }
  fixtureEvents.push({ directory, args, ...result })
  assert(allowed.includes(code), result.stderr)
  return result.stdout.trim()
}
const bundles = {}
const identities = {}
for (const [name, source] of [
  ['reader', 'src/main/git/git-reader.ts'],
  ['writer', 'src/main/git/git-workbench-writer.ts'],
  ['catalog', 'src/main/git/git-workbench-reader.ts']
]) {
  const output = path.join(evidence, name + '.cjs')
  const result = await build({
    entryPoints: [path.join(root, source)],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    metafile: true,
    logLevel: 'silent'
  })
  for (const filename of Object.keys(result.metafile.inputs))
    identities[filename] = hash(await fs.readFile(path.join(root, filename)))
  bundles[name] = createRequire(import.meta.url)(output)
}
const program = { executable: git, sha256: hash(await fs.readFile(git)) }
const productEvents = []
const windowsReplacementControls = []
const reader = bundles.reader.createGitReader({
  cacheRoot,
  onProcess: (event) => productEvents.push(event)
})
const writer = bundles.writer.createGitWorkbenchWriter({
  onProcess: (event) => productEvents.push(event)
})
const catalog = bundles.catalog.createGitWorkbenchReader({
  onProcess: (event) => productEvents.push(event)
})
const checks = []
const views = []
async function check(name, body) {
  try {
    await body()
    checks.push({ name, pass: true })
    console.log('PASS ' + name)
  } catch (error) {
    checks.push({ name, pass: false, error: error.stack })
    console.log('FAIL ' + name + ': ' + error.message)
    throw error
  }
}
async function repo(name, content = 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n') {
  const directory = path.join(repos, name)
  await fs.mkdir(directory)
  await fixture(directory, ['init', '--initial-branch=main'])
  await fixture(directory, ['config', 'core.autocrlf', 'false'])
  await fs.writeFile(path.join(directory, 'a.txt'), content)
  await fs.writeFile(path.join(directory, 'other.txt'), 'other baseline\n')
  await fixture(directory, ['add', '--all'])
  await fixture(directory, ['commit', '-m', 'baseline'])
  return directory
}
async function context(directory) {
  const view = await reader.open(directory)
  views.push(view)
  await reader.refresh(view)
  const ctx = {
    location: view.location,
    snapshot: view.snapshot,
    program,
    refs: new Map(),
    identity: { name: 'Manual Test', email: 'manual@example.invalid' }
  }
  for (const name of ['main', 'feature']) {
    const oid = await fs
      .readFile(path.join(view.location.common, 'refs/heads', name), 'utf8')
      .catch(() => null)
    if (oid)
      ctx.refs.set(name + '-opaque', {
        name,
        ref: 'refs/heads/' + name,
        oid: oid.trim(),
        remote: false
      })
  }
  return ctx
}
const request = (ctx, action, extra = {}) => ({
  requestId: randomUUID(),
  viewId: randomUUID(),
  revision: ctx.snapshot.revision,
  action,
  ...extra
})
const find = (ctx, group, filename = 'a.txt') =>
  ctx.snapshot.items.find((item) => item.group === group && item.path === filename).itemId
const text = (directory, name = 'a.txt') => fs.readFile(path.join(directory, name), 'utf8')
async function withActualDenyDelete(directory, body, firstDenied) {
  assert.equal(process.platform, 'win32')
  const target = path.join(directory, 'a.txt')
  const relative = path.relative(repos, target)
  assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative))
  const originalRename = fs.rename
  let helper,
    closed,
    denied = 0,
    ready
  const record = {
    target,
    actualWindowsFileHandle: true,
    shareReadWrite: true,
    shareDelete: false,
    denied: 0,
    closed: false
  }
  windowsReplacementControls.push(record)
  const release = () => {
    if (helper?.stdin && !helper.stdin.writableEnded && !helper.stdin.destroyed)
      helper.stdin.end('release\n')
  }
  fs.rename = async (from, to) => {
    if (
      path.resolve(to) !== path.resolve(target) ||
      !path.basename(from).startsWith('.zonecodex-write-')
    )
      return originalRename(from, to)
    if (!helper) {
      const script =
        "$stream = [System.IO.File]::Open('" +
        target.replaceAll("'", "''") +
        "', [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::ReadWrite); [Console]::WriteLine('READY'); [Console]::ReadLine() | Out-Null; $stream.Dispose()"
      helper = spawn(
        path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
        ['-NoProfile', '-Command', script],
        { cwd: directory, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
      )
      record.pid = helper.pid
      const stderr = []
      helper.stderr.on('data', (bytes) => stderr.push(bytes))
      closed = new Promise((resolve) =>
        helper.once('close', (code) => {
          record.closed = true
          record.exitCode = code
          record.stderr = Buffer.concat(stderr).toString('utf8')
          resolve(code)
        })
      )
      ready = new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(Error('Actual Windows lock helper did not become ready')),
          10000
        )
        helper.once('error', (error) => {
          clearTimeout(timer)
          reject(error)
        })
        helper.stdout.on('data', (bytes) => {
          if (bytes.toString('utf8').includes('READY')) {
            clearTimeout(timer)
            resolve()
          }
        })
      })
      await ready
    }
    try {
      return await originalRename(from, to)
    } catch (error) {
      assert(
        ['EPERM', 'EACCES', 'EBUSY'].includes(error.code),
        'The real Windows handle denies replacement'
      )
      record.denied = ++denied
      if (denied === 1) await firstDenied?.(release)
      throw error
    }
  }
  try {
    await body(record)
  } finally {
    fs.rename = originalRename
    release()
    if (closed) {
      let timer
      try {
        await Promise.race([
          closed,
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(Error('Actual Windows lock helper did not close')),
              10000
            )
          })
        ])
      } finally {
        clearTimeout(timer)
      }
      assert.equal(record.exitCode, 0, record.stderr)
    }
  }
  return record
}
let failed = null
try {
  const base = await repo('basic')
  await check('stage one file preserves other dirty file and uses only owned Git cwd', async () => {
    await fs.writeFile(path.join(base, 'a.txt'), 'staged content\n')
    await fs.writeFile(path.join(base, 'other.txt'), 'other dirty\n')
    const ctx = await context(base)
    const result = await writer.execute(
      ctx,
      request(ctx, 'stage', { itemIds: [find(ctx, 'unstaged')] })
    )
    assert.equal(result.outcome, 'success')
    assert.equal(await fixture(base, ['show', ':a.txt']), 'staged content')
    assert.equal(await fixture(base, ['show', ':other.txt']), 'other baseline')
    assert.equal(await text(base, 'other.txt'), 'other dirty\n')
    assert(
      productEvents
        .filter((event) => event.event === 'spawn')
        .every((event) => !event.args.includes('add') || event.cwd !== base)
    )
  })
  await check('unstage preserves newer working tree edits', async () => {
    await fs.writeFile(path.join(base, 'a.txt'), 'newer unsaved-to-index\n')
    const ctx = await context(base)
    const result = await writer.execute(
      ctx,
      request(ctx, 'unstage', { itemIds: [find(ctx, 'staged')] })
    )
    assert.equal(result.outcome, 'success')
    assert.equal(await text(base), 'newer unsaved-to-index\n')
    assert((await fixture(base, ['show', ':a.txt'])).startsWith('one\n'))
  })
  await check('revert unstaged restores index bytes and preserves unrelated edits', async () => {
    const ctx = await context(base)
    await writer.execute(ctx, request(ctx, 'revert', { itemIds: [find(ctx, 'unstaged')] }))
    assert((await text(base)).startsWith('one\n'))
    assert.equal(await text(base, 'other.txt'), 'other dirty\n')
  })
  await check(
    'actual Windows deny-delete handle is released and atomic replacement retries without deleting the original',
    async () => {
      const transient = await repo('transient-lock')
      const original = await text(transient)
      await fs.writeFile(path.join(transient, 'a.txt'), 'transient current bytes\n')
      const ctx = await context(transient)
      const record = await withActualDenyDelete(
        transient,
        async () => {
          const result = await writer.execute(
            ctx,
            request(ctx, 'revert', { itemIds: [find(ctx, 'unstaged')] })
          )
          assert.equal(result.outcome, 'success')
          assert.equal(await text(transient), original)
        },
        async (release) => {
          assert.equal(await text(transient), 'transient current bytes\n')
          release()
        }
      )
      assert(record.denied >= 1)
    }
  )
  await check(
    'persistent actual Windows replacement denial remains bounded and preserves original bytes',
    async () => {
      const persistent = await repo('persistent-lock')
      await fs.writeFile(path.join(persistent, 'a.txt'), 'persistent user bytes\n')
      const ctx = await context(persistent)
      const record = await withActualDenyDelete(persistent, async () => {
        await assert.rejects(
          writer.execute(ctx, request(ctx, 'revert', { itemIds: [find(ctx, 'unstaged')] })),
          /EPERM|EACCES|EBUSY/
        )
        assert.equal(await text(persistent), 'persistent user bytes\n')
      })
      assert.equal(record.denied, 6)
    }
  )
  await check(
    'Windows retry rechecks user byte changes and cancellation before replacing the destination',
    async () => {
      for (const kind of ['changed', 'cancelled']) {
        const raced = await repo('retry-' + kind)
        await fs.writeFile(path.join(raced, 'a.txt'), 'original dirty bytes\n')
        const ctx = await context(raced),
          controller = new AbortController()
        const record = await withActualDenyDelete(
          raced,
          async () => {
            await assert.rejects(
              writer.execute(
                ctx,
                request(ctx, 'revert', { itemIds: [find(ctx, 'unstaged')] }),
                controller.signal
              ),
              kind === 'changed' ? /变化/ : /取消/
            )
            assert.equal(
              await text(raced),
              kind === 'changed' ? 'newer user bytes must remain\n' : 'original dirty bytes\n'
            )
          },
          async (release) => {
            if (kind === 'changed')
              await fs.writeFile(path.join(raced, 'a.txt'), 'newer user bytes must remain\n')
            else controller.abort()
            release()
          }
        )
        assert.equal(record.denied, 1)
      }
    }
  )
  await check('stage new unicode and leading-dash literal paths', async () => {
    for (const name of ['中文 空格.txt', '-literal [x].txt'])
      await fs.writeFile(path.join(base, name), 'new ' + name + '\n')
    const ctx = await context(base)
    const ids = ctx.snapshot.items
      .filter((item) => item.group === 'untracked')
      .map((item) => item.itemId)
    await writer.execute(ctx, request(ctx, 'stage', { itemIds: ids }))
    assert.equal(await fixture(base, ['show', ':中文 空格.txt']), 'new 中文 空格.txt')
    assert.equal(await fixture(base, ['show', ':-literal [x].txt']), 'new -literal [x].txt')
  })
  await check('stage deletion and unstage deletion leave working tree deleted', async () => {
    await fs.unlink(path.join(base, 'a.txt'))
    let ctx = await context(base)
    await writer.execute(ctx, request(ctx, 'stage', { itemIds: [find(ctx, 'unstaged')] }))
    ctx = await context(base)
    await writer.execute(ctx, request(ctx, 'unstage', { itemIds: [find(ctx, 'staged')] }))
    assert((await fixture(base, ['show', ':a.txt'])).startsWith('one\n'))
    assert.equal(await fs.stat(path.join(base, 'a.txt')).catch(() => null), null)
  })
  await check('revert deleted file recreates bounded index version', async () => {
    const ctx = await context(base)
    await writer.execute(ctx, request(ctx, 'revert', { itemIds: [find(ctx, 'unstaged')] }))
    assert((await text(base)).startsWith('one\n'))
  })
  const stagedRevert = await repo('staged-revert')
  await check('revert staged changes preserves separate newer unstaged lines', async () => {
    const original = await text(stagedRevert)
    await fs.writeFile(path.join(stagedRevert, 'a.txt'), original.replace('one\n', 'ONE\n'))
    await fixture(stagedRevert, ['add', 'a.txt'])
    await fs.writeFile(
      path.join(stagedRevert, 'a.txt'),
      original.replace('one\n', 'ONE\n').replace('ten\n', 'TEN\n')
    )
    const ctx = await context(stagedRevert)
    const result = await writer.execute(
      ctx,
      request(ctx, 'revert', { itemIds: [find(ctx, 'staged')] })
    )
    assert.equal(result.outcome, 'success')
    assert.equal(await text(stagedRevert), original.replace('ten\n', 'TEN\n'))
    assert.equal(await fixture(stagedRevert, ['diff', '--cached']), '')
  })
  const dualRevert = await repo('dual-revert')
  await check(
    'uncommitted whole file revert restores HEAD in both index and working tree',
    async () => {
      const original = await text(dualRevert)
      await fs.writeFile(path.join(dualRevert, 'a.txt'), original.replace('one\n', 'STAGED\n'))
      await fixture(dualRevert, ['add', 'a.txt'])
      await fs.writeFile(
        path.join(dualRevert, 'a.txt'),
        original.replace('one\n', 'STAGED\n').replace('ten\n', 'WORKTREE\n')
      )
      const view = await reader.open(dualRevert)
      views.push(view)
      await reader.refresh(view)
      const review = await catalog.review(view, {
        requestId: randomUUID(),
        viewId: view.info.viewId,
        source: 'uncommitted'
      })
      const file = review.files.find((item) => item.path === 'a.txt')
      const diff = await catalog.diff(view, {
        requestId: randomUUID(),
        viewId: view.info.viewId,
        revision: review.revision,
        itemId: file.itemId
      })
      const ctx = await catalog.context(view, review.revision)
      await assert.rejects(
        writer.execute(ctx, {
          ...request(ctx, 'stage'),
          revision: review.revision,
          itemIds: [file.itemId],
          hunkIds: [diff.hunks[0].hunkId]
        }),
        /同时存在已暂存/
      )
      assert.equal(
        await text(dualRevert),
        original.replace('one\n', 'STAGED\n').replace('ten\n', 'WORKTREE\n')
      )
      const result = await writer.execute(ctx, {
        ...request(ctx, 'revert'),
        revision: review.revision,
        itemIds: [file.itemId]
      })
      assert.equal(result.outcome, 'success')
      assert.equal(await text(dualRevert), original)
      assert.equal(await fixture(dualRevert, ['show', ':a.txt']), original.trim())
      assert.equal(await fixture(dualRevert, ['status', '--porcelain']), '')
    }
  )
  const commits = await repo('commits')
  await check(
    'staged-only manual commit preserves unstaged changes and explicit identity',
    async () => {
      await fs.writeFile(path.join(commits, 'a.txt'), 'manual staged\n')
      await fixture(commits, ['add', 'a.txt'])
      await fs.writeFile(path.join(commits, 'other.txt'), 'not included\n')
      const previous = await fixture(commits, ['rev-parse', 'HEAD'])
      const ctx = await context(commits)
      const result = await writer.execute(
        ctx,
        request(ctx, 'commit', { message: '手工提交\n\nbody', includeUnstaged: false })
      )
      assert.equal(result.outcome, 'success')
      assert.equal(await fixture(commits, ['rev-parse', 'HEAD^']), previous)
      assert.equal(await fixture(commits, ['show', 'HEAD:other.txt']), 'other baseline')
      assert.equal(
        await fixture(commits, ['log', '-1', '--format=%an <%ae>']),
        'Manual Test <manual@example.invalid>'
      )
      assert.equal(await text(commits, 'other.txt'), 'not included\n')
    }
  )
  await check(
    'include-unstaged commit stages current bounded content and creates expected tree',
    async () => {
      await fs.writeFile(path.join(commits, 'new.txt'), 'include new\n')
      const ctx = await context(commits)
      await writer.execute(
        ctx,
        request(ctx, 'commit', { message: 'include changes', includeUnstaged: true })
      )
      assert.equal(await fixture(commits, ['status', '--porcelain']), '')
      assert.equal(await fixture(commits, ['show', 'HEAD:new.txt']), 'include new')
      assert.equal(await fixture(commits, ['show', 'HEAD:other.txt']), 'not included')
    }
  )
  await check('create branch never overwrites existing refs', async () => {
    let ctx = await context(commits)
    await writer.execute(ctx, request(ctx, 'create-branch', { name: 'feature' }))
    assert.equal(await fixture(commits, ['branch', '--show-current']), 'feature')
    assert.equal(
      await fixture(commits, ['rev-parse', 'feature']),
      await fixture(commits, ['rev-parse', 'HEAD'])
    )
    ctx = await context(commits)
    await assert.rejects(
      writer.execute(ctx, request(ctx, 'create-branch', { name: 'feature' })),
      /已经存在|已变化/
    )
  })
  await check(
    'checkout clean tree switches expected branch without loading source config',
    async () => {
      const ctx = await context(commits)
      const result = await writer.execute(ctx, request(ctx, 'checkout', { refId: 'main-opaque' }))
      assert.equal(result.outcome, 'success')
      assert.equal(await fixture(commits, ['branch', '--show-current']), 'main')
      assert.equal(await fixture(commits, ['status', '--porcelain']), '')
    }
  )
  await check('checkout refuses dirty tree with no stash/reset/clean', async () => {
    await fs.writeFile(path.join(commits, 'a.txt'), 'dirty checkout must preserve\n')
    const ctx = await context(commits)
    await assert.rejects(
      writer.execute(ctx, request(ctx, 'checkout', { refId: 'feature-opaque' })),
      /未提交改动/
    )
    assert.equal(await text(commits), 'dirty checkout must preserve\n')
    assert.equal(await fixture(commits, ['branch', '--show-current']), 'main')
  })
  await check(
    'packed branch checkout reads actual packed refs and respects existing branch and packed locks',
    async () => {
      const packedRepo = await repo('packed')
      await fixture(packedRepo, ['branch', 'feature'])
      await fixture(packedRepo, ['pack-refs', '--all'])
      const view = await reader.open(packedRepo)
      views.push(view)
      await reader.refresh(view)
      const metadata = await catalog.metadata(view)
      const ctx = await catalog.context(view, metadata.revision)
      const target = metadata.branches.find((item) => item.name === 'feature')
      const beforeIndex = await fs.readFile(path.join(packedRepo, '.git/index'))
      for (const lockName of ['refs/heads/feature.lock', 'packed-refs.lock']) {
        const filename = path.join(packedRepo, '.git', lockName)
        await fs.writeFile(filename, 'external lock kept\n')
        await assert.rejects(
          writer.execute(ctx, request(ctx, 'checkout', { refId: target.refId })),
          /现有锁|已变化/
        )
        assert.equal(await fs.readFile(filename, 'utf8'), 'external lock kept\n')
        assert.equal(await fixture(packedRepo, ['branch', '--show-current']), 'main')
        assert.deepEqual(await fs.readFile(path.join(packedRepo, '.git/index')), beforeIndex)
        await fs.unlink(filename)
      }
      await reader.refresh(view)
      const refreshed = await catalog.metadata(view)
      const current = await catalog.context(view, refreshed.revision)
      const currentTarget = refreshed.branches.find((item) => item.name === 'feature')
      const result = await writer.execute(
        current,
        request(current, 'checkout', { refId: currentTarget.refId })
      )
      assert.equal(result.outcome, 'success')
      assert.equal(await fixture(packedRepo, ['branch', '--show-current']), 'feature')
      assert.equal(await fixture(packedRepo, ['status', '--porcelain']), '')
      for (const lockName of [
        'HEAD.lock',
        'index.lock',
        'refs/heads/main.lock',
        'refs/heads/feature.lock',
        'packed-refs.lock'
      ])
        assert.equal(await fs.stat(path.join(packedRepo, '.git', lockName)).catch(() => null), null)
    }
  )
  await check(
    'manual commit accepts a bounded 16000 character body and rejects over 64 KiB before publication',
    async () => {
      const longRepo = await repo('long-message')
      await fs.writeFile(path.join(longRepo, 'a.txt'), 'long message commit bytes\n')
      let ctx = await context(longRepo)
      await writer.execute(ctx, request(ctx, 'stage', { itemIds: [find(ctx, 'unstaged')] }))
      ctx = await context(longRepo)
      const oldHead = await fixture(longRepo, ['rev-parse', 'HEAD'])
      await assert.rejects(
        writer.execute(
          ctx,
          request(ctx, 'commit', { message: '中'.repeat(23000), includeUnstaged: false })
        ),
        /超过上限/
      )
      assert.equal(await fixture(longRepo, ['rev-parse', 'HEAD']), oldHead)
      const message = 'Manual candidate body\n\n' + 'x'.repeat(16000)
      const result = await writer.execute(
        ctx,
        request(ctx, 'commit', { message, includeUnstaged: false })
      )
      assert.equal(result.outcome, 'success')
      assert.equal(await fixture(longRepo, ['show', '-s', '--format=%B', 'HEAD']), message)
    }
  )
  await check('stale source rejects before publishing index or overwriting edits', async () => {
    const ctx = await context(commits)
    const indexBefore = await fs.readFile(path.join(commits, '.git/index'))
    await fs.writeFile(path.join(commits, 'a.txt'), 'raced current bytes\n')
    await assert.rejects(
      writer.execute(ctx, request(ctx, 'stage', { itemIds: [find(ctx, 'unstaged')] })),
      /变化/
    )
    assert.deepEqual(await fs.readFile(path.join(commits, '.git/index')), indexBefore)
    assert.equal(await text(commits), 'raced current bytes\n')
  })
  await check('existing index lock is kept and cannot be stolen', async () => {
    await fs.writeFile(path.join(commits, '.git/index.lock'), 'external lock')
    const ctx = await context(commits)
    await assert.rejects(
      writer.execute(ctx, request(ctx, 'stage', { itemIds: [find(ctx, 'unstaged')] })),
      /现有锁/
    )
    assert.equal(await fs.readFile(path.join(commits, '.git/index.lock'), 'utf8'), 'external lock')
    await fs.unlink(path.join(commits, '.git/index.lock'))
  })
  await check('pre-start cancellation makes zero source change', async () => {
    const ctx = await context(commits)
    const before = await fs.readFile(path.join(commits, '.git/index'))
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      writer.execute(
        ctx,
        request(ctx, 'stage', { itemIds: [find(ctx, 'unstaged')] }),
        controller.signal
      ),
      /取消/
    )
    assert.deepEqual(await fs.readFile(path.join(commits, '.git/index')), before)
  })
  const hunks = await repo('hunks')
  await check('real catalog opaque hunk stages one hunk then unstages it', async () => {
    const original = await text(hunks)
    await fs.writeFile(
      path.join(hunks, 'a.txt'),
      original.replace('one\n', 'FIRST\n').replace('ten\n', 'LAST\n')
    )
    let view = await reader.open(hunks)
    views.push(view)
    await reader.refresh(view)
    let review = await catalog.review(view, {
      requestId: randomUUID(),
      viewId: view.info.viewId,
      source: 'unstaged'
    })
    const file = review.files.find((item) => item.path === 'a.txt')
    const diff = await catalog.diff(view, {
      requestId: randomUUID(),
      viewId: view.info.viewId,
      revision: review.revision,
      itemId: file.itemId
    })
    assert.equal(diff.hunks.length, 2)
    let ctx = await catalog.context(view, review.revision)
    await writer.execute(ctx, {
      ...request(ctx, 'stage'),
      revision: review.revision,
      itemIds: [file.itemId],
      hunkIds: [diff.hunks[0].hunkId]
    })
    assert.equal(
      await fixture(hunks, ['show', ':a.txt']),
      original.replace('one\n', 'FIRST\n').trim()
    )
    view = await reader.open(hunks)
    views.push(view)
    await reader.refresh(view)
    review = await catalog.review(view, {
      requestId: randomUUID(),
      viewId: view.info.viewId,
      source: 'staged'
    })
    const staged = review.files.find((item) => item.path === 'a.txt')
    const stagedDiff = await catalog.diff(view, {
      requestId: randomUUID(),
      viewId: view.info.viewId,
      revision: review.revision,
      itemId: staged.itemId
    })
    ctx = await catalog.context(view, review.revision)
    await writer.execute(ctx, {
      ...request(ctx, 'unstage'),
      revision: review.revision,
      itemIds: [staged.itemId],
      hunkIds: [stagedDiff.hunks[0].hunkId]
    })
    assert.equal(await fixture(hunks, ['diff', '--cached']), '')
    assert.equal(await text(hunks), original.replace('one\n', 'FIRST\n').replace('ten\n', 'LAST\n'))
  })
  const medium = await repo(
    'medium-patch',
    Array.from(
      { length: 2800 },
      (_, index) => 'baseline-' + index + '-' + 'x'.repeat(120) + '\n'
    ).join('')
  )
  await check(
    'new workbench opaque hunk permits a real patch larger than legacy 256KiB preview',
    async () => {
      const original = await text(medium)
      const replacement = original.replaceAll('baseline-', 'changed--')
      await fs.writeFile(path.join(medium, 'a.txt'), replacement)
      const view = await reader.open(medium)
      views.push(view)
      await reader.refresh(view)
      const review = await catalog.review(view, {
        requestId: randomUUID(),
        viewId: view.info.viewId,
        source: 'unstaged'
      })
      const file = review.files.find((item) => item.path === 'a.txt')
      const diff = await catalog.diff(view, {
        requestId: randomUUID(),
        viewId: view.info.viewId,
        revision: review.revision,
        itemId: file.itemId
      })
      assert(Buffer.byteLength(diff.text) > 256 * 1024)
      assert.equal(diff.hunks.length, 1)
      const ctx = await catalog.context(view, review.revision)
      const result = await writer.execute(ctx, {
        ...request(ctx, 'stage'),
        revision: review.revision,
        itemIds: [file.itemId],
        hunkIds: [diff.hunks[0].hunkId]
      })
      assert.equal(result.outcome, 'success')
      assert.equal(await fixture(medium, ['show', ':a.txt']), replacement.trim())
    }
  )
  const hooked = await repo('hooks')
  await check(
    'effective post-commit hook control executes, owned manual commit does not',
    async () => {
      const marker = path.join(hooked, 'hook-marker')
      const hook = path.join(hooked, '.git/hooks/post-commit')
      await fs.writeFile(
        hook,
        '#!/bin/sh\nprintf called > "' + marker.replaceAll('\\', '/') + '"\n'
      )
      await fs.writeFile(path.join(hooked, 'a.txt'), 'control\n')
      await fixture(hooked, ['add', 'a.txt'])
      await fixture(hooked, ['commit', '-m', 'effective control'])
      assert.equal(await fs.readFile(marker, 'utf8'), 'called')
      await fs.unlink(marker)
      await fs.writeFile(path.join(hooked, 'a.txt'), 'product manual commit\n')
      const beforeHook = await fs.readFile(hook)
      const config = await fs.readFile(path.join(hooked, '.git/config'))
      const ctx = await context(hooked)
      await writer.execute(
        ctx,
        request(ctx, 'commit', { message: 'owned no hook', includeUnstaged: true })
      )
      assert.equal(await fs.stat(marker).catch(() => null), null)
      assert.deepEqual(await fs.readFile(hook), beforeHook)
      assert.deepEqual(await fs.readFile(path.join(hooked, '.git/config')), config)
    }
  )
  await check('source subtree cannot commit hidden staged index or switch branches', async () => {
    await fs.mkdir(path.join(hooked, 'child'))
    await fs.writeFile(path.join(hooked, 'child/item.txt'), 'subtree\n')
    const ctx = await context(path.join(hooked, 'child'))
    await assert.rejects(
      writer.execute(
        ctx,
        request(ctx, 'commit', { message: 'must refuse', includeUnstaged: false })
      ),
      /仓库根目录/
    )
    await assert.rejects(
      writer.execute(ctx, request(ctx, 'create-branch', { name: 'scope-refuse' })),
      /仓库根目录/
    )
  })
  const unborn = path.join(repos, 'unborn')
  await fs.mkdir(unborn)
  await fixture(unborn, ['init', '--initial-branch=main'])
  await check(
    'unborn stage/unstage and first manual commit keep explicit empty baseline',
    async () => {
      await fs.writeFile(path.join(unborn, 'new.txt'), 'first\n')
      let ctx = await context(unborn)
      await writer.execute(
        ctx,
        request(ctx, 'stage', { itemIds: [find(ctx, 'untracked', 'new.txt')] })
      )
      ctx = await context(unborn)
      await writer.execute(
        ctx,
        request(ctx, 'unstage', { itemIds: [find(ctx, 'staged', 'new.txt')] })
      )
      assert.equal(await text(unborn, 'new.txt'), 'first\n')
      ctx = await context(unborn)
      const result = await writer.execute(
        ctx,
        request(ctx, 'commit', { message: 'first manual', includeUnstaged: true })
      )
      assert.equal(result.outcome, 'success')
      assert.equal(await fixture(unborn, ['rev-list', '--count', 'HEAD']), '1')
    }
  )
  await check(
    'all product write Git commands ran in owned material caches and actually closed',
    async () => {
      const events = productEvents.filter((event) => event.event === 'spawn')
      const writeNames = new Set([
        'add',
        'reset',
        'rm',
        'apply',
        'read-tree',
        'checkout-index',
        'write-tree',
        'commit-tree'
      ])
      assert(
        events
          .filter((event) => event.args.some((arg) => writeNames.has(arg)))
          .every((event) => event.cwd.startsWith(cacheRoot))
      )
      for (const event of events)
        assert(productEvents.some((closed) => closed.event === 'close' && closed.pid === event.pid))
      assert.equal(productEvents.filter((event) => event.event === 'unconfirmed').length, 0)
    }
  )
} catch (error) {
  failed = error
} finally {
  for (const view of views) await reader.dispose(view).catch(() => {})
  await fs.writeFile(
    path.join(evidence, 'report.json'),
    JSON.stringify(
      {
        evidence,
        pass: !failed,
        checks,
        layers: {
          actualGit: true,
          actualDisk: true,
          actualCatalog: true,
          actualElectron: false,
          actualModel: false,
          fixtureWrites: 'only new UUID repos',
          sourceRepositoryGitWrites: false
        },
        identities,
        fixtureEvents,
        windowsReplacementControls,
        productEvents
      },
      null,
      2
    )
  )
  console.log(evidence)
}
if (failed) throw failed
