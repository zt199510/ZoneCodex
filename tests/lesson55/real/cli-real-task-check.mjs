import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { promises as fs, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { contracts, materialize, outsideBusiness, hash } from './task-contracts.mjs'
import { root, createEvidence } from '../runtime.mjs'

const packaged = process.argv.includes('--packaged')
assert.ok(process.argv.slice(2).every((arg) => arg === '--packaged'))
const entry = path.join(root, packaged ? 'dist/agent/index.cjs' : 'out/cli/index.cjs')
const api = path.join(root, packaged ? 'dist/agent/agent.cjs' : 'out/cli/agent.cjs')
const launcher = path.join(root, 'dist/agent/agent.cmd')
const observer = fileURLToPath(new URL('./cli-real-observer.cjs', import.meta.url))
const evidence = await createEvidence(
  'cli-real-' + (packaged ? 'distributed' : 'development') + '-price'
)
const project = path.join(evidence, 'project')
await fs.mkdir(project, { recursive: true })
for (const file of ['cli-real-task-check.mjs', 'cli-real-observer.cjs', 'task-contracts.mjs'])
  await fs.copyFile(
    fileURLToPath(new URL('./' + file, import.meta.url)),
    path.join(evidence, file + '.snapshot')
  )
const checks = [],
  processes = [],
  stages = [],
  contract = contracts.find((item) => item.id === 'price')
const fixture = materialize(contract),
  nodeProgram = process.execPath
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
const check = (name, details = {}) => checks.push({ name, pass: true, ...details })
const requirements =
  contract.spec +
  '\n仅允许修改business.ts两个BUSINESS AREA函数内部。test.mjs、requirements.txt、sidecar.txt、package.json以及业务范围外正文原字节保持，禁止删断言、改期望、跳过检查或改测试入口。保持UTF-8 BOM、CRLF和三个尾换行。\n固定命令 program=' +
  nodeProgram +
  '，args=["test.mjs"]，cwd=' +
  project +
  '，不下载或安装依赖。\n'
const protectedFiles = {
  'test.mjs': fixture.test,
  'requirements.txt': Buffer.from(requirements),
  'sidecar.txt': Buffer.from('Self-authored sidecar\r\n旁路原字节\r\n'),
  'package.json': Buffer.from('{\n  "private": true,\n  "type": "module"\n}\n')
}
const protectedCheck = async () => {
  for (const [name, bytes] of Object.entries(protectedFiles))
    assert.deepEqual(
      await fs.readFile(path.join(project, name)),
      bytes,
      'Protected original bytes: ' + name
    )
}
const source = () => fs.readFile(path.join(project, 'business.ts'))
async function files(relative) {
  const output = []
  async function visit(name) {
    for (const item of await fs.readdir(path.join(root, name), { withFileTypes: true })) {
      const next = path.join(name, item.name)
      if (item.isDirectory()) await visit(next)
      else if (item.isFile()) output.push(next)
    }
  }
  await visit(relative)
  return output.sort()
}
async function externalTest(label) {
  const child = spawn(nodeProgram, ['test.mjs'], {
    cwd: project,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stdout = '',
    stderr = ''
  child.stdout.on('data', (bytes) => (stdout += bytes))
  child.stderr.on('data', (bytes) => (stderr += bytes))
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  const result = {
    label,
    program: nodeProgram,
    args: ['test.mjs'],
    cwd: project,
    exitCode,
    stdout,
    stderr
  }
  await fs.writeFile(path.join(evidence, label + '.json'), JSON.stringify(result, null, 2))
  return result
}
let productHashes,
  executionCounts,
  iterationCovered = false
try {
  // Configuration is loaded only for this explicitly invoked real validator; values are never recorded.
  try {
    process.loadEnvFile(path.join(root, '.env.local'))
  } catch {
    // An inherited explicit configuration is valid when the optional local env file is unavailable.
  }
  assert.ok(process.env.MODEL_ENDPOINT && process.env.MODEL_API_KEY)
  assert.equal(process.env.MODEL_NAME, 'gpt-6.1-sol')
  await fs.access(entry)
  await fs.access(api)
  if (packaged) await fs.access(launcher)
  await fs.writeFile(path.join(project, 'business.ts'), fixture.source)
  await fs.writeFile(path.join(evidence, 'business.initial.bin'), fixture.source)
  for (const [name, bytes] of Object.entries(protectedFiles)) {
    await fs.writeFile(path.join(project, name), bytes)
    await fs.chmod(path.join(project, name), 0o444)
  }
  const fixed = {
    model: 'gpt-6.1-sol',
    packaged,
    entry,
    api,
    launcher: packaged ? launcher : null,
    project,
    nodeProgram,
    initialBytes: fixture.source.length,
    totalLines: fixture.totalLines,
    sourceSHA256: hash(fixture.source),
    protected: Object.fromEntries(
      Object.entries(protectedFiles).map(([name, bytes]) => [
        name,
        { bytes: bytes.length, sha256: hash(bytes) }
      ])
    ),
    contract,
    format: { encoding: 'UTF-8', bom: true, newline: 'CRLF', trailingNewlines: 3 },
    fixedBeforeModelUTC: new Date().toISOString()
  }
  await fs.writeFile(path.join(evidence, 'contract.json'), JSON.stringify(fixed, null, 2))
  const names = [
    ...(await files('src')),
    'package.json',
    'package-lock.json',
    'electron.vite.config.ts',
    'electron-builder.yml',
    'tsconfig.cli.json',
    ...(await files('scripts')),
    ...(await files('resources/windows-command-runtime')),
    ...(await files('out')),
    ...(await files('dist/agent')),
    ...(await files('dist/win-unpacked'))
  ]
  productHashes = Object.fromEntries(
    await Promise.all(
      names.map(async (name) => [name, hash(await fs.readFile(path.join(root, name)))])
    )
  )
  await fs.writeFile(
    path.join(evidence, 'source-artifact-before.json'),
    JSON.stringify(productHashes, null, 2)
  )
  const scriptHashes = Object.fromEntries(
    await Promise.all(
      ['cli-real-task-check.mjs', 'cli-real-observer.cjs', 'task-contracts.mjs'].map(
        async (name) => [
          name,
          hash(await fs.readFile(fileURLToPath(new URL('./' + name, import.meta.url))))
        ]
      )
    )
  )
  await fs.writeFile(
    path.join(evidence, 'provenance.json'),
    JSON.stringify(
      {
        synthetic: false,
        originalCLI: true,
        runtime: process.version,
        scriptHashes,
        boundary:
          'Actual ordinary Node development CLI or actual distributed launcher. Transparent preload observes original real HTTP bytes, original public output and original supervised command launches. No model response, tool result or business fix is supplied by the validator. New fixed self-authored project only; no desktop history or user files.'
      },
      null,
      2
    )
  )
  const initial = await externalTest('initial-red-test')
  assert.equal(initial.exitCode, 1)
  assert.equal(JSON.parse(initial.stdout).checks, 8)
  assert.equal(JSON.parse(initial.stdout).failures.length, 7)
  async function run(stage, prompt) {
    const directory = path.join(evidence, stage)
    await fs.mkdir(directory)
    const env = { ...process.env, LESSON55_EVIDENCE: directory, LESSON55_STAGE: stage }
    delete env.ELECTRON_RUN_AS_NODE
    const argv = [
      '--mode',
      stage === 'plan' ? 'plan' : 'execute',
      '--cwd',
      project,
      '--workspace',
      project,
      '--permission',
      'full-access',
      '--prompt',
      prompt,
      '--output',
      'jsonl'
    ]
    let program = nodeProgram,
      args = ['--require', observer, entry, ...argv]
    if (packaged) {
      env.NODE_OPTIONS =
        (env.NODE_OPTIONS ? env.NODE_OPTIONS + ' ' : '') +
        '--require "' +
        observer.replaceAll('\\', '/') +
        '"'
      program = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe'
      const quote = (value) => '"' + value.replaceAll('"', '\\"') + '"'
      // The fixed prompts contain no quotes; this invokes the real distribution launcher from outside its directory.
      assert.ok(argv.every((value) => !value.includes('"')))
      args = ['/d', '/s', '/c', '"' + [quote(launcher), ...argv.map(quote)].join(' ') + '"']
    }
    const started = Date.now(),
      child = spawn(program, args, {
        cwd: directory,
        env,
        windowsHide: true,
        windowsVerbatimArguments: packaged,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    let stdout = '',
      stderr = '',
      forcedKill = false
    child.stdout.on('data', (bytes) => (stdout += bytes))
    child.stderr.on('data', (bytes) => (stderr += bytes))
    const done = new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (exitCode, signal) => resolve({ exitCode, signal }))
    })
    let planObservationError = null
    const monitor = setInterval(() => {
      if (stage !== 'plan') return
      try {
        assert.deepEqual(readFileSync(path.join(project, 'business.ts')), fixture.source)
        for (const [name, bytes] of Object.entries(protectedFiles))
          assert.deepEqual(readFileSync(path.join(project, name)), bytes)
      } catch (error) {
        planObservationError ??= error.stack
      }
    }, 100)
    // No total product deadline is added: this is a bounded external validation observation only.
    let outcome
    try {
      outcome = await bounded(done, 600000)
    } finally {
      clearInterval(monitor)
    }
    if (!outcome) {
      forcedKill = true
      child.kill()
      await Promise.race([done, pause(3000)])
    }
    const processResult = {
      stage,
      wrapperPid: child.pid,
      program,
      args: packaged ? ['actual-distributed-launcher', ...argv] : args,
      elapsedMs: Date.now() - started,
      ...outcome,
      forcedKill
    }
    processes.push(processResult)
    await fs.writeFile(path.join(directory, 'stdout.jsonl'), stdout)
    await fs.writeFile(path.join(directory, 'stderr.txt'), stderr)
    await fs.writeFile(path.join(directory, 'process.json'), JSON.stringify(processResult, null, 2))
    await fs.writeFile(
      path.join(directory, 'plan-byte-observation.json'),
      JSON.stringify({ stage, observationIntervalMs: 100, planObservationError }, null, 2)
    )
    let audit
    try {
      audit = JSON.parse(await fs.readFile(path.join(directory, 'transport-audit.json'), 'utf8'))
    } catch {
      // Preserve absent audit evidence for the existing stage assertions and failure report.
    }
    const values = stdout
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
    const item = { stage, directory, process: processResult, values, audit }
    stages.push(item)
    assert.equal(forcedKill, false, 'Actual CLI must end normally')
    assert.equal(
      planObservationError,
      null,
      'Observed original source or protected bytes changed during plan'
    )
    assert.equal(outcome?.exitCode, 0, stderr)
    assert.ok(audit)
    assert.equal(audit.modelMatches, true)
    assert.ok(!audit.requests.some((request) => request.title || request.approval))
    assert.ok(audit.spawns.every((spawn) => !spawn.hasModelCredential))
    assert.equal(
      audit.outputWriters.length,
      1,
      'Actual piped user CLI uses one fixed output writer'
    )
    for (const writer of audit.outputWriters) {
      assert.ok(writer.closed)
      assert.equal(writer.exitCode, 0)
      assert.ok(
        !writer.hasModelCredential &&
          !writer.hasModelEndpoint &&
          !writer.hasModelName &&
          !writer.hasNodeOptions
      )
      assert.ok(writer.environmentNames.every((key) => /^(SystemRoot|WINDIR|TEMP|TMP)$/i.test(key)))
      assert.equal(writer.sentWrites, writer.receivedAcks)
    }
    const finals = values.filter((value) => value.type === 'result')
    assert.equal(finals.length, 1)
    assert.equal(finals[0].task.state, 'completed')
    assert.equal(finals[0].exitCode, 0)
    const requestId = finals[0].requestId
    assert.ok(values.every((value) => value.requestId === requestId))
    return { ...item, requestId, final: finals[0] }
  }
  const plan = await run(
    'plan',
    '研究requirements.txt与business.ts并形成简洁计划。需求：' +
      contract.spec +
      ' 信息充分，无需提问。先search_workspace_text定位、read_workspace_file读取必要相关窗口，不读全文；test.mjs只读查看。计划不修改、不运行命令，等下一次明确执行。'
  )
  const planCalls = plan.values.filter((value) => value.type === 'tool' && value.phase === 'start')
  assert.ok(planCalls.some((call) => call.name === 'search_workspace_text'))
  assert.ok(planCalls.some((call) => call.name === 'read_workspace_file'))
  assert.ok(!planCalls.some((call) => /apply_|create_|command|propose_/.test(call.name)))
  assert.equal(plan.audit.spawns.length, 0)
  await protectedCheck()
  assert.deepEqual(await source(), fixture.source)
  check(
    'actual independent CLI plan researches and keeps every source byte and command unchanged',
    { requestId: plan.requestId }
  )
  const prompt =
    '现在明确执行：' +
    contract.spec +
    ' 只修改business.ts两个BUSINESS AREA函数内部，其余正文及UTF-8 BOM、CRLF、三个尾换行全部保持。test.mjs、requirements.txt、sidecar.txt、package.json绝对禁止修改；不能删断言、改期望、跳过检查或改测试入口。此执行是新的独立请求，重新按需读取必要片段与hash，用apply_workspace_patch局部补丁。固定测试命令program=' +
    nodeProgram +
    '，args=[test.mjs]，cwd=' +
    project +
    '；无shell复合命令、不下载依赖。修改后由你实际运行固定8项测试，若真实失败就在本次execute内继续读取、修正同一业务文件并重测。第一次通过后重读修改处，再实际运行同一固定测试确认。整个任务在这次execute内完成，不等追加提示；遇到阻塞如实报告。'
  assert.ok(prompt.length <= 2000)
  const execute = await run('execute', prompt)
  const starts = execute.values.filter((value) => value.type === 'tool' && value.phase === 'start')
  const pairs = starts.map((call) => {
    const finish = execute.values.find(
      (value) => value.type === 'tool' && value.phase === 'finish' && value.callId === call.callId
    )
    assert.ok(finish)
    return {
      call,
      args: JSON.parse(call.arguments),
      output: finish.output,
      result: JSON.parse(finish.output)
    }
  })
  const sameTarget = (candidate) =>
    typeof candidate === 'string' &&
    path.resolve(project, candidate).toLowerCase() ===
      path.join(project, 'business.ts').toLowerCase()
  const patches = pairs.filter(
    (pair) => pair.call.name === 'apply_workspace_patch' && pair.result.status === 'applied'
  )
  const commands = pairs.filter((pair) => pair.call.name === 'run_workspace_command')
  assert.ok(patches.length)
  assert.ok(
    pairs
      .slice(0, pairs.indexOf(patches[0]))
      .some(
        (pair) =>
          pair.call.name === 'read_workspace_file' &&
          sameTarget(pair.args.path) &&
          pair.result.sha256 === hash(fixture.source)
      )
  )
  assert.ok(patches.every((pair) => sameTarget(pair.args.path)))
  assert.ok(commands.length >= 2)
  for (const command of commands) {
    assert.equal(path.resolve(command.args.program).toLowerCase(), nodeProgram.toLowerCase())
    assert.deepEqual(command.args.args, ['test.mjs'])
    assert.equal(path.resolve(command.args.cwd).toLowerCase(), project.toLowerCase())
    assert.equal(command.result.truncated, false)
    assert.equal(command.result.treeExited, true)
  }
  const before = commands.at(-2),
    final = commands.at(-1)
  for (const command of [before, final]) {
    assert.equal(command.result.status, 'completed')
    assert.equal(command.result.exitCode, 0)
    const report = JSON.parse(command.result.stdout.trim())
    assert.equal(report.checks, 8)
    assert.deepEqual(report.failures, [])
  }
  assert.ok(
    pairs
      .slice(pairs.indexOf(before) + 1, pairs.indexOf(final))
      .some((pair) => pair.call.name === 'read_workspace_file' && sameTarget(pair.args.path)),
    'Agent must reread between actual passing tests'
  )
  iterationCovered = commands.some(
    (command) =>
      command.result.status === 'failed' &&
      command.result.exitCode !== 0 &&
      pairs.indexOf(command) > pairs.indexOf(patches[0]) &&
      pairs.some(
        (pair) =>
          pairs.indexOf(pair) > pairs.indexOf(command) &&
          pair.call.name === 'apply_workspace_patch' &&
          pair.result.status === 'applied'
      )
  )
  const realMain = execute.audit.requests.filter((request) => !request.title && !request.approval)
  executionCounts = {
    requestId: execute.requestId,
    toolExecutions: pairs.length,
    completedModelRounds: realMain.filter(
      (request) => request.httpStatus === 200 && request.completed
    ).length,
    modelAttempts: realMain.length,
    transportRetries: execute.values.filter((value) => value.type === 'retry').length,
    planRequests: plan.audit.requests.length,
    commands: commands.map((command) => ({ args: command.args, result: command.result }))
  }
  await fs.writeFile(
    path.join(evidence, 'execution-counts.json'),
    JSON.stringify(executionCounts, null, 2)
  )
  check('same explicit execute fresh reads patch actual eight tests reread and retest', {
    executionCounts,
    iterationCovered
  })
  await protectedCheck()
  const actual = await source()
  assert.deepEqual(outsideBusiness(actual), outsideBusiness(fixture.source))
  assert.ok(actual.subarray(0, 3).equals(Buffer.from([239, 187, 191])))
  assert.ok(!/(?<!\r)\n/.test(actual.toString('utf8')))
  assert.equal(actual.toString('utf8').match(/(?:\r\n)+$/)[0], '\r\n\r\n\r\n')
  await fs.writeFile(path.join(evidence, 'business.final.bin'), actual)
  const backups = []
  for (const name of await fs.readdir(project))
    if (/^\.zonecodex-[a-f0-9-]{36}\.bak$/.test(name)) {
      const bytes = await fs.readFile(path.join(project, name))
      backups.push({ name, sha256: hash(bytes), equalsInitial: bytes.equals(fixture.source) })
    }
  assert.ok(backups.some((backup) => backup.equalsInitial))
  await fs.writeFile(path.join(evidence, 'backup-check.json'), JSON.stringify(backups, null, 2))
  const reads = pairs.filter(
    (pair) => pair.call.name === 'read_workspace_file' && sameTarget(pair.args.path)
  )
  assert.ok(reads.every((read) => read.result.fullText == null))
  const visible = new Set(
    [...plan.values, ...execute.values]
      .filter(
        (value) =>
          value.type === 'tool' && value.phase === 'finish' && value.name === 'read_workspace_file'
      )
      .flatMap((value) => {
        const read = JSON.parse(value.output)
        return sameTarget(read.path)
          ? read.lines.filter((line) => !line.truncated).map((line) => line.line)
          : []
      })
  )
  assert.ok(visible.size < fixture.totalLines)
  const delivered = realMain.flatMap((request) =>
    request.rawBody.input
      .filter((item) => item.type === 'function_call_output')
      .map((item) => item.output)
  )
  assert.ok(reads.every((read) => delivered.includes(read.output)))
  const diff = spawn(
    'git',
    [
      'diff',
      '--no-index',
      '--',
      path.join(evidence, 'business.initial.bin'),
      path.join(evidence, 'business.final.bin')
    ],
    { cwd: root, windowsHide: true }
  )
  let diffText = '',
    diffStderr = ''
  diff.stdout.on('data', (bytes) => (diffText += bytes))
  diff.stderr.on('data', (bytes) => (diffStderr += bytes))
  const diffExitCode = await new Promise((resolve, reject) => {
    diff.once('error', reject)
    diff.once('close', resolve)
  })
  assert.equal(diffExitCode, 1)
  await fs.writeFile(path.join(evidence, 'business.diff'), diffText)
  await fs.writeFile(
    path.join(evidence, 'diff-result.json'),
    JSON.stringify({ diffExitCode, diffStderr }, null, 2)
  )
  assert.equal((await externalTest('independent-final-test')).exitCode, 0)
  check('independent protected hashes exterior format backups and fixed tests pass', {
    finalBytes: actual.length,
    finalSHA256: hash(actual),
    visibleCount: visible.size,
    totalLines: fixture.totalLines,
    backups
  })
  const idleDirectory = path.join(evidence, 'fresh-idle-import')
  await fs.mkdir(idleDirectory)
  const idleEnv = {
    ...process.env,
    LESSON55_EVIDENCE: idleDirectory,
    LESSON55_STAGE: 'fresh-idle-import'
  }
  delete idleEnv.ELECTRON_RUN_AS_NODE
  const idle = spawn(
    nodeProgram,
    [
      '--require',
      observer,
      '-e',
      'require(process.argv[1]);setTimeout(()=>console.log("idle-observation-completed"),5000)',
      api
    ],
    { cwd: idleDirectory, env: idleEnv, windowsHide: true }
  )
  let idleOutput = '',
    idleError = ''
  idle.stdout.on('data', (bytes) => (idleOutput += bytes))
  idle.stderr.on('data', (bytes) => (idleError += bytes))
  idle.stdin.end()
  const idleStarted = Date.now(),
    idleExit = await new Promise((resolve, reject) => {
      idle.once('error', reject)
      idle.once('close', resolve)
    })
  const idleAudit = JSON.parse(
    await fs.readFile(path.join(idleDirectory, 'transport-audit.json'), 'utf8')
  )
  assert.equal(idleExit, 0)
  assert.equal(idleAudit.requests.length, 0)
  assert.equal(idleAudit.allFetches.length, 0)
  assert.equal(idleAudit.spawns.length, 0)
  assert.equal(idleAudit.outputWriters.length, 0)
  assert.ok(Date.now() - idleStarted >= 5000)
  assert.ok(!stages.some((stage) => stage.audit.pid === idleAudit.pid))
  await fs.writeFile(
    path.join(idleDirectory, 'process.json'),
    JSON.stringify(
      { pid: idle.pid, idleExit, idleOutput, idleError, elapsedMs: Date.now() - idleStarted },
      null,
      2
    )
  )
  check(
    'new ordinary Node public-module process observes five seconds without implicit task requests',
    {
      observationMs: 5000,
      pid: idle.pid,
      modelRequests: 0,
      commandSpawns: 0,
      persistenceNotImplemented: true
    }
  )
  for (const [name, digest] of Object.entries(productHashes))
    assert.equal(
      hash(await fs.readFile(path.join(root, name))),
      digest,
      'Frozen product source/artifact changed: ' + name
    )
  await fs.writeFile(
    path.join(evidence, 'source-artifact-after.json'),
    JSON.stringify({ pass: true, hashes: productHashes }, null, 2)
  )
  check(
    'all product source runtime CLI desktop and distribution hashes kept throughout real regression',
    { files: Object.keys(productHashes).length }
  )
  const requests = stages.flatMap((stage) => stage.audit.requests)
  const outcomes = Object.fromEntries(
    ['main', 'title', 'approval'].map((kind) => {
      const selected = requests.filter((request) =>
        kind === 'title'
          ? request.title
          : kind === 'approval'
            ? request.approval
            : !request.title && !request.approval
      )
      return [
        kind,
        {
          attempts: selected.length,
          completed: selected.filter((request) => request.httpStatus === 200 && request.completed)
            .length,
          failures: selected
            .filter((request) => request.httpStatus !== 200 || !request.completed)
            .map((request) => ({ httpStatus: request.httpStatus, error: request.error }))
        }
      ]
    })
  )
  const result = {
    pass: true,
    synthetic: false,
    packaged,
    evidence,
    project,
    entry,
    api,
    checks,
    executionCounts,
    iterationCovered,
    outcomes,
    processes,
    boundary:
      'Real default model and original actual CLI business path. CLI has no persistent session; fresh idle import proves no implicit startup, not desktop task restoration. Desktop restoration is independently verified.'
  }
  await fs.writeFile(path.join(evidence, 'results.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result))
} catch (error) {
  const failure = {
    pass: false,
    synthetic: false,
    packaged,
    evidence,
    project,
    entry,
    checks,
    executionCounts,
    iterationCovered,
    processes,
    error: error.stack,
    atUTC: new Date().toISOString(),
    boundary:
      'Every failure is preserved; no test/model/tool/business correction supplied by validator.'
  }
  await fs.writeFile(path.join(evidence, 'results.json'), JSON.stringify(failure, null, 2))
  console.error(JSON.stringify(failure))
  process.exitCode = 1
}
