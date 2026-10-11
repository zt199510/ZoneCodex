import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { root, createEvidence } from '../runtime.mjs'

const entryArg = process.argv.find((arg) => arg.startsWith('--entry='))?.slice(8)
assert.ok(entryArg, 'Provide the actual compiled user CLI via --entry=')
assert.ok(process.argv.slice(2).every((arg) => arg.startsWith('--entry=')))
const entry = path.resolve(root, entryArg)
const preload = fileURLToPath(new URL('./cli-synthetic-preload.cjs', import.meta.url))
const evidence = await createEvidence('cli-process')
await fs.copyFile(fileURLToPath(import.meta.url), path.join(evidence, 'validator.mjs.snapshot'))
await fs.copyFile(preload, path.join(evidence, 'preload.cjs.snapshot'))
const require = createRequire(path.join(root, 'package.json'))
const pty = require('node-pty')
const checks = [],
  cases = []
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const provenance = {
  entry,
  entrySHA256: hash(await fs.readFile(entry)),
  preloadSHA256: hash(await fs.readFile(preload)),
  node: process.version,
  execPath: process.execPath
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const bounded = async (promise, ms) => {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), ms)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}
const stripAnsi = (text) =>
  text
    // eslint-disable-next-line no-control-regex -- Strip actual ConPTY ANSI control characters before parsing public records.
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    // eslint-disable-next-line no-control-regex -- Strip actual ConPTY OSC control characters before parsing public records.
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replaceAll('\r', '')
const records = (stdout) =>
  stdout
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
const assertWriters = (audit) => {
  assert.ok(Array.isArray(audit.outputWriters))
  assert.ok(audit.outputWriters.length <= 1)
  for (const writer of audit.outputWriters) {
    assert.equal(writer.kind, 'fixed-output-writer')
    assert.ok(writer.closed)
    assert.ok(
      !writer.hasModelCredential &&
        !writer.hasModelEndpoint &&
        !writer.hasModelName &&
        !writer.hasNodeOptions
    )
    assert.ok(writer.environmentNames.every((key) => /^(SystemRoot|WINDIR|TEMP|TMP)$/i.test(key)))
    assert.ok(!JSON.stringify(writer.args).includes('LESSON55_SYNTHETIC_SECRET_SENTINEL'))
    assert.ok(Number.isSafeInteger(writer.pid) && writer.pid > 0)
  }
}
async function check(name, action) {
  const start = Date.now()
  try {
    const details = await action()
    checks.push({ name, pass: true, elapsedMs: Date.now() - start, ...details })
  } catch (error) {
    checks.push({ name, pass: false, elapsedMs: Date.now() - start, error: error.stack })
    console.error(name + ': ' + error.message)
  }
}
async function prepare(label) {
  const directory = path.join(evidence, label + '-' + randomUUID())
  const workspace = path.join(directory, 'workspace')
  await fs.mkdir(workspace, { recursive: true })
  const source = Buffer.from('\ufeffexport const value = 1\r\n\r\n\r\n')
  await fs.writeFile(path.join(workspace, 'sample.ts'), source)
  await fs.writeFile(
    path.join(workspace, 'command.cjs'),
    'console.log(JSON.stringify({command:true,credential:!!process.env.MODEL_API_KEY}));\n'
  )
  await fs.writeFile(
    path.join(workspace, 'long-command.cjs'),
    'console.log("long-command-ready");setTimeout(()=>console.log("unexpected-late-command"),30000);\n'
  )
  const env = {
    ...process.env,
    MODEL_ENDPOINT: 'https://example.invalid/v1/responses',
    MODEL_NAME: 'gpt-6.1-sol',
    MODEL_API_KEY: 'LESSON55_SYNTHETIC_SECRET_SENTINEL',
    LESSON55_EVIDENCE: directory,
    LESSON55_WORKSPACE: workspace,
    LESSON55_SOURCE_HASH: hash(source),
    LESSON55_FIXTURE: label
  }
  delete env.ELECTRON_RUN_AS_NODE
  return { directory, workspace, source, env }
}
async function run(label, argv = [], options = {}) {
  const item = await prepare(label)
  if (options.fixture) item.env.LESSON55_FIXTURE = options.fixture
  for (const key of options.removeEnv || []) delete item.env[key]
  const args = [
    '--require',
    preload,
    entry,
    ...argv.map((arg) => (arg === '$cwd' ? item.workspace : arg))
  ]
  const child = spawn(process.execPath, args, {
    cwd: item.directory,
    env: item.env,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  let stdout = '',
    stderr = '',
    stdoutClosed = false,
    forcedKill = false
  child.stdout.on('data', (bytes) => {
    stdout += bytes
    if (options.closeOutput && !stdoutClosed) {
      stdoutClosed = true
      child.stdout.destroy()
    }
  })
  child.stderr.on('data', (bytes) => {
    stderr += bytes
  })
  child.stdin.on('error', () => undefined)
  const done = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (exitCode, signal) => resolve({ exitCode, signal }))
  })
  if (options.input !== undefined) {
    if (Array.isArray(options.input)) {
      for (const bytes of options.input) {
        child.stdin.write(bytes)
        await pause(30)
      }
      child.stdin.end()
    } else child.stdin.end(options.input)
  } else if (!options.keepInputOpen) child.stdin.end()
  const outcome = await bounded(done, options.timeoutMs || 30000)
  if (!outcome) {
    forcedKill = true
    child.kill()
    await Promise.race([done, pause(3000)])
  }
  let audit
  try {
    audit = JSON.parse(await fs.readFile(path.join(item.directory, 'transport-audit.json'), 'utf8'))
  } catch {
    // Preserve missing audit evidence in the process result for the existing assertions to reject.
  }
  const result = {
    label,
    directory: item.directory,
    pid: child.pid,
    args: argv,
    ...outcome,
    forcedKill,
    stdoutClosed,
    stdout,
    stderr,
    audit
  }
  await fs.writeFile(path.join(item.directory, 'process.json'), JSON.stringify(result, null, 2))
  await fs.writeFile(path.join(item.directory, 'stdout.txt'), stdout)
  await fs.writeFile(path.join(item.directory, 'stderr.txt'), stderr)
  cases.push(result)
  assert.equal(forcedKill, false, 'CLI must release itself within the check deadline')
  assert.ok(outcome)
  assertWriters(audit)
  return { ...result, ...item }
}
function terminalResult(item, code) {
  assert.equal(item.exitCode, code, item.stderr)
  const values = records(item.stdout)
  const finals = values.filter((value) => value.type === 'result')
  assert.equal(finals.length, 1, 'Exactly one public terminal result')
  assert.equal(finals[0].exitCode, code)
  assert.ok(!item.stdout.includes('LESSON55_PRIVATE_'))
  assert.ok(!item.stdout.includes('LESSON55_SYNTHETIC_SECRET_SENTINEL'))
  assert.ok(!Object.hasOwn(finals[0], 'items'))
  assert.ok(Array.isArray(finals[0].toolResults))
  assert.ok(finals[0].toolResults.length <= 160)
  assert.ok(
    finals[0].toolResults.every(
      (item) => Object.keys(item).sort().join(',') === 'callId,name,output'
    )
  )
  return { values, final: finals[0] }
}
async function zero(name, argv, options = {}) {
  const item = await run(name, argv, options)
  assert.equal(item.exitCode, options.code ?? 2)
  assert.equal(item.audit.requests.length, 0)
  assert.equal(item.audit.spawns.length, 0)
  return { evidence: item.directory, modelRequests: 0, toolSpawns: 0 }
}
const common = [
  '--mode',
  'execute',
  '--cwd',
  '$cwd',
  '--prompt',
  '固定的合成入口验证',
  '--output',
  'jsonl'
]
await check('actual Node help has zero model and tool requests', () =>
  zero('help', ['--help'], { code: 0 })
)
await check('empty fresh process is an input error with zero implicit requests', () =>
  zero('empty', [])
)
for (const [name, argv] of [
  ['missing-mode', ['--prompt', 'task']],
  ['unknown-mode', ['--mode', 'resume', '--prompt', 'task']],
  ['unknown-argument', [...common, '--yes']],
  ['duplicate-prompt', [...common, '--prompt', 'other']],
  ['conflicting-source', [...common, '--stdin']],
  ['empty-prompt', ['--mode', 'execute', '--prompt', '   ']],
  ['long-prompt', ['--mode', 'execute', '--prompt', ' '.repeat(1999) + 'xx']],
  ['unknown-permission', [...common, '--permission', 'dangerously-ignore']],
  ['invalid-output', ['--mode', 'plan', '--prompt', 'task', '--output', 'json']],
  ['help-conflict', ['--help', '--mode', 'plan']],
  [
    'missing-directory',
    ['--mode', 'execute', '--cwd', path.join(evidence, 'absent'), '--prompt', 'task']
  ]
])
  await check(name + ' rejects before model preparation', () => zero(name, argv))
await check('missing model credential rejects before requests', () =>
  zero('missing-credential', common, { removeEnv: ['MODEL_API_KEY'] })
)
await check('HTTP endpoint rejects before requests', async () => {
  // Preparation uses a unique local case; no synthetic fetch may mask invalid configuration.
  const item = await prepare('invalid-endpoint')
  item.env.MODEL_ENDPOINT = 'http://example.invalid/v1/responses'
  const child = spawn(
    process.execPath,
    ['--require', preload, entry, ...common.map((arg) => (arg === '$cwd' ? item.workspace : arg))],
    { cwd: item.directory, env: item.env, windowsHide: true }
  )
  let stdout = '',
    stderr = ''
  child.stdout.on('data', (bytes) => (stdout += bytes))
  child.stderr.on('data', (bytes) => (stderr += bytes))
  child.stdin.end()
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  const audit = JSON.parse(
    await fs.readFile(path.join(item.directory, 'transport-audit.json'), 'utf8')
  )
  await fs.writeFile(
    path.join(item.directory, 'process.json'),
    JSON.stringify({ pid: child.pid, stdout, stderr, exitCode, audit }, null, 2)
  )
  assert.equal(exitCode, 2)
  assert.equal(audit.requests.length, 0)
  assert.equal(audit.spawns.length, 0)
  return { evidence: item.directory }
})
for (const [name, bytes] of [
  ['stdin-invalid-utf8', Buffer.from([0xc3, 0x28])],
  ['stdin-byte-overflow', Buffer.alloc(8193, 0x61)],
  ['stdin-char-overflow', Buffer.from('你'.repeat(2001))],
  ['stdin-empty', Buffer.from(' \r\n ')],
  ['stdin-bom-count', Buffer.from('\ufeff' + 'a'.repeat(2000))]
])
  await check(name + ' fails without truncation and before model', () =>
    zero(name, ['--mode', 'plan', '--stdin', '--output', 'jsonl'], { input: bytes })
  )
await check(
  'normal pipe EOF validates original stdin length then follows existing core trim consumption',
  async () => {
    const prompt = '  管道任务\n'
    const bytes = Buffer.from(prompt)
    const item = await run('stdin-valid', ['--mode', 'plan', '--stdin', '--output', 'jsonl'], {
      input: [bytes.subarray(0, 5), bytes.subarray(5)],
      fixture: 'done'
    })
    terminalResult(item, 0)
    assert.equal(item.audit.requests.length, 1)
    assert.equal(
      item.audit.requests[0].input.findLast((value) => value.role === 'user').content,
      prompt.trim()
    )
    return { evidence: item.directory, normalEOFStartsTask: true }
  }
)
await check(
  'exact 2000 original JS characters are accepted before existing core trim consumption',
  async () => {
    const prompt = '  ' + 'a'.repeat(1998)
    const item = await run('prompt-boundary', [
      '--mode',
      'plan',
      '--prompt',
      prompt,
      '--output',
      'jsonl'
    ])
    terminalResult(item, 0)
    assert.equal(
      item.audit.requests[0].input.findLast((value) => value.role === 'user').content,
      prompt.trim()
    )
    return { evidence: item.directory }
  }
)
await check('JSONL only exposes public records and one semantic terminal outcome', async () => {
  const item = await run('done', common)
  const { values, final } = terminalResult(item, 0)
  assert.equal(final.task.state, 'completed')
  assert.equal(final.answer, 'synthetic public completion')
  assert.ok(values.some((value) => value.type === 'delta'))
  assert.ok(values.some((value) => value.type === 'message'))
  assert.equal(item.audit.requests.length, 1)
  assert.ok(!item.stderr.includes('LESSON55_PRIVATE_'))
  return { evidence: item.directory, recordTypes: [...new Set(values.map((value) => value.type))] }
})
await check('text stdout contains only final answer and process appears in stderr', async () => {
  const item = await run('time', ['--mode', 'execute', '--cwd', '$cwd', '--prompt', '固定任务'])
  assert.equal(item.exitCode, 0)
  assert.equal(item.stdout.trim(), 'synthetic time completed')
  assert.ok(item.stderr.includes('get_current_time'))
  assert.ok(!item.stdout.includes('LESSON55_PRIVATE_'))
  return { evidence: item.directory }
})
await check(
  'actual time tool has start/finish and is not replayed across transport retry',
  async () => {
    const item = await run('time-retry', common)
    const { values } = terminalResult(item, 0)
    assert.equal(
      values.filter((value) => value.type === 'tool' && value.phase === 'start').length,
      1
    )
    assert.equal(
      values.filter((value) => value.type === 'tool' && value.phase === 'finish').length,
      1
    )
    assert.equal(values.filter((value) => value.type === 'retry').length, 1)
    assert.equal(item.audit.requests.length, 3)
    assert.equal(item.audit.requests[1].bodySHA256, item.audit.requests[2].bodySHA256)
    return { evidence: item.directory }
  }
)
await check('initial attempt plus five actual automatic retries ends failed', async () => {
  const item = await run('retry-all', common, { timeoutMs: 45000 })
  const { values, final } = terminalResult(item, 1)
  assert.equal(final.task.state, 'failed')
  assert.equal(item.audit.requests.length, 6)
  assert.equal(new Set(item.audit.requests.map((value) => value.bodySHA256)).size, 1)
  assert.deepEqual(
    values.filter((value) => value.type === 'retry').map((value) => value.retry),
    [1, 2, 3, 4, 5]
  )
  return { evidence: item.directory }
})
await check('nonTTY plan question fails clearly instead of reading pipe as answer', async () => {
  const item = await run(
    'question',
    ['--mode', 'plan', '--cwd', '$cwd', '--prompt', '固定提问', '--output', 'jsonl'],
    { input: '1\nyes\n' }
  )
  terminalResult(item, 3)
  assert.equal(item.audit.requests.length, 1)
  assert.equal(item.audit.spawns.length, 0)
  return { evidence: item.directory }
})
await check('stdin task is not reused as plan answer after normal EOF', async () => {
  const item = await run(
    'question-stdin',
    ['--mode', 'plan', '--cwd', '$cwd', '--stdin', '--output', 'jsonl'],
    { input: '固定任务\nyes\n', fixture: 'question' }
  )
  terminalResult(item, 3)
  assert.equal(item.audit.requests.length, 1)
  return { evidence: item.directory }
})
await check('plan hidden write is blocked before original disk tool and effect', async () => {
  const item = await run(
    'create-plan',
    ['--mode', 'plan', '--cwd', '$cwd', '--prompt', '只研究', '--output', 'jsonl'],
    { fixture: 'create' }
  )
  const { values, final } = terminalResult(item, 1)
  assert.equal(values.filter((value) => value.type === 'tool').length, 0)
  assert.equal(final.effects.started, false)
  assert.equal(item.audit.spawns.length, 0)
  await assert.rejects(fs.access(path.join(item.workspace, 'created.txt')))
  return { evidence: item.directory }
})
await check(
  'default range permits original local file creation with no terminal approval',
  async () => {
    const item = await run('create', common)
    const { values, final } = terminalResult(item, 0)
    assert.equal(
      await fs.readFile(path.join(item.workspace, 'created.txt'), 'utf8'),
      'synthetic actual disk creation\n'
    )
    assert.equal(final.effects.started, true)
    assert.ok(
      values.some(
        (value) =>
          value.type === 'tool' &&
          value.phase === 'finish' &&
          JSON.parse(value.output).status === 'created'
      )
    )
    assert.equal(item.audit.spawns.length, 0)
    return { evidence: item.directory, modelSynthetic: true, diskActual: true }
  }
)
await check('known initial hash without execute read cannot apply original patch', async () => {
  const item = await run('patch-unread', [...common, '--permission', 'full-access'])
  const { values } = terminalResult(item, 0)
  assert.deepEqual(await fs.readFile(path.join(item.workspace, 'sample.ts')), item.source)
  const output = values.find((value) => value.type === 'tool' && value.phase === 'finish')
  assert.notEqual(JSON.parse(output.output).status, 'applied')
  assert.equal(
    (await fs.readdir(item.workspace)).some((name) => name.endsWith('.bak')),
    false
  )
  return { evidence: item.directory, modelSynthetic: true, diskActual: true }
})
await check('full-access actual command uses original signed plan and Job host', async () => {
  const item = await run('command', [...common, '--permission', 'full-access'])
  const { values } = terminalResult(item, 0)
  const finish = values.find((value) => value.type === 'tool' && value.phase === 'finish')
  const output = JSON.parse(finish.output)
  assert.equal(output.status, 'completed')
  assert.equal(output.exitCode, 0)
  assert.equal(output.treeExited, true)
  assert.deepEqual(JSON.parse(output.stdout.trim()), { command: true, credential: false })
  assert.ok(item.audit.spawns.some((value) => /host\.exe$/i.test(value.program)))
  assert.ok(item.audit.spawns.every((value) => !value.hasModelCredential))
  return { evidence: item.directory, actualCommand: output, modelSynthetic: true }
})
await check('nonTTY command escalation has no default yes and no process launch', async () => {
  const item = await run('command-approval', common, { input: 'yes\n' })
  terminalResult(item, 3)
  assert.equal(item.audit.spawns.length, 0)
  return { evidence: item.directory }
})
await check('real stdout EPIPE cancels transport and exits without hanging', async () => {
  const item = await run('stream-epipe', common, { closeOutput: true, timeoutMs: 15000 })
  assert.equal(item.exitCode, 1)
  assert.equal(item.audit.requests.length, 1)
  assert.ok(item.audit.streamCancellations >= 1)
  return {
    evidence: item.directory,
    stdoutClosed: true,
    cancelledStreams: item.audit.streamCancellations
  }
})
async function runTTY(label, fixture, mode, inputDriver, permission) {
  const item = await prepare(label)
  item.env.LESSON55_FIXTURE = fixture
  const args = [
    '--require',
    preload,
    entry,
    '--mode',
    mode,
    '--cwd',
    item.workspace,
    '--prompt',
    '固定TTY验证',
    '--output',
    'jsonl',
    ...(permission ? ['--permission', permission] : [])
  ]
  const terminal = pty.spawn(process.execPath, args, {
    cwd: item.directory,
    env: item.env,
    cols: 180,
    rows: 45,
    useConpty: true
  })
  let raw = '',
    exited,
    forcedKill = false
  const done = new Promise((resolve) =>
    terminal.onExit((value) => {
      exited = value
      resolve(value)
    })
  )
  terminal.onData((data) => (raw += data))
  const until = async (condition, description) => {
    for (const deadline = Date.now() + 15000; Date.now() < deadline;) {
      if (condition(stripAnsi(raw))) return
      if (exited) throw Error('TTY exited before ' + description)
      await pause(30)
    }
    throw Error('TTY input wait exceeded: ' + description)
  }
  try {
    await inputDriver({ terminal, until, raw: () => stripAnsi(raw) })
    const completion = await bounded(done, 15000)
    if (!completion) {
      forcedKill = true
      terminal.kill()
      await Promise.race([done, pause(3000)])
    }
    assert.equal(forcedKill, false, 'TTY CLI must release itself')
    assert.ok(completion)
    const audit = JSON.parse(
      await fs.readFile(path.join(item.directory, 'transport-audit.json'), 'utf8')
    )
    const clean = stripAnsi(raw)
    const values = clean
      .split('\n')
      .filter((line) => line.startsWith('{"type"'))
      .map((line) => JSON.parse(line))
    const result = {
      directory: item.directory,
      workspace: item.workspace,
      sourceSHA256: hash(item.source),
      label,
      pid: terminal.pid,
      exitCode: completion.exitCode,
      raw,
      clean,
      values,
      audit,
      forcedKill
    }
    await fs.writeFile(
      path.join(item.directory, 'tty-process.json'),
      JSON.stringify(result, null, 2)
    )
    await fs.writeFile(path.join(item.directory, 'raw-terminal.txt'), raw)
    assert.equal(audit.stdinTTY, true)
    assert.equal(audit.stdoutTTY, true)
    assertWriters(audit)
    assert.equal(
      audit.outputWriters.length,
      0,
      'TTY preserves original streams without a pipe helper'
    )
    return result
  } finally {
    if (exited) {
      terminal._agent._inSocket.destroy()
      terminal._agent._ptyNative.kill(terminal._agent._pty, terminal._agent._useConptyDll)
      terminal._agent._conoutSocketWorker.dispose()
    } else if (!forcedKill) terminal.kill()
    await fs.writeFile(path.join(item.directory, 'raw-terminal.txt'), raw)
  }
}
await check(
  'actual TTY plan question waits for explicit supported option and resumes',
  async () => {
    const item = await runTTY('tty-question', 'question', 'plan', async ({ terminal, until }) => {
      await until((text) => text.includes('或 c 自定义'), 'question')
      terminal.write('1\r')
    })
    assert.equal(item.exitCode, 0)
    assert.equal(item.audit.requests.length, 2)
    assert.deepEqual(
      JSON.parse(
        item.audit.requests[1].input.find((value) => value.type === 'function_call_output').output
      ).answers,
      [{ id: 'layout', answer: '卡片' }]
    )
    assert.equal(item.values.filter((value) => value.type === 'result').length, 1)
    return { evidence: item.directory, actualTTY: true }
  }
)
await check('actual TTY custom plan answer preserves explicit answer', async () => {
  const item = await runTTY('tty-custom', 'question', 'plan', async ({ terminal, until }) => {
    await until((text) => text.includes('或 c 自定义'), 'question')
    terminal.write('c\r')
    await until((text) => text.includes('输入自定义回答'), 'custom answer')
    terminal.write('两栏方案\r')
  })
  assert.equal(item.exitCode, 0)
  assert.deepEqual(
    JSON.parse(
      item.audit.requests[1].input.find((value) => value.type === 'function_call_output').output
    ).answers,
    [{ id: 'layout', answer: '两栏方案' }]
  )
  return { evidence: item.directory }
})
await check(
  'actual TTY question EOF releases pending wait without model continuation',
  async () => {
    const item = await runTTY('tty-eof', 'question', 'plan', async ({ terminal, until }) => {
      await until((text) => text.includes('或 c 自定义'), 'question')
      terminal.write('\x04')
    })
    assert.equal(item.exitCode, 3)
    assert.equal(item.audit.requests.length, 1)
    return { evidence: item.directory }
  }
)
await check('actual ConPTY Ctrl+C cancels an active model request', async () => {
  const item = await runTTY(
    'tty-sigint-model',
    'wait-model',
    'execute',
    async ({ terminal, until }) => {
      await until((text) => text.includes('模型请求'), 'active model')
      await pause(100)
      terminal.write('\x03')
    }
  )
  assert.equal(item.exitCode, 130)
  assert.equal(item.audit.requests.length, 1)
  assert.equal(item.audit.cancelled, true)
  return { evidence: item.directory, realConsoleCtrlC: true }
})
await check(
  'actual TTY Ctrl+C cancels a pending question and rejects late continuation',
  async () => {
    const item = await runTTY(
      'tty-sigint-question',
      'question',
      'plan',
      async ({ terminal, until }) => {
        await until((text) => text.includes('或 c 自定义'), 'question')
        terminal.write('\x03')
      }
    )
    assert.equal(item.exitCode, 130)
    assert.equal(item.audit.requests.length, 1)
    return { evidence: item.directory }
  }
)
for (const decision of ['yes', 'no'])
  await check(
    'actual TTY command ' + decision + ' follows original sign and launch chain',
    async () => {
      const item = await runTTY(
        'tty-approval-' + decision,
        'command-approval',
        'execute',
        async ({ terminal, until }) => {
          await until((text) => text.includes('输入 yes 批准'), 'approval')
          terminal.write(decision + '\r')
        }
      )
      assert.equal(item.exitCode, 0)
      const finish = item.values.find((value) => value.type === 'tool' && value.phase === 'finish')
      assert.ok(finish)
      const output = JSON.parse(finish.output)
      if (decision === 'yes') {
        assert.equal(output.status, 'completed')
        assert.equal(output.exitCode, 0)
        assert.equal(output.treeExited, true)
        assert.ok(item.audit.spawns.some((value) => /host\.exe$/i.test(value.program)))
      } else {
        assert.notEqual(output.status, 'completed')
        assert.equal(item.audit.spawns.length, 0)
      }
      return { evidence: item.directory, decision, toolResult: output }
    }
  )
await check(
  'actual TTY Ctrl+C stops real supervised command and records side effects',
  async () => {
    const item = await runTTY(
      'tty-sigint-command',
      'command-long',
      'execute',
      async ({ terminal, until }) => {
        await until((text) => text.includes('run_workspace_command'), 'command start')
        await pause(700)
        terminal.write('\x03')
      },
      'full-access'
    )
    assert.equal(item.exitCode, 130)
    assert.ok(item.audit.spawns.some((value) => /host\.exe$/i.test(value.program)))
    const final = item.values.find((value) => value.type === 'result')
    assert.equal(final.effects.started, true)
    return { evidence: item.directory, actualCommandStarted: true, final }
  }
)
await check('compiled CLI identity remains fixed throughout this suite', async () => {
  assert.equal(
    hash(await fs.readFile(entry)),
    provenance.entrySHA256,
    'Compiled CLI unchanged throughout suite'
  )
})
const result = {
  pass: checks.every((value) => value.pass),
  evidence,
  total: checks.length,
  failed: checks.filter((value) => !value.pass).length,
  checks,
  provenance,
  boundary:
    'Actual compiled ordinary Node CLI, original host/core/loop/Responses parsing and original tools; HTTP responses are explicitly synthetic. TTY is actual Windows ConPTY; pipe, EOF, stdout closure and command Job processes are actual. No real model request or product edits.'
}
await fs.writeFile(path.join(evidence, 'results.json'), JSON.stringify(result, null, 2))
console.log(
  JSON.stringify({ pass: result.pass, evidence, total: result.total, failed: result.failed })
)
if (!result.pass) process.exitCode = 1
