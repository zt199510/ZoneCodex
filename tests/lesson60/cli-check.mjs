import assert from 'node:assert/strict'
import { promises as fs, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import { root, hash, createEvidence, checksFor, runProcess } from './runtime.mjs'
import { call, message, response } from '../lesson57/runtime.mjs'

const offline = process.argv.includes('--offline')
const entryArg = process.argv.find((arg) => arg.startsWith('--entry='))?.slice(8)
assert(offline !== Boolean(entryArg), 'Choose --offline current public host or --entry=actual CLI')
assert(process.argv.slice(2).every((arg) => arg === '--offline' || arg.startsWith('--entry=')))
const evidence = await createEvidence(
  offline ? 'cli-source' : 'cli-' + (entryArg.includes('dist') ? 'distributed' : 'development')
)
const suite = checksFor(evidence, {
  ordinaryNode: true,
  currentSource: offline,
  actualCLIProcesses: !offline,
  actualTTY: !offline,
  realDisk: true,
  syntheticTransport: true,
  realTransport: false
})
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
const deferred = () => {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const processes = []
const require = createRequire(import.meta.url)
const terminalResult = (values, expected) => {
  const finals = values.filter((value) => value.type === 'result')
  assert.equal(finals.length, 1, 'One semantic public terminal result')
  const final = finals[0]
  assert.equal(final.exitCode, expected)
  assert.equal(Object.hasOwn(final, 'items'), false)
  assert(
    final.toolResults.every((tool) => Object.keys(tool).sort().join(',') === 'callId,name,output')
  )
  assert(!JSON.stringify(values).includes('LESSON60_PRIVATE_SENTINEL'))
  return final
}
async function absent(file) {
  await assert.rejects(fs.access(file), { code: 'ENOENT' })
}

if (offline) {
  const fixture = {
    main: 0,
    review: 0,
    summary: 0,
    command: 0,
    mode: 'create',
    target: '',
    first: null,
    reviewVerdict: 'risky'
  }
  globalThis.__lesson60CLI = fixture
  const modelStub = `export function readModelConfiguration() { return { endpoint:'https://example.invalid/v1/responses', model:'gpt-6.1-sol', apiKey:'SYNTHETIC_ONLY' }; }
export function createLiveResponse(tools) { return (input, signal) => globalThis.__lesson60CLI.send(tools.length ? 'main' : 'review', input, signal); }`
  const stubs = {
    'model-configuration': modelStub + `export const fixedResponsesConfiguration = (value) => value;`,
    'responses-provider': modelStub.replace('createLiveResponse', 'createResponsesSender'),
    'context-summary': `export function createContextSummaryResponse() { return async () => { globalThis.__lesson60CLI.summary++; throw new Error('No summary permitted'); }; }`,
    'windows-command-backend': `export async function inspectWindowsCommandBackend() { return null; } export async function inspectCommandHost(){ return null; } export function verifyCommandHost(){ return false; } export function verifyWindowsCommandBackend(){ return false; }`,
    'command-runner': `export function startCommandProcess(){ globalThis.__lesson60CLI.command++; throw new Error('No process allowed'); }`
  }
  const outfile = path.join(evidence, 'current-public-host.cjs')
  const bundle = await build({
    absWorkingDir: root,
    stdin: {
      contents: `export * from './src/cli/agent-host.ts'; export * from './src/cli/output.ts';`,
      resolveDir: root
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile,
    metafile: true,
    logLevel: 'silent',
    plugins: [
      {
        name: 'lesson60-public-host-transport-only',
        setup(builder) {
          builder.onResolve({ filter: /.*/ }, ({ path: id }) => {
            const name = id.split('/').at(-1)
            return Object.hasOwn(stubs, name) ? { path: name, namespace: 'fixture' } : null
          })
          builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path: id }) => ({
            contents: stubs[id],
            loader: 'js'
          }))
        }
      }
    ]
  })
  const sourceHashes = Object.fromEntries(
    await Promise.all(
      Object.keys(bundle.metafile.inputs)
        .filter((file) => file !== '<stdin>' && !file.startsWith('fixture:'))
        .map(async (file) => [file, hash(await fs.readFile(path.resolve(root, file)))])
    )
  )
  await fs.writeFile(
    path.join(evidence, 'identity.json'),
    JSON.stringify(
      {
        sourceHashes,
        compiledSHA256: hash(await fs.readFile(outfile)),
        stubbedDependencies: Object.keys(stubs)
      },
      null,
      2
    )
  )
  const api = require(outfile)
  assert.equal(
    fixture.main + fixture.review + fixture.summary + fixture.command,
    0,
    'Import is inert'
  )
  fixture.send = async (kind, input, signal) => {
    fixture[kind]++
    if (kind === 'review') return response(message(JSON.stringify({ risk: fixture.reviewVerdict })))
    signal.throwIfAborted()
    fixture.first?.(input)
    const done = input.some((item) => item.type === 'function_call_output')
    if (!done)
      return fixture.mode === 'question'
        ? response(
            call('lesson60-question', 'request_user_input', {
              questions: [
                {
                  id: 'layout',
                  header: '布局',
                  question: '选择布局',
                  options: [
                    { label: '卡片', description: '卡片' },
                    { label: '列表', description: '列表' }
                  ]
                }
              ]
            })
          )
        : response(
            call('lesson60-create', 'create_workspace_file', {
              path: fixture.target,
              content: 'Current source disk bytes\n'
            })
          )
    return response(
      { type: 'reasoning', encrypted_content: 'LESSON60_PRIVATE_SENTINEL', summary: [] },
      message('Refusal and operation success are distinguished by tool facts.')
    )
  }
  async function scenario(label, permission = 'default', options = {}, extras = {}) {
    const directory = path.join(evidence, label),
      cwd = path.join(directory, 'workspace')
    await fs.mkdir(cwd, { recursive: true })
    const target = path.join(extras.inside ? cwd : directory, 'target.txt')
    Object.assign(fixture, {
      main: 0,
      review: 0,
      summary: 0,
      command: 0,
      target,
      mode: extras.mode ?? 'create',
      first: null,
      reviewVerdict: 'risky'
    })
    const input = {
      mode: extras.mode === 'question' ? 'plan' : 'execute',
      prompt: 'Perform one exact bounded isolated operation',
      cwd,
      permission,
      ...(extras.checkpoint ? { checkpoint: path.join(directory, 'checkpoint.json') } : {})
    }
    extras.prepare?.(input, fixture, cwd)
    const result = await api.runAgentTask(input, options)
    await fs.writeFile(
      path.join(directory, 'outcome.json'),
      JSON.stringify(
        {
          result,
          counters: {
            main: fixture.main,
            review: fixture.review,
            summary: fixture.summary,
            command: fixture.command
          }
        },
        null,
        2
      )
    )
    return { directory, cwd, target, result, input }
  }
  for (const permission of ['default', 'auto-approve', 'full-access'])
    await suite.check(
      'public Node ' +
        permission +
        ' allows an in-root actual file operation without approval/review',
      async () => {
        let approvals = 0
        const item = await scenario(
          'inside-' + permission,
          permission,
          {
            approve: async () => {
              approvals++
              return false
            }
          },
          { inside: true }
        )
        assert.equal(item.result.exitCode, 0)
        assert.equal(item.result.task.state, 'completed')
        assert.equal(approvals, 0)
        assert.equal(fixture.review, 0)
        assert.equal(fixture.main, 2)
        assert.equal(await fs.readFile(item.target, 'utf8'), 'Current source disk bytes\n')
        assert.deepEqual(item.result.effects, { approved: false, started: true })
        return { effects: item.result.effects }
      }
    )
  await suite.check(
    'public Node operation refusal can complete the task while the exact tool is cancelled and disk unchanged',
    async () => {
      let approvals = 0
      const item = await scenario('refused', 'default', {
        approve: async () => {
          approvals++
          return false
        }
      })
      assert.equal(item.result.exitCode, 0)
      assert.equal(item.result.task.state, 'completed')
      assert.equal(approvals, 1)
      assert.equal(JSON.parse(item.result.toolResults[0].output).status, 'cancelled')
      assert.deepEqual(item.result.effects, { approved: false, started: false })
      await absent(item.target)
    }
  )
  await suite.check(
    'public Node missing approve capability reports unavailable=3 instead of silently approving an external write',
    async () => {
      const item = await scenario('no-approve')
      assert.equal(item.result.exitCode, 3)
      assert.equal(item.result.task.state, 'failed')
      assert.equal(fixture.main, 1)
      await absent(item.target)
    }
  )
  await suite.check(
    'auto-approve risky verdict asks current callback and a manual rejection is never a grant',
    async () => {
      let approvals = 0
      const item = await scenario('review-refused', 'auto-approve', {
        approve: async () => {
          approvals++
          return false
        }
      })
      assert.equal(item.result.exitCode, 0)
      assert.equal(fixture.review, 1)
      assert.equal(approvals, 1)
      await absent(item.target)
    }
  )
  await suite.check(
    'full-access still uses the original actual exclusive-create guard and does not ask or review',
    async () => {
      const item = await scenario('full-access', 'full-access', {
        approve: async () => {
          throw new Error('Must not ask')
        }
      })
      assert.equal(item.result.exitCode, 0)
      assert.equal(fixture.review, 0)
      assert.equal(await fs.readFile(item.target, 'utf8'), 'Current source disk bytes\n')
      assert.deepEqual(item.result.effects, { approved: false, started: true })
    }
  )
  await suite.check(
    'single run captures caller permission and callback identities before asynchronous model activity',
    async () => {
      let capturedApprovals = 0
      const options = {
        approve: async () => {
          capturedApprovals++
          return false
        }
      }
      const item = await scenario('captured-input', 'default', options, {
        prepare(input, state) {
          state.first = () => {
            input.permission = 'full-access'
            options.approve = async () => true
          }
        }
      })
      assert.equal(capturedApprovals, 1)
      assert.equal(item.result.effects.started, false)
      await absent(item.target)
    }
  )
  await suite.check(
    'stop during a callback that ignores abort returns cancelled; late approved true creates no file or model continuation',
    async () => {
      const entered = deferred(),
        gate = deferred(),
        controller = new AbortController()
      const running = scenario('late-approve', 'default', {
        signal: controller.signal,
        approve: async () => {
          entered.resolve()
          return gate.promise
        }
      })
      await entered.promise
      controller.abort()
      const item = await running
      assert.equal(item.result.exitCode, 130)
      assert.equal(item.result.task.state, 'cancelled')
      gate.resolve(true)
      await pause(10)
      assert.equal(fixture.main, 1)
      assert.equal(item.result.effects.started, false)
      await absent(item.target)
    }
  )
  await suite.check(
    'approved callback then abort before commit yields no real file operation',
    async () => {
      const controller = new AbortController()
      const item = await scenario('approve-then-stop', 'default', {
        signal: controller.signal,
        approve: async () => {
          controller.abort()
          return true
        }
      })
      assert.equal(item.result.exitCode, 130)
      assert.equal(item.result.effects.started, false)
      assert.equal(fixture.main, 1)
      await absent(item.target)
    }
  )
  await suite.check(
    'stop after actual write keeps approved/started effects, complete raw/checkpoint tool fact and public result warning',
    async () => {
      const controller = new AbortController()
      const events = []
      const item = await scenario(
        'write-then-stop',
        'default',
        {
          signal: controller.signal,
          approve: async () => true,
          onEvent: (event) => {
            events.push(structuredClone(event))
            if (event.type === 'progress' && event.message === '第 2 次模型请求') controller.abort()
          }
        },
        { checkpoint: true }
      )
      assert.equal(item.result.exitCode, 130)
      assert.equal(item.result.task.state, 'cancelled')
      assert.match(item.result.task.error, /可能已经执行/)
      assert.deepEqual(item.result.effects, { approved: true, started: true })
      assert.equal(fixture.main, 1)
      assert.equal(await fs.readFile(item.target, 'utf8'), 'Current source disk bytes\n')
      assert.equal(JSON.parse(item.result.toolResults[0].output).status, 'created')
      const pointer = JSON.parse(
        await fs.readFile(path.join(item.directory, 'checkpoint.json'), 'utf8')
      )
      const raw = JSON.parse(await fs.readFile(path.join(item.directory, pointer.raw.file), 'utf8'))
      assert(
        raw.some(
          (entry) =>
            entry.type === 'function_call_output' && JSON.parse(entry.output).status === 'created'
        )
      )
      const projected = api.projectResult(item.result)
      assert(!Object.hasOwn(projected, 'items'))
      assert(!JSON.stringify(projected).includes('LESSON60_PRIVATE_SENTINEL'))
      await fs.writeFile(path.join(item.directory, 'events.json'), JSON.stringify(events, null, 2))
      return { rawSHA256: hash(JSON.stringify(raw)), effects: item.result.effects }
    }
  )
  await suite.check(
    'AGENTS change during approval invalidates current run before write and does not count a late true as approved',
    async () => {
      let cwd
      const item = await scenario(
        'instruction-revoke',
        'default',
        {
          approve: async () => {
            writeFileSync(path.join(cwd, 'AGENTS.md'), 'Changed current project instruction\n')
            return true
          }
        },
        {
          prepare(_input, _state, directory) {
            cwd = directory
          }
        }
      )
      assert.equal(item.result.exitCode, 1)
      assert.equal(item.result.task.state, 'failed')
      assert.equal(item.result.effects.started, false)
      await absent(item.target)
    }
  )
  await suite.check(
    'plan answer callback ignored after stop cannot resume the model or grant execution',
    async () => {
      const entered = deferred(),
        gate = deferred(),
        controller = new AbortController()
      const running = scenario(
        'late-answer',
        'default',
        {
          signal: controller.signal,
          answer: async () => {
            entered.resolve()
            return gate.promise
          }
        },
        { mode: 'question' }
      )
      await entered.promise
      controller.abort()
      const item = await running
      assert.equal(item.result.exitCode, 130)
      gate.resolve([{ id: 'layout', answer: '卡片' }])
      await pause(10)
      assert.equal(fixture.main, 1)
      assert.deepEqual(item.result.effects, { approved: false, started: false })
    }
  )
  await suite.finish({
    processStarts: fixture.command,
    notCovered: [
      'real CLI artifacts/TTY (separate cli group)',
      'real Windows backend',
      'network models'
    ]
  })
  delete globalThis.__lesson60CLI
} else {
  const entry = path.resolve(root, entryArg),
    library = path.join(path.dirname(entry), 'agent.cjs')
  const preload = path.join(root, 'tests/lesson60/cli-synthetic-preload.cjs')
  const identityFiles = [
    entry,
    library,
    path.join(path.dirname(entry), 'output-writer.cjs'),
    preload,
    path.join(root, 'tests/lesson57/cli-synthetic-preload.cjs')
  ]
  const identities = Object.fromEntries(
    await Promise.all(identityFiles.map(async (file) => [file, hash(await fs.readFile(file))]))
  )
  await fs.writeFile(
    path.join(evidence, 'identity.json'),
    JSON.stringify(
      { identities, execPath: process.execPath, nodeVersion: process.version },
      null,
      2
    )
  )
  function environment(directory, fixture, target) {
    const env = { ...process.env }
    for (const key of Object.keys(env))
      if (/^(MODEL_|NODE_OPTIONS$|ELECTRON_RUN_AS_NODE$|LESSON\d+_)/i.test(key)) delete env[key]
    return {
      ...env,
      MODEL_ENDPOINT: 'https://example.invalid/v1/responses',
      MODEL_NAME: 'gpt-6.1-sol',
      MODEL_API_KEY: 'LESSON60_SYNTHETIC_ONLY',
      LESSON60_EVIDENCE: directory,
      LESSON60_FIXTURE: fixture,
      LESSON60_TARGET: target
    }
  }
  async function prepare(label, fixture = 'create', inside = false) {
    const directory = path.join(evidence, label),
      cwd = path.join(directory, 'workspace')
    await fs.mkdir(cwd, { recursive: true })
    const target = path.join(inside ? cwd : directory, 'target.txt')
    return { directory, cwd, target, env: environment(directory, fixture, target) }
  }
  const argsFor = (item, permission, extra = []) => [
    '--mode',
    'execute',
    '--cwd',
    item.cwd,
    '--prompt',
    'Create exactly one isolated bounded file',
    '--output',
    'jsonl',
    ...(permission ? ['--permission', permission] : []),
    ...extra
  ]
  async function capture(item, args) {
    const result = await runProcess(
      process.execPath,
      ['--require', preload, entry, ...args],
      { cwd: item.directory, env: item.env },
      30000
    )
    const audit = JSON.parse(
      await fs.readFile(path.join(item.directory, 'lesson60-transport.json'), 'utf8')
    )
    const guard = JSON.parse(
      await fs.readFile(path.join(item.directory, 'transport-audit.json'), 'utf8')
    )
    await fs.writeFile(path.join(item.directory, 'process.json'), JSON.stringify(result, null, 2))
    assert.equal(result.forcedKill, false)
    assert.equal(guard.unexpectedNetwork, 0)
    assert(
      guard.spawns.every(
        (child) =>
          child.kind === 'fixed-output-writer' &&
          !child.hasCredential &&
          !child.hasNodeOptions &&
          child.closed
      )
    )
    const values = result.stdout
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
    processes.push({
      pid: result.pid,
      cliPID: audit.pid,
      directory: item.directory,
      exitCode: result.exitCode,
      actualTTY: false
    })
    return { ...item, result, audit, values, final: terminalResult(values, result.exitCode) }
  }
  for (const permission of ['default', 'auto-approve', 'full-access'])
    await suite.check(
      'actual CLI ' + permission + ' performs an in-root disk operation without approval/review',
      async () => {
        const seed = await prepare('inside-' + permission, 'create', true)
        const item = await capture(seed, argsFor(seed, permission))
        assert.equal(item.result.exitCode, 0)
        assert.equal(item.audit.main, 2)
        assert.equal(item.audit.review + item.audit.summary, 0)
        assert.equal(
          await fs.readFile(item.target, 'utf8'),
          'Lesson60 current authorization bytes\n'
        )
        assert.deepEqual(item.final.effects, { approved: false, started: true })
        return { pid: item.audit.pid, effects: item.final.effects }
      }
    )
  await suite.check(
    'actual nonTTY default cannot supply an interactive approval and reports unavailable=3',
    async () => {
      const seed = await prepare('default-nontty'),
        item = await capture(seed, argsFor(seed))
      assert.equal(item.result.exitCode, 3)
      assert.equal(item.final.task.state, 'failed')
      assert.equal(item.audit.main, 1)
      assert.equal(item.audit.review, 0)
      await absent(item.target)
      return { pid: item.audit.pid, exitCode: 3 }
    }
  )
  for (const fixture of ['review-risky', 'review-failure'])
    await suite.check(
      'actual auto-approve ' + fixture + ' cannot silently approve a nonTTY operation',
      async () => {
        const seed = await prepare(fixture, fixture),
          item = await capture(seed, argsFor(seed, 'auto-approve'))
        assert.equal(item.result.exitCode, 3)
        assert(item.audit.review >= 1)
        assert.equal(item.audit.main, 1)
        await absent(item.target)
        return { pid: item.audit.pid, reviewRequests: item.audit.review, noWrite: true }
      }
    )
  await suite.check(
    'actual auto-approve safe review and full-access use current decisions on real disk',
    async () => {
      for (const [label, fixture, permission, review] of [
        ['safe', 'review-safe', 'auto-approve', 1],
        ['full', 'create', 'full-access', 0]
      ]) {
        const seed = await prepare(label, fixture),
          item = await capture(seed, argsFor(seed, permission))
        assert.equal(item.result.exitCode, 0)
        assert.equal(item.audit.review, review)
        assert.equal(
          await fs.readFile(item.target, 'utf8'),
          'Lesson60 current authorization bytes\n'
        )
        assert.equal(item.final.effects.approved, review === 1)
        assert.equal(item.final.effects.started, true)
      }
    }
  )
  const pty = require('node-pty')
  // eslint-disable-next-line no-control-regex -- Parse actual ConPTY display without ANSI sequences.
  const strip = (value) => value.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replaceAll('\r', '')
  const bounded = async (promise, milliseconds) => {
    let timer
    try {
      return await Promise.race([
        promise,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(null), milliseconds)
        })
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  async function tty(item, args, drive) {
    const term = pty.spawn(process.execPath, ['--require', preload, entry, ...args], {
      cwd: item.directory,
      env: item.env,
      cols: 260,
      rows: 50,
      useConpty: true
    })
    let raw = '',
      exited = false,
      forcedKill = false
    const off = term.onData((data) => {
      raw += data
    })
    const done = new Promise((resolve) =>
      term.onExit((result) => {
        exited = true
        resolve(result)
      })
    )
    const until = async (needle) => {
      for (let round = 0; round < 500; round++) {
        if (strip(raw).includes(needle)) return
        assert(!exited, 'TTY retired before prompt ' + needle)
        await pause(20)
      }
      throw new Error('No expected actual TTY prompt: ' + needle)
    }
    try {
      await drive(term, until)
      const result = await bounded(done, 15000)
      assert(result, 'CLI must settle itself without forced termination')
      const audit = JSON.parse(
          await fs.readFile(path.join(item.directory, 'lesson60-transport.json'), 'utf8')
        ),
        guard = JSON.parse(
          await fs.readFile(path.join(item.directory, 'transport-audit.json'), 'utf8')
        )
      assert.equal(audit.stdinTTY, true)
      assert.equal(audit.stderrTTY, true)
      assert.equal(guard.unexpectedNetwork, 0)
      assert.equal(guard.spawns.length, 0)
      const clean = strip(raw)
      const values = clean
        .split('\n')
        .map((line) => line.slice(line.indexOf('{"type"')))
        .filter((line) => line.startsWith('{"type"'))
        .map((line) => JSON.parse(line))
      const final = terminalResult(values, result.exitCode)
      processes.push({
        pid: term.pid,
        cliPID: audit.pid,
        directory: item.directory,
        exitCode: result.exitCode,
        actualTTY: true
      })
      await fs.writeFile(
        path.join(item.directory, 'tty-process.json'),
        JSON.stringify({ pid: term.pid, result, audit, guard, values, forcedKill }, null, 2)
      )
      return { ...item, result, audit, values, final }
    } finally {
      if (!exited) {
        forcedKill = true
        term.kill()
        assert(await bounded(done, 10000), 'Cleanup must receive public onExit')
      }
      off.dispose()
      await fs.writeFile(path.join(item.directory, 'tty-output.txt'), raw)
    }
  }
  for (const [label, input, code, wrote] of [
    ['yes', 'yes\r', 0, true],
    ['no', 'no\r', 0, false],
    ['eof', '\u0004', 3, false],
    ['ctrl-c', '\u0003', 130, false]
  ])
    await suite.check(
      'actual TTY approval ' +
        label +
        ' has the matching outcome, current effect and real file evidence',
      async () => {
        const seed = await prepare('tty-' + label),
          item = await tty(seed, argsFor(seed), async (term, until) => {
            await until('输入 yes')
            term.write(input)
          })
        assert.equal(item.result.exitCode, code)
        assert.equal(item.audit.review, 0)
        if (wrote) {
          assert.equal(
            await fs.readFile(item.target, 'utf8'),
            'Lesson60 current authorization bytes\n'
          )
          assert.deepEqual(item.final.effects, { approved: true, started: true })
        } else {
          await absent(item.target)
          assert.equal(item.final.effects.started, false)
        }
        if (label === 'no') {
          assert.equal(item.final.task.state, 'completed')
          assert.equal(JSON.parse(item.final.toolResults[0].output).status, 'cancelled')
          assert.equal(item.audit.main, 2)
        }
        if (label === 'ctrl-c') {
          assert.equal(item.final.task.state, 'cancelled')
          assert.equal(item.audit.main, 1)
        }
        return { pid: item.audit.pid, exitCode: code, actualTTY: true, wrote }
      }
    )
  await suite.check(
    'new CLI PID resume uses current default after previous full-access and requires new approval',
    async () => {
      const seed = await prepare('resume-current-permission', 'create-then-hold'),
        checkpoint = path.join(seed.directory, 'checkpoint.json')
      const first = await tty(
        seed,
        argsFor(seed, 'full-access', ['--checkpoint', checkpoint]),
        async (term, until) => {
          await until('第 2 次模型请求')
          for (let round = 0; round < 250; round++) {
            const audit = JSON.parse(
              await fs.readFile(path.join(seed.directory, 'lesson60-transport.json'), 'utf8')
            )
            if (audit.main === 2) break
            await pause(20)
          }
          const audit = JSON.parse(
            await fs.readFile(path.join(seed.directory, 'lesson60-transport.json'), 'utf8')
          )
          assert.equal(
            audit.main,
            2,
            'The real write/checkpoint completed before holding transport'
          )
          assert.equal(
            await fs.readFile(seed.target, 'utf8'),
            'Lesson60 current authorization bytes\n'
          )
          term.write('\u0003')
        }
      )
      assert.equal(first.result.exitCode, 130)
      assert.equal(first.audit.cancelled, 1)
      assert.deepEqual(first.final.effects, { approved: false, started: true })
      const pointerBefore = JSON.parse(await fs.readFile(checkpoint, 'utf8'))
      assert.equal(pointerBefore.progress, 'interrupted')
      assert.equal(pointerBefore.reason, 'user_cancelled')
      const rawBefore = await fs.readFile(path.join(seed.directory, pointerBefore.raw.file))
      assert(
        JSON.parse(rawBefore).some(
          (entry) =>
            entry.type === 'function_call_output' && JSON.parse(entry.output).status === 'created'
        )
      )
      assert(
        !/approvalId|commandtickets|readcredentials|permissionMode/.test(
          JSON.stringify(pointerBefore)
        )
      )
      const resumedSeed = await prepare('resumed-new-pid', 'resume-create')
      resumedSeed.cwd = seed.cwd
      resumedSeed.env.LESSON60_TARGET = resumedSeed.target
      const resumed = await capture(resumedSeed, ['--resume', checkpoint, '--output', 'jsonl'])
      assert.equal(resumed.result.exitCode, 3)
      assert.notEqual(resumed.audit.pid, first.audit.pid)
      assert.notEqual(resumed.final.requestId, first.final.requestId)
      assert.equal(resumed.audit.review, 0)
      await absent(resumedSeed.target)
      const resume = resumed.values.find((value) => value.type === 'resume')
      assert(resume)
      assert.equal(resume.taskId, pointerBefore.taskId)
      const pointerAfter = JSON.parse(await fs.readFile(checkpoint, 'utf8'))
      assert.equal(pointerAfter.taskId, pointerBefore.taskId)
      assert.notEqual(pointerAfter.scope.executionId, pointerBefore.scope.executionId)
      assert.deepEqual(
        await fs.readFile(path.join(seed.directory, pointerBefore.raw.file)),
        rawBefore
      )
      assert.equal(
        await fs.readFile(first.target, 'utf8'),
        'Lesson60 current authorization bytes\n'
      )
      return {
        firstPID: first.audit.pid,
        resumedPID: resumed.audit.pid,
        taskId: resume.taskId,
        oldRequestId: first.final.requestId,
        newRequestId: resumed.final.requestId,
        rawBeforeSHA256: hash(rawBefore),
        currentDefaultUnavailableCode: 3
      }
    }
  )
  for (const file of identityFiles)
    assert.equal(
      hash(await fs.readFile(file)),
      identities[file],
      'Artifact remains unchanged: ' + file
    )
  await suite.finish({
    entry,
    processes,
    identities,
    actualDistributedLauncher: false,
    notCovered: [
      'real network models',
      'command backend or arbitrary process tree/native handles',
      'distributed cmd launcher (existing lesson57 regression)'
    ]
  })
}
