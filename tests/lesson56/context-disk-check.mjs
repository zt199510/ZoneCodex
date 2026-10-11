import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { load } = require('../lesson55/shared/harness.cjs')
const root = process.cwd()
const evidence = path.join(root, '.ui-check', 'lesson56', 'context-disk', randomUUID())
await fs.mkdir(evidence, { recursive: true })
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const counters = {
  unexpectedNetwork: 0,
  commandStarts: 0,
  commandClaims: 0,
  commandAuthorization: 0
}
const previousFetch = globalThis.fetch
globalThis.fetch = () => {
  counters.unexpectedNetwork++
  throw new Error('offline only')
}
const isolation = {
  '../execution/command-runner': {
    startCommandProcess() {
      counters.commandStarts++
      throw new Error('No process allowed in this disk fixture')
    }
  },
  '../execution/command-plan': {
    discardCommandExecution() {
      /* No command plan exists in this disk fixture. */
    },
    claimCommandExecution() {
      counters.commandClaims++
      throw new Error('No command claim allowed')
    }
  }
}
const imports = {
  runAgentCore: 'src/main/agent/agent-core.ts',
  createAgentToolExecutor: 'src/main/agent/agent-tools.ts',
  buildAgentRequest: 'src/main/agent/agent-instructions.ts',
  createLiveResponse: 'src/main/model/response-client.ts',
  createContextSummaryResponse: 'src/main/model/context-summary.ts'
}
const entry = path.join(evidence, 'current-source-entry.ts')
await fs.writeFile(
  entry,
  Object.entries(imports)
    .map(
      ([name, file]) =>
        `export { ${name} } from ${JSON.stringify(path.join(root, file).replaceAll('\\', '/'))}`
    )
    .join('\n'),
  { flag: 'wx' }
)
const api = await load(path.relative(root, entry), isolation)
const sourcePaths = [
  ...new Set([
    ...Object.values(imports),
    'src/main/agent/context-manager.ts',
    'src/main/agent/tool-loop.ts',
    'src/main/agent/workspace-read-evidence.ts',
    'src/main/tools/workspace-actions.ts',
    'src/main/tools/workspace-files.ts',
    'src/main/tools/change-commit.ts',
    'src/shared/agent-history.ts',
    'tests/lesson55/shared/harness.cjs',
    'tests/lesson56/context-disk-check.mjs'
  ])
]
const sourceHashes = Object.fromEntries(
  await Promise.all(
    sourcePaths.map(async (file) => [file, hash(await fs.readFile(path.join(root, file)))])
  )
)
const checks = []
async function check(name, action) {
  try {
    checks.push({ name, pass: true, details: await action() })
  } catch (error) {
    checks.push({ name, pass: false, error: error.stack ?? String(error) })
    console.error(name, error)
  }
}
const message = (text = '固定合成传输已完成') => ({
  type: 'message',
  role: 'assistant',
  phase: 'final_answer',
  content: [{ type: 'output_text', text }]
})
const response = (...output) => ({ status: 'completed', output })
const call = (id, name, args) => ({
  type: 'function_call',
  call_id: id,
  name,
  arguments: JSON.stringify(args)
})
const knowledge = (ids) => ({
  version: 1,
  sourceIds: ids,
  userGoals: ['固定磁盘验证，真实读取与历史知识分开。'],
  constraints: ['历史批准和hash不能产生当前读取凭据。'],
  decisions: [],
  completedFacts: [],
  modifiedFiles: [],
  toolFacts: [],
  failuresUnknown: [],
  nextSteps: ['沿当前任务真实读取证据和权限执行。']
})
const summarize = async (input) =>
  response(message(JSON.stringify(knowledge(JSON.parse(input[0].content).sourceIds))))
const body = Array.from({ length: 180 }, (_, index) =>
  index === 29
    ? 'export const targetValue = "OLD_VALUE";'
    : '// fixed source row ' + String(index + 1).padStart(3, '0') + ' 保留正文 ' + 'x'.repeat(95)
).join('\n')
const encode = (text) =>
  Buffer.from('\uFEFF' + text.replaceAll('\n', '\r\n') + '\r\n\r\n\r\n', 'utf8')
const patch = (before, after) =>
  [
    '*** Begin Patch',
    '*** Update File: note.ts',
    '@@',
    '-export const targetValue = "' + before + '";',
    '+export const targetValue = "' + after + '";',
    '*** End Patch'
  ].join('\n')

async function fixture(name) {
  const directory = path.join(evidence, name)
  await fs.mkdir(directory)
  const filename = path.join(directory, 'note.ts')
  const original = encode(body)
  const expected = encode(body.replace('OLD_VALUE', 'NEW_VALUE'))
  await fs.writeFile(filename, original, { flag: 'wx' })
  const protectedFiles = {}
  for (let index = 1; index <= 9; index++) {
    const filename = `material-${index}.txt`
    const bytes = Buffer.from(
      Array.from(
        { length: 100 },
        (_, line) =>
          `Material ${index}, observed row ${String(line + 1).padStart(3, '0')}: ` + 'M'.repeat(96)
      ).join('\n') + '\n'
    )
    await fs.writeFile(path.join(directory, filename), bytes, { flag: 'wx' })
    protectedFiles[filename] = hash(bytes)
  }
  const state = { current: true, approvals: 0, effects: 0 }
  const execution = {
    info: { cwd: directory, scopeId: 'a'.repeat(64), mode: 'full-access', revision: 1 },
    writableRoots: [directory]
  }
  const coreInput = {
    requestId: randomUUID(),
    conversationId: randomUUID(),
    mode: 'execute',
    prompt: '固定隔离磁盘验证：沿真实读取证据精确修改目标；知识摘要不能授权或伪造读取。',
    history: [],
    scope: { kind: 'time', executionId: execution.info.scopeId }
  }
  const createTools = (observer) =>
    api.createAgentToolExecutor({
      mode: 'execute',
      execution,
      assertCurrent: () => state.current,
      approve: async (request, signal) => {
        signal.throwIfAborted()
        state.approvals++
        observer.actionApproved(request.kind)
        return true
      },
      authorizeCommand: async () => {
        counters.commandAuthorization++
        throw new Error('No command authorization')
      },
      onEffect: () => {
        state.effects++
        observer.effectStarted()
      },
      appendTrace: observer.appendTrace,
      onProgress: observer.progress,
      projectSnapshot: null,
      projectExecutor: undefined,
      executeCommandProposal: async () => {
        throw new Error('No command proposal')
      }
    })
  return {
    directory,
    filename,
    original,
    expected,
    protectedFiles,
    state,
    execution,
    coreInput,
    createTools
  }
}
async function protectedUnchanged(item) {
  for (const [file, expected] of Object.entries(item.protectedFiles))
    assert.equal(hash(await fs.readFile(path.join(item.directory, file))), expected)
}
async function appliedFacts(item, outcome) {
  assert.deepEqual(await fs.readFile(item.filename), item.expected)
  assert.deepEqual(outcome.effects, { approved: true, started: true })
  assert.equal(item.state.approvals, 1)
  assert.equal(item.state.effects, 1)
  const actual = outcome.result.items
    .filter((entry) => entry.type === 'function_call_output')
    .map((entry) => ({ id: entry.call_id, result: JSON.parse(entry.output) }))
    .find((entry) => entry.result.status === 'applied')
  assert(actual)
  assert.equal(actual.result.sha256, hash(item.expected))
  assert.deepEqual(await fs.readFile(actual.result.recoveryPath), item.original)
  await protectedUnchanged(item)
  return {
    path: item.filename,
    beforeSHA256: hash(item.original),
    afterSHA256: hash(item.expected),
    bytes: item.original.length,
    recoveryPath: actual.result.recoveryPath,
    recoverySHA256: hash(await fs.readFile(actual.result.recoveryPath)),
    actualPatchCallId: actual.id,
    approvalCallbacks: item.state.approvals,
    stagingEffects: item.state.effects,
    byteFormat: { encoding: 'utf-8', bom: true, newline: 'crlf', trailingNewlines: 3 }
  }
}
const readTarget = () =>
  call('target-read', 'read_workspace_file', { path: 'note.ts', startLine: 29, endLine: 31 })
const readMaterials = () =>
  Array.from({ length: 9 }, (_, index) =>
    call('material-read-' + (index + 1), 'read_workspace_file', {
      path: 'material-' + (index + 1) + '.txt',
      startLine: 1,
      endLine: 100
    })
  )
const applyTarget = (item, id = 'patch-target') =>
  call(id, 'apply_workspace_patch', {
    path: 'note.ts',
    expectedSha256: hash(item.original),
    patch: patch('OLD_VALUE', 'NEW_VALUE')
  })
const run = (item, send, extra = {}) =>
  api.runAgentCore(item.coreInput, {
    signal: extra.signal ?? new AbortController().signal,
    send,
    summarize: extra.summarize ?? summarize,
    assertCurrent: () => item.state.current,
    createTools: item.createTools,
    onEvent: extra.onEvent,
    ...extra.dependencies
  })

await check(
  'actual read evidence survives removal, patch preserves bytes/backup, real clients retry fixed summary/main bodies without tool replay',
  async () => {
    const item = await fixture('read-survives-summary')
    const queue = [
      readTarget(),
      ...readMaterials(),
      applyTarget(item),
      call('patch-without-reread', 'apply_workspace_patch', {
        path: 'note.ts',
        expectedSha256: hash(item.expected),
        patch: patch('NEW_VALUE', 'FORBIDDEN_WITHOUT_REREAD')
      }),
      call('target-reread', 'read_workspace_file', { path: 'note.ts', startLine: 29, endLine: 31 }),
      message()
    ]
    const config = Object.freeze({
      endpoint: 'https://lesson56-disk.synthetic.invalid/responses',
      model: 'fixed-synthetic-model',
      apiKey: 'fictional-key-never-used-on-network'
    })
    const request = api.buildAgentRequest({
      mode: 'execute',
      execution: item.execution.info,
      commandSandboxAvailable: false
    })
    const sends = [],
      events = []
    let summaryRetry = false,
      mainRetry = false,
      round = 0,
      summaryMainRound = 0
    const savedTimeout = globalThis.setTimeout
    globalThis.setTimeout = (fn, ms, ...args) => savedTimeout(fn, ms >= 1000 ? 0 : ms, ...args)
    globalThis.fetch = async (url, init) => {
      assert.equal(url, config.endpoint)
      const body = JSON.parse(init.body)
      assert.equal(body.model, config.model)
      const isSummary = body.instructions.startsWith('ZONECODEX_CONTEXT_SUMMARY_V1')
      const entry = {
        kind: isSummary ? 'summary' : 'main',
        inputSHA256: hash(JSON.stringify(body.input)),
        inputCharacters: JSON.stringify(body.input).length,
        bodySHA256: hash(init.body),
        hasKnowledge: JSON.stringify(body.input).includes('ZONECODEX_CONTEXT_KNOWLEDGE_V1'),
        callIds: body.input
          .filter((entry) => entry.type === 'function_call')
          .map((entry) => entry.call_id),
        resultIds: body.input
          .filter((entry) => entry.type === 'function_call_output')
          .map((entry) => entry.call_id),
        tools: body.tools.length
      }
      sends.push(entry)
      let output
      if (isSummary) {
        assert.deepEqual(body.tools, [])
        if (!summaryRetry) {
          summaryRetry = true
          entry.status = 502
          return new Response('', { status: 502 })
        }
        output = message(JSON.stringify(knowledge(JSON.parse(body.input[0].content).sourceIds)))
      } else {
        if (entry.hasKnowledge && !mainRetry) {
          mainRetry = true
          summaryMainRound = round + 1
          entry.status = 502
          return new Response('', { status: 502 })
        }
        output = queue.shift()
        assert(output, 'Fixed response queue exhausted')
        round++
      }
      entry.status = 200
      return new Response(
        'data: ' +
          JSON.stringify({ type: 'response.completed', response: response(output) }) +
          '\n\n',
        { headers: { 'content-type': 'text/event-stream' } }
      )
    }
    let outcome
    try {
      outcome = await run(
        item,
        api.createLiveResponse(request.tools, request.instructions, config),
        {
          summarize: api.createContextSummaryResponse(config),
          onEvent: (event) => events.push(structuredClone(event))
        }
      )
    } finally {
      globalThis.fetch = () => {
        counters.unexpectedNetwork++
        throw new Error('offline only')
      }
      globalThis.setTimeout = savedTimeout
    }
    assert.equal(outcome.result.status, 'done', JSON.stringify(outcome.result))
    assert.equal(queue.length, 0)
    const mainAfter = sends.find((entry) => entry.kind === 'main' && entry.hasKnowledge)
    assert(mainAfter)
    assert(!mainAfter.callIds.includes('target-read'))
    assert(!mainAfter.resultIds.includes('target-read'))
    assert(
      mainAfter.callIds.includes('material-read-8') && mainAfter.callIds.includes('material-read-9')
    )
    const mainRetries = events.filter((event) => event.type === 'retry')
    assert.equal(mainRetries.length, 1)
    assert.equal(mainRetries[0].event.round, summaryMainRound)
    assert.equal(mainRetries[0].event.status, 502)
    assert(
      events.some((event) => event.type === 'context' && event.event.reason === 'summary_retry')
    )
    for (const kind of ['main', 'summary']) {
      const failedIndex = sends.findIndex((entry) => entry.kind === kind && entry.status === 502)
      assert(failedIndex >= 0)
      assert.equal(sends[failedIndex + 1].bodySHA256, sends[failedIndex].bodySHA256)
    }
    const executedIds = events
      .filter((event) => event.type === 'tool' && event.event.phase === 'start')
      .map((event) => event.event.callId)
    assert.equal(new Set(executedIds).size, executedIds.length)
    assert.equal(executedIds.filter((id) => id === 'patch-target').length, 1)
    const noReread = outcome.result.items.find(
      (entry) => entry.type === 'function_call_output' && entry.call_id === 'patch-without-reread'
    )
    assert.equal(JSON.parse(noReread.output).status, 'error')
    assert.match(JSON.parse(noReread.output).error, /本执行请求读取/)
    const reread = JSON.parse(
      outcome.result.items.find(
        (entry) => entry.type === 'function_call_output' && entry.call_id === 'target-reread'
      ).output
    )
    assert.equal(reread.sha256, hash(item.expected))
    assert(reread.lines.some((line) => line.line === 30 && line.text.includes('NEW_VALUE')))
    assert.deepEqual(reread.format, {
      encoding: 'utf-8',
      hasUtf8Bom: true,
      newline: 'crlf',
      trailingNewlines: 3
    })
    assert(!JSON.stringify(outcome.result.items).includes('CONTEXT_KNOWLEDGE'))
    const facts = await appliedFacts(item, outcome)
    await fs.writeFile(
      path.join(item.directory, 'events-and-transport.json'),
      JSON.stringify({ events, sends }, null, 2),
      { flag: 'wx' }
    )
    return {
      ...facts,
      mainLogicalRounds: round,
      syntheticHttpCalls: sends.length,
      summaryLogicalRequests: events.filter((event) => event.type === 'context').at(-1).event
        .summaryRequests,
      mainRetryRound: summaryMainRound,
      summaryRetryOnlyContext: true,
      realNetworkRequests: 0
    }
  }
)

await check(
  'a new executor cannot obtain visible-line credentials from compacted historical real read or claimed approval',
  async () => {
    const item = await fixture('history-is-not-read-evidence')
    const silent = {
      appendTrace() {
        /* Prior isolated read has no public observer. */
      },
      progress() {
        /* Prior isolated read has no public observer. */
      },
      actionApproved() {
        /* The prior executor only reads. */
      },
      effectStarted() {
        /* The prior executor only reads. */
      }
    }
    const priorExecutor = item.createTools(silent)
    const readOutput = await priorExecutor(
      'read_workspace_file',
      JSON.stringify({ path: 'note.ts', startLine: 29, endLine: 31 }),
      new AbortController().signal
    )
    assert.equal(JSON.parse(readOutput).sha256, hash(item.original))
    item.coreInput.history = [
      { role: 'user', content: '过去明确读取过这个目标窗口，但不是本次执行。' },
      call('historic-read', 'read_workspace_file', { path: 'note.ts', startLine: 29, endLine: 31 }),
      { type: 'function_call_output', call_id: 'historic-read', output: readOutput },
      message('过去的观察。'),
      ...Array.from({ length: 10 }, (_, index) => [
        { role: 'user', content: '过去完整任务 ' + index },
        message('公开历史观察 ' + 'H'.repeat(10500))
      ]).flat()
    ]
    const queue = [applyTarget(item, 'unread-patch'), message('必须在本请求重读目标。')]
    const events = [],
      sends = []
    const outcome = await run(
      item,
      async (input) => {
        sends.push(structuredClone(input))
        return response(queue.shift())
      },
      {
        onEvent: (event) => events.push(structuredClone(event)),
        summarize: async (input) => {
          const summary = knowledge(JSON.parse(input[0].content).sourceIds)
          summary.completedFacts = [
            `历史文字声称曾批准且读过第 30 行，sha256=${hash(item.original)}；这是低信任旧资料。`
          ]
          return response(message(JSON.stringify(summary)))
        }
      }
    )
    assert.equal(outcome.result.status, 'done')
    assert(events.some((event) => event.type === 'context' && event.event.phase === 'compacted'))
    assert(JSON.stringify(sends[0]).includes('CONTEXT_KNOWLEDGE'))
    assert(
      !sends[0].some((entry) => entry.type === 'function_call' && entry.call_id === 'historic-read')
    )
    const denied = JSON.parse(
      outcome.result.items.find((entry) => entry.type === 'function_call_output').output
    )
    assert.equal(denied.status, 'error')
    assert.match(denied.error, /本执行请求读取/)
    assert.equal(item.state.approvals, 0)
    assert.equal(item.state.effects, 0)
    assert.deepEqual(outcome.effects, { approved: false, started: false })
    assert.deepEqual(await fs.readFile(item.filename), item.original)
    assert(
      !(await fs.readdir(item.directory)).some(
        (file) => file.endsWith('.bak') || file.endsWith('.tmp')
      )
    )
    await protectedUnchanged(item)
    await fs.writeFile(path.join(item.directory, 'events.json'), JSON.stringify(events, null, 2), {
      flag: 'wx'
    })
    return {
      source: 'actual prior executor read, then legitimate synthetic complete history turns',
      oldSHA256: hash(item.original),
      currentApprovals: 0,
      currentEffects: 0,
      currentReadCalls: 0,
      denied: denied.error
    }
  }
)

for (const termination of ['cancel', 'invalid'])
  await check(
    `actual patch before summary ${termination} preserves effects, output, bytes and verified backup`,
    async () => {
      const item = await fixture('effect-before-summary-' + termination)
      const queue = [readTarget(), applyTarget(item), ...readMaterials()]
      const events = []
      let mainRequests = 0,
        summaryRequests = 0,
        release,
        announce
      const entered = new Promise((resolve) => {
        announce = resolve
      })
      const controller = new AbortController()
      const pending = run(
        item,
        async () => {
          mainRequests++
          const item = queue.shift()
          assert(item)
          return response(item)
        },
        {
          signal: controller.signal,
          onEvent: (event) => events.push(structuredClone(event)),
          summarize: async (input) => {
            summaryRequests++
            announce()
            const result = response(
              message(JSON.stringify(knowledge(JSON.parse(input[0].content).sourceIds)))
            )
            if (termination === 'invalid') {
              item.state.current = false
              return result
            }
            return new Promise((resolve) => {
              release = () => resolve(result)
            })
          }
        }
      )
      await Promise.race([
        entered,
        pending.then((result) => {
          throw new Error('Ended before summary: ' + JSON.stringify(result))
        })
      ])
      if (termination === 'cancel')
        controller.abort(new Error('fixed summary cancellation after real patch'))
      const outcome = await pending
      assert.equal(outcome.result.status, termination === 'cancel' ? 'cancelled' : 'error')
      assert.match(outcome.task.error, /本地操作可能已经执行/)
      assert.equal(mainRequests, 11)
      assert.equal(summaryRequests, 1)
      assert.equal(queue.length, 0)
      assert(!events.some((event) => event.type === 'context' && event.event.phase === 'compacted'))
      assert(!JSON.stringify(outcome.result.items).includes('CONTEXT_KNOWLEDGE'))
      const facts = await appliedFacts(item, outcome)
      const oldCount = events.length,
        originalOutcome = JSON.stringify(outcome)
      release?.()
      await Promise.resolve()
      assert.equal(events.length, oldCount)
      assert.equal(JSON.stringify(outcome), originalOutcome)
      assert.equal(mainRequests, 11)
      await fs.writeFile(
        path.join(item.directory, 'events.json'),
        JSON.stringify(events, null, 2),
        { flag: 'wx' }
      )
      return {
        ...facts,
        status: outcome.result.status,
        mainRequests,
        summaryRequests,
        latePublication: false
      }
    }
  )

globalThis.fetch = previousFetch
const report = {
  pass:
    checks.every((check) => check.pass) && Object.values(counters).every((count) => count === 0),
  evidence,
  sourceHashes,
  counters,
  checks,
  boundary:
    'Actual current core, executor, real filesystem reads/hash/format-preserving patch/staging/rename/backup. Model responses, HTTP 502, approval acceptance and time acceleration are fixed synthetic fixtures. Shared command backend isolation rejects every launch/claim; no Electron, native command process or real model claim.'
}
await fs.writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2), {
  flag: 'wx'
})
console.log(JSON.stringify({ pass: report.pass, checks: checks.length, evidence }))
if (!report.pass) process.exitCode = 1
