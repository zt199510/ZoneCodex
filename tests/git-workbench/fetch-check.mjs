import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { createEvidence, checksFor, compile, runProcess, assertOwnedPath } from './runtime.mjs'
import { findFixtureGit } from '../lesson61/materials.mjs'
import { diskIdentity, verifyProcessRetirement } from '../lesson61/runtime.mjs'

const evidence = await createEvidence('fetch-native')
const harness = checksFor(evidence, {
  actualGit: true,
  actualDisk: true,
  actualElectron: false,
  actualNetworkTransport: false,
  controlledTransport:
    'Internal runner replaces captured production HTTPS URL with this new UUID local bare repository. Git processes, received objects, refs and disk checks are real; no Internet server is contacted.',
  fixtureGitWrites:
    'Only newly created UUID evidence fixture repositories; no project or user repositories are written.'
})
const { api, sourceHashes, compiledSHA256 } = await compile(evidence, [
  'src/main/git/git-reader.ts',
  'src/main/git/git-workbench-reader.ts',
  'src/main/git/git-workbench-fetch.ts',
  'src/main/git/git-process.ts',
  'src/shared/git-workbench.ts'
])
const git = await findFixtureGit()
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
      'protocol.file.allow=always',
      '-c',
      'user.name=Fetch Fixture',
      '-c',
      'user.email=fetch@example.invalid',
      ...args
    ],
    { cwd: directory, env: environment },
    15000
  )
  preparation.push(result)
  assert.equal(result.exitCode, 0, result.stderr)
  return result.stdout.trim()
}
const seed = assertOwnedPath(evidence, path.join(evidence, 'seed'))
const remote = assertOwnedPath(evidence, path.join(evidence, 'remote.git'))
await fs.mkdir(seed, { recursive: true })
await prepare(seed, ['init', '--initial-branch=main'])
await fs.writeFile(path.join(seed, 'tracked.txt'), 'initial\n')
await prepare(seed, ['add', '--all'])
await prepare(seed, ['commit', '-m', 'initial'])
const initial = await prepare(seed, ['rev-parse', 'HEAD'])
await prepare(seed, ['clone', '--bare', seed, remote])
await fs.writeFile(path.join(seed, 'tracked.txt'), 'advanced\n')
await fs.writeFile(path.join(seed, 'remote-only.txt'), 'received object\n')
await prepare(seed, ['add', '--all'])
await prepare(seed, ['commit', '-m', 'advanced'])
const advanced = await prepare(seed, ['rev-parse', 'HEAD'])
await prepare(seed, ['push', remote, 'main'])
await prepare(seed, ['push', remote, 'main:refs/heads/中文分支'])
const productionURL = 'https://example.invalid/reference.git'
const observations = []
const actualFetchRequests = []
const syntheticSecurityObservations = []
const reader = api.createGitReader({
  cacheRoot: path.join(evidence, 'reader-cache'),
  onProcess: (event) => observations.push({ ...event, atUTC: new Date().toISOString() })
})
const workbench = api.createGitWorkbenchReader({
  onProcess: (event) => observations.push({ ...event, atUTC: new Date().toISOString() })
})
const views = []
let fixtureCounter = 0
async function fixture() {
  const directory = assertOwnedPath(evidence, path.join(evidence, 'source-' + ++fixtureCounter))
  await fs.mkdir(directory, { recursive: true })
  await prepare(directory, ['init', '--initial-branch=main'])
  await prepare(directory, ['fetch', remote, initial])
  await prepare(directory, ['reset', '--hard', initial])
  await prepare(directory, ['update-ref', 'refs/remotes/origin/main', initial])
  await prepare(directory, ['remote', 'add', 'origin', productionURL])
  await prepare(directory, ['config', 'branch.main.remote', 'origin'])
  await prepare(directory, ['config', 'branch.main.merge', 'refs/heads/main'])
  const view = await reader.open(directory)
  views.push(view)
  const metadata = await workbench.metadata(view)
  const context = await workbench.context(view, metadata.revision)
  const remoteId = metadata.remotes.find((item) => item.name === 'origin').remoteId
  return { directory, view, metadata, context, remoteId }
}
function controlled({ after, forcePack = false, bareRemote = remote } = {}) {
  return api.createGitWorkbenchFetcher({
    onProcess: (event) => observations.push({ ...event, atUTC: new Date().toISOString() }),
    run: async (options) => {
      const original = [...options.args]
      let actual = options
      if (original.includes('fetch')) {
        assert(original.includes(productionURL))
        assert.equal(options.env.GIT_ALLOW_PROTOCOL, 'https')
        assert.equal(options.env.GIT_TERMINAL_PROMPT, '0')
        assert(!original.some((arg) => /authorization|token/i.test(arg)))
        actualFetchRequests.push({ args: original, cwd: options.cwd, url: productionURL })
        const args = original.map((arg) =>
          arg === productionURL
            ? pathToFileURL(bareRemote).href
            : forcePack && /^(fetch|transfer)\.unpackLimit=/.test(arg)
              ? arg.replace(/=.+$/, '=1')
              : arg
        )
        actual = { ...options, args, env: { ...options.env, GIT_ALLOW_PROTOCOL: 'file' } }
      }
      const output = await api.runGitProcess(actual)
      await after?.(original, output)
      return output
    }
  })
}
function allowedFetchWrites(name) {
  return (
    name === '.git/FETCH_HEAD' ||
    name.startsWith('.git/objects/') ||
    name === '.git/refs/remotes/origin/中文分支' ||
    name === '.git/refs/remotes/origin/main'
  )
}
function preserved(before, after) {
  for (const [name, identity] of Object.entries(before))
    if (!allowedFetchWrites(name) || name.startsWith('.git/objects/'))
      assert.deepEqual(after[name], identity, name + ' is preserved')
  for (const name of Object.keys(after))
    if (!(name in before)) assert(allowedFetchWrites(name), 'Unexpected new source entry ' + name)
}
function validResult(result, view) {
  assert(
    api.parseGitActionResult({
      requestId: randomUUID(),
      viewId: view.info.viewId,
      status: 'ready',
      data: result
    })
  )
}

function credentialErrorFixture() {
  const token = 'fetch-auth-fixture-' + randomUUID()
  const decoded = 'x-access-token:' + token
  const encoded = Buffer.from(decoded).toString('base64')
  const header = 'Authorization: Basic ' + encoded
  const env = {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.' + productionURL + '.extraHeader',
    GIT_CONFIG_VALUE_0: header
  }
  const secrets = [token, decoded, encoded, 'Basic ' + encoded, header]
  const message =
    'synthetic fetch stderr ' + token + ' | ' + header + ' | ' + encoded + ' | ' + decoded
  return { env, secrets, message }
}
function assertCredentialHidden(value, secrets) {
  const output = typeof value === 'string' ? value : JSON.stringify(value)
  for (const secret of secrets)
    assert(!output.includes(secret), 'Request-local credential form must be hidden')
}
async function rejectedFetch(action) {
  try {
    await action()
  } catch (error) {
    return error
  }
  assert.fail('Expected a rejected fetch')
}

try {
  await harness.check(
    'real controlled fetch publishes verified objects, refs and FETCH_HEAD while source HEAD/index/config/worktree are unchanged',
    async () => {
      const f = await fixture()
      const before = await diskIdentity(f.directory)
      const result = await controlled()(f.context, f.remoteId)
      validResult(result, f.view)
      assert.equal(result.outcome, 'success', result.message)
      assert.equal(
        await fs.readFile(path.join(f.directory, '.git/refs/remotes/origin/main'), 'utf8'),
        advanced + '\n'
      )
      assert.equal(
        await fs.readFile(path.join(f.directory, '.git/refs/remotes/origin/中文分支'), 'utf8'),
        advanced + '\n'
      )
      const fetchHead = await fs.readFile(path.join(f.directory, '.git/FETCH_HEAD'), 'utf8')
      assert(
        fetchHead.includes(advanced) &&
          fetchHead.includes('中文分支') &&
          fetchHead.includes(productionURL)
      )
      preserved(before, await diskIdentity(f.directory))
      assert.equal(
        await prepare(f.directory, ['cat-file', '-p', advanced]),
        await prepare(seed, ['cat-file', '-p', advanced])
      )
      await assert.rejects(
        workbench.context(f.view, f.metadata.revision),
        (error) => error.status === 'stale'
      )
      await reader.refresh(f.view)
      const metadata = await workbench.metadata(f.view)
      assert.equal(metadata.branch, 'main')
      assert.equal(metadata.headSha, initial)
      assert.equal(metadata.ahead, 0)
      assert.equal(metadata.behind, 1)
      return { outcome: result.outcome, head: initial, fetched: advanced, behind: metadata.behind }
    }
  )
  await harness.check(
    'received real transport pack is strictly verified and converted into publishable loose objects',
    async () => {
      const f = await fixture()
      const start = observations.length
      const before = await diskIdentity(f.directory)
      const result = await controlled({ forcePack: true })(f.context, f.remoteId)
      assert.equal(result.outcome, 'success', result.message)
      const actual = observations.slice(start).filter((event) => event.event === 'spawn')
      assert(actual.some((event) => event.args.includes('index-pack')))
      assert(actual.some((event) => event.args.includes('unpack-objects')))
      preserved(before, await diskIdentity(f.directory))
      return { actualPackVerification: true, actualUnpack: true }
    }
  )
  await harness.check(
    'forced remote rewind uses captured source CAS and leaves local branch untouched',
    async () => {
      const f = await fixture()
      await prepare(f.directory, ['fetch', remote, advanced])
      await prepare(f.directory, ['update-ref', 'refs/remotes/origin/main', advanced])
      await reader.refresh(f.view)
      f.metadata = await workbench.metadata(f.view)
      f.context = await workbench.context(f.view, f.metadata.revision)
      f.remoteId = f.metadata.remotes.find((item) => item.name === 'origin').remoteId
      await prepare(remote, ['update-ref', 'refs/heads/main', initial])
      try {
        const before = await diskIdentity(f.directory)
        const result = await controlled()(f.context, f.remoteId)
        assert.equal(result.outcome, 'success', result.message)
        assert.equal(
          await fs.readFile(path.join(f.directory, '.git/refs/remotes/origin/main'), 'utf8'),
          initial + '\n'
        )
        preserved(before, await diskIdentity(f.directory))
      } finally {
        await prepare(remote, ['update-ref', 'refs/heads/main', advanced])
      }
    }
  )
  await harness.check(
    'deleted server branch is not falsely listed in current FETCH_HEAD and existing tracking branch is preserved',
    async () => {
      const f = await fixture()
      await prepare(f.directory, ['update-ref', 'refs/remotes/origin/deleted-on-server', initial])
      await reader.refresh(f.view)
      f.metadata = await workbench.metadata(f.view)
      f.context = await workbench.context(f.view, f.metadata.revision)
      f.remoteId = f.metadata.remotes.find((item) => item.name === 'origin').remoteId
      const oldRef = await fs.readFile(
        path.join(f.directory, '.git/refs/remotes/origin/deleted-on-server')
      )
      const result = await controlled()(f.context, f.remoteId)
      assert.equal(result.outcome, 'success', result.message)
      assert.deepEqual(
        await fs.readFile(path.join(f.directory, '.git/refs/remotes/origin/deleted-on-server')),
        oldRef
      )
      assert(
        !(await fs.readFile(path.join(f.directory, '.git/FETCH_HEAD'), 'utf8')).includes(
          'deleted-on-server'
        )
      )
    }
  )
  await harness.check(
    'empty real remote publishes an empty current FETCH_HEAD and preserves tracking refs',
    async () => {
      const f = await fixture()
      const emptyRemote = assertOwnedPath(evidence, path.join(evidence, 'empty-remote.git'))
      await fs.mkdir(emptyRemote)
      await prepare(emptyRemote, ['init', '--bare', '--initial-branch=main'])
      const before = await diskIdentity(f.directory)
      const result = await controlled({ bareRemote: emptyRemote })(f.context, f.remoteId)
      assert.equal(result.outcome, 'success', result.message)
      assert(result.message.includes('0 个分支'))
      assert.equal(await fs.readFile(path.join(f.directory, '.git/FETCH_HEAD'), 'utf8'), '')
      assert.equal(
        await fs.readFile(path.join(f.directory, '.git/refs/remotes/origin/main'), 'utf8'),
        initial + '\n'
      )
      preserved(before, await diskIdentity(f.directory))
    }
  )
  await harness.check(
    'received object store over the existing 128 MiB cap rejects before source publication',
    async () => {
      const f = await fixture()
      const before = await diskIdentity(f.directory)
      const fetch = controlled({
        after: async (args) => {
          if (!args.includes('fetch')) return
          const lastRequest = actualFetchRequests.at(-1)
          const filename = path.join(
            path.dirname(lastRequest.cwd),
            'git/objects/oversized-received-fixture'
          )
          const handle = await fs.open(filename, 'wx')
          try {
            await handle.truncate(128 * 1024 * 1024 + 1)
          } finally {
            await handle.close()
          }
        }
      })
      await assert.rejects(fetch(f.context, f.remoteId), (error) => error.status === 'too-large')
      assert.deepEqual(await diskIdentity(f.directory), before)
    }
  )
  await harness.check(
    'unknown remote, unsafe URL, subtree scope and malformed auth header reject before process or source writes',
    async () => {
      const f = await fixture()
      const before = await diskIdentity(f.directory)
      const start = actualFetchRequests.length
      const fetch = controlled()
      await assert.rejects(fetch(f.context, randomUUID()), (error) => error.status === 'stale')
      for (const url of [
        'file:///C:/repo',
        'https://user:pass@example.invalid/repo',
        'https://example.invalid/repo?token=x',
        'http://example.invalid/repo'
      ]) {
        const context = {
          ...f.context,
          remotes: new Map([[f.remoteId, { ...f.context.remotes.get(f.remoteId), url }]])
        }
        await assert.rejects(fetch(context, f.remoteId), (error) => error.status === 'unsupported')
      }
      await assert.rejects(
        fetch(
          { ...f.context, location: { ...f.context.location, scopePath: 'subtree' } },
          f.remoteId
        ),
        (error) => error.status === 'unsupported'
      )
      await assert.rejects(
        fetch(f.context, f.remoteId, {
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'http.https://other.invalid/.extraHeader',
          GIT_CONFIG_VALUE_0: 'Authorization: Basic eDp5'
        }),
        (error) => error.status === 'unsupported'
      )
      assert.equal(actualFetchRequests.length, start)
      assert.deepEqual(await diskIdentity(f.directory), before)
    }
  )
  await harness.check(
    'fresh source identity check rejects an old view before fetching or publishing',
    async () => {
      const f = await fixture()
      await fs.writeFile(path.join(f.directory, 'tracked.txt'), 'concurrent user edit\n')
      const before = await diskIdentity(f.directory)
      const start = actualFetchRequests.length
      await assert.rejects(controlled()(f.context, f.remoteId), (error) => error.status === 'stale')
      assert.equal(actualFetchRequests.length, start)
      assert.deepEqual(await diskIdentity(f.directory), before)
    }
  )
  await harness.check(
    'concurrent remote ref update is retained and publication reports partial-success instead of overriding it',
    async () => {
      const f = await fixture()
      const ref = path.join(f.directory, '.git/refs/remotes/origin/main')
      const oldFetchHead = await fs.readFile(path.join(f.directory, '.git/FETCH_HEAD'))
      const rival = advanced
      const fetch = controlled({
        after: async (args) => {
          if (args.includes('fsck')) await fs.writeFile(ref, rival + '\n')
        }
      })
      const result = await fetch(f.context, f.remoteId)
      validResult(result, f.view)
      assert.equal(result.outcome, 'partial-success', result.message)
      assert.equal(await fs.readFile(ref, 'utf8'), rival + '\n')
      await assert.rejects(fs.stat(ref + '.lock'), { code: 'ENOENT' })
      assert.deepEqual(await fs.readFile(path.join(f.directory, '.git/FETCH_HEAD')), oldFetchHead)
      return result
    }
  )
  await harness.check(
    'foreign FETCH_HEAD lock is preserved and real fetched ref publication is reported as partial-success',
    async () => {
      const f = await fixture()
      const lock = path.join(f.directory, '.git/FETCH_HEAD.lock')
      const fetch = controlled({
        after: async (args) => {
          if (args.includes('fsck')) await fs.writeFile(lock, 'foreign owner\n', { flag: 'wx' })
        }
      })
      const result = await fetch(f.context, f.remoteId)
      assert.equal(result.outcome, 'partial-success', result.message)
      assert.equal(result.stage, 'fetch-refs')
      assert.equal(await fs.readFile(lock, 'utf8'), 'foreign owner\n')
      assert.equal(
        await fs.readFile(path.join(f.directory, '.git/refs/remotes/origin/main'), 'utf8'),
        advanced + '\n'
      )
      return result
    }
  )
  await harness.check(
    'cancellation after received real objects but before publication leaves source completely unchanged',
    async () => {
      const f = await fixture()
      const before = await diskIdentity(f.directory)
      const controller = new AbortController()
      const fetch = controlled({
        after: async (args) => {
          if (args.includes('fsck')) controller.abort()
        }
      })
      await assert.rejects(
        fetch(f.context, f.remoteId, {}, controller.signal),
        (error) => error.status === 'cancelled'
      )
      assert.deepEqual(await diskIdentity(f.directory), before)
    }
  )
  await harness.check(
    'real publication plus synthetic cache cleanup failure retains partial-success and exact diagnostic copy',
    async () => {
      const f = await fixture()
      const before = await diskIdentity(f.directory)
      const originalRemove = fs.rm
      let retained
      fs.rm = async (filename, options) => {
        if (path.basename(filename).startsWith('fetch-')) {
          retained = filename
          throw Object.assign(new Error('synthetic cleanup busy'), { code: 'EBUSY' })
        }
        return originalRemove(filename, options)
      }
      try {
        const result = await controlled()(f.context, f.remoteId)
        validResult(result, f.view)
        assert.equal(result.outcome, 'partial-success', result.message)
        assert.equal(result.stage, 'fetch-cleanup')
        assert.equal(
          await fs.readFile(path.join(f.directory, '.git/refs/remotes/origin/main'), 'utf8'),
          advanced + '\n'
        )
        assert((await fs.stat(retained)).isDirectory())
        preserved(before, await diskIdentity(f.directory))
        return { actualPublication: true, syntheticCleanupFailure: true, result, retained }
      } finally {
        fs.rm = originalRemove
        if (retained)
          await fs.rm(assertOwnedPath(evidence, retained), { recursive: true, force: true })
      }
    }
  )
  await harness.check(
    'synthetic authenticated fetch error is redacted before first public rejection and observations retain no environment or stderr',
    async () => {
      const f = await fixture()
      const before = await diskIdentity(f.directory)
      const credential = credentialErrorFixture()
      const records = []
      let calls = 0,
        environmentReference
      const fetch = api.createGitWorkbenchFetcher({
        onProcess: (event) => records.push({ ...event }),
        run: async (options) => {
          calls++
          environmentReference = options.env
          assert.equal(options.env.GIT_CONFIG_VALUE_0, credential.env.GIT_CONFIG_VALUE_0)
          options.onProcess?.({
            event: 'spawn',
            executable: options.executable,
            args: [...options.args],
            cwd: options.cwd
          })
          options.onProcess?.({
            event: 'close',
            executable: options.executable,
            args: [...options.args],
            cwd: options.cwd,
            code: 1
          })
          throw new api.GitReadError('error', credential.message)
        }
      })
      const error = await rejectedFetch(() => fetch(f.context, f.remoteId, credential.env))
      assert.equal(error.status, 'error')
      assertCredentialHidden(error.message, credential.secrets)
      assert(error.message.includes('[凭据已隐藏]'))
      assert.equal(calls, 1)
      assert.equal(environmentReference.GIT_CONFIG_VALUE_0, undefined)
      assertCredentialHidden(records, credential.secrets)
      assert(
        records.every((event) => !Object.hasOwn(event, 'env') && !Object.hasOwn(event, 'stderr'))
      )
      assert.deepEqual(await diskIdentity(f.directory), before)
      syntheticSecurityObservations.push({
        case: 'first-error',
        syntheticRunner: true,
        actualChild: false,
        events: records
      })
      return {
        syntheticRunner: true,
        actualNetwork: false,
        errorStatus: error.status,
        redactedMessage: error.message,
        observedEvents: records.length
      }
    }
  )
  await harness.check(
    'synthetic unknown-exit fetch retains diagnostic copy but stores only redacted blocked error and refuses later factories without another process',
    async () => {
      const f = await fixture()
      const before = await diskIdentity(f.directory)
      const credential = credentialErrorFixture()
      const records = []
      let calls = 0,
        environmentReference,
        retained
      const fetch = api.createGitWorkbenchFetcher({
        onProcess: (event) => records.push({ ...event }),
        run: async (options) => {
          calls++
          environmentReference = options.env
          assert.equal(options.env.GIT_CONFIG_VALUE_0, credential.env.GIT_CONFIG_VALUE_0)
          options.onProcess?.({
            event: 'unconfirmed',
            executable: options.executable,
            args: [...options.args],
            cwd: options.cwd
          })
          throw new api.GitReadError('error', 'Git 进程退出未确认；' + credential.message)
        }
      })
      try {
        const first = await rejectedFetch(() => fetch(f.context, f.remoteId, credential.env))
        assert.equal(first.status, 'error')
        assert(first.message.includes('退出未确认'))
        assertCredentialHidden(first.message, credential.secrets)
        assert.equal(environmentReference.GIT_CONFIG_VALUE_0, undefined)
        const laterFactory = api.createGitWorkbenchFetcher({
          run: async () => {
            calls++
            assert.fail('A blocked repository must not start another process')
          }
        })
        const later = await rejectedFetch(() => laterFactory(f.context, f.remoteId))
        assert.equal(later.status, 'error')
        assert.equal(later.message, first.message)
        assertCredentialHidden(later.message, credential.secrets)
        assert.equal(calls, 1)
        assertCredentialHidden(records, credential.secrets)
        assert(
          records.every((event) => !Object.hasOwn(event, 'env') && !Object.hasOwn(event, 'stderr'))
        )
        assert.deepEqual(await diskIdentity(f.directory), before)
        const copies = (await fs.readdir(path.join(evidence, 'reader-cache'))).filter((name) =>
          name.startsWith('fetch-')
        )
        assert.equal(copies.length, 1)
        retained = assertOwnedPath(evidence, path.join(evidence, 'reader-cache', copies[0]))
        assert((await fs.stat(retained)).isDirectory())
        async function checkDiagnostic(directory) {
          for (const name of await fs.readdir(directory)) {
            const filename = path.join(directory, name),
              stat = await fs.lstat(filename)
            if (stat.isDirectory()) await checkDiagnostic(filename)
            else if (stat.isFile())
              assertCredentialHidden(
                (await fs.readFile(filename)).toString('utf8'),
                credential.secrets
              )
          }
        }
        await checkDiagnostic(retained)
        syntheticSecurityObservations.push({
          case: 'unknown-exit-blocked',
          syntheticRunner: true,
          actualChild: false,
          events: records
        })
        return {
          syntheticRunner: true,
          actualNetwork: false,
          firstMessage: first.message,
          laterBlockedMessage: later.message,
          runnerCalls: calls,
          diagnosticCopyRetained: true,
          retained,
          explicitFixtureCleanupAfterSyntheticNoChild: true
        }
      } finally {
        // The seam never spawned a child. Only this new UUID diagnostic fixture is removed.
        // Product unknown-exit cleanup still retains its copy until host recovery.
        if (retained) await fs.rm(retained, { recursive: true, force: true })
      }
    }
  )
  await harness.check(
    'Git process ownership includes only the existing fixed source-root probe; fetch processes use owned cache, close and clean all copies',
    async () => {
      const spawns = observations.filter((event) => event.event === 'spawn')
      const closes = observations.filter((event) => event.event === 'close')
      assert(spawns.length > 0)
      assert.equal(spawns.length, closes.length)
      assert(!observations.some((event) => event.event === 'unconfirmed'))
      const sourceRootProbes = []
      for (const event of spawns) {
        const cwd = path.resolve(event.cwd)
        const cache = path.join(evidence, 'reader-cache')
        if (cwd.startsWith(cache + path.sep) || cwd === cache) continue
        assert(cwd.startsWith(path.join(evidence, 'source-')))
        assert.deepEqual(event.args, ['--no-optional-locks', 'rev-parse', '--show-toplevel'])
        sourceRootProbes.push({ cwd, args: event.args })
      }
      await verifyProcessRetirement(
        closes.map((event) => ({
          pid: event.pid,
          executable: event.executable,
          closedAtUTC: event.atUTC
        }))
      )
      const retained = (await fs.readdir(path.join(evidence, 'reader-cache'))).filter((name) =>
        name.startsWith('fetch-')
      )
      assert.deepEqual(retained, [])
      return {
        spawns: spawns.length,
        closes: closes.length,
        sourceRootProbes,
        retainedFetchCopies: retained
      }
    }
  )
} finally {
  for (const view of views) await reader.dispose(view)
  await fs.writeFile(path.join(evidence, 'processes.json'), JSON.stringify(observations, null, 2))
  await fs.writeFile(
    path.join(evidence, 'production-fetch-requests.json'),
    JSON.stringify(actualFetchRequests, null, 2)
  )
  await fs.writeFile(path.join(evidence, 'preparation.json'), JSON.stringify(preparation, null, 2))
  await fs.writeFile(
    path.join(evidence, 'synthetic-security-observations.json'),
    JSON.stringify(syntheticSecurityObservations, null, 2)
  )
  await harness.finish({ sourceHashes, compiledSHA256 })
}
