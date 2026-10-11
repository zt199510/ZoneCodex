const { assert, fs, path, root, load, FakeClock, electronFixture, suite } = require('./harness.cjs')
const { finalMessage, call, response, clone } = require('./fixture.cjs')
const crypto = require('node:crypto')
const checks = suite('lesson55-desktop-runner-protection')
const elapsed = 30 * 60 * 1000
const prompt = '请研究计划，或执行已明确要求的隔离文件操作。'
const answers = [{ id: 'direction', answer: '卡片' }]

function gate(signal) {
  let resolve
  const promise = new Promise((yes, no) => {
    resolve = yes
    if (signal.aborted) no(signal.reason)
    else signal.addEventListener('abort', () => no(signal.reason), { once: true })
  })
  return { promise, resolve }
}
async function waitUntil(predicate, label) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > 10000) throw new Error('Wait failed: ' + label)
    await new Promise((resolve) => setImmediate(resolve))
  }
}
async function settled(completion) {
  let timer
  try {
    return await Promise.race([
      completion,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Runner did not settle')), 10000)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}
async function environment(model, options = {}) {
  const fixture = electronFixture()
  const clock = new FakeClock()
  const scheduled = []
  const originalTimeout = clock.setTimeout.bind(clock)
  clock.setTimeout = (callback, duration) => {
    scheduled.push({ type: 'timeout', duration })
    return originalTimeout(callback, duration)
  }
  const source = fixture.window(1)
  const other = fixture.window(2)
  const cwd = path.join(__dirname, 'cases', crypto.randomUUID())
  await fs.mkdir(cwd, { recursive: true })
  const input = await load(
    'src/main/agent/agent-user-input.ts',
    { electron: fixture.electron },
    { clock }
  )
  input.registerAgentUserInput()
  const approval = await load(
    'src/main/execution/execution-approval.ts',
    { electron: fixture.electron },
    { clock }
  )
  approval.registerExecutionApproval()
  const tasks = await load(
    'src/main/execution/task-registry.ts',
    { electron: fixture.electron },
    { clock }
  )
  const info = { cwd, scopeId: 'a'.repeat(64), mode: options.permission ?? 'default', revision: 1 }
  const execution = { info, writableRoots: [cwd] }
  let current = true
  const spy = { requests: 0, backend: 0, processes: 0 }
  const env = {
    ...fixture,
    clock,
    scheduled,
    source,
    other,
    cwd,
    input,
    approval,
    tasks,
    spy,
    current: () => current,
    invalidate: () => {
      current = false
    },
    question: () => fixture.handlers.get('agent:user-input-get')(source.event()),
    answer: (value) => fixture.handlers.get('agent:user-input-respond')(source.event(), value),
    pendingApproval: () => fixture.handlers.get('execution:approval-get')(source.event()),
    approve: (value) => fixture.handlers.get('execution:approval-respond')(source.event(), value)
  }
  const auth = await load(
    'src/main/execution/action-authorization.ts',
    {
      './execution-context-policy': {
        localPermission: () => (options.permission === 'full-access' ? 'allow' : 'ask')
      },
      './execution-approval': approval,
      './approval-reviewer': {
        reviewExecutionApproval: async () => {
          throw new Error('Unexpected model approval review')
        }
      }
    },
    { clock }
  )
  const dependencies = {
    electron: fixture.electron,
    'node:perf_hooks': { performance: { now: () => clock.now } },
    './agent-user-input': input,
    '../model/response-client': {
      readModelConfiguration: () =>
        Object.freeze({
          endpoint: 'https://fixture.invalid/responses',
          apiKey: 'fixture-only',
          model: 'gpt-6.1-sol'
        }),
      createLiveResponse: () => async (items, signal, callbacks) => {
        spy.requests++
        env.modelSignal = signal
        return model(env, items, signal, callbacks)
      }
    },
    '../model/context-summary': {
      createContextSummaryResponse: () => async () => {
        throw new Error('Unexpected summary in short protected fixture')
      }
    },
    '../project/image-access': {
      hasImageSelection: () => false,
      captureImageAccess() {
        /* Deliberate no-op fixture callback. */
      },
      captureSavedImageAccess() {
        /* Deliberate no-op fixture callback. */
      },
      bindImageMessageGroup: () => true,
      verifyImageRequestGroup: () => true,
      verifyImageMessageGroup: async () => true
    },
    '../project/attachment-access': {
      captureProjectAccess: () => null,
      hasProjectSelection: () => false
    },
    '../project/workspace-access': {
      captureWorkspaceAccess: () => null,
      hasWorkspaceSelection: () => false
    },
    '../project/project-instruction': {
      readProjectInstruction: async () => ({ status: 'absent' })
    },
    '../execution/task-registry': tasks,
    '../execution/execution-approval': approval,
    '../execution/execution-context': {
      resolveExecutionContext: async () => execution,
      executionStillCurrent: () => current
    },
    '../execution/action-authorization': auth,
    '../execution/windows-command-backend': {
      inspectWindowsCommandBackend: async () => {
        spy.backend++
        return null
      }
    },
    '../execution/command-runner': {
      startCommandProcess: () => {
        spy.processes++
        throw new Error('Unexpected command process')
      }
    },
    '../execution/command-plan': {
      discardCommandExecution() {
        /* Deliberate no-op fixture callback. */
      },
      claimCommandExecution: () => {
        throw new Error('Unexpected command claim')
      }
    }
  }
  env.runner = await load('src/main/agent/agent-runner.ts', dependencies, {
    clock,
    dependencyScopes: { './agent-user-input': '/src/main/agent/' }
  })
  env.history = await load('src/shared/agent-history.ts')
  const project = await load('src/shared/project.ts')
  env.context = { conversationId: 'chat-check', mode: options.mode ?? 'plan', execution: info }
  env.scope = project.toolScopeForAgentRequest(env.context)
  env.start = (id = 'request-check', taskId = 'task-check', history = []) =>
    env.runner.runAgentRequest(
      1,
      source.sender,
      id,
      prompt,
      history,
      env.context,
      taskId,
      () => false
    )
  env.record = () => tasks.listTasks(1).at(-1)
  return env
}
function noDeadline(env) {
  assert.deepEqual(env.scheduled, [], 'runner must not schedule any task deadline')
}
function released(env) {
  assert.equal(env.runner.hasAgentJob(1), false)
  assert.equal(env.input.hasAgentUserInput(1), false)
  assert.equal(env.approval.hasExecutionApproval(1), false)
  assert.equal(env.clock.timers.size, 0)
  for (const event of ['did-start-loading', 'render-process-gone', 'destroyed'])
    assert.equal(env.source.sender.listenerCount(event), 0)
  assert.equal(env.source.owner.listenerCount('closed'), 0)
  noDeadline(env)
}
const questionReply = (request) => ({
  requestId: request.requestId,
  inputId: request.inputId,
  answers: clone(answers)
})
const approvalReply = (request) => ({ approvalId: request.approvalId, approved: true })
const createCall = () =>
  response(
    call(
      'create_workspace_file',
      { path: 'result.txt', content: 'isolated local effect\n' },
      'call-create'
    )
  )

async function main() {
  for (const mode of ['plan', 'execute'])
    await checks.test(
      mode + ' active model survives 30 simulated minutes and settles complete legal history',
      async () => {
        const env = await environment(
          async (env, items, signal) => {
            env.gate = gate(signal)
            return env.gate.promise
          },
          { mode }
        )
        const completion = env.start()
        await waitUntil(() => env.gate, 'active model')
        env.clock.advance(elapsed)
        assert.equal(env.runner.hasAgentJob(1), true)
        assert.equal(env.modelSignal.aborted, false)
        assert.equal(env.record().status, 'running')
        noDeadline(env)
        env.gate.resolve(response(finalMessage('模拟30分钟后正常完成。')))
        const result = await settled(completion)
        assert.equal(result.status, 'done')
        assert.equal(env.record().status, 'completed')
        assert.ok(env.history.parseProtocolTurn(result.items, env.scope, mode))
        assert.ok(result.trace.includes('用时：1800000毫秒'))
        assert.equal(env.spy.backend, mode === 'execute' ? 1 : 0)
        assert.equal(env.spy.processes, 0)
        released(env)
      }
    )
  await checks.test(
    'plan question waits 30 minutes and resumed model runs another 30 with exact answers and no deadline',
    async () => {
      let nextInput
      const env = await environment(async (env, items, signal) => {
        if (env.spy.requests === 1) {
          env.clock.advance(60000)
          return response(call('request_user_input'))
        }
        nextInput = clone(items)
        env.gate = gate(signal)
        return env.gate.promise
      })
      const completion = env.start()
      await waitUntil(() => env.question(), 'question')
      const request = env.question()
      assert.equal(env.record().status, 'waiting_input')
      env.clock.advance(elapsed)
      assert.ok(env.question())
      noDeadline(env)
      assert.equal(env.answer(questionReply(request)), true)
      await waitUntil(() => env.gate, 'resumed model')
      assert.equal(env.record().status, 'running')
      env.clock.advance(elapsed)
      assert.equal(env.modelSignal.aborted, false)
      noDeadline(env)
      env.gate.resolve(response(finalMessage('已采纳卡片布局。')))
      const result = await settled(completion)
      assert.equal(result.status, 'done')
      assert.deepEqual(
        JSON.parse(nextInput.find((item) => item.type === 'function_call_output').output),
        { answers }
      )
      assert.ok(env.history.parseProtocolTurn(result.items, env.scope, 'plan'))
      assert.equal(env.spy.processes, 0)
      assert.equal(env.answer(questionReply(request)), false)
      released(env)
    }
  )
  await checks.test(
    'manual approval waits 30 minutes and resume runs another 30 before real isolated write result completes',
    async () => {
      const env = await environment(
        async (env, items, signal) => {
          if (env.spy.requests === 1) return createCall()
          env.nextInput = clone(items)
          env.gate = gate(signal)
          return env.gate.promise
        },
        { mode: 'execute' }
      )
      const completion = env.start()
      await waitUntil(() => env.pendingApproval(), 'manual approval')
      const request = env.pendingApproval()
      assert.equal(env.record().status, 'waiting_approval')
      env.clock.advance(elapsed)
      assert.ok(env.pendingApproval())
      noDeadline(env)
      assert.equal(env.approve(approvalReply(request)), true)
      await waitUntil(() => env.gate, 'post-write model')
      env.clock.advance(elapsed)
      assert.equal(env.modelSignal.aborted, false)
      assert.equal(env.record().status, 'running')
      assert.equal(
        await fs.readFile(path.join(env.cwd, 'result.txt'), 'utf8'),
        'isolated local effect\n'
      )
      assert.equal(
        JSON.parse(env.nextInput.find((item) => item.type === 'function_call_output').output)
          .status,
        'created'
      )
      env.gate.resolve(response(finalMessage('文件已完成。')))
      const result = await settled(completion)
      assert.equal(result.status, 'done')
      assert.ok(env.history.parseProtocolTurn(result.items, env.scope, 'execute'))
      assert.equal(env.approve(approvalReply(request)), false)
      released(env)
    }
  )
  await checks.test(
    'approval rejected after 30 minutes never writes file or starts a local effect',
    async () => {
      const env = await environment(
        async (env) =>
          env.spy.requests === 1 ? createCall() : response(finalMessage('批准未通过。')),
        { mode: 'execute' }
      )
      const completion = env.start()
      await waitUntil(() => env.pendingApproval(), 'approval')
      const request = env.pendingApproval()
      env.clock.advance(elapsed)
      assert.equal(env.approve({ ...approvalReply(request), approved: false }), true)
      const result = await settled(completion)
      assert.equal(result.status, 'done')
      await assert.rejects(fs.access(path.join(env.cwd, 'result.txt')))
      assert.equal(
        result.trace.some((line) => line.startsWith('本地操作已开始：')),
        false
      )
      released(env)
    }
  )
  await checks.test(
    'stop still aborts an active model after 30 minutes and rejects a different request ID',
    async () => {
      const env = await environment(async (env, items, signal) => {
        env.gate = gate(signal)
        return env.gate.promise
      })
      const completion = env.start()
      await waitUntil(() => env.gate, 'active model')
      env.clock.advance(elapsed)
      assert.equal(env.runner.cancelAgentJob(1, 'other'), false)
      assert.equal(env.runner.cancelAgentJob(1, 'request-check'), true)
      assert.equal((await settled(completion)).status, 'cancelled')
      assert.equal(env.record().status, 'cancelled')
      released(env)
    }
  )
  for (const lifecycle of ['reload', 'render-process-gone', 'destroyed'])
    await checks.test(
      lifecycle + ' still aborts model and releases listeners after long active work',
      async () => {
        const env = await environment(async (env, items, signal) => {
          env.gate = gate(signal)
          return env.gate.promise
        })
        const completion = env.start()
        await waitUntil(() => env.gate, 'active model')
        env.clock.advance(elapsed)
        if (lifecycle === 'reload') env.source.reload()
        else env.source.sender.emit(lifecycle)
        assert.equal((await settled(completion)).status, 'cancelled')
        released(env)
      }
    )
  await checks.test(
    'window teardown still interrupts task and cancels model without overwriting terminal record',
    async () => {
      const env = await environment(async (env, items, signal) => {
        env.gate = gate(signal)
        return env.gate.promise
      })
      const completion = env.start()
      await waitUntil(() => env.gate, 'active model')
      env.clock.advance(elapsed)
      env.tasks.cleanupTaskWindow(1)
      env.source.destroy()
      assert.equal((await settled(completion)).status, 'cancelled')
      assert.equal(env.record().status, 'interrupted')
      released(env)
    }
  )
  await checks.test(
    'stop while plan question waits releases pending call history and rejects late answer',
    async () => {
      const env = await environment(async () => response(call('request_user_input')))
      const completion = env.start()
      await waitUntil(() => env.question(), 'question')
      const request = env.question()
      env.clock.advance(elapsed)
      assert.equal(env.tasks.cancelTask(1, 'task-check'), true)
      const result = await settled(completion)
      assert.equal(result.status, 'cancelled')
      assert.ok(env.history.parseIncompleteToolTurn(result.items, env.scope, prompt, 'plan'))
      assert.equal(result.items.at(-1).type, 'function_call')
      assert.equal(env.answer(questionReply(request)), false)
      assert.equal(env.spy.requests, 1)
      released(env)
    }
  )
  await checks.test(
    'stop during approval rejects delayed approval and does not create file',
    async () => {
      const env = await environment(async () => createCall(), { mode: 'execute' })
      const completion = env.start()
      await waitUntil(() => env.pendingApproval(), 'approval')
      const request = env.pendingApproval()
      env.clock.advance(elapsed)
      assert.equal(env.runner.cancelAgentJob(1, 'request-check'), true)
      const result = await settled(completion)
      assert.equal(result.status, 'cancelled')
      assert.equal(env.approve(approvalReply(request)), false)
      await assert.rejects(fs.access(path.join(env.cwd, 'result.txt')))
      assert.ok(env.history.parseIncompleteToolTurn(result.items, env.scope, prompt, 'execute'))
      released(env)
    }
  )
  await checks.test(
    'refresh while question waits rejects original document answer and releases task',
    async () => {
      const env = await environment(async () => response(call('request_user_input')))
      const completion = env.start()
      await waitUntil(() => env.question(), 'question')
      const request = env.question()
      env.clock.advance(elapsed)
      env.source.reload()
      assert.equal((await settled(completion)).status, 'cancelled')
      assert.equal(env.answer(questionReply(request)), false)
      released(env)
    }
  )
  await checks.test(
    'invalid context during indefinite question still fails at existing periodic check',
    async () => {
      const env = await environment(async () => response(call('request_user_input')))
      const completion = env.start()
      await waitUntil(() => env.question(), 'question')
      const request = env.question()
      env.clock.advance(elapsed)
      env.invalidate()
      env.clock.advance(500)
      const result = await settled(completion)
      assert.equal(result.status, 'error')
      assert.match(result.error, /失效/)
      assert.equal(env.record().status, 'failed')
      assert.equal(env.answer(questionReply(request)), false)
      released(env)
    }
  )
  await checks.test(
    'failure after actual isolated file effect retains warning and complete tool evidence',
    async () => {
      const env = await environment(
        async (env) => {
          if (env.spy.requests === 1) return createCall()
          env.clock.advance(elapsed)
          throw new Error('synthetic network failure after actual write')
        },
        { mode: 'execute', permission: 'full-access' }
      )
      const result = await settled(env.start())
      assert.equal(result.status, 'error')
      assert.match(result.error, /本地操作可能已经执行/)
      assert.equal(
        await fs.readFile(path.join(env.cwd, 'result.txt'), 'utf8'),
        'isolated local effect\n'
      )
      assert.equal(env.record().status, 'failed')
      assert.ok(env.history.parseIncompleteToolTurn(result.items, env.scope, prompt, 'execute'))
      assert.equal(result.items.at(-1).type, 'function_call_output')
      released(env)
    }
  )
  await checks.test(
    'stop after actual file effect retains warning in task and tool evidence without repeating write',
    async () => {
      const env = await environment(
        async (env, items, signal) => {
          if (env.spy.requests === 1) return createCall()
          env.gate = gate(signal)
          return env.gate.promise
        },
        { mode: 'execute', permission: 'full-access' }
      )
      const completion = env.start()
      await waitUntil(() => env.gate, 'post-write model')
      env.clock.advance(elapsed)
      env.runner.cancelAgentJob(1, 'request-check')
      const result = await settled(completion)
      assert.equal(result.status, 'cancelled')
      assert.match(env.record().error, /本地操作可能已经执行/)
      assert.equal(
        await fs.readFile(path.join(env.cwd, 'result.txt'), 'utf8'),
        'isolated local effect\n'
      )
      assert.equal(env.spy.requests, 2)
      assert.ok(env.history.parseIncompleteToolTurn(result.items, env.scope, prompt, 'execute'))
      released(env)
    }
  )
  await checks.test(
    'long active request keeps mutual exclusion and completed request releases it for another task',
    async () => {
      const env = await environment(async (env, items, signal) => {
        if (env.spy.requests === 1) {
          env.gate = gate(signal)
          return env.gate.promise
        }
        return response(finalMessage('后续请求完成。'))
      })
      const completion = env.start()
      await waitUntil(() => env.gate, 'active model')
      env.clock.advance(elapsed)
      assert.equal((await env.start('request-other', 'task-other')).status, 'error')
      assert.equal(env.spy.requests, 1)
      env.gate.resolve(response(finalMessage('原请求完成。')))
      assert.equal((await settled(completion)).status, 'done')
      released(env)
      assert.equal((await settled(env.start('request-next', 'task-next'))).status, 'done')
      assert.equal(env.spy.requests, 2)
      released(env)
    }
  )
  await checks.test(
    'late model public callback after cancellation cannot publish or mutate saved evidence',
    async () => {
      let callbacks
      const env = await environment(async (env, items, signal, value) => {
        callbacks = value
        env.gate = gate(signal)
        return env.gate.promise
      })
      const completion = env.start()
      await waitUntil(() => env.gate, 'active model')
      env.clock.advance(elapsed)
      env.runner.cancelAgentJob(1, 'request-check')
      const result = await settled(completion)
      const eventCount = env.source.events.length
      const before = JSON.stringify(result.items)
      assert.throws(() =>
        callbacks.onMessageEvent({
          attempt: 0,
          outputIndex: 0,
          phase: 'commentary',
          text: '迟到消息'
        })
      )
      assert.throws(() => callbacks.onTextDelta('迟到增量'))
      assert.equal(env.source.events.length, eventCount)
      assert.equal(JSON.stringify(result.items), before)
      released(env)
    }
  )
  const sourceHashes = {}
  for (const relative of [
    'src/main/agent/agent-runner.ts',
    'src/main/agent/tool-loop.ts',
    'src/main/agent/agent-instructions.ts',
    'src/main/agent/agent-user-input.ts',
    'src/main/execution/action-authorization.ts',
    'src/main/execution/task-registry.ts'
  ])
    sourceHashes[relative] = crypto
      .createHash('sha256')
      .update(await fs.readFile(path.join(root, relative)))
      .digest('hex')
  await checks.finish({
    method:
      'Actual current runner, tool loop, task registry, authorization, user-input channel, executor and real isolated file writes. Electron/window/model/backend are explicitly synthetic. FakeClock advances 30 simulated minutes (not real wall clock); no model API or user data used.',
    sourceHashes,
    simulatedActiveDurationMs: elapsed,
    realModel: false,
    derivation:
      'Copied the lesson53 corrected desktop runner verifier into this new lesson55 UUID against current source; old evidence is preserved. Electron/window/model/backend are synthetic while desktop runner/brokers/task/auth/tool modules and isolated writes are actual.'
  })
}
main().catch(async (error) => {
  await checks.test('suite setup', () => {
    throw error
  })
  await checks.finish({ realModel: false })
})
