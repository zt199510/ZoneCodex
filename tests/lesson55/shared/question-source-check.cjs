const { assert, load, FakeClock, electronFixture, suite } = require('./harness.cjs')
const { questions, call, response, clone } = require('./fixture.cjs')
const checks = suite('lesson55-question-source')
const answers = [{ id: 'direction', answer: '卡片' }]
const prompt = '请制定方案，先向我确认布局。'
const questionSeed = {
  ...clone(questions),
  requestId: 'request-plan',
  conversationId: 'chat-plan',
  callId: 'call-question-1'
}
const respond = (request) => ({
  requestId: request.requestId,
  inputId: request.inputId,
  answers: clone(answers)
})

async function environment() {
  const fixture = electronFixture()
  const clock = new FakeClock()
  const source = fixture.window(1)
  const other = fixture.window(2)
  const module = await load(
    'src/main/agent/agent-user-input.ts',
    { electron: fixture.electron },
    { clock }
  )
  module.registerAgentUserInput()
  return {
    ...fixture,
    clock,
    source,
    other,
    module,
    get: (event) => fixture.handlers.get('agent:user-input-get')(event),
    answer: (event, value) => fixture.handlers.get('agent:user-input-respond')(event, value)
  }
}

function assertReleased(env) {
  assert.equal(env.module.hasAgentUserInput(1), false)
  assert.equal(env.clock.timers.size, 0)
  for (const event of ['did-start-loading', 'render-process-gone', 'destroyed'])
    assert.equal(env.source.sender.listenerCount(event), 0)
  assert.equal(env.source.owner.listenerCount('closed'), 0)
}

async function main() {
  await checks.test(
    'pending questions are cloned, belong to original window, and answers resume exactly once',
    async () => {
      const env = await environment()
      const controller = new AbortController()
      const seed = clone(questionSeed)
      const completion = env.module.requestAgentUserInput(1, seed, controller.signal, () => true)
      seed.questions[0].question = 'Mutated external seed'
      const request = env.get(env.source.event())
      assert.equal(request.questions[0].question, questions.questions[0].question)
      assert.equal(env.get(env.other.event()), null)
      const response = respond(request)
      assert.equal(env.answer(env.other.event(), response), false)
      request.questions[0].question = 'Mutated returned copy'
      assert.equal(
        env.get(env.source.event()).questions[0].question,
        questions.questions[0].question
      )
      assert.equal(env.answer(env.source.event(), response), true)
      assert.deepEqual(await completion, answers)
      assert.equal(env.answer(env.source.event(), response), false)
      assertReleased(env)
      assert.equal(
        env.source.events.some((event) => event.channel.startsWith('execution:')),
        false
      )
    }
  )
  await checks.test(
    'malformed, extra, mismatched question, request or input IDs cannot settle valid pending questions',
    async () => {
      const env = await environment()
      const controller = new AbortController()
      const completion = env.module.requestAgentUserInput(
        1,
        questionSeed,
        controller.signal,
        () => true
      )
      const request = env.get(env.source.event())
      const value = respond(request)
      for (const invalid of [
        null,
        {},
        { ...value, approved: true },
        { ...value, requestId: 'request-other' },
        { ...value, inputId: 'input-other' },
        { ...value, answers: [] },
        { ...value, answers: [{ id: 'wrong', answer: '卡片' }] },
        { ...value, answers: [...answers, ...answers] }
      ]) {
        assert.equal(env.answer(env.source.event(), invalid), false)
        assert.equal(env.module.hasAgentUserInput(1), true)
      }
      assert.equal(
        await env.module.requestAgentUserInput(1, questionSeed, controller.signal, () => true),
        null
      )
      assert.equal(env.module.hasAgentUserInput(1), true)
      controller.abort()
      assert.equal(await completion, null)
      assertReleased(env)
    }
  )
  await checks.test(
    'subframes and unknown senders are refused without consuming another document question',
    async () => {
      const env = await environment()
      const controller = new AbortController()
      const completion = env.module.requestAgentUserInput(
        1,
        questionSeed,
        controller.signal,
        () => true
      )
      const value = respond(env.get(env.source.event()))
      assert.throws(() => env.answer({ sender: env.source.sender, senderFrame: {} }, value), /来源/)
      assert.throws(() => env.answer({ sender: { mainFrame: {} }, senderFrame: {} }, value), /来源/)
      assert.equal(env.module.hasAgentUserInput(1), true)
      controller.abort()
      await completion
      assertReleased(env)
    }
  )
  await checks.test('abort releases wait and rejects delayed or repeated answers', async () => {
    const env = await environment()
    const controller = new AbortController()
    const completion = env.module.requestAgentUserInput(
      1,
      questionSeed,
      controller.signal,
      () => true
    )
    const value = respond(env.get(env.source.event()))
    controller.abort()
    assert.equal(await completion, null)
    assert.equal(env.answer(env.source.event(), value), false)
    assert.equal(env.get(env.source.event()), null)
    assertReleased(env)
    assert.equal(env.source.events.at(-1).value, null)
  })
  await checks.test(
    'late answer for a cancelled question cannot consume a new question with the same agent request',
    async () => {
      const env = await environment()
      const originalController = new AbortController()
      const original = env.module.requestAgentUserInput(
        1,
        questionSeed,
        originalController.signal,
        () => true
      )
      const originalResponse = respond(env.get(env.source.event()))
      originalController.abort()
      await original
      const replacementController = new AbortController()
      const replacement = env.module.requestAgentUserInput(
        1,
        questionSeed,
        replacementController.signal,
        () => true
      )
      const replacementRequest = env.get(env.source.event())
      assert.notEqual(originalResponse.inputId, replacementRequest.inputId)
      assert.equal(env.answer(env.source.event(), originalResponse), false)
      assert.equal(env.module.hasAgentUserInput(1), true)
      assert.equal(env.answer(env.source.event(), respond(replacementRequest)), true)
      assert.deepEqual(await replacement, answers)
      assertReleased(env)
    }
  )
  await checks.test(
    'reload releases original document wait and old answer cannot apply to new document',
    async () => {
      const env = await environment()
      const completion = env.module.requestAgentUserInput(
        1,
        questionSeed,
        new AbortController().signal,
        () => true
      )
      const value = respond(env.get(env.source.event()))
      env.source.reload()
      assert.equal(await completion, null)
      assert.equal(env.answer(env.source.event(), value), false)
      assertReleased(env)
    }
  )
  await checks.test(
    'scope invalidation or assertCurrent failure releases unanswered wait on next periodic check',
    async () => {
      for (const failure of [false, 'throw']) {
        const env = await environment()
        let current = true
        const completion = env.module.requestAgentUserInput(
          1,
          questionSeed,
          new AbortController().signal,
          () => {
            if (current === 'throw') throw new Error('Expired context')
            return current
          }
        )
        const value = respond(env.get(env.source.event()))
        current = failure
        env.clock.advance(500)
        assert.equal(await completion, null)
        assert.equal(env.answer(env.source.event(), value), false)
        assertReleased(env)
      }
    }
  )
  await checks.test(
    'window close, renderer crash and sender destruction release waits and runtime listeners',
    async () => {
      for (const termination of ['closed', 'render-process-gone', 'destroyed']) {
        const env = await environment()
        const completion = env.module.requestAgentUserInput(
          1,
          questionSeed,
          new AbortController().signal,
          () => true
        )
        if (termination === 'closed') env.source.owner.emit(termination)
        else env.source.sender.emit(termination)
        assert.equal(await completion, null)
        assertReleased(env)
      }
    }
  )
  await checks.test(
    'invalid, already aborted, nonexistent window and failed publication never create surviving pending input',
    async () => {
      const env = await environment()
      const controller = new AbortController()
      controller.abort()
      assert.equal(
        await env.module.requestAgentUserInput(1, questionSeed, controller.signal, () => true),
        null
      )
      assert.equal(
        await env.module.requestAgentUserInput(
          9,
          questionSeed,
          new AbortController().signal,
          () => true
        ),
        null
      )
      assert.equal(
        await env.module.requestAgentUserInput(
          1,
          { ...questionSeed, questions: [] },
          new AbortController().signal,
          () => true
        ),
        null
      )
      assert.equal(
        await env.module.requestAgentUserInput(
          1,
          questionSeed,
          new AbortController().signal,
          () => false
        ),
        null
      )
      env.source.sender.send = () => {
        throw new Error('Renderer vanished')
      }
      assert.equal(
        await env.module.requestAgentUserInput(
          1,
          questionSeed,
          new AbortController().signal,
          () => true
        ),
        null
      )
      assertReleased(env)
    }
  )

  await checks.test(
    'real tool loop rejects user questions in execute before tool event and executor callback',
    async () => {
      const { runToolLoop } = await load('src/main/agent/tool-loop.ts')
      let invoked = 0
      const events = []
      await assert.rejects(
        runToolLoop(
          prompt,
          async () => response(call('request_user_input')),
          new AbortController().signal,
          [],
          undefined,
          [],
          async () => {
            invoked++
            return '{}'
          },
          { kind: 'time' },
          undefined,
          (event) => events.push(event),
          undefined,
          'execute'
        ),
        /范围/
      )
      assert.equal(invoked, 0)
      assert.deepEqual(events, [])
    }
  )
  await checks.test(
    'executor independently rejects execute mode, malformed questions, missing call ID and stale context before question publication',
    async () => {
      const { createAgentToolExecutor } = await load('src/main/agent/agent-tools.ts', {
        '../execution/command-runner': {
          startCommandProcess: () => {
            throw new Error('Unexpected command')
          }
        }
      })
      let published = 0
      const info = { cwd: __dirname, scopeId: 'a'.repeat(64), mode: 'full-access', revision: 1 }
      const options = {
        mode: 'plan',
        execution: { info, writableRoots: [__dirname] },
        assertCurrent: () => true,
        approve: async () => false,
        authorizeCommand: async () => {
          throw new Error('Unexpected command')
        },
        onEffect() {
          /* Deliberate no-op fixture callback. */
        },
        appendTrace() {
          /* Deliberate no-op fixture callback. */
        },
        onProgress() {
          /* Deliberate no-op fixture callback. */
        },
        projectSnapshot: null,
        projectExecutor: undefined,
        executeCommandProposal: async () => {
          throw new Error('Unexpected proposal')
        },
        requestUserInput: async () => {
          published++
          return JSON.stringify({ answers })
        }
      }
      const abort = new AbortController().signal
      await assert.rejects(
        createAgentToolExecutor({ ...options, mode: 'execute' })(
          'request_user_input',
          JSON.stringify(questions),
          abort,
          questionSeed.callId
        ),
        /只有计划/
      )
      const execute = createAgentToolExecutor(options)
      for (const raw of [
        '{',
        '{}',
        JSON.stringify({ questions: [] }),
        JSON.stringify({ ...questions, approved: true })
      ])
        await assert.rejects(execute('request_user_input', raw, abort, questionSeed.callId), /参数/)
      await assert.rejects(execute('request_user_input', JSON.stringify(questions), abort), /参数/)
      await assert.rejects(
        createAgentToolExecutor({ ...options, assertCurrent: () => false })(
          'request_user_input',
          JSON.stringify(questions),
          abort,
          questionSeed.callId
        ),
        /失效/
      )
      assert.equal(published, 0)
    }
  )
  await checks.finish({
    method:
      'Actual current question broker, shared validation and tool executor; synthetic Electron transport/window and FakeClock. No model API or actual browser.',
    derivation:
      'Current-source rerun in lesson55 UUID of question source/lifecycle tests; obsolete four-minute model budget tests intentionally excluded because lesson52 removed that budget.'
  })
}
main().catch(async (error) => {
  await checks.test('suite setup', () => {
    throw error
  })
  await checks.finish()
})
