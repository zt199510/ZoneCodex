import assert from 'node:assert/strict'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import { createEvidence, compile, checksFor, root, hash } from './runtime.mjs'

const evidence = await createEvidence('pr-protocol')
const { api, sourceHashes, compiledSHA256 } = await compile(evidence, ['src/shared/git-pr.ts'])
const suite = checksFor(evidence, {
  sourceHashes,
  compiledSHA256,
  realNetworking: false,
  actualGit: false,
  syntheticIPC: true
})
const viewId = randomUUID(),
  revision = randomUUID(),
  prId = randomUUID(),
  requestId = randomUUID()
const list = { requestId, viewId, revision, remoteId: randomUUID(), state: 'open' }
const detail = { requestId, viewId, revision, prId }
const merge = { ...detail, prRevision: randomUUID(), method: 'squash' }
const item = {
  prId,
  number: 42,
  title: 'Fixture title',
  url: 'https://github.com/fixture-owner/fixture-repo/pull/42',
  state: 'OPEN',
  draft: false,
  headRefName: 'feature',
  baseRefName: 'main',
  author: 'fixture-user'
}
const data = {
  ...item,
  repository: 'fixture-owner/fixture-repo',
  account: 'fixture-user',
  prRevision: merge.prRevision,
  body: 'Body\ntext',
  headOid: 'a'.repeat(40),
  baseOid: 'b'.repeat(40),
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  mergeMethods: ['merge', 'squash'],
  checks: [{ name: 'CI', status: 'success' }]
}
const ready = (data) => ({ requestId, viewId, status: 'ready', data })

await suite.check(
  'exact opaque identities accept list/detail/manual merge and reject URL/number/argv/environment authority',
  () => {
    for (const [parse, request] of [
      [api.parseGitPullRequestListRequest, list],
      [api.parseGitPullRequestDetailRequest, detail],
      [api.parseGitPullRequestMergeRequest, merge]
    ]) {
      assert.deepEqual(parse(request), request)
      for (const [key, value] of Object.entries({
        url: item.url,
        number: 42,
        repo: 'owner/repo',
        argv: [],
        env: {},
        executable: 'gh',
        method: 'rebase'
      })) {
        if (key === 'method' && !Object.hasOwn(request, key)) continue
        assert.equal(parse({ ...request, [key]: value }), null)
      }
      assert.equal(parse({ ...request, viewId: '../other' }), null)
    }
  }
)
await suite.check(
  'accessors, non-plain objects, sparse arrays, symbols and duplicate IDs never reach IPC',
  () => {
    let accessorCalled = false
    const getter = { ...merge }
    Object.defineProperty(getter, 'method', {
      get() {
        accessorCalled = true
        return 'merge'
      }
    })
    assert.equal(api.parseGitPullRequestMergeRequest(getter), null)
    assert.equal(accessorCalled, false)
    assert.equal(api.parseGitPullRequestMergeRequest(Object.assign(new Date(), merge)), null)
    assert.equal(api.parseGitPullRequestMergeRequest({ ...merge, [Symbol('extra')]: true }), null)
    assert.equal(
      api.parseGitPullRequestListResult(
        ready({
          repository: data.repository,
          account: data.account,
          items: Array(1),
          capped: false
        })
      ),
      null
    )
    assert.equal(
      api.parseGitPullRequestListResult(
        ready({
          repository: data.repository,
          account: data.account,
          items: [item, item],
          capped: false
        })
      ),
      null
    )
  }
)
await suite.check(
  'PR results pin canonical GitHub URL/number, strict OIDs/checks and merge methods',
  () => {
    assert.deepEqual(api.parseGitPullRequestDetailResult(ready(data)), ready(data))
    for (const mutation of [
      { url: item.url + '?x=1' },
      { number: 43 },
      { headOid: 'z'.repeat(40) },
      { baseOid: 'b'.repeat(64) },
      { checks: [{ name: 'CI', status: 'INVALID' }] },
      { mergeMethods: ['merge', 'merge'] },
      { body: 'x'.repeat(65537) }
    ])
      assert.equal(api.parseGitPullRequestDetailResult(ready({ ...data, ...mutation })), null)
    assert.equal(
      api.parseGitPullRequestMergeResult(
        ready({ prId, number: 42, url: item.url, outcome: 'success', message: 'Merged' })
      ).status,
      'ready'
    )
  }
)
await suite.check(
  'failure and cancelled results carry exact request identities without hidden fields',
  () => {
    for (const parser of [
      api.parseGitPullRequestListResult,
      api.parseGitPullRequestDetailResult,
      api.parseGitPullRequestMergeResult
    ]) {
      assert.equal(parser({ requestId, viewId, status: 'cancelled' }).status, 'cancelled')
      assert.equal(parser({ requestId, viewId, status: 'stale', error: 'Refresh' }).status, 'stale')
      assert.equal(parser({ requestId, viewId, status: 'cancelled', data }), null)
      assert.equal(parser({ requestId, viewId, status: 'error', error: 'x'.repeat(1001) }), null)
    }
  }
)

const dispatcherKey = '__zonecodexPrIpc_' + randomUUID().replaceAll('-', '')
const mock = path.join(evidence, 'electron-mock.ts'),
  output = path.join(evidence, 'preload.cjs')
await fs.writeFile(
  mock,
  'export const ipcRenderer = { invoke: (...args) => globalThis[' +
    JSON.stringify(dispatcherKey) +
    '](...args) };\n'
)
const compiled = await build({
  stdin: { contents: 'export * from "./src/preload/git-pr-api.ts";', resolveDir: root },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: output,
  metafile: true,
  logLevel: 'silent',
  plugins: [
    {
      name: 'test-only-electron-seam',
      setup(builder) {
        builder.onResolve({ filter: /^electron$/ }, () => ({ path: mock }))
      }
    }
  ]
})
const preload = createRequire(import.meta.url)(output).gitPullRequestAPI
let calls = [],
  response = ready(data)
globalThis[dispatcherKey] = async (channel, request) => {
  calls.push({ channel, request })
  return response
}
await suite.check(
  'preload rejects malformed request before IPC and invokes only three dedicated channels',
  async () => {
    await assert.rejects(preload.mergeGitPullRequest({ ...merge, url: item.url }), /无效/)
    assert.equal(calls.length, 0)
    response = ready({
      repository: data.repository,
      account: data.account,
      items: [item],
      capped: false
    })
    await preload.getGitPullRequests(list)
    response = ready(data)
    await preload.getGitPullRequest(detail)
    response = ready({ prId, number: 42, url: item.url, outcome: 'success', message: 'Merged' })
    await preload.mergeGitPullRequest(merge)
    assert.deepEqual(
      calls.map((call) => call.channel),
      ['git:pr-list', 'git:pr-detail', 'git:pr-merge']
    )
  }
)
await suite.check(
  'preload rejects wrong request/view/PR identity and invalid GitHub results',
  async () => {
    for (const changed of [
      { requestId: randomUUID() },
      { viewId: randomUUID() },
      { data: { ...data, prId: randomUUID() } },
      { data: { ...data, url: 'https://example.invalid/pull/42' } }
    ]) {
      response = { ...ready(data), ...changed }
      await assert.rejects(preload.getGitPullRequest(detail), /身份/)
    }
  }
)
delete globalThis[dispatcherKey]
await suite.finish({
  preloadSHA256: hash(await fs.readFile(output)),
  preloadInputs: Object.keys(compiled.metafile.inputs)
})
