import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { build } from 'esbuild'

const root = path.resolve(import.meta.dirname, '../..')
const evidence = path.join(root, '.ui-check/git-codex-parity/materials/worktrees-' + randomUUID())
await fs.mkdir(evidence, { recursive: true })
const repository = path.join(evidence, 'repository'),
  targets = path.join(evidence, 'targets')
await fs.mkdir(repository)
await fs.mkdir(targets)
const git = path.join(process.env.ProgramFiles ?? 'C:/Program Files', 'Git/cmd/git.exe')
const empty = path.join(evidence, 'empty.config')
await fs.writeFile(empty, '')
const env = {
  SystemRoot: process.env.SystemRoot,
  WINDIR: process.env.WINDIR,
  TEMP: process.env.TEMP,
  TMP: process.env.TMP,
  PATH: path.join(process.env.SystemRoot, 'System32'),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: empty,
  GIT_TERMINAL_PROMPT: '0',
  GIT_NO_LAZY_FETCH: '1'
}
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const fixtureEvents = [],
  productEvents = [],
  checks = [],
  identities = {},
  views = []
async function gitFixture(directory, args) {
  const relative = path.relative(evidence, path.resolve(directory))
  assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative))
  const child = spawn(
    git,
    [
      '-c',
      'user.name=Independent Worktree Fixture',
      '-c',
      'user.email=worktree@example.invalid',
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
  const text = Buffer.concat(stdout).toString('utf8')
  fixtureEvents.push({
    directory,
    args,
    code,
    stdout: text,
    stderr: Buffer.concat(stderr).toString('utf8')
  })
  assert.equal(code, 0, Buffer.concat(stderr).toString('utf8'))
  return text.trim()
}
const modules = {}
for (const [name, filename] of [
  ['reader', 'src/main/git/git-reader.ts'],
  ['catalog', 'src/main/git/git-workbench-reader.ts'],
  ['worktrees', 'src/main/git/git-workbench-worktrees.ts']
]) {
  const output = path.join(evidence, name + '.cjs')
  const result = await build({
    entryPoints: [path.join(root, filename)],
    outfile: output,
    platform: 'node',
    bundle: true,
    format: 'cjs',
    metafile: true,
    logLevel: 'silent'
  })
  for (const filename of Object.keys(result.metafile.inputs))
    identities[filename] = hash(await fs.readFile(path.join(root, filename)))
  modules[name] = createRequire(import.meta.url)(output)
}
const cacheRoot = path.join(root, '.ui-check', 'git-worktree-cache-' + randomUUID())
const reader = modules.reader.createGitReader({
  cacheRoot,
  onProcess: (event) => productEvents.push(event)
})
const catalog = modules.catalog.createGitWorkbenchReader({
  onProcess: (event) => productEvents.push(event)
})
const worktrees = modules.worktrees.createGitWorkbenchWorktrees({
  registryRoot: path.join(evidence, 'registry'),
  onProcess: (event) => productEvents.push(event)
})
async function capture(directory = repository) {
  const view = await reader.open(directory)
  views.push(view)
  await reader.refresh(view)
  const metadata = await catalog.metadata(view)
  const context = await catalog.context(view, metadata.revision)
  return { view, metadata, context }
}
const action = (state, kind, extra = {}) => ({
  requestId: randomUUID(),
  viewId: state.view.info.viewId,
  revision: state.context.snapshot.revision,
  action: kind,
  ...extra
})
const ownedPath = path.join(targets, 'alpha')
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
let failed = null
try {
  await gitFixture(repository, ['init', '--initial-branch=main'])
  await gitFixture(repository, ['config', 'core.autocrlf', 'false'])
  await fs.writeFile(path.join(repository, 'file.txt'), 'tracked original\n')
  await fs.writeFile(path.join(repository, '.gitignore'), 'ignored.txt\n')
  await gitFixture(repository, ['add', '--all'])
  await gitFixture(repository, ['commit', '-m', 'baseline'])
  const originalIndex = await fs.readFile(path.join(repository, '.git/index')),
    originalConfig = await fs.readFile(path.join(repository, '.git/config')),
    originalHEAD = await gitFixture(repository, ['rev-parse', 'HEAD'])
  await check(
    'create materializes owned snapshot and registers valid linked worktree without changing source index/config/HEAD',
    async () => {
      const state = await capture()
      const ref = state.metadata.branches.find((item) => item.current)
      const result = await worktrees.execute(
        state.context,
        action(state, 'create-worktree', { name: 'alpha', refId: ref.refId }),
        targets
      )
      assert.equal(result.outcome, 'success')
      assert.equal(
        await fs.readFile(path.join(ownedPath, 'file.txt'), 'utf8'),
        'tracked original\n'
      )
      assert.equal(await gitFixture(ownedPath, ['branch', '--show-current']), 'codex/alpha')
      assert.equal(await gitFixture(ownedPath, ['status', '--porcelain']), '')
      assert(
        (await gitFixture(repository, ['worktree', 'list', '--porcelain'])).includes(
          ownedPath.replaceAll('\\', '/')
        )
      )
      assert.deepEqual(await fs.readFile(path.join(repository, '.git/index')), originalIndex)
      assert.deepEqual(await fs.readFile(path.join(repository, '.git/config')), originalConfig)
      assert.equal(await gitFixture(repository, ['rev-parse', 'HEAD']), originalHEAD)
    }
  )
  await check(
    'create refuses positions inside source repository and existing target directories',
    async () => {
      let state = await capture()
      const refId = state.metadata.branches.find((item) => item.current).refId
      await assert.rejects(
        worktrees.execute(
          state.context,
          action(state, 'create-worktree', { name: 'inside', refId }),
          repository
        ),
        /原仓库之外/
      )
      await fs.mkdir(path.join(targets, 'existing'))
      await fs.writeFile(path.join(targets, 'existing/user.txt'), 'keep\n')
      state = await capture()
      await assert.rejects(
        worktrees.execute(
          state.context,
          action(state, 'create-worktree', {
            name: 'existing',
            refId: state.metadata.branches.find((item) => item.current).refId
          }),
          targets
        ),
        /已经存在/
      )
      assert.equal(await fs.readFile(path.join(targets, 'existing/user.txt'), 'utf8'), 'keep\n')
    }
  )
  await check('remove refuses actual tracked dirty bytes', async () => {
    await fs.writeFile(path.join(ownedPath, 'file.txt'), 'dirty user bytes\n')
    const state = await capture()
    const item = state.metadata.worktrees.find(
      (item) => path.resolve(item.path) === path.resolve(ownedPath)
    )
    await assert.rejects(
      worktrees.execute(
        state.context,
        action(state, 'remove-worktree', { worktreeId: item.worktreeId })
      ),
      /未提交改动/
    )
    assert.equal(await fs.readFile(path.join(ownedPath, 'file.txt'), 'utf8'), 'dirty user bytes\n')
    await fs.writeFile(path.join(ownedPath, 'file.txt'), 'tracked original\n')
  })
  await check('remove refuses ignored files even when Git status is clean', async () => {
    await fs.writeFile(path.join(ownedPath, 'ignored.txt'), 'ignored user data\n')
    assert.equal(await gitFixture(ownedPath, ['status', '--porcelain']), '')
    const state = await capture()
    const item = state.metadata.worktrees.find(
      (item) => path.resolve(item.path) === path.resolve(ownedPath)
    )
    await assert.rejects(
      worktrees.execute(
        state.context,
        action(state, 'remove-worktree', { worktreeId: item.worktreeId })
      ),
      /忽略文件/
    )
    assert.equal(
      await fs.readFile(path.join(ownedPath, 'ignored.txt'), 'utf8'),
      'ignored user data\n'
    )
    await fs.unlink(path.join(ownedPath, 'ignored.txt'))
  })
  await check('remove refuses current worktree and preserves locked registration', async () => {
    let state = await capture(ownedPath)
    const current = state.metadata.worktrees.find((item) => item.current)
    await assert.rejects(
      worktrees.execute(
        state.context,
        action(state, 'remove-worktree', { worktreeId: current.worktreeId })
      ),
      /当前工作树/
    )
    const metadataPath = (await fs.readFile(path.join(ownedPath, '.git'), 'utf8')).trim().slice(8)
    await fs.writeFile(path.join(metadataPath, 'locked'), 'user lock\n')
    state = await capture()
    const item = state.metadata.worktrees.find(
      (item) => path.resolve(item.path) === path.resolve(ownedPath)
    )
    await assert.rejects(
      worktrees.execute(
        state.context,
        action(state, 'remove-worktree', { worktreeId: item.worktreeId })
      ),
      /已锁定/
    )
    assert.equal(await fs.readFile(path.join(metadataPath, 'locked'), 'utf8'), 'user lock\n')
    await fs.unlink(path.join(metadataPath, 'locked'))
  })
  const external = path.join(targets, 'external')
  await check(
    'unknown worktrees and forged repository manifests cannot grant removal ownership',
    async () => {
      await gitFixture(repository, ['worktree', 'add', '-b', 'external', external, 'main'])
      const metadataPath = (await fs.readFile(path.join(external, '.git'), 'utf8')).trim().slice(8)
      await fs.writeFile(
        path.join(metadataPath, 'zonecodex-owned.json'),
        JSON.stringify({ version: 1, target: external, owner: 'ZoneCodex' })
      )
      const state = await capture()
      const item = state.metadata.worktrees.find(
        (item) => path.resolve(item.path) === path.resolve(external)
      )
      await assert.rejects(
        worktrees.execute(
          state.context,
          action(state, 'remove-worktree', { worktreeId: item.worktreeId })
        ),
        /不是本功能/
      )
      assert.equal(await fs.readFile(path.join(external, 'file.txt'), 'utf8'), 'tracked original\n')
    }
  )
  await check(
    'metadata exposes create and owned remove capabilities without creating registry files',
    async () => {
      const state = await capture()
      const before = await fs.readdir(path.join(evidence, 'registry'))
      const metadata = await worktrees.metadata(state.context, state.metadata)
      assert.equal(
        metadata.capabilities.find((item) => item.name === 'create-worktree').available,
        true
      )
      assert.equal(
        metadata.capabilities.find((item) => item.name === 'remove-worktree').available,
        true
      )
      assert.deepEqual(await fs.readdir(path.join(evidence, 'registry')), before)
    }
  )
  await check(
    'remove clean owned tree retires registration and registry while preserving branch and unknown tree',
    async () => {
      const state = await capture()
      const item = state.metadata.worktrees.find(
        (item) => path.resolve(item.path) === path.resolve(ownedPath)
      )
      const result = await worktrees.execute(
        state.context,
        action(state, 'remove-worktree', { worktreeId: item.worktreeId })
      )
      assert.equal(result.outcome, 'success')
      assert.equal(await fs.stat(ownedPath).catch(() => null), null)
      assert.equal(await gitFixture(repository, ['rev-parse', 'codex/alpha']), originalHEAD)
      assert.equal(await fs.readFile(path.join(external, 'file.txt'), 'utf8'), 'tracked original\n')
      assert.deepEqual(await fs.readdir(path.join(evidence, 'registry')), [])
      assert.deepEqual(await fs.readFile(path.join(repository, '.git/index')), originalIndex)
      assert.deepEqual(await fs.readFile(path.join(repository, '.git/config')), originalConfig)
      assert.equal(await gitFixture(repository, ['rev-parse', 'HEAD']), originalHEAD)
    }
  )
  await check('pre-start cancellation creates no worktree, branch or registration', async () => {
    const state = await capture()
    const refId = state.metadata.branches.find((item) => item.current).refId
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      worktrees.execute(
        state.context,
        action(state, 'create-worktree', { name: 'cancelled', refId }),
        targets,
        controller.signal
      ),
      /取消/
    )
    assert.equal(await fs.stat(path.join(targets, 'cancelled')).catch(() => null), null)
    assert.equal(
      await fs.stat(path.join(repository, '.git/refs/heads/codex/cancelled')).catch(() => null),
      null
    )
  })
  await check(
    'explicit valid branch prefix creates a removable owned tree and invalid ref prefix is rejected',
    async () => {
      let state = await capture()
      let refId = state.metadata.branches.find((item) => item.current).refId
      await assert.rejects(
        worktrees.execute(
          state.context,
          action(state, 'create-worktree', { name: 'bad-prefix', refId, branchPrefix: '../' }),
          targets
        ),
        /名称不支持|退出/
      )
      assert.equal(await fs.stat(path.join(targets, 'bad-prefix')).catch(() => null), null)
      const result = await worktrees.execute(
        state.context,
        action(state, 'create-worktree', { name: 'custom-prefix', refId, branchPrefix: 'review/' }),
        targets
      )
      assert.equal(result.outcome, 'success')
      const target = path.join(targets, 'custom-prefix')
      assert.equal(await gitFixture(target, ['branch', '--show-current']), 'review/custom-prefix')
      state = await capture()
      const item = state.metadata.worktrees.find(
        (item) => path.resolve(item.path) === path.resolve(target)
      )
      assert.equal(
        (
          await worktrees.execute(
            state.context,
            action(state, 'remove-worktree', { worktreeId: item.worktreeId })
          )
        ).outcome,
        'success'
      )
      assert.equal(await fs.stat(target).catch(() => null), null)
      assert.equal(
        await gitFixture(repository, ['rev-parse', 'review/custom-prefix']),
        originalHEAD
      )
    }
  )
  await check(
    'all product commands execute in owned caches and every spawned process closed',
    async () => {
      const writes = new Set(['read-tree', 'checkout-index'])
      for (const event of productEvents.filter((event) => event.event === 'spawn')) {
        if (event.args.some((arg) => writes.has(arg))) assert(event.cwd.startsWith(cacheRoot))
        assert(productEvents.some((closed) => closed.event === 'close' && closed.pid === event.pid))
      }
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
        implementationUUID: '49d0ef00-bfaf-4bb7-82aa-7e89cef59388',
        evidence,
        pass: !failed,
        checks,
        identities,
        layers: {
          actualGit: true,
          actualDisk: true,
          actualCatalog: true,
          actualElectron: false,
          actualModel: false,
          sourceRepositoryGitWrites: false,
          fixtureGitWrites: 'only new UUID material repository and its targets',
          registry: 'new UUID material only'
        },
        fixtureEvents,
        productEvents
      },
      null,
      2
    )
  )
  console.log(evidence)
}
if (failed) throw failed
