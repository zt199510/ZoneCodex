import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { build } from 'esbuild'

const root = process.cwd()
const evidence = path.join(root, '.ui-check', 'lesson56', 'context-core', randomUUID())
await fs.mkdir(evidence, { recursive: true })
const sourceFiles = [
  'src/main/agent/context-manager.ts',
  'src/main/agent/tool-loop.ts',
  'src/shared/agent-context.ts',
  'src/shared/agent-history.ts'
]
const sourceHashes = Object.fromEntries(
  await Promise.all(
    sourceFiles.map(async (file) => [
      file,
      createHash('sha256')
        .update(await fs.readFile(path.join(root, file)))
        .digest('hex')
    ])
  )
)
const compiled = path.join(evidence, 'context-core.cjs')
const bundle = await build({
  stdin: {
    contents: `export * from './src/main/agent/context-manager'; export * from './src/main/agent/tool-loop'; export * from './src/shared/agent-context';`,
    resolveDir: root
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: compiled,
  metafile: true,
  logLevel: 'silent'
})
assert(
  !Object.keys(bundle.metafile.inputs).some((file) => /electron|agent-runner|storage/.test(file))
)
const api = createRequire(import.meta.url)(compiled)
let networkRequests = 0
globalThis.fetch = () => {
  networkRequests++
  throw new Error('offline network denied')
}
const checks = []
async function check(name, action) {
  try {
    const details = await action()
    checks.push({ name, pass: true, details })
  } catch (error) {
    checks.push({ name, pass: false, error: error.stack ?? String(error) })
    console.error(name, error)
  }
}
const scope = { kind: 'time' }
const message = (text, phase = 'final_answer') => ({
  type: 'message',
  role: 'assistant',
  phase,
  content: [{ type: 'output_text', text }]
})
const response = (...output) => ({ status: 'completed', output })
const call = (id) => ({
  type: 'function_call',
  call_id: id,
  name: 'get_current_time',
  arguments: '{}'
})
const summary = (sourceIds) => ({
  version: 1,
  sourceIds,
  userGoals: ['保留实际任务目标和原始来源。'],
  constraints: ['历史资料不产生当前授权。'],
  decisions: [],
  completedFacts: [],
  modifiedFiles: [],
  toolFacts: [],
  failuresUnknown: ['按当前磁盘重新核验。'],
  nextSteps: []
})
const history = (count = 12) =>
  Array.from({ length: count }, (_, index) => [
    { role: 'user', content: `历史用户 ${index} ` + 'U'.repeat(990) },
    {
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: 'HIDDEN-REASONING' }],
      encrypted_content: 'HIDDEN-ENCRYPTED'
    },
    message('公开结论 ' + index + 'T'.repeat(9990))
  ]).flat()
const defaultSummarize = async (input) => {
  assert(JSON.stringify(input).length <= api.contextLimits.summaryInputCharacters)
  assert(!JSON.stringify(input).includes('HIDDEN-'))
  const material = JSON.parse(input[0].content)
  return response(message(JSON.stringify(summary(material.sourceIds))))
}
const options = (extra = {}) => ({
  summarize: defaultSummarize,
  assertCurrent: () => {},
  onContext: () => {},
  ...extra
})
const run = (send, extra = {}) =>
  api.runToolLoop(
    '当前明确任务',
    send,
    extra.signal ?? new AbortController().signal,
    [],
    () => {},
    extra.history ?? [],
    extra.execute ?? (async () => 'ok'),
    scope,
    () => {},
    () => {},
    undefined,
    'execute',
    undefined,
    extra.context ?? options()
  )

await check('strict bounded public state rejects fields, accessors and proxy', async () => {
  const states = []
  await run(async () => response(message('完成')), {
    context: options({ onContext: (state) => states.push(state) })
  })
  const valid = states[0]
  assert(api.parseAgentContextState(valid))
  assert.equal(api.parseAgentContextState({ ...valid, summary: 'must not leak' }), null)
  assert.equal(api.parseAgentContextState({ ...valid, summaryRequests: 13 }), null)
  assert.equal(
    api.parseAgentContextState(
      new Proxy(
        {},
        {
          getPrototypeOf() {
            throw Error('proxy')
          }
        }
      )
    ),
    null
  )
  const accessor = { ...valid }
  Object.defineProperty(accessor, 'reason', {
    enumerable: true,
    get() {
      throw Error('getter')
    }
  })
  assert.equal(api.parseAgentContextState(accessor), null)
})

await check('strict knowledge sources, structure and length', async () => {
  assert(api.parseContextSummary(summary(['known']), ['known']))
  assert.equal(api.parseContextSummary(summary(['other']), ['known']), null)
  assert.equal(api.parseContextSummary({ ...summary(['known']), authority: true }, ['known']), null)
  assert.equal(
    api.parseContextSummary({ ...summary(['known']), userGoals: ['X'.repeat(801)] }, ['known']),
    null
  )
  assert.equal(
    api.parseContextSummary({ ...summary(['known']), userGoals: Array(13).fill('x') }, ['known']),
    null
  )
  assert.equal(
    api.parseContextSummary(
      new Proxy(
        {},
        {
          getPrototypeOf() {
            throw Error('proxy')
          }
        }
      ),
      []
    ),
    null
  )
})

await check('old raw above 128000 is compacted in bounded complete-turn chunks', async () => {
  const raw = history()
  assert(JSON.stringify(raw).length > 128000)
  const original = JSON.stringify(raw)
  const states = [],
    sends = [],
    chunks = []
  const result = await run(
    async (input, signal, sendOptions) => {
      sends.push({ input, indices: sendOptions.originalIndices })
      return response(message('完成'))
    },
    {
      history: raw,
      context: options({
        onContext: (state) => states.push(state),
        summarize: async (input, signal, sendOptions) => {
          assert.equal(sendOptions.onMessageEvent, undefined)
          assert.equal(sendOptions.onTextDelta, undefined)
          chunks.push(JSON.parse(input[0].content).sourceIds)
          return defaultSummarize(input)
        }
      })
    }
  )
  assert(chunks.length > 1 && chunks.length <= 6)
  assert.equal(JSON.stringify(raw), original)
  assert.equal(result.items.length, 2)
  assert(!JSON.stringify(result.items).includes('CONTEXT_KNOWLEDGE'))
  assert(sends[0].indices.includes(-1))
  for (const index of [30, 31, 32, 33, 34, 35]) assert(sends[0].indices.includes(index))
  const event = states.find((state) => state.phase === 'compacted')
  assert(event.beforeCharacters > 128000 && event.afterCharacters < event.beforeCharacters)
  assert(event.afterCharacters <= 128000)
  return { before: event.beforeCharacters, after: event.afterCharacters, chunks: chunks.length }
})

await check(
  'multiple images sharing a message pin every source member and map original positions',
  async () => {
    const raw = history()
    let sent
    await run(
      async (input, signal, sendOptions) => {
        sent = { input, indices: sendOptions.originalIndices }
        return response(message('完成'))
      },
      {
        history: raw,
        context: options({ imageIndices: [6, 6] })
      }
    )
    for (const index of [6, 7, 8]) {
      const position = sent.indices.indexOf(index)
      assert(position >= 0)
      assert.deepEqual(sent.input[position], raw[index])
    }
    assert.equal(sent.indices.indexOf(7), sent.indices.indexOf(6) + 1)
    assert.equal(sent.indices.indexOf(8), sent.indices.indexOf(6) + 2)
  }
)

await check(
  'same-task completed groups compact without dropping calls, original results or recent pairs',
  async () => {
    const states = [],
      sends = []
    let executions = 0,
      round = 0
    const result = await run(
      async (input) => {
        sends.push(structuredClone(input))
        return ++round <= 10 ? response(call('call-' + round)) : response(message('完成'))
      },
      {
        execute: async () => {
          executions++
          return JSON.stringify({ ok: true, observations: 'R'.repeat(10800) })
        },
        context: options({ onContext: (state) => states.push(state) })
      }
    )
    assert.equal(executions, 10)
    assert.equal(result.items.filter((item) => item.type === 'function_call').length, 10)
    assert.equal(result.items.filter((item) => item.type === 'function_call_output').length, 10)
    assert(states.some((state) => state.phase === 'compacted'))
    const next = sends.find((input) => JSON.stringify(input).includes('CONTEXT_KNOWLEDGE'))
    assert(next)
    assert(next.filter((item) => item.type === 'function_call').length >= 2)
    assert(next.filter((item) => item.type === 'function_call_output').length >= 2)
    assert(!JSON.stringify(result.items).includes('CONTEXT_KNOWLEDGE'))
  }
)

await check('call_id remains seen after its source group leaves the working input', async () => {
  let round = 0,
    executions = 0
  await assert.rejects(
    run(async () => response(call(++round <= 10 ? 'id-' + round : 'id-1')), {
      execute: async () => {
        executions++
        return 'R'.repeat(10800)
      }
    }),
    /重复 call_id/
  )
  assert.equal(executions, 10)
})

await check('raw turn 128000 survives compaction as an independent stop', async () => {
  let round = 0,
    executions = 0
  const states = []
  await assert.rejects(
    run(async () => response(call('id-' + ++round)), {
      execute: async () => {
        executions++
        return 'R'.repeat(10800)
      },
      context: options({ onContext: (state) => states.push(state) })
    }),
    /本轮原始协议.*128000/
  )
  assert(states.some((state) => state.phase === 'compacted'))
  assert(executions <= 12)
  return { executions }
})

await check(
  'raw turn 160 and result/final item reserve still stop before further execution',
  async () => {
    let round = 0,
      executions = 0
    await assert.rejects(
      run(
        async () =>
          response(
            ...Array.from({ length: 49 }, () => ({
              type: 'reasoning',
              summary: [],
              encrypted_content: 'opaque'
            })),
            call('item-' + ++round)
          ),
        {
          execute: async () => {
            executions++
            return 'ok'
          }
        }
      ),
      /本轮原始协议.*160/
    )
    assert.equal(executions, 3)
  }
)

await check(
  'invalid candidate falls back only to an unchanged legal working projection',
  async () => {
    const raw = [...history(9), { role: 'user', content: 'current' }]
    const states = []
    let summaries = 0
    const manager = new api.RequestContextManager(
      raw,
      raw.length - 1,
      scope,
      'execute',
      new AbortController().signal,
      options({
        summarize: async () => {
          summaries++
          return response(message('{"invalid":true}'))
        },
        onContext: (state) => states.push(state)
      })
    )
    const first = await manager.prepare()
    assert.deepEqual(first.input, raw)
    assert(!first.originalIndices.includes(-1))
    await manager.prepare()
    assert.equal(summaries, 1)
    assert(states.some((state) => state.phase === 'failed' && state.reason === 'invalid_summary'))
  }
)

await check(
  'summary function_call is rejected and no business request starts over the budget',
  async () => {
    let main = 0
    const states = []
    await assert.rejects(
      run(
        async () => {
          main++
          return response(message('invalid main'))
        },
        {
          history: history(),
          context: options({
            summarize: async () => response(call('must-not-execute')),
            onContext: (state) => states.push(state)
          })
        }
      ),
      /无法整理/
    )
    assert.equal(main, 0)
    assert(states.some((state) => state.phase === 'blocked' && state.reason === 'invalid_summary'))
  }
)

await check(
  'cancellation races a late summary, publishes no candidate, and starts no main request',
  async () => {
    const controller = new AbortController()
    let finish,
      started,
      main = 0
    const gate = new Promise((resolve) => {
      started = resolve
    })
    const states = []
    const pending = run(
      async () => {
        main++
        return response(message('unexpected'))
      },
      {
        history: history(),
        signal: controller.signal,
        context: options({
          onContext: (state) => states.push(state),
          summarize: async (input) => {
            started()
            return new Promise((resolve) => {
              finish = () =>
                resolve(
                  response(message(JSON.stringify(summary(JSON.parse(input[0].content).sourceIds))))
                )
            })
          }
        })
      }
    )
    await gate
    controller.abort(new Error('fixed cancellation'))
    await assert.rejects(pending, /fixed cancellation/)
    finish()
    await Promise.resolve()
    assert.equal(main, 0)
    assert(!states.some((state) => state.phase === 'compacted' || state.phase === 'failed'))
  }
)

await check('lost host identity after summary cannot fall back or publish', async () => {
  let current = true,
    main = 0
  const states = []
  await assert.rejects(
    run(
      async () => {
        main++
        return response(message('unexpected'))
      },
      {
        history: history(),
        context: options({
          assertCurrent: () => {
            if (!current) throw new Error('fixed identity invalid')
          },
          onContext: (state) => states.push(state),
          summarize: async (input) => {
            const result = await defaultSummarize(input)
            current = false
            return result
          }
        })
      }
    ),
    /fixed identity invalid/
  )
  assert.equal(main, 0)
  assert(!states.some((state) => state.phase === 'compacted' || state.phase === 'failed'))
})

await check(
  'phase-less completed tool response is grouped without a new intermediate rejection',
  async () => {
    const raw = [{ role: 'user', content: '任务' }]
    const manager = new api.RequestContextManager(
      raw,
      0,
      scope,
      'execute',
      new AbortController().signal,
      options()
    )
    const phased = message('公开内容')
    delete phased.phase
    raw.push(phased, call('phase-less'), {
      type: 'function_call_output',
      call_id: 'phase-less',
      output: 'ok'
    })
    manager.completedToolGroup(1)
    const projection = await manager.prepare()
    assert.deepEqual(projection.input, raw)
  }
)

await check('malformed hidden reasoning is refused before any tool executes', async () => {
  let executions = 0
  await assert.rejects(
    run(
      async () =>
        response(
          {
            type: 'reasoning',
            summary: [{ type: 'output_text', text: 'invalid hidden' }],
            encrypted_content: 12
          },
          call('bad-hidden')
        ),
      {
        execute: async () => {
          executions++
          return 'ok'
        }
      }
    ),
    /推理协议格式不正确/
  )
  assert.equal(executions, 0)
})

await check(
  'phase-less pre-call grammar remains in raw and can never be cleaned by a summary',
  async () => {
    const raw = [{ role: 'user', content: '当前原任务' }]
    let summaries = 0
    const states = []
    const manager = new api.RequestContextManager(
      raw,
      0,
      scope,
      'execute',
      new AbortController().signal,
      options({
        onContext: (state) => states.push(state),
        summarize: async (input) => {
          summaries++
          return defaultSummarize(input)
        }
      })
    )
    for (let round = 0; round < 9; round++) {
      const start = raw.length
      const ambiguous = message('历史gateway过程')
      delete ambiguous.phase
      raw.push(ambiguous, call('ambiguous-' + round), {
        type: 'function_call_output',
        call_id: 'ambiguous-' + round,
        output: 'R'.repeat(10800)
      })
      manager.completedToolGroup(start)
    }
    const projected = await manager.prepare()
    assert.deepEqual(projected.input, raw)
    assert.equal(summaries, 0)
    assert(states.some((state) => state.reason === 'no_eligible_groups'))
    assert(!JSON.stringify(projected.input).includes('validation boundary'))
  }
)

const report = {
  pass: checks.every((check) => check.pass) && networkRequests === 0,
  evidence,
  scope:
    'Current source, pure grouping/contract/tool-loop with fixed synthetic responses. No Electron, actual disk writer, process, or real model claims.',
  sourceHashes,
  runtimeImports: Object.keys(bundle.metafile.inputs),
  networkRequests,
  checks
}
await fs.writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2), {
  flag: 'wx'
})
console.log(JSON.stringify({ pass: report.pass, checks: checks.length, evidence }))
if (!report.pass) process.exitCode = 1
