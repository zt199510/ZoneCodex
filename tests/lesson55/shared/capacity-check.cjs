const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { createHash, randomUUID } = require('node:crypto')
const { load } = require('./harness.cjs')
const checks = []
const scope = { kind: 'time', executionId: 'a'.repeat(64) }
const call = (id, name = 'get_current_time', args = '{}') => ({
  type: 'function_call',
  call_id: id,
  name,
  arguments: args
})
const message = (text = '完成', phase = 'final_answer') => ({
  type: 'message',
  role: 'assistant',
  phase,
  content: [{ type: 'output_text', text }]
})
const response = (...output) => ({ status: 'completed', output })
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
async function check(name, action) {
  try {
    const details = await action()
    checks.push({ name, passed: true, details })
  } catch (error) {
    checks.push({ name, passed: false, error: error.stack })
    console.error(name, error.message)
  }
}
async function main() {
  const [loop, history, agent] = await Promise.all([
    load('src/main/agent/tool-loop.ts'),
    load('src/shared/agent-history.ts'),
    load('src/main/agent/agent-tools.ts', {
      '../execution/command-runner': {
        startCommandProcess() {
          throw new Error('Unexpected command')
        }
      },
      '../execution/command-plan': {
        discardCommandExecution() {
          /* Deliberate no-op fixture callback. */
        },
        claimCommandExecution() {
          throw new Error('Unexpected command')
        }
      }
    })
  ])
  const run = (send, options = {}) =>
    loop.runToolLoop(
      '隔离检查',
      send,
      options.signal ?? new AbortController().signal,
      [],
      () => {},
      [],
      options.execute ?? (async () => 'ok'),
      options.scope ?? scope,
      () => {},
      options.onToolEvent ?? (() => {}),
      options.onMessageEvent,
      options.mode ?? 'execute',
      options.onRetry
    )
  const sequence = (count) => {
    let round = 0
    return async () => (++round <= count ? response(call('call-' + round)) : response(message()))
  }
  await check(
    '12 tools and 13 model rounds complete with original protocol and visible round 10',
    async () => {
      let effects = 0
      const messages = []
      let round = 0
      const result = await run(
        async () => {
          round++
          return round <= 12
            ? response(message('步骤 ' + round, 'commentary'), call('long-' + round))
            : response(message())
        },
        {
          execute: async () => {
            effects++
            return 'ok'
          },
          onMessageEvent: (event) => messages.push(event)
        }
      )
      assert.equal(round, 13)
      assert.equal(effects, 12)
      assert.ok(messages.some((value) => value.messageId === 'response-10-attempt-0-message-0'))
      assert.ok(history.parseProtocolTurn(result.items, scope))
      assert.ok(history.parseIncompleteToolTurn(result.items.slice(0, -1), scope))
      assert.ok(history.parseToolHistory(result.items, scope))
      return { rounds: round, tools: effects, items: result.items.length }
    }
  )
  await check('79 short tools fit exactly 160 existing turn items', async () => {
    const result = await run(sequence(79))
    assert.equal(result.items.length, 160)
    assert.ok(history.parseProtocolTurn(result.items, scope))
  })
  await check('existing item capacity stops tool 80 before events and execution', async () => {
    let starts = 0
    let effects = 0
    await assert.rejects(
      run(sequence(80), {
        onToolEvent: (event) => {
          if (event.phase === 'start') starts++
        },
        execute: async () => {
          effects++
          return 'ok'
        }
      }),
      /协议历史过长/
    )
    assert.equal(starts, 79)
    assert.equal(effects, 79)
  })
  await check('cancellation after tool 9 starts no round 10', async () => {
    const controller = new AbortController()
    let rounds = 0
    let effects = 0
    await assert.rejects(
      run(async () => response(call('cancel-' + ++rounds)), {
        signal: controller.signal,
        execute: async () => {
          if (++effects === 9) controller.abort()
          return 'ok'
        }
      }),
      { name: 'AbortError' }
    )
    assert.equal(rounds, 9)
    assert.equal(effects, 9)
  })
  await check('duplicate call id at round 10 is refused before another effect', async () => {
    let rounds = 0
    let effects = 0
    await assert.rejects(
      run(async () => response(call(++rounds === 10 ? 'duplicate-1' : 'duplicate-' + rounds)), {
        execute: async () => {
          effects++
          return 'ok'
        }
      }),
      /重复 call_id/
    )
    assert.equal(rounds, 10)
    assert.equal(effects, 9)
  })
  await check('plan mode remains read only after 12 calls', async () => {
    let rounds = 0
    let effects = 0
    await assert.rejects(
      run(
        async () =>
          response(
            ++rounds <= 12 ? call('plan-' + rounds) : call('plan-write', 'apply_workspace_patch')
          ),
        {
          mode: 'plan',
          execute: async () => {
            effects++
            return 'ok'
          }
        }
      ),
      /计划模式只允许/
    )
    assert.equal(effects, 12)
  })
  await check('output and input character budgets still stop the loop', async () => {
    await assert.rejects(
      run(sequence(1), { execute: async () => 'x'.repeat(12001) }),
      /工具结果过长/
    )
    let rounds = 0
    await assert.rejects(
      run(async () => response(call('size-' + ++rounds)), {
        execute: async () => 'x'.repeat(12000)
      }),
      /协议历史过长/
    )
    assert.ok(rounds > 9)
    assert.ok(rounds < 20)
    return { rounds }
  })
  await check('incomplete call 12 serializes and rereads through the current parser', async () => {
    const values = [{ role: 'user', content: '隔离检查' }]
    for (let index = 1; index <= 12; index++) {
      values.push(call('incomplete-' + index))
      if (index < 12)
        values.push({ type: 'function_call_output', call_id: 'incomplete-' + index, output: 'ok' })
    }
    assert.ok(history.parseIncompleteToolTurn(values, scope))
    assert.equal(history.parseProtocolTurn(values, scope), null)
    assert.equal(history.parseIncompleteToolTurn([...values, call('another')], scope), null)
    const disk = path.join(__dirname, 'incomplete-' + randomUUID() + '.json')
    await fs.writeFile(disk, JSON.stringify(values), { flag: 'wx' })
    assert.deepEqual(
      history.parseIncompleteToolTurn(JSON.parse(await fs.readFile(disk, 'utf8')), scope),
      values
    )
  })
  await check(
    'ninth distinct read registers evidence and commits a real large file patch',
    async () => {
      const directory = path.join(__dirname, 'disk-' + randomUUID())
      await fs.mkdir(directory)
      const lines = Array.from({ length: 380 }, (_, index) =>
        index === 200
          ? 'export const target = "OLD";'
          : '// unchanged 中文 ' + index + ' ' + 'x'.repeat(90)
      )
      const initial = Buffer.from('\ufeff' + lines.join('\r\n') + '\r\n\r\n\r\n')
      assert.ok(initial.length > 32768 && initial.length <= 131072)
      for (let index = 1; index <= 8; index++)
        await fs.writeFile(
          path.join(directory, 'read-' + index + '.txt'),
          'read marker ' + index + '\n',
          { flag: 'wx' }
        )
      const filename = path.join(directory, 'catalog.ts')
      await fs.writeFile(filename, initial, { flag: 'wx' })
      let approvals = 0
      let effects = 0
      const execution = {
        info: { cwd: directory, scopeId: scope.executionId, mode: 'full-access', revision: 1 },
        writableRoots: [directory]
      }
      const options = {
        mode: 'execute',
        execution,
        assertCurrent: () => true,
        approve: async () => {
          approvals++
          return true
        },
        authorizeCommand: async () => {
          throw new Error('Unexpected command approval')
        },
        onEffect: () => {
          effects++
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
        }
      }
      const execute = agent.createAgentToolExecutor(options)
      const patch = [
        '*** Begin Patch',
        '*** Update File: catalog.ts',
        '@@',
        '-export const target = "OLD";',
        '+export const target = "NEW";',
        '*** End Patch'
      ].join('\n')
      const steps = Array.from({ length: 8 }, (_, index) =>
        call(
          'disk-read-' + index,
          'read_workspace_file',
          JSON.stringify({ path: 'read-' + (index + 1) + '.txt', startLine: 1, endLine: 1 })
        )
      )
      steps.push(
        call(
          'disk-read-target',
          'read_workspace_file',
          JSON.stringify({ path: 'catalog.ts', startLine: 200, endLine: 202 })
        ),
        call(
          'disk-patch',
          'apply_workspace_patch',
          JSON.stringify({ path: 'catalog.ts', expectedSha256: hash(initial), patch })
        ),
        call(
          'disk-reread',
          'read_workspace_file',
          JSON.stringify({ path: 'catalog.ts', startLine: 200, endLine: 202 })
        )
      )
      const result = await run(
        async () => (steps.length ? response(steps.shift()) : response(message())),
        { execute }
      )
      const outputs = result.items
        .filter((item) => item.type === 'function_call_output')
        .map((item) => JSON.parse(item.output))
      assert.equal(outputs[8].fullText, null)
      assert.equal(outputs[8].lines.length, 3)
      assert.equal(outputs[9].status, 'applied')
      assert.equal(approvals, 1)
      assert.equal(effects, 1)
      const expected = Buffer.from(
        initial.toString('utf8').replace('target = "OLD";', 'target = "NEW";')
      )
      assert.deepEqual(await fs.readFile(filename), expected)
      const backup = (await fs.readdir(directory)).find((name) => name.endsWith('.bak'))
      assert.ok(backup)
      assert.deepEqual(await fs.readFile(path.join(directory, backup)), initial)
      const fresh = agent.createAgentToolExecutor(options)
      const unread = JSON.parse(
        await fresh(
          'apply_workspace_patch',
          JSON.stringify({
            path: 'catalog.ts',
            expectedSha256: hash(expected),
            patch: patch
              .replaceAll('OLD', 'NEW')
              .replace('+export const target = "NEW";', '+export const target = "AGAIN";')
          }),
          new AbortController().signal
        )
      )
      assert.equal(unread.status, 'error')
      assert.equal(approvals, 1)
      return {
        tools: 11,
        rounds: 12,
        originalBytes: initial.length,
        linesVisible: 3,
        totalLines: outputs[8].totalLines,
        before: hash(initial),
        after: hash(expected),
        unchangedBytesAndFormat: true
      }
    }
  )
  await check(
    'real response client retries synthetic HTTP 502 at round 10 without repeating tools',
    async () => {
      const { build } = require('esbuild')
      const Module = require('node:module')
      const root = process.cwd()
      const built = await build({
        stdin: {
          contents: "export { createLiveResponse } from './src/main/model/response-client'",
          resolveDir: root,
          loader: 'ts'
        },
        bundle: true,
        platform: 'node',
        format: 'cjs',
        write: false,
        logLevel: 'silent',
        define: {
          'process.env.MODEL_ENDPOINT': JSON.stringify('https://synthetic.invalid/responses'),
          'process.env.MODEL_NAME': JSON.stringify('synthetic-only'),
          'process.env.MODEL_API_KEY': JSON.stringify('synthetic-key')
        }
      })
      const client = new Module(path.join(__dirname, 'retry-client.cjs'), module)
      client.filename = path.join(__dirname, 'retry-client.cjs')
      client.paths = Module._nodeModulePaths(root)
      client._compile(built.outputFiles[0].text, client.filename)
      const queue = Array.from({ length: 9 }, (_, index) => response(call('http-' + (index + 1))))
      queue.push(
        502,
        response(message('恢复后第10步', 'commentary'), call('http-10')),
        response(message())
      )
      const requests = []
      const retries = []
      const messages = []
      let effects = 0
      const originalFetch = globalThis.fetch
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
        const result = await run(
          client.exports.createLiveResponse([], '合成传输，仅验证真实client循环', {
            endpoint: 'https://synthetic.invalid/responses',
            model: 'synthetic-only',
            apiKey: 'synthetic-key'
          }),
          {
            execute: async () => {
              effects++
              return 'ok'
            },
            onMessageEvent: (value) => messages.push(value),
            onRetry: (value) => retries.push(value)
          }
        )
        assert.equal(result.answer, '完成')
        assert.equal(requests.length, 12)
        assert.equal(effects, 10)
        assert.equal(requests[9], requests[10])
        assert.equal(retries.length, 1)
        assert.equal(retries[0].round, 10)
        assert.equal(retries[0].maxRetries, 5)
        assert.ok(messages.some((value) => value.messageId === 'response-10-attempt-1-message-0'))
        return {
          httpRequests: requests.length,
          tools: effects,
          retryRound: retries[0].round,
          frozenRequestIdentical: true
        }
      } finally {
        globalThis.fetch = originalFetch
      }
    }
  )
  const result = {
    generatedAt: new Date().toISOString(),
    method: {
      real: [
        'current source modules',
        'file reads, evidence, prepare, backup, commit, reread',
        'current shared history parsers',
        'response-client SSE and automatic retry'
      ],
      synthetic: ['model output queue and HTTP 502 transport', 'approval response'],
      noRealModelClaim: true
    },
    passed: checks.every((item) => item.passed),
    total: checks.length,
    failed: checks.filter((item) => !item.passed).length,
    checks
  }
  await fs.writeFile(path.join(__dirname, 'results.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ passed: result.passed, total: result.total, failed: result.failed }))
  if (!result.passed) process.exitCode = 1
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
