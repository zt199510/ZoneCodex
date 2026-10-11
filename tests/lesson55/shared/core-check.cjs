const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const Module = require('node:module')
const { createHash, randomUUID } = require('node:crypto')
const { build } = require('esbuild')
const { load } = require('./harness.cjs')
const { questions } = require('./fixture.cjs')
const root = process.cwd()
const checks = []
const scope = { kind: 'time', executionId: 'a'.repeat(64) }
const message = (text = '完成', phase = 'final_answer') => ({
  type: 'message',
  role: 'assistant',
  phase,
  content: [{ type: 'output_text', text }]
})
const call = (id, name = 'get_current_time', args = '{}') => ({
  type: 'function_call',
  call_id: id,
  name,
  arguments: typeof args === 'string' ? args : JSON.stringify(args)
})
const response = (...output) => ({ status: 'completed', output })
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const input = (extra) => ({
  requestId: 'request-core',
  conversationId: 'conversation-core',
  mode: 'execute',
  prompt: '固定的内部验证任务',
  history: [],
  scope: structuredClone(scope),
  ...extra
})
function gate(signal) {
  let resolve
  const promise = new Promise((yes, no) => {
    resolve = yes
    if (signal.aborted) no(signal.reason)
    else signal.addEventListener('abort', () => no(signal.reason), { once: true })
  })
  return { promise, resolve }
}
async function test(name, action) {
  try {
    const details = await action()
    checks.push({ name, passed: true, ...(details ? { details } : {}) })
  } catch (error) {
    checks.push({ name, passed: false, error: error.stack ?? String(error) })
    console.error(name + ': ' + (error.stack ?? String(error)))
  }
}
let core, runDirectory, compiled, sourceHashes, runtimeImports
const run = (send, options = {}) =>
  core.runAgentCore(options.input ?? input(), {
    signal: options.signal ?? new AbortController().signal,
    send,
    createTools: options.createTools ?? (() => options.execute ?? (async () => 'ok')),
    assertCurrent: options.assertCurrent ?? (() => true),
    onEvent: options.onEvent,
    ...options.dependencies
  })
async function main() {
  runDirectory = path.join(__dirname, 'core-run-' + randomUUID())
  await fs.mkdir(runDirectory)
  sourceHashes = {}
  for (const file of [
    'src/main/agent/agent-core.ts',
    'src/main/agent/agent-core-contract.ts',
    'src/main/agent/tool-loop.ts',
    'src/shared/agent-history.ts'
  ])
    sourceHashes[file] = hash(await fs.readFile(path.join(root, file)))
  compiled = path.join(runDirectory, 'agent-core.cjs')
  const bundled = await build({
    entryPoints: [path.join(root, 'src/main/agent/agent-core.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: compiled,
    external: ['electron'],
    write: true,
    metafile: true,
    logLevel: 'silent'
  })
  runtimeImports = {
    inputs: Object.keys(bundled.metafile.inputs),
    outputs: bundled.metafile.outputs
  }
  await fs.writeFile(
    path.join(runDirectory, 'runtime-imports.json'),
    JSON.stringify(runtimeImports, null, 2) + '\n',
    { flag: 'wx' }
  )
  const originalLoad = Module._load
  let electronAttempts = 0
  Module._load = function (id, ...args) {
    if (id === 'electron' || id.startsWith('electron/')) {
      electronAttempts++
      throw new Error('Electron must never load in ordinary Node core')
    }
    return originalLoad.call(this, id, ...args)
  }
  try {
    core = require(compiled)
  } finally {
    Module._load = originalLoad
  }
  await test('ordinary Node imports compiled actual core with Electron import rejection and no window globals', async () => {
    assert.equal(process.versions.electron, undefined)
    assert.notEqual(process.env.ELECTRON_RUN_AS_NODE, '1')
    assert.equal(typeof globalThis.window, 'undefined')
    assert.equal(typeof globalThis.document, 'undefined')
    assert.equal(electronAttempts, 0)
    assert.ok(runtimeImports.inputs.some((file) => file.endsWith('tool-loop.ts')))
    for (const file of runtimeImports.inputs)
      assert.equal(
        /src\/main\/.*(?:agent-runner|agent-user-input|execution-context|task-registry|windows-command-backend|image-access)/.test(
          file.replaceAll('\\', '/')
        ),
        false,
        file
      )
    const outcome = await run(async () => response(message()))
    assert.equal(outcome.result.status, 'done')
    assert.equal(outcome.task.state, 'completed')
    return {
      executable: process.execPath,
      node: process.versions.node,
      compiled,
      runtimeInputCount: runtimeImports.inputs.length,
      electronAttempts
    }
  })
  await test('actual core and unique loop complete 12 tools and 13 rounds beyond removed 8/9 caps', async () => {
    let rounds = 0,
      executions = 0
    const events = []
    const outcome = await run(
      async () =>
        ++rounds <= 12
          ? response(message('公开进度 ' + rounds, 'commentary'), call('many-' + rounds))
          : response(
              {
                type: 'reasoning',
                summary: [{ type: 'summary_text', text: 'PRIVATE_REASONING' }],
                encrypted_content: 'PRIVATE_CIPHER'
              },
              message()
            ),
      {
        execute: async () => {
          executions++
          return 'ok'
        },
        onEvent: (event) => events.push(event)
      }
    )
    assert.equal(outcome.result.status, 'done')
    assert.equal(rounds, 13)
    assert.equal(executions, 12)
    assert.equal(
      outcome.result.items.filter((item) => item.type === 'function_call_output').length,
      12
    )
    assert.ok(
      events.some(
        (event) =>
          event.type === 'message' && event.event.messageId === 'response-10-attempt-0-message-0'
      )
    )
    assert.equal(JSON.stringify(events).includes('PRIVATE_REASONING'), false)
    assert.equal(JSON.stringify(events).includes('PRIVATE_CIPHER'), false)
    return { rounds, executions, semanticEventCount: events.length }
  })
  await test('fixed request and dependencies survive mutation during active model wait', async () => {
    const seed = input({ history: [{ role: 'user', content: '旧问题' }, message('旧答复')] })
    const events = []
    let received, callbacks, pending
    const controller = new AbortController()
    const dependencies = {
      signal: controller.signal,
      send: async (items, signal, hooks) => {
        received = structuredClone(items)
        callbacks = hooks
        pending = gate(signal)
        return pending.promise
      },
      createTools: () => async () => 'ok',
      assertCurrent: () => true,
      onEvent: (event) => events.push(event)
    }
    const completion = core.runAgentCore(seed, dependencies)
    seed.requestId = 'request-mutated'
    seed.prompt = '改动的问题'
    seed.mode = 'plan'
    seed.history[0].content = '改动的历史'
    seed.scope.executionId = 'b'.repeat(64)
    dependencies.send = async () => {
      throw new Error('must be frozen')
    }
    dependencies.assertCurrent = () => false
    dependencies.onEvent = () => {
      throw new Error('must be frozen')
    }
    dependencies.createTools = undefined
    callbacks.onTextDelta('真实合成增量')
    callbacks.onMessageEvent({
      outputIndex: 0,
      attempt: 0,
      phase: 'commentary',
      text: '公开固定进度'
    })
    pending.resolve(response(message('公开固定进度', 'commentary'), message('固定完成')))
    const outcome = await completion
    assert.equal(outcome.result.status, 'done')
    assert.equal(received[0].content, '旧问题')
    assert.equal(received.at(-1).content, '固定的内部验证任务')
    for (const event of events)
      assert.equal(event.requestId ?? event.event.requestId, 'request-core')
    assert.ok(outcome.result.trace.some((line) => line.includes('执行')))
  })
  await test('invalid identities mode scope and history fail before model or tool creation', async () => {
    for (const invalid of [
      { requestId: '' },
      { conversationId: '' },
      { mode: 'unknown' },
      { scope: { kind: 'invalid' } },
      { history: [{ type: 'function_call_output', call_id: 'missing', output: 'ok' }] }
    ]) {
      let requests = 0,
        factories = 0
      const outcome = await run(
        async () => {
          requests++
          return response(message())
        },
        {
          input: input(invalid),
          createTools: () => {
            factories++
            return async () => 'ok'
          }
        }
      )
      assert.equal(outcome.result.status, 'error')
      assert.equal(requests, 0)
      assert.equal(factories, 0)
    }
  })
  await test('missing tool capability is explicit failure and never defaults to permission', async () => {
    let requests = 0
    const outcome = await run(
      async () => {
        requests++
        return response(message())
      },
      { createTools: () => undefined }
    )
    assert.equal(outcome.result.status, 'error')
    assert.match(outcome.result.error, /工具适配/)
    assert.equal(requests, 0)
    assert.deepEqual(outcome.effects, { approved: false, started: false })
  })
  await test('plan forbids hidden write before synthetic executor or public tool event', async () => {
    let calls = 0
    const events = []
    const outcome = await run(
      async () => response(call('hidden-patch', 'apply_workspace_patch', '{}')),
      {
        input: input({ mode: 'plan' }),
        execute: async () => {
          calls++
          return 'must not execute'
        },
        onEvent: (event) => events.push(event)
      }
    )
    assert.equal(outcome.result.status, 'error')
    assert.match(outcome.result.error, /计划模式/)
    assert.equal(calls, 0)
    assert.equal(
      events.some((event) => event.type === 'tool'),
      false
    )
  })
  await test('plan question pauses and resumes exact answers via fixed synthetic adapter', async () => {
    let pending,
      requests = 0,
      outputSeen
    const controller = new AbortController()
    const completion = run(
      async (items) => {
        requests++
        if (requests === 1)
          return response(
            call('question', 'request_user_input', {
              questions: [
                {
                  id: 'direction',
                  header: '方向',
                  question: '选择布局',
                  options: [
                    { label: '卡片', description: '卡片布局' },
                    { label: '列表', description: '列表布局' }
                  ]
                }
              ]
            })
          )
        outputSeen = items.find((item) => item.type === 'function_call_output').output
        return response(message('已采用卡片'))
      },
      {
        input: input({ mode: 'plan' }),
        signal: controller.signal,
        execute: async (_name, _args, signal) => {
          pending = gate(signal)
          return pending.promise
        }
      }
    )
    for (let index = 0; !pending && index < 20; index++) await Promise.resolve()
    assert.ok(pending)
    assert.equal(requests, 1)
    pending.resolve(JSON.stringify({ answers: [{ id: 'direction', answer: '卡片' }] }))
    const outcome = await completion
    assert.equal(outcome.result.status, 'done')
    assert.equal(requests, 2)
    assert.deepEqual(JSON.parse(outputSeen), { answers: [{ id: 'direction', answer: '卡片' }] })
    return { syntheticQuestionAdapter: true, waitingModelRequests: 1 }
  })
  await test('cancellation releases synthetic question wait and prevents resumed model call', async () => {
    const controller = new AbortController()
    let pending,
      requests = 0
    const completion = run(
      async () => {
        requests++
        return response(call('question-cancel', 'request_user_input', questions))
      },
      {
        input: input({ mode: 'plan' }),
        signal: controller.signal,
        execute: async (_name, _args, signal) => {
          pending = gate(signal)
          return pending.promise
        }
      }
    )
    for (let index = 0; !pending && index < 20; index++) await Promise.resolve()
    assert.ok(pending)
    controller.abort()
    const outcome = await completion
    assert.equal(outcome.result.status, 'cancelled')
    assert.equal(requests, 1)
    assert.equal(outcome.result.items.at(-1).type, 'function_call')
    pending.resolve('late answer')
    assert.equal(requests, 1)
  })
  await test('model cancellation rejects late streaming callbacks and leaves final evidence stable', async () => {
    const controller = new AbortController()
    const events = []
    let callbacks, pending
    const completion = run(
      async (_items, signal, hooks) => {
        callbacks = hooks
        pending = gate(signal)
        return pending.promise
      },
      { signal: controller.signal, onEvent: (event) => events.push(event) }
    )
    callbacks.onMessageEvent({ outputIndex: 0, phase: 'commentary', text: '中断前公开片段' })
    controller.abort()
    const outcome = await completion
    assert.equal(outcome.result.status, 'cancelled')
    const evidence = JSON.stringify(outcome)
    const count = events.length
    assert.throws(() => callbacks.onTextDelta('迟到'))
    assert.throws(() =>
      callbacks.onMessageEvent({ outputIndex: 0, phase: 'commentary', text: '迟到' })
    )
    pending.resolve(response(message('迟到答复')))
    assert.equal(events.length, count)
    assert.equal(JSON.stringify(outcome), evidence)
    assert.ok(outcome.result.items.some((item) => item.phase === 'commentary'))
  })
  await test('cancel racing completed tool keeps actual returned output without public late delivery', async () => {
    const controller = new AbortController()
    const events = []
    let requests = 0
    const outcome = await run(
      async () => {
        requests++
        return response(call('raced-tool'))
      },
      {
        signal: controller.signal,
        onEvent: (event) => events.push(event),
        createTools: (observer) => async () => {
          observer.effectStarted()
          controller.abort()
          return JSON.stringify({ status: 'created', path: 'synthetic-only' })
        }
      }
    )
    assert.equal(outcome.result.status, 'cancelled')
    assert.equal(requests, 1)
    assert.equal(outcome.result.items.at(-1).type, 'function_call_output')
    assert.match(outcome.task.error, /本地操作可能已经执行/)
    assert.equal(events.filter((event) => event.type === 'tool').length, 1)
    assert.equal(outcome.effects.started, true)
  })
  await test('completed observer callbacks are inert and cannot mutate subsequent invocation', async () => {
    let observer
    const outcome = await run(async () => response(message()), {
      createTools: (value) => {
        observer = value
        return async () => 'ok'
      }
    })
    const before = JSON.stringify(outcome)
    observer.actionApproved('late')
    observer.effectStarted()
    observer.appendTrace('late')
    observer.progress('late')
    assert.equal(JSON.stringify(outcome), before)
    const next = await run(async () => response(message()))
    assert.deepEqual(next.effects, { approved: false, started: false })
  })
  await test('invalid context before request and before next round prevents further transport', async () => {
    let requests = 0
    const first = await run(
      async () => {
        requests++
        return response(message())
      },
      { assertCurrent: () => false }
    )
    assert.equal(first.result.status, 'error')
    assert.equal(requests, 0)
    let current = true
    const second = await run(
      async () => {
        requests++
        return response(call('context-tool'))
      },
      {
        assertCurrent: () => current,
        execute: async () => {
          current = false
          return 'ok'
        }
      }
    )
    assert.equal(second.result.status, 'error')
    assert.equal(requests, 1)
    assert.match(second.result.error, /失效/)
    assert.equal(second.result.items.at(-1).type, 'function_call_output')
  })
  await test('model or tool error after approval preserves action risk and existing evidence', async () => {
    for (const failure of ['model', 'tool', 'event']) {
      let requests = 0
      const outcome = await run(
        async () => {
          if (++requests === 1) return response(call('effect-' + failure))
          throw new Error('synthetic model error')
        },
        {
          createTools: (observer) => async () => {
            observer.actionApproved('create')
            observer.effectStarted()
            if (failure === 'tool') throw new Error('synthetic tool error')
            return JSON.stringify({ status: 'created' })
          },
          onEvent: (event) => {
            if (failure === 'event' && event.type === 'tool' && event.event.phase === 'finish')
              throw new Error('synthetic host delivery error')
          }
        }
      )
      assert.equal(outcome.result.status, 'error')
      assert.match(outcome.result.error, /本地操作可能已经执行/)
      assert.equal(outcome.task.state, 'failed')
      assert.deepEqual(outcome.effects, { approved: true, started: true })
      assert.equal(
        outcome.result.items.at(-1).type,
        failure === 'tool' ? 'function_call' : 'function_call_output'
      )
    }
  })
  await test('nonzero command remains failed tool output and loop completion is not business success', async () => {
    let requests = 0
    const failure = {
      status: 'failed',
      exitCode: 7,
      treeExited: true,
      stdout: '',
      stderr: 'fixed red test'
    }
    const outcome = await run(
      async () =>
        ++requests === 1
          ? response(call('command-fail', 'run_workspace_command', '{}'))
          : response(message('测试失败，仍需修正')),
      { execute: async () => JSON.stringify(failure) }
    )
    assert.equal(outcome.result.status, 'done')
    assert.equal(outcome.task.state, 'completed')
    assert.deepEqual(
      JSON.parse(outcome.result.items.find((item) => item.type === 'function_call_output').output),
      failure
    )
    return { commandProcess: 'synthetic result only', businessPassed: false }
  })
  await test('uncertain process-tree shutdown is preserved in failure trace and risk', async () => {
    const errors = await load('src/main/errors.ts')
    const outcome = await run(
      async () => response(call('command-uncertain', 'run_workspace_command')),
      {
        createTools: (observer) => async () => {
          observer.effectStarted()
          throw new errors.AgentError('进程树是否退出未确认')
        }
      }
    )
    assert.equal(outcome.result.status, 'error')
    assert.ok(outcome.result.trace.some((line) => line.includes('进程树是否退出未确认')))
    assert.match(outcome.result.error, /本地操作可能已经执行/)
  })
  await test('completed command proposal remains waiting approval', async () => {
    let round = 0
    const projectScope = {
      kind: 'project',
      snapshotId: 'snapshot-core',
      executionId: 'a'.repeat(64)
    }
    const outcome = await run(
      async () =>
        ++round === 1
          ? response(call('proposal', 'propose_command', '{}'))
          : response(message('命令提案已生成')),
      {
        input: input({ scope: projectScope }),
        execute: async () => JSON.stringify({ status: 'proposed', proposalId: 'proposal-core' })
      }
    )
    assert.equal(outcome.result.status, 'done')
    assert.equal(outcome.task.state, 'waiting_approval')
  })
  await test('retry retires failed commentary and retains success tool once with correct attempt identity', async () => {
    let round = 0,
      executions = 0
    const events = []
    const outcome = await run(
      async (_items, _signal, hooks) => {
        if (++round === 1) return response(call('tool-once'))
        hooks.onMessageEvent({
          outputIndex: 0,
          phase: 'commentary',
          text: '失败尝试片段',
          attempt: 0
        })
        hooks.onRetry({ retry: 1, maxRetries: 5, delayMs: 0, reason: 'http', status: 502 })
        hooks.onMessageEvent({ outputIndex: 0, phase: 'commentary', text: '恢复片段', attempt: 1 })
        throw new Error('synthetic failure after retry')
      },
      {
        execute: async () => {
          executions++
          return 'successful-tool'
        },
        onEvent: (event) => events.push(event)
      }
    )
    assert.equal(outcome.result.status, 'error')
    assert.equal(executions, 1)
    assert.equal(JSON.stringify(outcome.result.items).includes('失败尝试片段'), false)
    assert.equal(JSON.stringify(outcome.result.items).includes('恢复片段'), true)
    assert.equal(
      outcome.result.items.filter((item) => item.type === 'function_call_output').length,
      1
    )
    assert.ok(events.some((event) => event.type === 'retry' && event.event.round === 2))
  })
  await test('all five automatic retries use actual response client and freeze post-tool request', async () => {
    const clientFile = path.join(runDirectory, 'client.cjs')
    await build({
      entryPoints: [path.join(root, 'src/main/model/response-client.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: clientFile,
      logLevel: 'silent',
      define: {
        'process.env.MODEL_ENDPOINT': JSON.stringify(
          'https://lesson55.synthetic.invalid/responses'
        ),
        'process.env.MODEL_NAME': JSON.stringify('synthetic-only'),
        'process.env.MODEL_API_KEY': JSON.stringify('synthetic-key')
      }
    })
    const client = require(clientFile)
    const requests = []
    const retries = []
    const previousFetch = globalThis.fetch
    const originalTimeout = globalThis.setTimeout
    let executions = 0
    globalThis.setTimeout = (fn, ms, ...args) => originalTimeout(fn, ms >= 1000 ? 0 : ms, ...args)
    const queue = [
      response(call('retry-tool')),
      502,
      502,
      502,
      502,
      502,
      response(message('五次重试后完成'))
    ]
    globalThis.fetch = async (_url, init) => {
      requests.push(init.body)
      const next = queue.shift()
      assert.notEqual(next, undefined)
      if (next === 502) return new Response('', { status: 502 })
      return new Response(
        'data: ' + JSON.stringify({ type: 'response.completed', response: next }) + '\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } }
      )
    }
    try {
      const outcome = await run(
        client.createLiveResponse([], '实际客户端固定合成传输', {
          endpoint: 'https://lesson55.synthetic.invalid/responses',
          model: 'synthetic-only',
          apiKey: 'synthetic-key'
        }),
        {
          execute: async () => {
            executions++
            return 'tool-result-once'
          },
          onEvent: (event) => {
            if (event.type === 'retry') retries.push(event.event)
          }
        }
      )
      assert.equal(outcome.result.status, 'done')
      assert.equal(executions, 1)
      assert.equal(retries.length, 5)
      assert.deepEqual(
        retries.map((value) => value.retry),
        [1, 2, 3, 4, 5]
      )
      assert.equal(requests.length, 7)
      for (const request of requests.slice(1)) assert.equal(request, requests[1])
      return {
        syntheticHttpRequests: requests.length,
        clientRetries: retries.length,
        toolExecutions: executions,
        delayClock: 'real client delay timers accelerated only in this fixture'
      }
    } finally {
      globalThis.fetch = previousFetch
      globalThis.setTimeout = originalTimeout
    }
  })
  await test('ordinary Node actual core enforces 160 turn items and 128000 complete input characters', async () => {
    for (const count of [79, 80]) {
      let requests = 0,
        executions = 0
      const outcome = await run(
        async () =>
          ++requests <= count ? response(call('capacity-' + requests)) : response(message()),
        {
          execute: async () => {
            executions++
            return 'ok'
          }
        }
      )
      assert.equal(outcome.result.status, count === 79 ? 'done' : 'error')
      assert.equal(executions, 79)
      if (count === 79) assert.equal(outcome.result.items.length, 160)
      else assert.match(outcome.result.error, /协议历史过长/)
    }
    let requests = 0
    const over = await run(async () => response(call('chars-' + ++requests)), {
      execute: async () => 'x'.repeat(12000)
    })
    assert.equal(over.result.status, 'error')
    assert.match(over.result.error, /协议历史过长/)
    assert.ok(requests > 9 && requests < 20)
  })
  await test('cross-round history above 300 short items remains accepted under current capacity', async () => {
    const history = []
    for (let index = 0; index < 170; index++)
      history.push({ role: 'user', content: '历史' + index }, message('答复' + index))
    let received
    const outcome = await run(
      async (items) => {
        received = items.length
        return response(message())
      },
      { input: input({ history }) }
    )
    assert.equal(outcome.result.status, 'done')
    assert.equal(received, 341)
  })
  const commandIsolation = {
    '../execution/command-runner': {
      startCommandProcess() {
        throw new Error('No command process authorized by this disk fixture')
      }
    },
    '../execution/command-plan': {
      discardCommandExecution() {
        /* Deliberate no-op fixture callback. */
      },
      claimCommandExecution() {
        throw new Error('No command plan authorized by this disk fixture')
      }
    }
  }
  // Compile the actual core and tool executor together so their AgentError class
  // retains production identity; the independent-only Node proof remains above.
  const integration = await build({
    stdin: {
      contents:
        "export { runAgentCore } from './src/main/agent/agent-core'; export { createAgentToolExecutor } from './src/main/agent/agent-tools'",
      resolveDir: root,
      loader: 'ts'
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    logLevel: 'silent',
    external: ['electron'],
    plugins: [
      {
        name: 'command-isolation',
        setup(builder) {
          builder.onResolve({ filter: /.*/ }, ({ path: id }) =>
            Object.hasOwn(commandIsolation, id) ? { path: '@isolated/' + id, external: true } : null
          )
        }
      }
    ]
  })
  const integrationFile = path.join(runDirectory, 'core-and-original-tools.cjs')
  await fs.writeFile(integrationFile, integration.outputFiles[0].text, { flag: 'wx' })
  const loaded = new Module(integrationFile, module)
  loaded.filename = integrationFile
  loaded.paths = Module._nodeModulePaths(root)
  loaded.require = (id) =>
    id.startsWith('@isolated/') ? commandIsolation[id.slice(10)] : require(id)
  loaded._compile(integration.outputFiles[0].text, integrationFile)
  const actualTools = loaded.exports
  core = loaded.exports
  function realFactory(directory, counters, requestMode = 'execute') {
    return (observer) =>
      actualTools.createAgentToolExecutor({
        mode: requestMode,
        execution: {
          info: { cwd: directory, scopeId: scope.executionId, mode: 'full-access', revision: 1 },
          writableRoots: [directory]
        },
        assertCurrent: () => true,
        approve: async (action) => {
          counters.approvals++
          observer.actionApproved(action.kind)
          return true
        },
        authorizeCommand: async () => {
          throw new Error('No command authorization in disk fixture')
        },
        onEffect: () => {
          counters.effects++
          observer.effectStarted()
        },
        appendTrace: observer.appendTrace,
        onProgress: observer.progress,
        projectSnapshot: null,
        projectExecutor: undefined,
        executeCommandProposal: async () => {
          throw new Error('No proposal authorization in disk fixture')
        }
      })
  }
  await test('actual core original executor and real disk perform read evidence local patch backup reread', async () => {
    const directory = path.join(runDirectory, 'actual-core-patch')
    await fs.mkdir(directory)
    const original = Buffer.from('\ufeffhead\r\nOLD\r\nunchanged 中文正文\r\n\r\n\r\n')
    const filename = path.join(directory, 'note.txt')
    await fs.writeFile(filename, original, { flag: 'wx' })
    const counters = { approvals: 0, effects: 0 }
    const steps = [
      call('real-read', 'read_workspace_file', { path: 'note.txt', startLine: 2, endLine: 2 }),
      call('real-patch', 'apply_workspace_patch', {
        path: 'note.txt',
        expectedSha256: hash(original),
        patch: [
          '*** Begin Patch',
          '*** Update File: note.txt',
          '@@',
          '-OLD',
          '+NEW',
          '*** End Patch'
        ].join('\n')
      }),
      call('real-reread', 'read_workspace_file', { path: 'note.txt', startLine: 1, endLine: 3 })
    ]
    const outcome = await run(
      async () =>
        steps.length ? response(steps.shift()) : response(message('实际磁盘隔离补丁完成')),
      { createTools: realFactory(directory, counters) }
    )
    assert.equal(outcome.result.status, 'done')
    assert.deepEqual(counters, { approvals: 1, effects: 1 })
    const expected = Buffer.from(original.toString('utf8').replace('OLD', 'NEW'))
    assert.deepEqual(await fs.readFile(filename), expected)
    const backup = (await fs.readdir(directory)).find((file) => file.endsWith('.bak'))
    assert.ok(backup)
    assert.deepEqual(await fs.readFile(path.join(directory, backup)), original)
    const outputs = outcome.result.items
      .filter((item) => item.type === 'function_call_output')
      .map((item) => JSON.parse(item.output))
    assert.equal(outputs[1].status, 'applied')
    assert.equal(outputs[2].sha256, hash(expected))
    assert.deepEqual(outputs[2].format, outputs[0].format)
    return {
      realReads: 2,
      realPatches: 1,
      backup,
      syntheticModel: true,
      syntheticFileApproval: true
    }
  })
  await test('actual core original executor missing user-input adapter fails without default answer', async () => {
    const counters = { approvals: 0, effects: 0 }
    const outcome = await run(
      async () => response(call('unsupported-question', 'request_user_input', questions)),
      { input: input({ mode: 'plan' }), createTools: realFactory(runDirectory, counters, 'plan') }
    )
    assert.equal(outcome.result.status, 'error')
    assert.match(outcome.result.error, /不支持向用户提问/)
    assert.deepEqual(counters, { approvals: 0, effects: 0 })
    assert.equal(outcome.result.items.at(-1).type, 'function_call')
  })
  await test('actual isolated disk write followed by model failure retains exact file and effect warning', async () => {
    const directory = path.join(runDirectory, 'actual-core-effect-failure')
    await fs.mkdir(directory)
    const counters = { approvals: 0, effects: 0 }
    let requests = 0
    const outcome = await run(
      async () => {
        if (++requests === 1)
          return response(
            call('real-created', 'create_workspace_file', {
              path: 'result.txt',
              content: 'actual isolated effect\n'
            })
          )
        throw new Error('synthetic network error after real file effect')
      },
      { createTools: realFactory(directory, counters) }
    )
    assert.equal(outcome.result.status, 'error')
    assert.match(outcome.result.error, /本地操作可能已经执行/)
    assert.equal(
      await fs.readFile(path.join(directory, 'result.txt'), 'utf8'),
      'actual isolated effect\n'
    )
    assert.deepEqual(counters, { approvals: 1, effects: 1 })
    assert.equal(outcome.result.items.at(-1).type, 'function_call_output')
  })
  const result = {
    generatedAt: new Date().toISOString(),
    suite: 'lesson55-ordinary-node-core',
    passed: checks.every((value) => value.passed),
    total: checks.length,
    failed: checks.filter((value) => !value.passed).length,
    checks,
    sourceHashes,
    compiledSHA256: hash(await fs.readFile(compiled)),
    method: {
      actual: [
        'compiled current agent-core imported by ordinary Node',
        'sole original tool-loop and history parser',
        'actual response-client SSE and five retries',
        'original executor read evidence local patch backup and real isolated disk write'
      ],
      synthetic: [
        'fixed model output queue/HTTP transport',
        'tool/question/command outcomes except three explicitly actual executor cases',
        'file approval responses',
        'effect notifications except actual executor cases'
      ],
      boundaries:
        'Synthetic tool returns prove orchestration only; real plan/evidence/patch/authorization protections are separately verified by protection-check and capacity-check using actual createAgentToolExecutor and isolated disk.'
    },
    noRealModel: true
  }
  await fs.writeFile(
    path.join(runDirectory, 'results.json'),
    JSON.stringify(result, null, 2) + '\n',
    { flag: 'wx' }
  )
  console.log(
    JSON.stringify({
      runDirectory,
      passed: result.passed,
      total: result.total,
      failed: result.failed
    })
  )
  if (!result.passed) process.exitCode = 1
}
main().catch((error) => {
  console.error(error.stack ?? String(error))
  process.exitCode = 1
})
