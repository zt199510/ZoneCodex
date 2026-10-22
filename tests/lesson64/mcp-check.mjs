import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { root, compileProduct, evidenceFor, suite, until, alive, delay } from './runtime.mjs'

const evidence = await evidenceFor('mcp'), checks = suite(evidence)
const compiled = await compileProduct(evidence), { api, owner, invoke, events, userData } = compiled
const logs = [], clients = []
const rows = async (file) => { try { return (await fs.readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse) } catch (error) { if (error.code === 'ENOENT') return []; throw error } }
const config = (id, mode = 'normal') => {
  const audit = path.join(evidence, id + '-' + randomUUID() + '.jsonl'); logs.push(audit)
  return { id, name: id, transport: 'stdio', command: process.execPath, args: [path.join(root, 'tests/lesson64/mcp-fixture.mjs'), audit, mode], enabled: true, timeoutMs: 1000 }
}
const signal = () => new AbortController().signal
const tool = (status, name = 'echo') => { const result = status.tools.find((item) => item.name === name); assert(result, 'Missing tool ' + name); return result }
const pidFor = async (configuration) => (await until(async () => (await rows(configuration.args[1])).find((row) => row.pid), 'fixture startup')).pid
const clientFor = async (mode = 'normal') => {
  const configuration = config('direct_' + clients.length, mode), client = new api.McpClient(configuration)
  clients.push(client); await client.connect(); return { client, configuration, pid: await pidFor(configuration) }
}
globalThis.fetch = async () => { throw Error('MCP tests never use remote models') }
api.registerMcpIpc(); api.registerExecutionApproval()
owner(1); owner(2)

try {
await checks.check('fresh missing settings are empty; corruption remains an error across repeated reads and writes', async () => {
  assert.deepEqual(await api.listMcpServers(1), [])
  const broken = await compileProduct(evidence, ['src/main/mcp/mcp-manager.ts'], path.join(evidence, 'broken'))
  const file = path.join(evidence, 'broken/mcp-settings.json'); await fs.writeFile(file, '{broken')
  for (let i = 0; i < 2; i++) await assert.rejects(broken.api.listMcpConfigs(), /损坏/)
  await assert.rejects(broken.api.upsertMcpServer(config('corrupt')), /损坏/)
  assert.equal(await fs.readFile(file, 'utf8'), '{broken')
})

await checks.check('config rejects unknown fields, URLs, UNC, shell strings, huge args and nonexistent working directories', async () => {
  const base = config('validation')
  for (const invalid of [{ ...base, token: 'bad' }, { ...base, env: {} }, { ...base, command: 'https://example.invalid/mcp' }, { ...base, command: '\\\\server\\exe' }, { ...base, command: 'node.exe & whoami' }, { ...base, args: ['x'.repeat(2049)] }])
    assert.equal(api.parseMcpServerConfig(invalid), null)
  await assert.rejects(api.upsertMcpServer({ ...base, cwd: 'relative' }))
  await assert.rejects(api.upsertMcpServer({ ...base, cwd: path.join(evidence, 'not-a-directory') }))
})

await checks.check('schema depth/property/size and serializability limits are enforced before discovery or calls', async () => {
  const basic = { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] }
  assert(api.validSchema(basic)); assert(api.validateMcpArguments({ value: 'ok' }, basic))
  assert(!api.validateMcpArguments({}, basic)); assert(!api.validateMcpArguments({ value: 1 }, basic))
  assert(!api.validateMcpArguments([], basic))
  const circular = {}; circular.self = circular
  for (const bad of [{ f() {} }, { value: NaN }, { value: undefined }, { value: 1n }, circular, { description: 'x'.repeat(128 * 1024) }, { properties: Object.fromEntries(Array.from({ length: 65 }, (_, i) => ['p' + i, {}])) }]) assert(!api.validSchema(bad))
  let deep = {}; for (let i = 0; i < 10; i++) deep = { items: deep }
  assert(!api.validSchema(deep))
})

await checks.check('serial concurrent window writes preserve both configs; enabled servers stay lazy', async () => {
  await Promise.all([api.upsertMcpServer(config('first')), api.upsertMcpServer(config('second'))])
  assert.deepEqual((await api.listMcpConfigs()).map((item) => item.id).sort(), ['first', 'second'])
  assert((await api.listMcpServers(1)).every((item) => item.state === 'stopped'))
  const stored = JSON.parse(await fs.readFile(path.join(userData, 'mcp-settings.json'), 'utf8'))
  assert.equal(stored.version, 1); assert.equal(stored.servers.length, 2)
})

await checks.check('same-window connection reuse and namespace isolation; cross-window runtimes own separate processes', async () => {
  const results = await Promise.all([api.connectMcpServer(1, 'first'), api.connectMcpServer(1, 'first')])
  assert.equal(tool(results[0]).connectionToken, tool(results[1]).connectionToken)
  const configuration = (await api.listMcpConfigs()).find((item) => item.id === 'first')
  assert.equal((await rows(configuration.args[1])).filter((row) => row.pid).length, 1)
  const second = await api.connectMcpServer(1, 'second'), otherWindow = await api.connectMcpServer(2, 'first')
  assert.notEqual(tool(results[0]).qualifiedName, tool(second).qualifiedName)
  assert.notEqual(tool(results[0]).connectionToken, tool(otherWindow).connectionToken)
  assert.equal(JSON.parse(await api.callMcpTool(1, tool(results[0]), { text: 'actual-echo' }, signal())).content[0].text, 'actual-echo')
})

await checks.check('real Agent runtime converts function schemas and executes MCP through a real default approval card', async () => {
  const captured = (await api.listMcpServers(1)).find((item) => item.id === 'first'), descriptor = tool(captured)
  const requestId = randomUUID(), conversationId = randomUUID(), requests = []
  let round = 0, approved = 0
  const session = api.createProviderSession({ id: 'scripted-test', label: 'offline fixture only', capabilities: { tools: true }, createSender(request) {
    requests.push(request)
    return async (input) => {
      if (++round === 1) return { status: 'completed', output: [{ type: 'function_call', call_id: 'fixture-' + requestId, name: descriptor.qualifiedName, arguments: JSON.stringify({ text: 'agent-mcp-echo' }) }] }
      const output = input.findLast((item) => item.type === 'function_call_output')
      assert.equal(JSON.parse(output.output).content[0].text, 'agent-mcp-echo')
      return { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Agent received actual MCP echo.' }] }] }
    }
  } })
  const runtime = api.createAgentRuntime({ session, capabilities: { mode: 'execute', mcpTools: captured.tools } })
  const modelTool = requests[0].tools.find((item) => item.name === descriptor.qualifiedName)
  assert.deepEqual(modelTool, { type: 'function', name: descriptor.qualifiedName, description: descriptor.description, strict: false, parameters: descriptor.inputSchema })
  const onCard = (channel, value) => {
    if (channel === 'execution:approval-change' && value) {
      assert.equal(value.kind, 'mcp'); assert.equal(value.serverId, 'first'); approved++
      queueMicrotask(() => invoke('execution:approval-respond', [{ approvalId: value.approvalId, approved: true }]))
    }
  }
  owner(1).webContents.on('send', onCard)
  try {
    const outcome = await api.runAgentCore({ requestId, conversationId, prompt: 'Run fixed echo fixture', history: [], mode: 'execute', scope: { kind: 'time' } }, {
      signal: signal(), ...runtime, assertCurrent: () => true,
      createTools: (observer) => api.createAgentRuntimeTools({ conversationId, mode: 'execute', execution: { info: { cwd: evidence, mode: 'default', revision: 0, scopeId: 'a'.repeat(64) }, writableRoots: [evidence] },
        assertCurrent: () => true, approve: async () => false, authorizeCommand: async () => null, projectSnapshot: null, executeCommandProposal: async () => { throw Error('No command execution') },
        mcpTools: captured.tools, validateMcpTool: (item) => api.assertMcpToolCurrent(1, item), callMcpTool: (item, args, abort) => api.callMcpTool(1, item, args, abort),
        approveMcpTool: (item, argumentsText, abort) => api.requestExecutionApproval(1, { kind: 'mcp', requestId, conversationId, cwd: evidence, serverId: item.serverId, serverName: 'first', toolName: item.name, argumentsText }, abort)
      }, observer)
    })
    assert.equal(outcome.result.status, 'done', JSON.stringify(outcome.result)); assert.equal(approved, 1)
  } finally { owner(1).webContents.removeListener('send', onCard) }
})

await checks.check('plan exposes no MCP tools; unfrozen MCP names cannot bypass executor via regex', async () => {
  const captured = (await api.listMcpServers(1)).find((item) => item.id === 'first')
  for (const mode of ['plan', 'execute']) {
    let exposed
    const session = api.createProviderSession({ id: 'test', label: 'test', capabilities: { tools: true }, createSender(request) { exposed = request.tools; return async () => ({ status: 'completed', output: [{ type: 'function_call', call_id: 'unknown-' + mode, name: 'mcp__unknown__echo', arguments: '{}' }] }) } })
    const runtime = api.createAgentRuntime({ session, capabilities: { mode, mcpTools: captured.tools } })
    if (mode === 'plan') assert(!exposed.some((item) => item.name.startsWith('mcp__')))
    const outcome = await api.runAgentCore({ requestId: randomUUID(), conversationId: randomUUID(), prompt: 'fixed', history: [], scope: { kind: 'time' }, mode }, { signal: signal(), ...runtime, assertCurrent: () => true, createTools: () => async () => { throw Error('Must never reach executor') } })
    assert.equal(outcome.result.status, 'error'); assert.match(outcome.result.error, /白名单/)
  }
})

await checks.check('list_changed notifications serialize refresh and invalidate captured schemas before approval/call', async () => {
  const status = (await api.listMcpServers(1)).find((item) => item.id === 'first'), previous = tool(status)
  await api.callMcpTool(1, tool(status, 'burst'), {}, signal())
  await until(async () => tool((await api.listMcpServers(1)).find((item) => item.id === 'first')).schemaFingerprint !== previous.schemaFingerprint, 'updated schema')
  await assert.rejects(api.callMcpTool(1, previous, { text: 'old' }, signal()), /schema/)
  const configuration = (await api.listMcpConfigs()).find((item) => item.id === 'first')
  await until(async () => (await rows(configuration.args[1])).filter((row) => row.method === 'tools/list').length >= 5, 'all list changed refreshes')
  assert((await rows(configuration.args[1])).filter((row) => row.listing).every((row) => row.listing === 1))
})

await checks.check('pending calls and continuation proofs invalidate after schema/config changes; restart cannot restore grants', async () => {
  const config = (await api.listMcpConfigs()).find(item => item.id === 'first')
  let status = (await api.listMcpServers(1)).find(item => item.id === 'first')
  const captured = tool(status)
  api.captureMcpTaskTools(1, 'resume64', status.tools)
  api.assertMcpTaskResume(1, 'resume64', [])
  const pending = api.callMcpTool(1, tool(status, 'hold'), {}, signal()).then(() => 'unexpected', () => 'rejected')
  await until(async () => (await rows(config.args[1])).some(row => row.method === 'tools/call' && row.params.name === 'hold'), 'pending schema-sensitive call')
  await api.callMcpTool(1, tool(status, 'burst'), {}, signal())
  await until(async () => tool((await api.listMcpServers(1)).find(item => item.id === 'first')).schemaFingerprint !== captured.schemaFingerprint, 'schema replaced')
  assert.throws(() => api.assertMcpTaskResume(1, 'resume64', []), /schema/)
  assert.throws(() => api.assertMcpTaskResume(99, 'resume64', [{ type: 'function_call', name: captured.qualifiedName }]), /快照/)
  await api.upsertMcpServer({ ...config, name: 'configuration changed during pending call' })
  assert.equal(await pending, 'rejected')
  assert.throws(() => api.assertMcpTaskResume(1, 'resume64', []), /配置/)
})

await checks.check('MCP arguments cannot obtain workspace tool authority; environment contains no model credentials', async () => {
  const status = (await api.listMcpServers(1)).find((item) => item.id === 'first')
  await assert.rejects(api.callMcpTool(1, tool(status), { text: 'x', path: evidence, tool: 'read_workspace_file' }, signal()), /schema/)
  await assert.rejects(api.callMcpTool(1, { ...tool(status), name: 'read_workspace_file', qualifiedName: 'read_workspace_file' }, { path: evidence }, signal()))
  const response = JSON.parse(await api.callMcpTool(1, tool(status, 'environment'), {}, signal()))
  assert.equal(response.content[0].text, '[]')
})

await checks.check('JSON-RPC errors, invalid JSON, mismatched request IDs, duplicate names and startup failure are handled', async () => {
  const { client } = await clientFor()
  await assert.rejects(client.call(tool({ tools: client.getTools() }, 'error'), {}, signal()), /请求错误/)
  for (const name of ['invalid', 'wrongid']) {
    const value = await clientFor(); await assert.rejects(value.client.call(tool({ tools: value.client.getTools() }, name), {}, signal()))
    await value.client.close(); assert(!alive(value.pid))
  }
  const duplicate = new api.McpClient(config('duplicate', 'duplicates')); clients.push(duplicate)
  await assert.rejects(duplicate.connect(), /schema/); await duplicate.close()
  await api.upsertMcpServer({ ...config('missing'), command: path.join(evidence, 'missing.exe') })
  assert.equal((await api.connectMcpServer(1, 'missing')).state, 'failed')
})

await checks.check('result truncation includes marker within 12000 characters', async () => {
  const { client } = await clientFor()
  const output = await client.call(tool({ tools: client.getTools() }, 'large'), {}, signal())
  assert.equal(output.length, 12000); assert(output.endsWith('[结果已截断]'))
})

await checks.check('timeout and cancellation send exact request IDs, retire processes, and repeated close is safe', async () => {
  for (const cancel of [false, true]) {
    const value = await clientFor('stubborn'), abort = new AbortController()
    const pending = value.client.call(tool({ tools: value.client.getTools() }, 'hold'), {}, abort.signal)
    const rejected = assert.rejects(pending, cancel ? /取消/ : /超时/)
    await until(async () => (await rows(value.configuration.args[1])).some((row) => row.method === 'tools/call'), 'hold request')
    if (cancel) abort.abort()
    await rejected
    await until(async () => (await rows(value.configuration.args[1])).some((row) => row.method === 'notifications/cancelled'), 'cancel notification')
    const audit = await rows(value.configuration.args[1]), request = audit.find((row) => row.method === 'tools/call'), notification = audit.find((row) => row.method === 'notifications/cancelled')
    assert.equal(notification.params.requestId, request.id)
    await until(() => !alive(value.pid), 'cancelled process exited')
    await Promise.all([value.client.close(), value.client.close()])
  }
})

await checks.check('window closes during initialize and pending call leave no process or late connected state', async () => {
  for (const startOnly of [true, false]) {
    const configuration = config('closing_' + Number(startOnly), startOnly ? 'slow-initialize' : 'stubborn')
    await api.upsertMcpServer(configuration)
    const window = owner(startOnly ? 3 : 4); api.attachMcpCleanup(window)
    const connection = api.connectMcpServer(window.id, configuration.id)
    const pid = await pidFor(configuration)
    let called
    if (!startOnly) { const status = await connection; called = api.callMcpTool(window.id, tool(status, 'hold'), {}, signal()).then(() => 'unexpected-success', () => 'rejected'); await until(async () => (await rows(configuration.args[1])).some((row) => row.method === 'tools/call'), 'pending call') }
    window.emit('closed'); await api.cleanupMcpWindow(window.id); await connection
    if (called) assert.equal(await called, 'rejected')
    assert(!alive(pid))
  }
})

await checks.check('configuration replacement discards initializing connection and frozen call; new runtime wins', async () => {
  const previous = config('replace', 'slow-initialize'); await api.upsertMcpServer(previous)
  const connecting = api.connectMcpServer(1, previous.id), oldPid = await pidFor(previous)
  const next = { ...config('replace'), name: 'new configuration' }
  await api.upsertMcpServer(next); await connecting
  const current = (await api.listMcpServers(1)).find((item) => item.id === next.id)
  assert.equal(current.name, 'new configuration'); assert.equal(current.state, 'connected'); assert(!alive(oldPid))
  const captured = tool(current)
  await api.upsertMcpServer({ ...next, name: 'newer configuration' })
  await assert.rejects(api.callMcpTool(1, captured, { text: 'stale' }, signal()), /配置/)
})

await checks.check('abnormal exit updates own status; disconnected calls are refused; process trees close', async () => {
  const configuration = config('crashing'); await api.upsertMcpServer(configuration)
  const current = await api.connectMcpServer(1, configuration.id)
  await assert.rejects(api.callMcpTool(1, tool(current, 'crash'), {}, signal()))
  await until(async () => (await api.listMcpServers(1)).find((item) => item.id === 'crashing').state === 'failed', 'failed status')
  const value = await clientFor('descendant')
  const descendant = (await until(async () => (await rows(value.configuration.args[1])).find((row) => row.descendant), 'descendant')).descendant
  await value.client.close(); assert(!alive(value.pid)); assert(!alive(descendant))
  const connected = (await api.listMcpServers(1)).find((item) => item.id === 'first'); const captured = tool(connected)
  await api.disconnectMcpServer(1, 'first'); await assert.rejects(api.callMcpTool(1, captured, { text: 'stopped' }, signal()), /未连接/)
})
} finally {
  await api.cleanupAllMcp()
  await Promise.all(clients.map((client) => client.close()))
  await delay(50)
  const pids = (await Promise.all(logs.map(rows))).flat().flatMap((row) => [row.pid, row.descendant].filter(Boolean))
  await checks.check('all actual fixture processes and observed descendants have exited', async () => { assert(pids.length > 0); assert.deepEqual(pids.filter(alive), []); return { observedProcesses: pids.length } })
}
await checks.finish({ compiledProductModules: true, actualStdioProcesses: true, syntheticElectronBoundary: true, realAgentToolLoop: true, realApprovalBroker: true, externalNetwork: false, eventsObserved: events.length })
