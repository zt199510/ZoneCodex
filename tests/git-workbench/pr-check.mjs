import assert from 'node:assert/strict'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import {
  createEvidence,
  compile,
  checksFor,
  root,
  hash,
  runProcess,
  delay,
  assertOwnedPath
} from './runtime.mjs'
import { findFixtureGit } from '../lesson61/materials.mjs'
import { diskIdentity, verifyProcessRetirement } from '../lesson61/runtime.mjs'

const evidence = await createEvidence('pr-native-synthetic-network')
const { api, sourceHashes, compiledSHA256 } = await compile(evidence, [
  'src/main/git/git-workbench-pr.ts',
  'src/main/git/git-reader.ts',
  'src/main/git/git-workbench-reader.ts'
])
const suite = checksFor(evidence, {
  sourceHashes,
  compiledSHA256,
  actualGit: true,
  actualDisk: true,
  realNetworking: false,
  actualGhProcess: false,
  syntheticGhRunner: true,
  actualElectron: false,
  actualModel: false,
  actualPTY: false,
  note: 'Current PR service and real Git-owned snapshot logic with a narrowly substituted gh process runner. Fake gh.exe is identity data and never executed. All Git writes are UUID fixture preparation only.'
})
const dispatcherKey = '__zonecodexPr_' + randomUUID().replaceAll('-', '')
const mock = path.join(evidence, 'gh-process-seam.ts'),
  output = path.join(evidence, 'pr-current-seam.cjs')
await fs.writeFile(
  mock,
  'export { GitReadError } from ' +
    JSON.stringify(path.join(root, 'src/main/git/git-process.ts')) +
    ';\nexport async function runGitProcess(options) { return globalThis[' +
    JSON.stringify(dispatcherKey) +
    '](options); }\n'
)
const bundle = await build({
  stdin: {
    contents:
      'export * from "./src/main/git/git-workbench-pr.ts"; export * from "./src/main/git/git-process.ts";',
    resolveDir: root
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: output,
  metafile: true,
  logLevel: 'silent',
  plugins: [
    {
      name: 'explicit-test-only-gh-seam',
      setup(builder) {
        builder.onResolve({ filter: /^\.\/git-process$/ }, ({ importer }) =>
          importer.replaceAll('\\', '/').endsWith('/git-workbench-pr.ts') ? { path: mock } : null
        )
      }
    }
  ]
})
const synthetic = createRequire(import.meta.url)(output)
const ghPath = assertOwnedPath(evidence, path.join(evidence, 'installation', 'gh.exe'))
await fs.mkdir(path.dirname(ghPath), { recursive: true })
const ghIdentity = 'Fixture identity bytes; not an executable.\n'
await fs.writeFile(ghPath, ghIdentity)
const git = await findFixtureGit()
const env = { ...process.env }
for (const key of Object.keys(env)) if (/^GIT_|^NODE_OPTIONS$|^MODEL_/i.test(key)) delete env[key]
const empty = assertOwnedPath(evidence, path.join(evidence, 'empty.config'))
await fs.writeFile(empty, '')
Object.assign(env, {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: empty,
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_NO_LAZY_FETCH: '1'
})
const preparation = [],
  events = [],
  calls = [],
  views = []
async function prepare(directory, args) {
  assertOwnedPath(evidence, directory)
  const result = await runProcess(
    git,
    [
      '--no-optional-locks',
      '-c',
      'core.hooksPath=' + path.join(evidence, 'no-hooks'),
      '-c',
      'user.name=PR Fixture',
      '-c',
      'user.email=pr@example.invalid',
      ...args
    ],
    { cwd: directory, env },
    15000
  )
  preparation.push(result)
  assert.equal(result.exitCode, 0, result.stderr)
  return result.stdout.trim()
}
const reader = api.createGitReader({
  cacheRoot: path.join(evidence, 'cache'),
  onProcess: (event) => events.push({ ...event, atUTC: new Date().toISOString() })
})
const workbench = api.createGitWorkbenchReader({
  onProcess: (event) => events.push({ ...event, atUTC: new Date().toISOString() })
})
async function fixture(url = 'https://github.com/fixture-owner/fixture-repo.git', scope = '') {
  const directory = assertOwnedPath(evidence, path.join(evidence, 'fixture-' + randomUUID()))
  await fs.mkdir(path.join(directory, 'sub'), { recursive: true })
  await prepare(directory, ['init', '--initial-branch=main'])
  await fs.writeFile(path.join(directory, 'file.txt'), 'base\n')
  await prepare(directory, ['add', '--all'])
  await prepare(directory, ['commit', '-m', 'initial'])
  const base = await prepare(directory, ['rev-parse', 'HEAD'])
  await prepare(directory, ['switch', '-c', 'feature'])
  await fs.writeFile(path.join(directory, 'file.txt'), 'feature\n')
  await prepare(directory, ['commit', '-am', 'feature'])
  await prepare(directory, ['remote', 'add', 'origin', url])
  const head = await prepare(directory, ['rev-parse', 'HEAD'])
  const view = await reader.open(scope ? path.join(directory, scope) : directory)
  views.push(view)
  const metadata = await workbench.metadata(view),
    context = await workbench.context(view, metadata.revision)
  return {
    directory,
    head,
    base,
    view,
    metadata,
    context,
    before: await diskIdentity(directory),
    remoteId: metadata.remotes[0].remoteId
  }
}
const token = 'synthetic-PR-token-' + randomUUID(),
  otherToken = 'synthetic-other-token-' + randomUUID()
let network = {},
  gate = null,
  onCall = null
function resetNetwork(f) {
  network = {
    number: 42,
    title: 'PR fixture',
    url: 'https://github.com/fixture-owner/fixture-repo/pull/42',
    state: 'OPEN',
    isDraft: false,
    headRefName: 'feature',
    baseRefName: 'main',
    author: { login: 'fixture-user' },
    body: 'Fixture body\nSecond line',
    headRefOid: f.head,
    baseRefOid: f.base,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    statusCheckRollup: [
      { name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { context: 'lint', state: 'PENDING' }
    ],
    account: 'fixture-user',
    allowMerge: true,
    allowSquash: true,
    error: null,
    merged: false,
    queue: false
  }
}
globalThis[dispatcherKey] = async (options) => {
  const entry = {
    args: [...options.args],
    cwd: options.cwd,
    executable: options.executable,
    environmentKeys: Object.keys(options.env).sort(),
    fixedHost: options.env.GH_HOST,
    transientTokenPresent: options.env.GH_TOKEN === token,
    startedAtUTC: new Date().toISOString()
  }
  calls.push(entry)
  assert.equal(options.executable, ghPath)
  assert(
    !Object.keys(options.env).some((key) =>
      /^(NODE_OPTIONS|GIT_CONFIG_COUNT|GIT_SSH_COMMAND|GH_CONFIG_DIR|MODEL_)/.test(key)
    )
  )
  assert.equal(options.env.GH_PROMPT_DISABLED, '1')
  assert.equal(options.env.GH_HOST, 'github.com')
  if (onCall) await onCall(options)
  if (gate && options.args[0] !== 'auth') await gate
  if (options.signal?.aborted) throw new synthetic.GitReadError('cancelled', 'Cancelled')
  if (options.args[0] === 'auth') {
    entry.closedAtUTC = new Date().toISOString()
    return Buffer.from(token)
  }
  if (network.error) throw new synthetic.GitReadError('error', network.error)
  let value
  if (options.args[0] === 'api' && options.args.at(-1) === 'user')
    value = { login: network.account }
  else if (options.args[0] === 'api')
    value = {
      full_name: 'fixture-owner/fixture-repo',
      allow_merge_commit: network.allowMerge,
      allow_squash_merge: network.allowSquash
    }
  else if (options.args[1] === 'list') value = [network]
  else if (options.args[1] === 'view') value = network
  else if (options.args[1] === 'merge') {
    if (!network.queue) {
      network.state = 'MERGED'
      network.merged = true
    }
    value = null
  } else assert.fail('Unexpected PR command')
  entry.closedAtUTC = new Date().toISOString()
  return value === null ? Buffer.alloc(0) : Buffer.from(JSON.stringify(value))
}
const service = () => synthetic.createGitWorkbenchPullRequests({ programCandidates: [ghPath] })
const listRequest = (f) => ({
  requestId: randomUUID(),
  viewId: f.view.info.viewId,
  revision: f.metadata.revision,
  remoteId: f.remoteId,
  state: 'open'
})
async function selected(f, pr = service()) {
  resetNetwork(f)
  const data = await pr.list(f.context, listRequest(f)),
    prId = data.items[0].prId
  const request = {
    requestId: randomUUID(),
    viewId: f.view.info.viewId,
    revision: f.metadata.revision,
    prId
  }
  const detail = await pr.detail(f.context, request)
  return {
    pr,
    request,
    detail,
    merge: { ...request, requestId: randomUUID(), prRevision: detail.prRevision, method: 'merge' }
  }
}
const f = await fixture()
await suite.check(
  'read-only list/detail use actual owned Git snapshots, pin account/repo/PR identity and normalize checks without touching source',
  async () => {
    const start = calls.length,
      chosen = await selected(f)
    assert.equal(chosen.detail.headOid, f.head)
    assert.equal(chosen.detail.baseOid, f.base)
    assert.equal(chosen.detail.account, 'fixture-user')
    assert.deepEqual(chosen.detail.checks, [
      { name: 'build', status: 'success' },
      { name: 'lint', status: 'pending' }
    ])
    assert.deepEqual(chosen.detail.mergeMethods, ['merge', 'squash'])
    assert(!calls.slice(start).some((call) => call.args[1] === 'merge'))
    assert(
      calls
        .slice(start)
        .filter((call) => call.args[0] === 'pr')
        .every((call) => call.args.includes('github.com/fixture-owner/fixture-repo'))
    )
    assert.deepEqual(await diskIdentity(f.directory), f.before)
  }
)
await suite.check(
  'list refresh keeps same opaque PR id and unchanged detail revision; release retires it',
  async () => {
    const chosen = await selected(f)
    const next = await chosen.pr.list(f.context, listRequest(f))
    assert.equal(next.items[0].prId, chosen.request.prId)
    assert.equal(
      (await chosen.pr.detail(f.context, chosen.request)).prRevision,
      chosen.detail.prRevision
    )
    await chosen.pr.releaseView(chosen.request.viewId)
    await assert.rejects(chosen.pr.detail(f.context, chosen.request), /失效/)
  }
)
await suite.check(
  'manual merge matches exact current head, honors allowed method and confirms actual remote state',
  async () => {
    const chosen = await selected(f),
      start = calls.length
    const result = await chosen.pr.merge(f.context, chosen.merge)
    assert.equal(result.outcome, 'success')
    assert.equal(network.merged, true)
    const merge = calls.slice(start).find((call) => call.args[1] === 'merge')
    assert.deepEqual(merge.args, [
      'pr',
      'merge',
      '42',
      '--repo',
      'github.com/fixture-owner/fixture-repo',
      '--match-head-commit',
      f.head,
      '--merge'
    ])
    assert(!merge.args.includes('--admin'))
    assert(!merge.args.includes('--delete-branch'))
    assert(!merge.args.includes('--auto'))
    assert.deepEqual(await diskIdentity(f.directory), f.before)
  }
)
await suite.check(
  'squash is an explicit distinct manual strategy, never a rebase or branch deletion',
  async () => {
    const chosen = await selected(f),
      start = calls.length
    assert.equal(
      (await chosen.pr.merge(f.context, { ...chosen.merge, method: 'squash' })).outcome,
      'success'
    )
    const command = calls.slice(start).find((call) => call.args[1] === 'merge').args
    assert(command.includes('--squash'))
    assert(!command.includes('--merge'))
    assert(!command.includes('--rebase'))
  }
)
await suite.check(
  'remote head/base OID, target branch, current account, state and draft changes reject before write',
  async () => {
    for (const mutation of [
      { headRefOid: 'f'.repeat(40) },
      { baseRefOid: 'e'.repeat(40) },
      { baseRefName: 'changed' },
      { headRefName: 'changed' },
      { account: 'another-user' },
      { state: 'CLOSED' },
      { isDraft: true }
    ]) {
      const chosen = await selected(f),
        start = calls.length
      Object.assign(network, mutation)
      await assert.rejects(chosen.pr.merge(f.context, chosen.merge), /变化/)
      assert(!calls.slice(start).some((call) => call.args[1] === 'merge'))
    }
  }
)
await suite.check(
  'base/head changes during repository-policy lookup are caught by the final exact identity check',
  async () => {
    for (const field of ['baseRefOid', 'headRefOid']) {
      const chosen = await selected(f),
        start = calls.length
      onCall = async (options) => {
        if (options.args[0] === 'api' && options.args.at(-1) === 'repos/fixture-owner/fixture-repo')
          network[field] = 'd'.repeat(40)
      }
      try {
        await assert.rejects(chosen.pr.merge(f.context, chosen.merge), /变化/)
        assert(!calls.slice(start).some((call) => call.args[1] === 'merge'))
      } finally {
        onCall = null
      }
    }
  }
)
await suite.check(
  'old PR revision, another window id and unheld PR id reject before credential read',
  async () => {
    const chosen = await selected(f),
      start = calls.length
    for (const mutation of [
      { prRevision: randomUUID() },
      { viewId: randomUUID() },
      { prId: randomUUID() }
    ])
      await assert.rejects(chosen.pr.merge(f.context, { ...chosen.merge, ...mutation }), /失效/)
    assert.equal(calls.length, start)
  }
)
await suite.check(
  'conflict/unknown/draft/closed and disabled merge strategy never write remotely',
  async () => {
    for (const mutation of [
      { mergeable: 'CONFLICTING' },
      { mergeable: 'UNKNOWN' },
      { state: 'CLOSED' },
      { isDraft: true },
      { allowMerge: false }
    ]) {
      resetNetwork(f)
      Object.assign(network, mutation)
      const pr = service(),
        listing = await pr.list(f.context, listRequest(f))
      const request = {
        requestId: randomUUID(),
        viewId: f.view.info.viewId,
        revision: f.metadata.revision,
        prId: listing.items[0].prId
      }
      const detail = await pr.detail(f.context, request),
        start = calls.length
      await assert.rejects(
        pr.merge(f.context, { ...request, prRevision: detail.prRevision, method: 'merge' }),
        /不能|不允许/
      )
      assert(!calls.slice(start).some((call) => call.args[1] === 'merge'))
    }
  }
)
await suite.check(
  'unsupported SSH/HTTP/credential URL/scoped root and unavailable gh are explicit failures before network',
  async () => {
    for (const [url, scope] of [
      ['git@github.com:a/b', ''],
      ['http://github.com/a/b', ''],
      ['https://user:pass@github.com/a/b', ''],
      ['https://github.com/fixture-owner/fixture-repo.git', 'sub']
    ]) {
      const other = await fixture(url, scope),
        start = calls.length
      await assert.rejects(service().list(other.context, listRequest(other)), /HTTPS|根目录/)
      assert.equal(calls.length, start)
      assert.deepEqual(await diskIdentity(other.directory), other.before)
    }
    await assert.rejects(
      synthetic
        .createGitWorkbenchPullRequests({
          programCandidates: [path.join(evidence, 'absent-gh', 'gh.exe')]
        })
        .list(f.context, listRequest(f)),
      /安装 GitHub CLI/
    )
  }
)
await suite.check(
  'hashed gh identity replacement rejects before authentication and deployment path is not renderer controlled',
  async () => {
    const chosen = await selected(f),
      start = calls.length
    await fs.writeFile(ghPath, ghIdentity + ' changed')
    try {
      await assert.rejects(chosen.pr.detail(f.context, chosen.request), /身份已变化/)
      assert.equal(calls.length, start)
    } finally {
      await fs.writeFile(ghPath, ghIdentity)
    }
    assert.throws(
      () => synthetic.createGitWorkbenchPullRequests({ programCandidates: ['gh.exe'] }),
      /路径无效/
    )
    assert.throws(
      () =>
        synthetic.createGitWorkbenchPullRequests({
          programCandidates: [path.join(evidence, 'other.exe')]
        }),
      /路径无效/
    )
  }
)
await suite.check(
  'external source edit during auth fails freshness before subsequent GitHub calls',
  async () => {
    const other = await fixture(),
      start = calls.length
    resetNetwork(other)
    onCall = async (options) => {
      if (options.args[0] === 'auth')
        await fs.writeFile(path.join(other.directory, 'file.txt'), 'external changed\n')
    }
    try {
      await assert.rejects(service().list(other.context, listRequest(other)), /变化/)
      assert.equal(calls.length - start, 1)
    } finally {
      onCall = null
    }
  }
)
await suite.check(
  'credential diagnostics redact transient and both inherited tokens, including stored unknown-exit failure',
  async () => {
    const saved = process.env.GITHUB_TOKEN
    process.env.GITHUB_TOKEN = otherToken
    try {
      for (const unknown of [false, true]) {
        const chosen = await selected(f)
        network.error =
          (unknown ? '退出未确认 ' : 'Failure ') +
          token +
          ' ' +
          otherToken +
          ' https://user:pass@github.com/a/b'
        for (let round = 0; round < 2; round++) {
          let error
          try {
            await chosen.pr.detail(f.context, chosen.request)
          } catch (value) {
            error = value
          }
          assert(error)
          assert(!error.message.includes(token))
          assert(!error.message.includes(otherToken))
          assert(!error.message.includes('user:pass'))
        }
      }
    } finally {
      if (saved === undefined) delete process.env.GITHUB_TOKEN
      else process.env.GITHUB_TOKEN = saved
    }
  }
)
await suite.check('queue result remains partial success and is never auto-retried', async () => {
  const chosen = await selected(f),
    start = calls.length
  network.queue = true
  const result = await chosen.pr.merge(f.context, chosen.merge)
  assert.equal(result.outcome, 'partial-success')
  assert.match(result.message, /队列/)
  assert.equal(calls.slice(start).filter((call) => call.args[1] === 'merge').length, 1)
})
await suite.check(
  'cancel before write produces no merge; cancel during write reports uncertain remote result after settlement',
  async () => {
    const chosen = await selected(f),
      controller = new AbortController(),
      start = calls.length
    controller.abort()
    await assert.rejects(chosen.pr.merge(f.context, chosen.merge, controller.signal), /取消/)
    assert.equal(calls.length, start)
    const active = new AbortController(),
      next = await selected(f)
    onCall = async (options) => {
      if (options.args[1] === 'merge') {
        network.state = 'MERGED'
        active.abort()
      }
    }
    try {
      const result = await next.pr.merge(f.context, next.merge, active.signal)
      assert.equal(result.outcome, 'partial-success')
      assert.match(result.message, /可能已发生/)
    } finally {
      onCall = null
    }
  }
)
await suite.check(
  'unconfirmed merge exit preserves redacted uncertainty and forbids release of its owned view',
  async () => {
    const chosen = await selected(f),
      start = calls.length
    onCall = async (options) => {
      if (options.args[1] === 'merge') {
        network.state = 'MERGED'
        throw new synthetic.GitReadError('error', '退出未确认 ' + token)
      }
    }
    try {
      const result = await chosen.pr.merge(f.context, chosen.merge)
      assert.equal(result.outcome, 'partial-success')
      assert.match(result.message, /退出未确认/)
      assert(!result.message.includes(token))
      await assert.rejects(chosen.pr.releaseView(f.view.info.viewId), /退出未确认/)
      assert.equal(f.view.disposed, false)
      const beforeRetry = calls.length
      await assert.rejects(chosen.pr.detail(f.context, chosen.request), /退出未确认/)
      assert.equal(calls.length, beforeRetry)
      assert.equal(calls.slice(start).filter((call) => call.args[1] === 'merge').length, 1)
    } finally {
      onCall = null
    }
  }
)
await suite.check(
  'unconfirmed postmerge verification preserves its diagnostic and forbids cache retirement',
  async () => {
    for (const diagnostic of ['退出未确认', '清理失败']) {
      const chosen = await selected(f)
      onCall = async (options) => {
        if (options.args[1] === 'view' && network.merged)
          throw new synthetic.GitReadError('error', diagnostic + ' ' + token)
      }
      try {
        const result = await chosen.pr.merge(f.context, chosen.merge)
        assert.equal(result.outcome, 'partial-success')
        assert(result.message.includes(diagnostic))
        assert(!result.message.includes(token))
        await assert.rejects(chosen.pr.releaseView(f.view.info.viewId), /退出未确认|清理失败/)
        assert.equal(f.view.disposed, false)
      } finally {
        onCall = null
      }
    }
  }
)
await suite.check(
  'repository lock keeps concurrent manual merges serialized until actual process promise settles',
  async () => {
    const chosen = await selected(f),
      start = calls.length
    let release, entered
    const waiting = new Promise((resolve) => {
        release = resolve
      }),
      reached = new Promise((resolve) => {
        entered = resolve
      })
    onCall = async (options) => {
      if (options.args[1] === 'merge') {
        entered()
        await waiting
      }
    }
    const first = chosen.pr.merge(f.context, chosen.merge)
    await reached
    const second = chosen.pr.merge(f.context, chosen.merge)
    await delay(25)
    assert.equal(calls.slice(start).filter((call) => call.args[1] === 'merge').length, 1)
    release()
    assert.equal((await first).outcome, 'success')
    await assert.rejects(second, /失效|变化|不能/)
    onCall = null
    assert.equal(calls.slice(start).filter((call) => call.args[1] === 'merge').length, 1)
  }
)
await suite.check(
  'malformed PR identity/output never grants a held merge target and final source remains byte/mtime identical',
  async () => {
    resetNetwork(f)
    network.url = 'https://github.com/different/repository/pull/42'
    await assert.rejects(service().list(f.context, listRequest(f)), /不匹配/)
    resetNetwork(f)
    network.statusCheckRollup = Array.from({ length: 201 }, () => ({
      name: 'CI',
      conclusion: 'SUCCESS'
    }))
    const pr = service(),
      listing = await pr.list(f.context, listRequest(f))
    await assert.rejects(
      pr.detail(f.context, {
        requestId: randomUUID(),
        viewId: f.view.info.viewId,
        revision: f.metadata.revision,
        prId: listing.items[0].prId
      }),
      /超过/
    )
    assert.deepEqual(await diskIdentity(f.directory), f.before)
  }
)
for (const view of views) await reader.dispose(view)
const spawns = events.filter((event) => event.event === 'spawn'),
  closes = events.filter((event) => event.event === 'close')
assert.equal(spawns.length, closes.length)
const retirement = await verifyProcessRetirement(
  closes.map((event) => ({ ...event, closedAtUTC: event.atUTC }))
)
assert(!JSON.stringify(calls).includes(token))
assert(!JSON.stringify(calls).includes(otherToken))
await fs.writeFile(
  path.join(evidence, 'processes.json'),
  JSON.stringify(
    { preparation, actualGitEvents: events, syntheticGhCalls: calls, retirement },
    null,
    2
  )
)
delete globalThis[dispatcherKey]
await suite.finish({
  syntheticBundleSHA256: hash(await fs.readFile(output)),
  syntheticInputs: Object.keys(bundle.metafile.inputs),
  actualGitSpawnCount: spawns.length
})
