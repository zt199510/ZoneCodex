import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { evidenceFor, compileProduct, suite } from './runtime.mjs'

const evidence = await evidenceFor('model'), checks = suite(evidence)
const { api, invoke, owner, handlers } = await compileProduct(evidence)
let attempts = 0
const blocked = async () => { attempts++; throw Error('Unexpected external model call') }
globalThis.fetch = blocked
for (const key of Object.keys(process.env)) if (/^(MODEL_|OPENAI_)/.test(key)) delete process.env[key]
const remote = { endpoint: 'https://fixture.invalid/responses', model: 'fixture', apiKey: 'SYNTHETIC_SECRET' }
const message = (text) => ({ type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text }] })
const sse = (output, events = []) => new Response([...events, { type: 'response.completed', response: { status: 'completed', output } }].map((item) => 'data: ' + JSON.stringify(item) + '\n\n').join(''), { headers: { 'content-type': 'text/event-stream' } })
const sendFor = (configuration) => api.createModelSession(configuration).createSend({ purpose: 'agent', tools: [], instructions: 'fixture' })
const signal = () => new AbortController().signal

await checks.check('configuration selection: auto offline, explicit offline without credential reads, legacy and explicit responses', async () => {
  assert.deepEqual(api.readModelConfiguration({}), { provider: 'offline' })
  const env = { MODEL_PROVIDER: 'offline' }
  Object.defineProperty(env, 'MODEL_API_KEY', { get() { throw Error('credential read') } })
  assert.deepEqual(api.readModelConfiguration(env), { provider: 'offline' })
  const legacy = { MODEL_ENDPOINT: remote.endpoint, MODEL_NAME: remote.model, MODEL_API_KEY: remote.apiKey }
  assert.deepEqual(api.readModelConfiguration(legacy), remote)
  assert.deepEqual(api.readModelConfiguration({ ...legacy, MODEL_PROVIDER: 'responses' }), remote)
  for (const invalid of [{ MODEL_PROVIDER: 'plugin.js' }, { MODEL_PROVIDER: 'responses' }, { MODEL_NAME: 'only-one' }, { ...legacy, MODEL_ENDPOINT: 'http://fixture.invalid' }, { ...legacy, MODEL_ENDPOINT: 'https://user:secret@fixture.invalid' }])
    assert.throws(() => api.readModelConfiguration(invalid))
})

await checks.check('safe model status and IPC exclude credentials, endpoints and untrusted frames', async () => {
  api.registerModelIpc()
  assert.equal(invoke('model:status').state, 'offline')
  assert.throws(() => handlers.get('model:status')({ sender: owner(1).webContents, senderFrame: {} }), /来源/)
  const status = api.getModelStatus({ MODEL_ENDPOINT: 'https://private.invalid?token=SYNTHETIC_SECRET' })
  assert.deepEqual(Object.keys(status).sort(), ['errorCode', 'label', 'provider', 'state'])
  assert(!JSON.stringify(status).includes('SYNTHETIC_SECRET'))
  assert(!api.parseModelStatus({ ...status, apiKey: 'bad' }))
})

await checks.check('offline compiled runtime runs core with fixed explanation and no tool effects or network', async () => {
  const runtime = api.createAgentRuntime({ capabilities: { mode: 'execute' } })
  assert.equal(runtime.summarize, undefined)
  assert.deepEqual(runtime.mcpToolNames, [])
  const outcome = await api.runAgentCore({ requestId: randomUUID(), conversationId: randomUUID(), mode: 'execute', prompt: '修改文件并执行工具', history: [], scope: { kind: 'time' } }, {
    signal: signal(), ...runtime, assertCurrent: () => true,
    createTools: () => async () => { throw Error('Offline mode must not call tools') }
  })
  assert.equal(outcome.result.status, 'done'); assert.equal(outcome.result.answer, api.offlineModelNotice)
  assert.deepEqual(outcome.effects, { approved: false, started: false })
  assert.equal(attempts, 0)
})

await checks.check('offline title is skipped; images/resume/Git generation are refused before effects', async () => {
  const result = await api.requestConversationTitle({ requestId: randomUUID(), conversationId: randomUUID(), messageId: randomUUID(), content: '离线标题' }, signal())
  assert.equal(result.status, 'skipped'); assert.deepEqual(api.parseConversationTitleOutcome(result), result)
  for (const capabilities of [{ imagePresent: true }, { resuming: true }])
    assert.throws(() => api.createAgentRuntime({ capabilities: { mode: 'execute', ...capabilities } }), /离线/)
  await assert.rejects(api.generateGitText({}, {}, signal()), /离线/)
  assert.equal(attempts, 0)
})

await checks.check('offline risk reviewer returns ask and existing auto-approve broker requests manual approval', async () => {
  let manual = 0
  const execution = { info: { cwd: evidence, mode: 'auto-approve', revision: 0, scopeId: 'a'.repeat(64) }, writableRoots: [evidence] }
  const authorize = api.createHostWorkspaceAuthorization({
    owner: { kind: 'cli', runId: randomUUID(), requestId: randomUUID(), conversationId: randomUUID() },
    userRequest: '创建文件', execution, assertCurrent: () => true, beginApproval: () => true,
    finishApproval() {}, onApproved() {}, reviewApproval: api.createApprovalReviewer({ provider: 'offline' }),
    requestApproval: async () => { manual++; return false }
  })
  assert.equal(await authorize({ kind: 'create', cwd: evidence, path: evidence + '/../outside-demo.txt', after: 'fixture' }, signal()), false)
  assert.equal(manual, 1); assert.equal(attempts, 0)
})

await checks.check('offline context manager preserves raw and stops at existing capacity instead of inventing summary', async () => {
  const raw = []
  for (let i = 0; i < 80; i++) raw.push({ role: 'user', content: 'u'.repeat(1800) }, message('answer'))
  const index = raw.length; raw.push({ role: 'user', content: 'current' })
  const original = JSON.stringify(raw)
  const manager = new api.RequestContextManager(raw, index, { kind: 'time' }, 'execute', signal(), { assertCurrent() {}, onContext() {} })
  await assert.rejects(manager.prepare(), /128000/)
  assert.equal(JSON.stringify(raw), original); assert.equal(attempts, 0)
})

await checks.check('Responses SSE preserves phase, tool schema, call IDs and reasoning; configuration remains frozen', async () => {
  const configuration = { ...remote }, requests = [], messages = []
  const session = api.createModelSession(configuration)
  const tool = { type: 'function', name: 'fixture', strict: false, parameters: { type: 'object' } }
  const send = session.createSend({ purpose: 'agent', tools: [tool], instructions: 'stable' })
  configuration.model = 'changed'; tool.name = 'changed'
  globalThis.fetch = async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization })
    return sse([{ type: 'reasoning', encrypted_content: 'opaque' }, { type: 'function_call', call_id: 'fixture-call', name: 'fixture', arguments: '{}' }, message('done')])
  }
  const response = await send([], signal(), { onMessageEvent: (event) => messages.push(event) })
  assert.equal(response.output[0].encrypted_content, 'opaque')
  assert.equal(response.output[1].call_id, 'fixture-call')
  assert.equal(requests[0].body.model, remote.model); assert.equal(requests[0].body.tools[0].name, 'fixture')
  assert.equal(requests[0].body.parallel_tool_calls, false); assert.equal(requests[0].auth, 'Bearer ' + remote.apiKey)
  assert.equal(messages[0].phase, 'final_answer')
})

await checks.check('summary, title, risk review and Git purposes share a session and enforce capabilities', async () => {
  const requests = [], session = api.createProviderSession({ id: 'script', label: 'test only', capabilities: { tools: true, images: true, summary: true, title: true, riskReview: true, gitGeneration: true, resume: true }, createSender(request) { requests.push(request); return async () => ({ status: 'completed', output: [message('{"risk":"safe"}')] }) } })
  const runtime = api.createAgentRuntime({ session, capabilities: { mode: 'execute' } })
  await runtime.summarize([], signal()); const review = api.createApprovalReviewer(session)
  await review({ kind: 'create', requestId: randomUUID(), conversationId: randomUUID(), cwd: evidence, path: evidence + '/x.txt', content: 'x' }, '创建文件', signal())
  assert.deepEqual(requests.map((item) => item.purpose), ['agent', 'summary', 'risk-review'])
  assert(requests.filter((item) => item.purpose !== 'agent').every((item) => item.tools.length === 0))
  assert.throws(() => api.createModelSession({ provider: 'offline' }).createSend({ purpose: 'summary', tools: [], instructions: '' }))
})

await checks.check('remote authentication and malformed stream fail without offline fallback or credential leakage', async () => {
  globalThis.fetch = async () => new Response('SYNTHETIC_SECRET', { status: 401 })
  await assert.rejects(sendFor(remote)([], signal()), (error) => /401/.test(error.message) && !error.message.includes(remote.apiKey))
  globalThis.fetch = async () => new Response('data: invalid-json\n\n', { headers: { 'content-type': 'text/event-stream' } })
  await assert.rejects(sendFor(remote)([], signal()), /JSON/)
})

await checks.check('stream failures expose only safe event/reason categories and never remote error text', async () => {
  for (const [event, expected] of [
    [{ type: 'response.failed', response: { error: { code: 'insufficient_quota', message: 'SYNTHETIC_SECRET https://private.invalid' } } }, /额度不足/],
    [{ type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } }, /输出长度限制/],
    [{ type: 'error', code: 'model_not_found', message: 'SYNTHETIC_SECRET' }, /模型不存在/],
    [{ type: 'error', error: { code: 'SYNTHETIC_SECRET', message: 'SYNTHETIC_SECRET' } }, /未提供可公开/]
  ]) {
    globalThis.fetch = async () => new Response('data: ' + JSON.stringify(event) + '\n\n', { headers: { 'content-type': 'text/event-stream' } })
    await assert.rejects(sendFor(remote)([], signal()), error => {
      assert.match(error.message, expected); assert(error.message.includes(event.type))
      assert(!error.message.includes('SYNTHETIC_SECRET')); assert(!error.message.includes('private.invalid'))
      return true
    })
  }
})

await checks.check('remote retries retain frozen body and stop after five retries without offline substitution', async () => {
  const originalTimer = globalThis.setTimeout, bodies = [], retries = []
  globalThis.setTimeout = (callback, ms, ...args) => originalTimer(callback, ms >= 1000 ? 1 : ms, ...args)
  globalThis.fetch = async (_url, init) => { bodies.push(init.body); return new Response('', { status: 503 }) }
  try { await assert.rejects(sendFor(remote)([], signal(), { onRetry: (value) => retries.push(value.retry) }), /5 次/) }
  finally { globalThis.setTimeout = originalTimer }
  assert.equal(bodies.length, 6); assert.equal(new Set(bodies).size, 1); assert.deepEqual(retries, [1, 2, 3, 4, 5])
})

await checks.check('cancel during retry does not perform another fetch', async () => {
  const controller = new AbortController(); let calls = 0
  globalThis.fetch = async () => { calls++; return new Response('', { status: 503 }) }
  await assert.rejects(sendFor(remote)([], controller.signal, { onRetry: () => controller.abort() }))
  assert.equal(calls, 1)
})

await checks.check('late provider callbacks and result after cancellation are rejected', async () => {
  let release, emit; const seen = [], controller = new AbortController()
  const session = api.createProviderSession({ id: 'late-test', label: 'test', capabilities: {}, createSender: () => async (_input, _signal, options) => { emit = options; return new Promise((resolve) => { release = resolve }) } })
  const pending = session.createSend({ purpose: 'agent', tools: [], instructions: '' })([], controller.signal, { onTextDelta: (text) => seen.push(text) })
  controller.abort(); assert.throws(() => emit.onTextDelta('late')); release({ status: 'completed', output: [message('late')] })
  await assert.rejects(pending); assert.deepEqual(seen, [])
})

globalThis.fetch = blocked
await checks.finish({ externalNetwork: false, compiledProductModules: true, syntheticResponsesSSE: true, modelLoginUsed: false })
