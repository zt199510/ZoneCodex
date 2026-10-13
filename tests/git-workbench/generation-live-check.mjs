import assert from 'node:assert/strict'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import {
  createEvidence,
  compile,
  checksFor,
  root,
  hash,
  runProcess,
  assertOwnedPath
} from './runtime.mjs'
import { findFixtureGit } from '../lesson61/materials.mjs'
import { diskIdentity, verifyProcessRetirement } from '../lesson61/runtime.mjs'

// Explicit live entry only. Never register this file in offline/native groups.
const evidence = await createEvidence('generation-live')
const { api, sourceHashes, compiledSHA256 } = await compile(evidence, [
  'src/main/git/git-reader.ts',
  'src/main/git/git-workbench-reader.ts',
  'src/main/git/git-workbench-generation.ts',
  'src/main/model/response-client.ts',
  'src/shared/git-workbench.ts'
])
async function main() {
  let configuration
  try {
    try {
      process.loadEnvFile(path.join(root, '.env.local'))
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Environment file unavailable')
    }
    configuration = api.readModelConfiguration()
  } catch {
    const report = {
      pass: false,
      status: 'unavailable',
      evidence,
      sourceHashes,
      compiledSHA256,
      realModelTransport: false,
      requestCount: 0,
      outcomes: ['commit', 'pr'].map((purpose) => ({
        purpose,
        status: 'unavailable',
        requestCount: 0
      })),
      message: '模型配置缺失、无效或环境文件不可用；未发送请求。'
    }
    await fs.writeFile(path.join(evidence, 'results.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify({ pass: false, status: report.status, evidence, requestCount: 0 }))
    process.exitCode = 2
    return
  }
  const suite = checksFor(evidence, {
    actualGit: true,
    actualDisk: true,
    actualElectron: false,
    realModelTransport: true,
    syntheticModelTransport: false,
    maxNetworkRequests: 2,
    requestTimeoutMs: 60000,
    actualExternalPush: false,
    actualPRPublication: false,
    agentCoreCalls: 0,
    fixtureGitWrites:
      'Preparation only in this newly created UUID repository; model generation never commits or publishes.'
  })
  const git = await findFixtureGit()
  const empty = assertOwnedPath(evidence, path.join(evidence, 'empty-global.config'))
  await fs.writeFile(empty, '')
  const environment = { ...process.env }
  for (const key of Object.keys(environment))
    if (/^GIT_|^NODE_OPTIONS$|^ELECTRON_RUN_AS_NODE$|^MODEL_|^GH_|^GITHUB_/i.test(key))
      delete environment[key]
  Object.assign(environment, {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: empty,
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_LAZY_FETCH: '1'
  })
  const preparation = []
  const fixture = assertOwnedPath(evidence, path.join(evidence, 'fixture'))
  await fs.mkdir(fixture)
  async function prepare(args) {
    const result = await runProcess(
      git,
      [
        '--no-optional-locks',
        '-c',
        'core.hooksPath=' + path.join(evidence, 'no-hooks'),
        '-c',
        'core.autocrlf=false',
        '-c',
        'user.name=Live Git Fixture',
        '-c',
        'user.email=live-git@example.invalid',
        ...args
      ],
      { cwd: fixture, env: environment },
      15000
    )
    preparation.push(result)
    assert.equal(result.exitCode, 0, 'Fixture Git preparation failed')
    return result.stdout.trim()
  }
  await prepare(['init', '--initial-branch=main'])
  await fs.writeFile(path.join(fixture, 'tiny.txt'), 'smoke base\n')
  await prepare(['add', '--all'])
  await prepare(['commit', '-m', 'fixture base'])
  await prepare(['switch', '-c', 'fixture-feature'])
  await fs.writeFile(path.join(fixture, 'tiny.txt'), 'smoke feature\n')
  await prepare(['add', '--all'])
  await prepare(['commit', '-m', 'fixture feature'])
  await fs.writeFile(path.join(fixture, 'tiny.txt'), 'smoke staged\n')
  await prepare(['add', '--', 'tiny.txt'])
  const before = await diskIdentity(fixture)
  const events = []
  const observe = (event) => events.push({ ...event, atUTC: new Date().toISOString() })
  const cacheRoot = path.join(evidence, 'reader-cache')
  const reader = api.createGitReader({ cacheRoot, onProcess: observe })
  const workbench = api.createGitWorkbenchReader({ onProcess: observe })
  const view = await reader.open(fixture)
  const metadata = await workbench.metadata(view)
  const context = await workbench.context(view, metadata.revision)
  const mainRef = metadata.branches.find((ref) => ref.name === 'main' && !ref.remote)
  assert(mainRef)
  const requests = [],
    outcomes = []
  const originalFetch = globalThis.fetch
  let activePurpose
  // This observer forwards the exact current client request to the actual network.
  // Only request-body fields are read; URLs, headers and credentials are never logged.
  globalThis.fetch = async (url, options) => {
    assert(activePurpose === 'commit' || activePurpose === 'pr', 'No active live purpose')
    assert.equal(
      requests.filter((request) => request.purpose === activePurpose).length,
      0,
      'One live request per purpose; automatic retries are blocked before transport'
    )
    const body = JSON.parse(options.body)
    assert.deepEqual(body.tools, [], 'Dedicated Git generation cannot call tools')
    assert.equal(body.store, false)
    assert.equal(body.model, configuration.model)
    assert.equal(body.input.length, 1)
    const input = JSON.parse(body.input[0].content)
    assert.deepEqual(Object.keys(input).sort(), ['diff', 'guidance', 'purpose'])
    assert.equal(input.purpose, activePurpose)
    assert(input.diff.includes('tiny.txt'))
    assert(Buffer.byteLength(input.diff) < 2048, 'Only the tiny fixture diff may be sent')
    assert(
      !body.input[0].content.includes(configuration.apiKey),
      'Generation input cannot include a credential'
    )
    requests.push({
      purpose: activePurpose,
      model: body.model,
      inputBytes: Buffer.byteLength(body.input[0].content),
      inputSHA256: hash(body.input[0].content),
      diffBytes: Buffer.byteLength(input.diff),
      diffSHA256: hash(input.diff),
      bodyBytes: Buffer.byteLength(options.body),
      bodySHA256: hash(options.body),
      toolsCount: body.tools.length,
      store: body.store,
      atUTC: new Date().toISOString()
    })
    return originalFetch(url, options)
  }
  function safeFailure(error, signal) {
    if (signal.aborted) return { status: 'timeout', message: '真实候选请求在 60 秒限制内未完成。' }
    const message = typeof error?.message === 'string' ? error.message : ''
    const http = message.match(/HTTP (\d{3})/)
    if (http) return { status: 'http-error', message: '模型请求失败（HTTP ' + http[1] + '）。' }
    if (/格式|结构|限制|不支持的内容|未完成/.test(message))
      return {
        status: 'invalid-response',
        message: '真实模型候选未满足当前生成接口的完成或格式要求。'
      }
    if (/配置|HTTPS/.test(message))
      return { status: 'unavailable', message: '模型配置不可用于当前请求。' }
    if (/automatic retries/.test(message))
      return {
        status: 'request-budget',
        message: '首次传输未完成；为保持每种用途仅一次真实请求，已阻止自动重试。'
      }
    return { status: 'failed', message: '真实候选生成失败；没有提交或发布。' }
  }
  try {
    for (const purpose of ['commit', 'pr']) {
      await suite.check(
        'real ' + purpose + ' candidate request returns validated editable fixture-only text',
        async () => {
          activePurpose = purpose
          const signal = AbortSignal.timeout(60000)
          const started = Date.now()
          const request = {
            requestId: randomUUID(),
            viewId: view.info.viewId,
            revision: metadata.revision,
            purpose,
            guidance:
              '隔离烟测夹具：只根据 tiny.txt 的实际差异生成简短中文说明；返回纯 JSON subject/body，不使用 Markdown 代码块。',
            ...(purpose === 'commit' ? { includeUnstaged: false } : { baseRefId: mainRef.refId })
          }
          try {
            // Use the product's default dedicated instructions and current response client.
            const candidate = await api.generateGitText(context, request, signal)
            assert(
              !JSON.stringify(candidate).includes(configuration.apiKey),
              'Candidate cannot contain a credential'
            )
            assert(
              api.parseGitGenerateResult({
                requestId: request.requestId,
                viewId: request.viewId,
                status: 'ready',
                data: candidate
              }),
              'Candidate failed current public contract'
            )
            const count = requests.filter((entry) => entry.purpose === purpose).length
            assert.equal(count, 1)
            const outcome = {
              purpose,
              status: 'ready',
              requestCount: count,
              elapsedMs: Date.now() - started,
              candidate
            }
            outcomes.push(outcome)
            return outcome
          } catch (error) {
            const failure = safeFailure(error, signal)
            outcomes.push({
              purpose,
              ...failure,
              requestCount: requests.filter((entry) => entry.purpose === purpose).length,
              elapsedMs: Date.now() - started
            })
            // Throw only this fixed sanitized failure, never provider text, URL or headers.
            throw new Error(failure.message)
          } finally {
            activePurpose = undefined
          }
        }
      )
    }
    await suite.check(
      'real generation preserves all fixture repository files and sends at most one request per purpose with no tools',
      async () => {
        assert.deepEqual(await diskIdentity(fixture), before)
        assert(requests.length <= 2)
        for (const purpose of ['commit', 'pr'])
          assert(requests.filter((entry) => entry.purpose === purpose).length <= 1)
        assert(requests.every((request) => request.toolsCount === 0 && request.store === false))
        return {
          requestCount: requests.length,
          purposeCounts: Object.fromEntries(
            ['commit', 'pr'].map((purpose) => [
              purpose,
              requests.filter((request) => request.purpose === purpose).length
            ])
          )
        }
      }
    )
  } finally {
    globalThis.fetch = originalFetch
    await reader.dispose(view)
    await fs.writeFile(path.join(evidence, 'processes.json'), JSON.stringify(events, null, 2))
    await fs.writeFile(
      path.join(evidence, 'preparation.json'),
      JSON.stringify(preparation, null, 2)
    )
    await fs.writeFile(path.join(evidence, 'request-audit.json'), JSON.stringify(requests, null, 2))
    await suite.check(
      'real owned Git queries close and query cache is removed after live smoke',
      async () => {
        const spawned = events.filter((event) => event.event === 'spawn'),
          closed = events.filter((event) => event.event === 'close')
        assert.equal(spawned.length, closed.length)
        assert(!events.some((event) => event.event === 'unconfirmed'))
        const retired = await verifyProcessRetirement(
          closed.map((event) => ({ ...event, closedAtUTC: event.atUTC }))
        )
        assert(!(await fs.readdir(cacheRoot)).some((name) => name.startsWith('query-')))
        return { spawned: spawned.length, closed: closed.length, retired }
      }
    )
    await suite.finish({
      sourceHashes,
      compiledSHA256,
      model: configuration.model,
      status:
        outcomes.length === 2 && outcomes.every((outcome) => outcome.status === 'ready')
          ? 'ready'
          : 'failed',
      requestCount: requests.length,
      requests,
      outcomes
    })
  }
}
try {
  await main()
} catch {
  // Setup errors are also intentionally opaque: credentials must never appear in logs.
  await fs.writeFile(
    path.join(evidence, 'setup-failure.json'),
    JSON.stringify(
      {
        status: 'failed',
        sourceHashes,
        compiledSHA256,
        message: '真实生成烟测准备失败；未运行提交或发布。'
      },
      null,
      2
    )
  )
  console.log(
    JSON.stringify({
      pass: false,
      status: 'failed',
      evidence,
      message: '真实生成烟测准备失败；未运行提交或发布。'
    })
  )
  process.exitCode = 1
}
