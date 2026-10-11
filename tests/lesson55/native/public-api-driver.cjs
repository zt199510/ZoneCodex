const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const Module = require('node:module')
const scenario = process.argv[2]
const file = process.env.LESSON55_PUBLIC_API
const events = [],
  imports = []
const originalLoad = Module._load
Module._load = function (id) {
  imports.push(id)
  if (id === 'electron' || id.startsWith('electron/'))
    throw Error('Public API may not load Electron')
  return originalLoad.apply(this, arguments)
}
const stdinListeners = process.stdin.listenerCount('data')
const api = require(file)
assert.equal(typeof api.runAgentTask, 'function')
assert.equal(process.stdin.listenerCount('data'), stdinListeners)
const base = { mode: 'execute', prompt: '固定公共脚本任务', cwd: process.env.LESSON55_WORKSPACE }
const signalTask = (signal) =>
  api.runAgentTask(base, { signal, onEvent: (event) => events.push(structuredClone(event)) })
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const safe = (outcome) => {
  assert.ok(!Object.hasOwn(outcome, 'result'))
  assert.ok(!Object.hasOwn(outcome, 'items'))
  assert.ok(!JSON.stringify(outcome).includes('LESSON55_PRIVATE_'))
  assert.ok(!JSON.stringify(outcome).includes('LESSON55_SYNTHETIC_SECRET_SENTINEL'))
  assert.ok(Array.isArray(outcome.toolResults))
  assert.ok(
    outcome.toolResults.every((item) => Object.keys(item).sort().join(',') === 'callId,name,output')
  )
}
async function main() {
  let outcome,
    details = {}
  if (scenario === 'import') {
    await pause(50)
    return { noTaskStarted: true, imports, stdinListenersUnchanged: true }
  }
  if (scenario === 'normal' || scenario === 'read-only-missing-resources') {
    outcome = await api.runAgentTask(base, {
      onEvent: (event) => events.push(structuredClone(event))
    })
    assert.equal(outcome.exitCode, 0)
    assert.equal(outcome.task.state, 'completed')
  } else if (scenario === 'input-frozen') {
    const supplied = { ...base },
      options = { onEvent: (event) => events.push(structuredClone(event)) }
    const pending = api.runAgentTask(supplied, options)
    supplied.prompt = 'mutated external prompt'
    supplied.cwd = path.dirname(base.cwd)
    supplied.permission = 'full-access'
    options.onEvent = () => {
      throw Error('mutated external event callback')
    }
    outcome = await pending
    assert.equal(outcome.exitCode, 0)
    assert.equal(
      await fs.readFile(path.join(base.cwd, 'created.txt'), 'utf8'),
      'synthetic actual disk creation\n'
    )
    details.inputMutationAfterCallIgnored = true
  } else if (scenario === 'configuration-frozen') {
    const pending = api.runAgentTask(base, {
      onEvent: (event) => events.push(structuredClone(event))
    })
    process.env.MODEL_NAME = 'unexpected-after-call'
    process.env.MODEL_ENDPOINT = 'https://mutated.invalid/'
    process.env.MODEL_API_KEY = 'mutated-config'
    outcome = await pending
    assert.equal(outcome.exitCode, 0)
    details.configurationMutationAfterCallIgnored = true
  } else if (scenario === 'no-on-event') {
    outcome = await api.runAgentTask(base)
    assert.equal(outcome.exitCode, 0)
  } else if (scenario === 'event-exception') {
    outcome = await api.runAgentTask(base, {
      onEvent: () => {
        throw Error('private callback exception')
      }
    })
    assert.equal(outcome.exitCode, 1)
    assert.equal(outcome.task.state, 'failed')
    assert.ok(!JSON.stringify(outcome).includes('private callback exception'))
  } else if (scenario === 'already-cancelled') {
    const controller = new AbortController()
    controller.abort()
    outcome = await signalTask(controller.signal)
    assert.equal(outcome.exitCode, 130)
    assert.equal(outcome.task.state, 'cancelled')
  } else if (scenario === 'model-cancel') {
    const controller = new AbortController(),
      pending = signalTask(controller.signal)
    setTimeout(() => controller.abort(), 150)
    outcome = await pending
    assert.equal(outcome.exitCode, 130)
    assert.equal(outcome.task.state, 'cancelled')
  } else if (scenario === 'question-answer') {
    outcome = await api.runAgentTask(
      { ...base, mode: 'plan' },
      {
        onEvent: (event) => events.push(structuredClone(event)),
        answer: async (request, signal) => {
          assert.ok(Object.isFrozen(request))
          assert.ok(Object.isFrozen(request.questions))
          assert.ok(Object.isFrozen(request.questions[0].options))
          assert.equal(signal.aborted, false)
          details.question = {
            requestId: request.requestId,
            inputId: request.inputId,
            callId: request.callId
          }
          return [{ id: 'layout', answer: '列表' }]
        }
      }
    )
    assert.equal(outcome.exitCode, 0)
  } else if (
    scenario === 'question-unavailable' ||
    scenario === 'question-invalid' ||
    scenario === 'question-exception'
  ) {
    outcome = await api.runAgentTask(
      { ...base, mode: 'plan' },
      {
        onEvent: (event) => events.push(structuredClone(event)),
        ...(scenario === 'question-invalid'
          ? { answer: async () => [{ id: 'stale-question', answer: 'yes' }] }
          : {}),
        ...(scenario === 'question-exception'
          ? {
              answer: async () => {
                throw Error('private question callback exception')
              }
            }
          : {})
      }
    )
    assert.equal(outcome.exitCode, 3)
    assert.ok(!JSON.stringify(outcome).includes('private question callback exception'))
  } else if (scenario === 'question-cancel-late') {
    const controller = new AbortController()
    let resolveAnswer, callbackSignal
    const pending = api.runAgentTask(
      { ...base, mode: 'plan' },
      {
        signal: controller.signal,
        onEvent: (event) => events.push(structuredClone(event)),
        answer: async (_request, signal) => {
          callbackSignal = signal
          setTimeout(() => controller.abort(), 80)
          return new Promise((resolve) => {
            resolveAnswer = resolve
          })
        }
      }
    )
    outcome = await pending
    assert.equal(outcome.exitCode, 130)
    assert.equal(callbackSignal.aborted, true)
    const recorded = JSON.stringify(outcome),
      count = events.length
    resolveAnswer([{ id: 'layout', answer: '卡片' }])
    await pause(100)
    assert.equal(JSON.stringify(outcome), recorded)
    assert.equal(events.length, count)
    details.lateAnswerIgnored = true
  } else if (scenario === 'command-finish-cancel') {
    const controller = new AbortController()
    outcome = await api.runAgentTask(base, {
      signal: controller.signal,
      approve: async () => true,
      onEvent: (event) => {
        events.push(structuredClone(event))
        if (event.type === 'tool' && event.event.phase === 'finish') controller.abort()
      }
    })
    assert.equal(outcome.exitCode, 130)
    assert.equal(outcome.task.state, 'cancelled')
    assert.equal(outcome.effects.started, true)
    assert.equal(outcome.toolResults.length, 1)
    const output = JSON.parse(outcome.toolResults[0].output)
    assert.equal(output.status, 'completed')
    assert.equal(output.exitCode, 0)
    assert.equal(output.treeExited, true)
    const count = events.length
    await pause(100)
    assert.equal(events.length, count)
    details.completedCommandRetainedDuringCancellation = output
  } else if (scenario.startsWith('command-')) {
    const decision =
      scenario === 'command-approve'
        ? true
        : scenario === 'command-reject'
          ? false
          : { approved: true }
    outcome = await api.runAgentTask(base, {
      onEvent: (event) => events.push(structuredClone(event)),
      approve: async (request, signal) => {
        assert.ok(Object.isFrozen(request))
        assert.ok(Object.isFrozen(request.args))
        assert.equal(signal.aborted, false)
        details.approval = {
          requestId: request.requestId,
          kind: request.kind,
          program: request.program,
          args: request.args,
          cwd: request.cwd
        }
        return decision
      }
    })
    assert.equal(outcome.exitCode, 0)
    const finish = events.find((event) => event.type === 'tool' && event.event.phase === 'finish')
    const output = JSON.parse(finish.event.output)
    if (scenario === 'command-approve') {
      assert.equal(output.status, 'completed')
      assert.equal(output.exitCode, 0)
      assert.equal(output.treeExited, true)
      assert.equal(JSON.parse(output.stdout).credential, false)
    } else assert.notEqual(output.status, 'completed')
    details.toolResult = output
  } else if (scenario === 'agents-invalidated') {
    const pending = signalTask(undefined)
    setTimeout(
      () =>
        fs.writeFile(path.join(base.cwd, 'AGENTS.md'), '# changed controlled test instruction\n'),
      120
    )
    outcome = await pending
    assert.equal(outcome.exitCode, 1)
    assert.equal(outcome.task.state, 'failed')
    assert.match(outcome.task.error, /AGENTS/)
  } else if (scenario === 'missing-resources-command' || scenario === 'tampered-host-command') {
    outcome = await api.runAgentTask(
      { ...base, permission: 'full-access' },
      { onEvent: (event) => events.push(structuredClone(event)) }
    )
    const finish = events.find((event) => event.type === 'tool' && event.event.phase === 'finish')
    assert.ok(finish)
    const output = JSON.parse(finish.event.output)
    assert.notEqual(output.status, 'completed')
    assert.equal(outcome.effects.started, false)
    details.toolResult = output
  } else throw Error('Unknown public API scenario: ' + scenario)
  safe(outcome)
  return { outcome, events, imports, ...details }
}
main()
  .then((details) => console.log(JSON.stringify({ pass: true, scenario, details })))
  .catch((error) => {
    console.error(error.stack)
    process.exitCode = 1
  })
