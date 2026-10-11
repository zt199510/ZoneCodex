import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { PassThrough, Readable, Writable } from 'node:stream'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { root, createEvidence } from '../runtime.mjs'

const evidence = await createEvidence('io')
await mkdir(evidence, { recursive: true })
await writeFile(join(evidence, 'run.mjs'), await readFile(fileURLToPath(import.meta.url)))
const checks = [],
  fixtures = []
const files = [
  'arguments.ts',
  'output.ts',
  'interaction.ts',
  'index.ts',
  'output-bridge.ts',
  'output-writer.ts',
  'agent-host.ts',
  'host-contract.ts'
]
const sourceIdentities = []
for (const file of files) {
  const source = join(root, 'src/cli', file),
    bytes = await readFile(source)
  sourceIdentities.push({ source, sha256: createHash('sha256').update(bytes).digest('hex') })
  await writeFile(join(evidence, basename(file) + '.snapshot'), bytes)
}
const bundled = await build({
  stdin: {
    contents:
      "export * from './src/cli/arguments'; export * from './src/cli/output'; export * from './src/cli/interaction'; export * from './src/cli/host-contract'",
    resolveDir: root,
    loader: 'ts'
  },
  outfile: join(evidence, 'io.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  metafile: true,
  logLevel: 'silent'
})
await writeFile(join(evidence, 'metafile.json'), JSON.stringify(bundled.metafile, null, 2))
const io = createRequire(import.meta.url)(join(evidence, 'io.cjs'))
const pause = (ms) => new Promise((done) => setTimeout(done, ms))
async function until(predicate) {
  const start = Date.now()
  while (!predicate()) {
    assert.ok(Date.now() - start < 1200, 'fixture readiness deadline')
    await pause(5)
  }
}
async function check(name, action) {
  const startedAt = Date.now()
  try {
    const details = await action()
    checks.push({ name, pass: true, elapsedMs: Date.now() - startedAt, ...details })
  } catch (error) {
    checks.push({ name, pass: false, elapsedMs: Date.now() - startedAt, error: error.stack })
    console.error(name + ': ' + error.message)
  }
}
function capture(delay = 0) {
  const value = { text: '', active: 0, maxActive: 0, callbacks: 0 }
  value.stream = new Writable({
    highWaterMark: 1,
    write(bytes, _encoding, done) {
      value.active++
      value.maxActive = Math.max(value.maxActive, value.active)
      value.text += bytes.toString()
      const complete = () => {
        value.active--
        value.callbacks++
        done()
      }
      if (delay) setTimeout(complete, delay)
      else complete()
    }
  })
  return value
}
function result(overrides = {}) {
  return {
    requestId: 'io-request',
    conversationId: 'io-conversation',
    task: { state: 'completed', result: '最终回答' },
    answer: '最终回答',
    effects: { approved: false, started: false },
    toolResults: [],
    elapsedMs: 5,
    exitCode: 0,
    ...overrides
  }
}
function writer(mode = 'jsonl', delay = 0) {
  const stdout = capture(delay),
    stderr = capture(delay),
    errors = []
  const value = new io.CLIOutput(mode, stdout.stream, stderr.stream, (error) =>
    errors.push(error.message)
  )
  return {
    value,
    stdout,
    stderr,
    errors,
    dispose() {
      value.dispose()
      stdout.stream.destroy()
      stderr.stream.destroy()
    }
  }
}
const common = ['--mode', 'plan', '--prompt', '真实原字符串']
await check(
  'explicit named invocation preserves original prompt and defaults independently',
  () => {
    assert.deepEqual(
      io.parseCLIArguments([
        '--mode=execute',
        '--prompt=  原始任务  ',
        '--cwd=D:\\测试 目录',
        '--workspace',
        'D:\\工作区'
      ]),
      {
        help: false,
        mode: 'execute',
        prompt: '  原始任务  ',
        cwd: 'D:\\测试 目录',
        workspace: 'D:\\工作区',
        permission: 'default',
        output: 'text',
        stdin: false
      }
    )
    assert.equal(
      io.parseCLIArguments([...common, '--permission=full-access', '--output=jsonl']).permission,
      'full-access'
    )
    assert.equal(
      io.parseCLIArguments([...common, '--permission=auto-approve']).permission,
      'auto-approve'
    )
  }
)
for (const [name, args] of [
  ['missing mode', ['--prompt', 'task']],
  ['unknown mode', ['--mode', 'resume', '--prompt', 'task']],
  ['unknown named argument', [...common, '--yes']],
  ['positional argument', [...common, 'extra']],
  ['duplicate across equal and separated forms', [...common, '--mode=execute']],
  ['prompt and stdin conflict', [...common, '--stdin']],
  ['missing task source', ['--mode', 'plan']],
  ['stdin takes no value', ['--mode', 'plan', '--stdin=yes']],
  ['missing named value', ['--mode', '--stdin']],
  ['unknown permission', [...common, '--permission', 'dangerously-ignore']],
  ['unknown output', [...common, '--output=json']],
  ['control character in cwd', [...common, '--cwd=bad\0dir']],
  ['empty workspace', [...common, '--workspace=   ']],
  ['help cannot coexist with task', ['--help', ...common]],
  ['long original untrimmed prompt', ['--mode', 'plan', '--prompt', ' '.repeat(1999) + 'xx']],
  ['whitespace-only task', ['--mode', 'plan', '--prompt= \t\n ']]
])
  await check('arguments reject ' + name, () =>
    assert.throws(() => io.parseCLIArguments(args), io.CLIInputError)
  )
await check('help only and stdin only are explicit nonoverlapping contracts', () => {
  assert.equal(io.parseCLIArguments(['--help']).help, true)
  assert.equal(io.parseCLIArguments(['--mode', 'plan', '--stdin']).stdin, true)
  assert.equal(io.requestedOutput(['--output=jsonl']), 'jsonl')
})
await check('prompt budget is original JS UTF16 length and accepts exactly 2000', () => {
  const text = '😀'.repeat(1000)
  assert.equal(text.length, 2000)
  assert.equal(io.validatePrompt(text), text)
  assert.throws(() => io.validatePrompt(text + ' '), io.CLIInputError)
})
await check('raw split multibyte UTF8 and normal EOF complete task input', async () => {
  const bytes = Buffer.from(' \ufeff任务😀\n '),
    input = Readable.from([bytes.subarray(0, 4), bytes.subarray(4, 8), bytes.subarray(8)])
  assert.equal(await io.readTaskInput(input, new AbortController().signal), ' \ufeff任务😀\n ')
  for (const event of ['data', 'end', 'error', 'close']) assert.equal(input.listenerCount(event), 0)
})
for (const [name, chunks] of [
  ['fatal invalid UTF8', [Buffer.from([0xc3, 0x28])]],
  ['unfinished multibyte UTF8', [Buffer.from([0xe4, 0xb8])]],
  ['empty EOF', []],
  ['trim empty input', [Buffer.from(' \t\n')]],
  ['8192 byte budget before decoding', [Buffer.alloc(8193, 0x61)]],
  ['2000 original JS characters after decode', [Buffer.from('x'.repeat(2001))]],
  ['BOM counts as original character', [Buffer.from('\ufeff' + 'x'.repeat(2000))]]
])
  await check('stdin rejects ' + name, async () => {
    const input = Readable.from(chunks)
    await assert.rejects(io.readTaskInput(input, new AbortController().signal), io.CLIInputError)
    for (const event of ['data', 'end', 'error', 'close'])
      assert.equal(input.listenerCount(event), 0)
  })
await check('text-decoded stdin is rejected rather than silently repaired', async () => {
  const input = Readable.from([Buffer.from('任务')])
  input.setEncoding('utf8')
  await assert.rejects(io.readTaskInput(input, new AbortController().signal), io.CLIInputError)
})
await check('stdin abort carries exact cause and removes every owned listener', async () => {
  const input = new PassThrough(),
    controller = new AbortController(),
    cause = new Error('用户停止')
  const waiting = io.readTaskInput(input, controller.signal)
  controller.abort(cause)
  await assert.rejects(waiting, (error) => error === cause)
  for (const event of ['data', 'end', 'error', 'close']) assert.equal(input.listenerCount(event), 0)
  assert.equal(input.isPaused(), true)
  input.destroy()
})
await check('stdin error or premature close never starts a task', async () => {
  for (const action of ['error', 'close']) {
    const input = new PassThrough(),
      waiting = io.readTaskInput(input, new AbortController().signal)
    if (action === 'error') input.emit('error', new Error('private input error'))
    else input.destroy()
    await assert.rejects(waiting, io.CLIInputError)
  }
})
await check(
  'public projection drops raw protocol, reasoning and credentials at all envelopes',
  () => {
    const privateFields = {
      items: ['PRIVATE_ITEMS'],
      encrypted_content: 'PRIVATE_ENCRYPTED',
      headers: { authorization: 'PRIVATE_KEY' }
    }
    const events = [
      { type: 'progress', requestId: 'io-request', message: '公开', ...privateFields },
      { type: 'delta', requestId: 'io-request', delta: '增量', ...privateFields },
      {
        type: 'message',
        event: {
          requestId: 'io-request',
          messageId: 'response-1-attempt-0-message-0',
          phase: 'commentary',
          text: '过程',
          ...privateFields
        },
        ...privateFields
      },
      {
        type: 'retry',
        event: {
          requestId: 'io-request',
          round: 1,
          retry: 1,
          maxRetries: 5,
          delayMs: 0,
          reason: 'stream',
          ...privateFields
        },
        ...privateFields
      },
      {
        type: 'tool',
        event: {
          requestId: 'io-request',
          callId: 'call-a',
          name: 'get_current_time',
          phase: 'start',
          arguments: '{}',
          ...privateFields
        },
        ...privateFields
      },
      {
        type: 'tool',
        event: {
          requestId: 'io-request',
          callId: 'call-a',
          name: 'get_current_time',
          phase: 'finish',
          output: '公开工具结果',
          durationMs: 1,
          ...privateFields
        },
        ...privateFields
      }
    ]
    for (const event of events)
      assert.ok(!JSON.stringify(io.projectEvent(event)).includes('PRIVATE_'))
    const projected = io.projectResult(
      result({
        ...privateFields,
        task: { state: 'completed', result: '最终回答', ...privateFields },
        effects: { approved: true, started: true, ...privateFields },
        toolResults: [
          { callId: 'call-a', name: 'get_current_time', output: '公开工具结果', ...privateFields }
        ]
      })
    )
    assert.ok(!JSON.stringify(projected).includes('PRIVATE_'))
    assert.deepEqual(Object.keys(projected), [
      'type',
      'requestId',
      'conversationId',
      'task',
      'answer',
      'effects',
      'toolResults',
      'elapsedMs',
      'exitCode'
    ])
  }
)
await check('invalid private event kinds, tool names and public budgets are rejected', () => {
  for (const event of [
    { type: 'reasoning' },
    { type: 'progress', requestId: 'io-request', message: 'x'.repeat(501) },
    {
      type: 'tool',
      event: {
        requestId: 'io-request',
        callId: 'x',
        name: 'hidden_tool',
        phase: 'finish',
        output: '',
        durationMs: 0
      }
    },
    {
      type: 'message',
      event: { requestId: 'io-request', messageId: 'old-message', phase: 'commentary', text: '' }
    }
  ])
    assert.throws(() => io.projectEvent(event), io.CLIOutputError)
  assert.throws(() => io.projectResult(result({ answer: 'x'.repeat(16001) })), io.CLIOutputError)
  assert.throws(
    () =>
      io.projectResult(
        result({
          toolResults: [{ callId: 'x', name: 'run_workspace_command', output: 'x'.repeat(12001) }]
        })
      ),
    io.CLIOutputError
  )
})
await check(
  'JSONL is flat public records plus exactly one terminal; unrelated and late ignored',
  async () => {
    const fixture = writer()
    try {
      fixture.value.event({ type: 'progress', requestId: 'io-request', message: '公开过程' })
      fixture.value.event({ type: 'progress', requestId: 'foreign', message: 'UNRELATED' })
      fixture.value.terminal(result())
      fixture.value.terminal(result())
      fixture.value.event({ type: 'progress', requestId: 'io-request', message: 'LATE' })
      await fixture.value.flush()
      const rows = fixture.stdout.text.trim().split('\n').map(JSON.parse)
      assert.deepEqual(
        rows.map((row) => row.type),
        ['progress', 'result']
      )
      assert.equal(fixture.stderr.text, '')
      assert.ok(!fixture.stdout.text.includes('UNRELATED'))
      assert.ok(!fixture.stdout.text.includes('LATE'))
      fixtures.push({ label: 'jsonl', stdout: fixture.stdout.text, stderr: fixture.stderr.text })
    } finally {
      fixture.dispose()
    }
  }
)
await check(
  'text stdout is final only; cumulative commentary emits each suffix once and retry retires attempt',
  async () => {
    const fixture = writer('text')
    try {
      fixture.value.event({ type: 'delta', requestId: 'io-request', delta: 'DUPLICATE_FINAL' })
      const commentary = (text) => ({
        type: 'message',
        event: {
          requestId: 'io-request',
          messageId: 'response-1-attempt-0-message-0',
          phase: 'commentary',
          text
        }
      })
      fixture.value.event(commentary('公开'))
      fixture.value.event(commentary('公开过程'))
      fixture.value.event(commentary('公开过程'))
      fixture.value.event({
        type: 'retry',
        event: {
          requestId: 'io-request',
          round: 1,
          retry: 1,
          maxRetries: 5,
          delayMs: 0,
          reason: 'stream'
        }
      })
      fixture.value.event({
        type: 'message',
        event: {
          requestId: 'io-request',
          messageId: 'response-1-attempt-1-message-0',
          phase: 'commentary',
          text: '重新研究'
        }
      })
      fixture.value.terminal(result())
      await fixture.value.flush()
      assert.equal(fixture.stdout.text, '最终回答\n')
      assert.equal(fixture.stderr.text.match(/公开过程/g)?.length, 1)
      assert.ok(fixture.stderr.text.includes('前一尝试过程已退休'))
      assert.ok(fixture.stderr.text.includes('重新研究'))
      fixtures.push({ label: 'text', stdout: fixture.stdout.text, stderr: fixture.stderr.text })
    } finally {
      fixture.dispose()
    }
  }
)
await check(
  'cancelled terminal retains returned tool facts and text stderr delivers missing late result',
  async () => {
    for (const mode of ['jsonl', 'text']) {
      const fixture = writer(mode)
      try {
        fixture.value.terminal(
          result({
            task: { state: 'cancelled', error: '用户停止；核对副作用' },
            answer: '',
            effects: { approved: true, started: true },
            toolResults: [
              {
                callId: 'actual-return',
                name: 'run_workspace_command',
                output: '{"exitCode":7,"treeExited":false}'
              }
            ],
            exitCode: 130
          })
        )
        await fixture.value.flush()
        if (mode === 'jsonl') {
          const row = JSON.parse(fixture.stdout.text)
          assert.equal(row.exitCode, 130)
          assert.equal(row.effects.started, true)
          assert.ok(row.toolResults[0].output.includes('treeExited'))
        } else {
          assert.equal(fixture.stdout.text, '')
          assert.ok(fixture.stderr.text.includes('"treeExited":false'))
          assert.ok(fixture.stderr.text.includes('核对副作用'))
        }
        fixtures.push({
          label: 'cancelled-' + mode,
          stdout: fixture.stdout.text,
          stderr: fixture.stderr.text
        })
      } finally {
        fixture.dispose()
      }
    }
  }
)
await check('serial writes honor callback backpressure across stdout and stderr', async () => {
  const fixture = writer('jsonl', 15)
  try {
    fixture.value.event({ type: 'progress', requestId: 'io-request', message: '一' })
    fixture.value.diagnostic('诊断')
    fixture.value.terminal(result())
    assert.equal(fixture.stdout.callbacks, 0)
    await fixture.value.flush()
    assert.equal(fixture.stdout.maxActive, 1)
    assert.equal(fixture.stderr.maxActive, 1)
    assert.equal(fixture.stdout.callbacks, 2)
    assert.equal(fixture.stderr.callbacks, 1)
  } finally {
    fixture.dispose()
  }
})
await check(
  'EPIPE callback cancels once, flush fails and all stream listeners release',
  async () => {
    const stdout = new Writable({
        write(_bytes, _encoding, done) {
          const error = new Error('private EPIPE details')
          error.code = 'EPIPE'
          done(error)
        }
      }),
      stderr = capture(),
      errors = []
    const value = new io.CLIOutput('jsonl', stdout, stderr.stream, (error) => errors.push(error))
    value.terminal(result())
    await assert.rejects(value.flush(), io.CLIOutputError)
    assert.equal(errors.length, 1)
    value.dispose()
    await pause(0)
    assert.equal(stdout.listenerCount('error'), 0)
    assert.equal(stdout.listenerCount('close'), 0)
    stdout.destroy()
    stderr.stream.destroy()
  }
)
await check('pending output byte budget rejects runaway consumer buffering', async () => {
  const fixture = writer()
  try {
    assert.throws(() => {
      for (let i = 0; i < 60; i++)
        fixture.value.event({ type: 'delta', requestId: 'io-request', delta: 'x'.repeat(100000) })
    }, io.CLIOutputError)
    await assert.rejects(fixture.value.flush(), io.CLIOutputError)
    assert.equal(fixture.errors.length, 1)
  } finally {
    fixture.dispose()
  }
})
await check(
  'cancel signal releases indefinitely stalled output within grace and removes listeners',
  async () => {
    const stdout = new Writable({
        write() {
          /* Deliberate stalled-output fixture: never complete the write. */
        }
      }),
      stderr = capture(),
      controller = new AbortController(),
      errors = []
    const value = new io.CLIOutput('jsonl', stdout, stderr.stream, (error) => errors.push(error))
    value.event({ type: 'progress', requestId: 'io-request', message: '阻塞' })
    const start = Date.now(),
      flushing = value.flush(controller.signal)
    controller.abort(new Error('用户停止'))
    await assert.rejects(flushing, io.CLIOutputError)
    assert.ok(Date.now() - start < 1000)
    assert.equal(stdout.destroyed, true)
    assert.equal(errors.length, 1)
    value.dispose()
    assert.equal(stdout.listenerCount('error'), 0)
    assert.equal(stdout.listenerCount('close'), 0)
    stderr.stream.destroy()
    return { releaseMs: Date.now() - start, syntheticBlockedWritable: true }
  }
)
await check(
  'healthy output still delivers exactly one cancelled terminal after signal',
  async () => {
    const fixture = writer('jsonl', 10),
      controller = new AbortController()
    try {
      controller.abort(new Error('用户停止'))
      fixture.value.terminal(
        result({ task: { state: 'cancelled', error: '用户停止' }, answer: '', exitCode: 130 })
      )
      await fixture.value.flush(controller.signal)
      assert.equal(JSON.parse(fixture.stdout.text).exitCode, 130)
      assert.equal(fixture.stdout.stream.destroyed, false)
    } finally {
      fixture.dispose()
    }
  }
)
await check('terminal controls are removed without altering Unicode or ordinary whitespace', () => {
  assert.equal(io.terminalText('中\t文\n\r\0\x1b[31m\x7f'), '中\t文\n\r[31m')
})
function terminalFixture({ tty = true, used = false } = {}) {
  const input = new PassThrough(),
    stderr = capture(),
    controller = new AbortController(),
    diagnostics = []
  input.isTTY = tty
  input.setRawMode = () => input
  stderr.stream.isTTY = tty
  stderr.stream.columns = 120
  let unavailable = 0,
    interrupts = 0
  const terminal = new io.TerminalInteraction(input, stderr.stream, used, controller.signal, {
    diagnostic: (text) => diagnostics.push(text),
    flush: async () => {},
    unavailable: (error) => {
      unavailable++
      controller.abort(error)
    },
    cancel: () => {
      interrupts++
      controller.abort(new Error('用户停止'))
    }
  })
  return {
    input,
    stderr,
    controller,
    terminal,
    diagnostics,
    get unavailable() {
      return unavailable
    },
    get interrupts() {
      return interrupts
    },
    dispose() {
      terminal.dispose()
      input.destroy()
      stderr.stream.destroy()
    }
  }
}
const approval = {
  kind: 'command',
  requestId: 'io-request',
  conversationId: 'io-conversation',
  cwd: 'D:\\隔离测试',
  program: 'node',
  args: ['fixed-test.cjs'],
  reason: '精确命令'
}
const question = {
  requestId: 'io-request',
  conversationId: 'io-conversation',
  inputId: 'input-a',
  callId: 'call-question',
  questions: [
    {
      id: 'layout',
      header: '布局',
      question: '选择布局',
      options: [
        { label: '卡片', description: '用卡片' },
        { label: '列表', description: '用列表' }
      ]
    },
    {
      id: 'color',
      header: '颜色',
      question: '选择颜色',
      options: [
        { label: '蓝', description: '蓝色' },
        { label: '绿', description: '绿色' }
      ]
    }
  ]
}
await check('readline is lazy and stdin task or nonTTY cannot supply approval', async () => {
  for (const options of [{ tty: false }, { used: true }]) {
    const fixture = terminalFixture(options)
    try {
      assert.equal(fixture.input.listenerCount('data'), 0)
      await assert.rejects(
        fixture.terminal.approve(approval, fixture.controller.signal),
        io.InteractionUnavailableError
      )
      assert.equal(fixture.unavailable, 1)
      assert.equal(fixture.input.listenerCount('data'), 0)
    } finally {
      fixture.dispose()
    }
  }
})
for (const [answer, accepted] of [
  ['yes', true],
  ['no', false]
])
  await check(
    'synthetic terminal actual readline ' + answer + ' is an explicit current decision',
    async () => {
      const fixture = terminalFixture()
      try {
        const waiting = fixture.terminal.approve(approval, fixture.controller.signal)
        await until(() => fixture.stderr.text.includes('yes'))
        fixture.input.write(answer + '\n')
        assert.equal(await waiting, accepted)
        assert.equal(fixture.controller.signal.aborted, false)
        assert.ok(fixture.diagnostics.join('\n').includes('fixed-test.cjs'))
        fixtures.push({
          label: 'readline-' + answer,
          syntheticTTY: true,
          diagnostics: fixture.diagnostics,
          terminal: fixture.stderr.text
        })
      } finally {
        fixture.dispose()
      }
    }
  )
await check(
  'file approval identifies exact candidate and original hashes with explicit truncation',
  async () => {
    const fixture = terminalFixture()
    try {
      const waiting = fixture.terminal.approve(
        {
          kind: 'edit',
          requestId: 'io-request',
          conversationId: 'io-conversation',
          cwd: 'D:\\隔离测试',
          path: 'large.txt',
          before: '原文',
          after: 'x'.repeat(4100)
        },
        fixture.controller.signal
      )
      await until(() => fixture.stderr.text.includes('yes'))
      assert.ok(fixture.diagnostics.join('\n').includes('SHA-256'))
      assert.ok(fixture.diagnostics.join('\n').includes('前4000字符，其余未展示'))
      fixture.input.write('no\n')
      assert.equal(await waiting, false)
    } finally {
      fixture.dispose()
    }
  }
)
await check(
  'approval invalid truthy word does not grant; pending new question still requires no',
  async () => {
    const fixture = terminalFixture()
    try {
      const waiting = fixture.terminal.approve(approval, fixture.controller.signal)
      await until(() => fixture.stderr.text.includes('yes'))
      fixture.input.write('true\n')
      await until(() => fixture.diagnostics.some((text) => text.includes('未作出批准')))
      fixture.input.write('no\n')
      assert.equal(await waiting, false)
    } finally {
      fixture.dispose()
    }
  }
)
await check(
  'answers use canonical question IDs, choices/custom text and never imply approval',
  async () => {
    const fixture = terminalFixture()
    try {
      const waiting = fixture.terminal.answer(question, fixture.controller.signal)
      await until(() => fixture.stderr.text.includes('自定义'))
      fixture.input.write('2\n')
      await until(() => fixture.stderr.text.split('自定义').length >= 3)
      fixture.input.write('c\n')
      await until(() => fixture.stderr.text.includes('输入自定义回答'))
      fixture.input.write(' 自选颜色 \n')
      assert.deepEqual(await waiting, [
        { id: 'layout', answer: '列表' },
        { id: 'color', answer: '自选颜色' }
      ])
      assert.ok(fixture.diagnostics.some((text) => text.includes('不授予执行权限')))
      fixtures.push({
        label: 'readline-questions',
        syntheticTTY: true,
        diagnostics: fixture.diagnostics,
        terminal: fixture.stderr.text
      })
    } finally {
      fixture.dispose()
    }
  }
)
await check('approval EOF releases pending wait with unavailable and never grants', async () => {
  const fixture = terminalFixture()
  try {
    const waiting = fixture.terminal.approve(approval, fixture.controller.signal)
    await until(() => fixture.stderr.text.includes('yes'))
    fixture.input.end()
    await assert.rejects(waiting, io.InteractionUnavailableError)
    assert.equal(fixture.unavailable, 1)
  } finally {
    fixture.dispose()
  }
})
await check(
  'question EOF releases pending wait with unavailable and no fabricated answer',
  async () => {
    const fixture = terminalFixture()
    try {
      const waiting = fixture.terminal.answer(question, fixture.controller.signal)
      await until(() => fixture.stderr.text.includes('自定义'))
      fixture.input.end()
      await assert.rejects(waiting, io.InteractionUnavailableError)
      assert.equal(fixture.unavailable, 1)
    } finally {
      fixture.dispose()
    }
  }
)
await check(
  'callback-specific signal aborts readline even when original CLI signal is active',
  async () => {
    const fixture = terminalFixture(),
      callbackController = new AbortController(),
      cause = new Error('宿主上下文失效')
    try {
      const waiting = fixture.terminal.approve(approval, callbackController.signal)
      await until(() => fixture.stderr.text.includes('yes'))
      callbackController.abort(cause)
      await assert.rejects(waiting, (error) => error === cause)
      assert.equal(fixture.controller.signal.aborted, false)
      for (const event of ['keypress', 'end', 'error'])
        assert.equal(fixture.input.listenerCount(event), 0)
      assert.equal(fixture.input.isPaused(), true)
    } finally {
      fixture.dispose()
    }
  }
)
await check(
  'original CLI signal cancels pending answer and releases owned input listeners',
  async () => {
    const fixture = terminalFixture(),
      cause = new Error('Ctrl+C')
    try {
      const waiting = fixture.terminal.answer(question, new AbortController().signal)
      await until(() => fixture.stderr.text.includes('自定义'))
      fixture.controller.abort(cause)
      await assert.rejects(waiting, (error) => error === cause)
      for (const event of ['keypress', 'end', 'error'])
        assert.equal(fixture.input.listenerCount(event), 0)
      assert.equal(fixture.input.isPaused(), true)
    } finally {
      fixture.dispose()
    }
  }
)
await check(
  'readline Ctrl+C uses one cancellation callback and cannot count as an answer',
  async () => {
    const fixture = terminalFixture()
    try {
      const waiting = fixture.terminal.approve(approval, fixture.controller.signal)
      await until(() => fixture.stderr.text.includes('yes'))
      fixture.input.write('\x03')
      await assert.rejects(waiting, /用户停止/)
      assert.equal(fixture.interrupts, 1)
    } finally {
      fixture.dispose()
    }
  }
)
await check(
  'overlapping waits fail closed rather than accept a second future decision',
  async () => {
    const fixture = terminalFixture()
    try {
      const first = fixture.terminal.approve(approval, fixture.controller.signal)
      await until(() => fixture.stderr.text.includes('yes'))
      const firstRejected = assert.rejects(first, io.InteractionUnavailableError)
      await assert.rejects(
        fixture.terminal.answer(question, fixture.controller.signal),
        io.InteractionUnavailableError
      )
      await firstRejected
    } finally {
      fixture.dispose()
    }
  }
)
await check(
  'unsolicited line between operations does not preapprove the next operation',
  async () => {
    const fixture = terminalFixture()
    try {
      const first = fixture.terminal.approve(approval, fixture.controller.signal)
      await until(() => fixture.stderr.text.includes('yes'))
      fixture.input.write('yes\n')
      assert.equal(await first, true)
      fixture.input.write('yes\n')
      await pause(5)
      let resolved = false
      const second = fixture.terminal
        .approve({ ...approval, requestId: 'second-request' }, fixture.controller.signal)
        .then((value) => {
          resolved = true
          return value
        })
      await until(() => fixture.stderr.text.split('yes 批准').length >= 3)
      await pause(15)
      assert.equal(resolved, false)
      fixture.input.write('no\n')
      assert.equal(await second, false)
    } finally {
      fixture.dispose()
    }
  }
)
await writeFile(join(evidence, 'fixtures.json'), JSON.stringify(fixtures, null, 2))
const report = {
  layer: 'Original CLI arguments/output/interaction modules, bundled for targeted offline checks',
  node: process.version,
  syntheticIO: true,
  syntheticTTY: true,
  realConPTY: false,
  modelRequests: 0,
  toolSpawns: 0,
  sourceIdentities,
  checks,
  passed: checks.filter((row) => row.pass).length,
  failed: checks.filter((row) => !row.pass).length,
  limitations: [
    'Readline input uses synthetic stream TTY capabilities; actual ConPTY/compiled CLI subprocess coverage belongs to separate evidence.',
    'No model, original tool execution, desktop app or network requests in this fixture.'
  ]
}
await writeFile(join(evidence, 'results.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify({ evidence, passed: report.passed, failed: report.failed }))
process.exitCode = report.failed ? 1 : 0
