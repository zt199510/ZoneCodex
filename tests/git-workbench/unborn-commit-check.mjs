import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  createEvidence,
  checksFor,
  compile,
  runProcess,
  assertOwnedPath,
  root,
  hash
} from './runtime.mjs'
import { findFixtureGit } from '../lesson61/materials.mjs'
import { diskIdentity } from '../lesson61/runtime.mjs'

const evidence = await createEvidence('unborn-commit-native')
const suite = checksFor(evidence, {
  implementationUUID: '49d0ef00-bfaf-4bb7-82aa-7e89cef59388',
  actualGit: true,
  actualDisk: true,
  actualElectron: false,
  actualModel: false,
  fixtureGitWrites: 'Only new UUID material repositories'
})
const { api, sourceHashes, compiledSHA256 } = await compile(evidence, [
  'src/main/git/git-reader.ts',
  'src/main/git/git-workbench-writer.ts'
])
const git = await findFixtureGit(),
  empty = path.join(evidence, 'empty.config')
await fs.writeFile(empty, '')
const program = { executable: git, sha256: hash(await fs.readFile(git)) }
const environment = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: empty,
  GIT_TERMINAL_PROMPT: '0',
  GIT_NO_LAZY_FETCH: '1'
}
const preparations = [],
  events = [],
  views = []
const reader = api.createGitReader({
  cacheRoot: path.join(root, '.ui-check/git-unborn-cache-' + randomUUID()),
  onProcess: (event) => events.push(event)
})
const writer = api.createGitWorkbenchWriter({ onProcess: (event) => events.push(event) })
async function prepare(directory, args) {
  assertOwnedPath(evidence, directory)
  const result = await runProcess(
    git,
    [
      '--no-optional-locks',
      '-c',
      'core.autocrlf=false',
      '-c',
      'user.name=Unborn Fixture',
      '-c',
      'user.email=unborn@example.invalid',
      ...args
    ],
    { cwd: directory, env: environment },
    15000
  )
  preparations.push(result)
  assert.equal(result.exitCode, 0, result.stderr)
  return result.stdout.trim()
}
async function repository(name) {
  const directory = assertOwnedPath(evidence, path.join(evidence, name))
  await fs.mkdir(directory)
  await prepare(directory, ['init', '--initial-branch=main'])
  await prepare(directory, ['config', 'core.autocrlf', 'false'])
  return directory
}
async function context(directory) {
  const view = await reader.open(directory)
  views.push(view)
  await reader.refresh(view)
  return {
    location: view.location,
    snapshot: view.snapshot,
    program,
    refs: new Map(),
    identity: { name: 'Manual Unborn', email: 'manual-unborn@example.invalid' }
  }
}
const commit = (context, includeUnstaged) => ({
  requestId: randomUUID(),
  viewId: randomUUID(),
  revision: context.snapshot.revision,
  action: 'commit',
  message: 'explicit first commit',
  includeUnstaged
})
try {
  await suite.check(
    'an empty unborn repository rejects both commit modes without original objects, index or HEAD changes',
    async () => {
      const directory = await repository('empty')
      for (const includeUnstaged of [false, true]) {
        const current = await context(directory),
          before = await diskIdentity(directory),
          count = events.length
        await assert.rejects(
          writer.execute(current, commit(current, includeUnstaged)),
          /没有可提交的改动/
        )
        assert.deepEqual(await diskIdentity(directory), before)
        assert(
          !events
            .slice(count)
            .some((event) => event.event === 'spawn' && event.args.includes('commit-tree'))
        )
      }
    }
  )
  await suite.check(
    'untracked data alone cannot create a staged-only first commit; explicit include-unstaged commits it',
    async () => {
      const directory = await repository('untracked')
      await fs.writeFile(path.join(directory, 'user.txt'), 'first user bytes\n')
      let current = await context(directory),
        before = await diskIdentity(directory)
      await assert.rejects(writer.execute(current, commit(current, false)), /没有可提交的改动/)
      assert.deepEqual(await diskIdentity(directory), before)
      current = await context(directory)
      const result = await writer.execute(current, commit(current, true))
      assert.equal(result.outcome, 'success')
      assert.equal(await prepare(directory, ['show', 'HEAD:user.txt']), 'first user bytes')
      assert.equal(await prepare(directory, ['rev-list', '--count', 'HEAD']), '1')
    }
  )
  await suite.check(
    'a deliberately staged zero-byte file remains a valid nonempty first tree',
    async () => {
      const directory = await repository('zero-byte')
      await fs.writeFile(path.join(directory, 'empty.txt'), '')
      await prepare(directory, ['add', '--', 'empty.txt'])
      const current = await context(directory)
      const result = await writer.execute(current, commit(current, false))
      assert.equal(result.outcome, 'success')
      assert.equal(await prepare(directory, ['ls-tree', '--name-only', 'HEAD']), 'empty.txt')
      assert.equal(await prepare(directory, ['rev-list', '--count', 'HEAD']), '1')
    }
  )
  await suite.check('all observed product Git children close', async () => {
    const spawned = events.filter((event) => event.event === 'spawn'),
      closed = events.filter((event) => event.event === 'close')
    assert(spawned.length > 0)
    for (const child of spawned) assert(closed.some((event) => event.pid === child.pid))
    assert(!events.some((event) => event.event === 'unconfirmed'))
  })
} finally {
  for (const view of views) await reader.dispose(view).catch(() => {})
  await fs.writeFile(path.join(evidence, 'preparation.json'), JSON.stringify(preparations, null, 2))
  await fs.writeFile(path.join(evidence, 'processes.json'), JSON.stringify(events, null, 2))
  await suite.finish({ sourceHashes, compiledSHA256 })
}
