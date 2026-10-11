import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  root,
  createEvidence,
  runProcess,
  sourceIdentity,
  loadRealConfiguration
} from './runtime.mjs'
import { prepareBusiness, cliPairs, validateBusiness, captureDiskFacts } from './business.mjs'

const packaged = process.argv.includes('--packaged')
assert.ok(process.argv.slice(2).every((arg) => arg === '--packaged'))
const evidence = await createEvidence('real-cli-' + (packaged ? 'distributed' : 'development'))
const entry = path.join(root, packaged ? 'dist/agent/index.cjs' : 'out/cli/index.cjs')
const api = path.join(root, packaged ? 'dist/agent/agent.cjs' : 'out/cli/agent.cjs')
const launcher = path.join(root, 'dist/agent/agent.cmd')
const observer = path.join(root, 'tests/lesson56/real-observer.cjs')
const report = {
  pass: false,
  evidence,
  packaged,
  model: 'gpt-6.1-sol',
  realTransport: true,
  syntheticHistory: false,
  stages: [],
  checks: [],
  failures: [],
  uncovered: []
}
let before, business
async function run(stage, args, moduleImport = false) {
  const directory = path.join(evidence, stage)
  await fs.mkdir(directory)
  const auditFile = path.join(directory, 'audit.json')
  const env = {
    ...process.env,
    LESSON56_OBSERVER_CONFIG: JSON.stringify({ root, stage, auditFile, desktop: false })
  }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  let program = process.execPath,
    parameters = [
      '--require',
      observer,
      ...(moduleImport ? ['-e', 'require(' + JSON.stringify(api) + ')'] : [entry, ...args])
    ]
  if (packaged && !moduleImport) {
    env.NODE_OPTIONS = '--require "' + observer.replaceAll('\\', '/') + '"'
    program = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe'
    assert.ok(
      args.every((arg) => !arg.includes('"')),
      'Fixed launcher args cannot contain quotes'
    )
    const quote = (value) => '"' + value + '"'
    parameters = ['/d', '/s', '/c', '"' + [quote(launcher), ...args.map(quote)].join(' ') + '"']
  }
  const result = await runProcess(
    program,
    parameters,
    { cwd: directory, env, windowsVerbatimArguments: packaged && !moduleImport },
    600000
  )
  await fs.writeFile(path.join(directory, 'stdout.jsonl'), result.stdout)
  await fs.writeFile(path.join(directory, 'stderr.txt'), result.stderr)
  const processResult = {
    program: result.program,
    args: moduleImport
      ? ['module-import-only']
      : packaged
        ? ['actual-distributed-launcher', ...args]
        : ['actual-development-entry', ...args],
    pid: result.pid,
    elapsedMs: result.elapsedMs,
    exitCode: result.exitCode ?? null,
    signal: result.signal ?? null,
    forcedKill: result.forcedKill
  }
  await fs.writeFile(path.join(directory, 'process.json'), JSON.stringify(processResult, null, 2))
  let audit = null
  try {
    audit = JSON.parse(await fs.readFile(auditFile, 'utf8'))
  } catch {
    /* Absence is retained as failed evidence, never substituted. */
  }
  report.stages.push({ stage, directory, process: processResult, audit })
  assert.equal(result.forcedKill, false, 'Bounded external observation ended normally')
  assert.ok(audit, 'Actual observer audit exists')
  assert.deepEqual(audit.writeFailures, [])
  return { result, audit }
}
async function zero(stage, args, moduleImport = false) {
  const { result, audit } = await run(stage, args, moduleImport)
  assert.equal(result.exitCode, 0)
  assert.equal(audit.requests.length, 0)
  assert.equal(audit.allFetches.length, 0)
  assert.equal(audit.spawns.length, 0)
  report.checks.push({
    name: stage + ' new process has zero main/summary/title/approval/Agent/command requests',
    pass: true,
    pid: result.pid,
    counts: { main: 0, summary: 0, title: 0, approval: 0, command: 0 }
  })
}
try {
  await loadRealConfiguration()
  await fs.access(entry)
  await fs.access(api)
  if (packaged) await fs.access(launcher)
  before = await sourceIdentity([
    path.relative(root, entry),
    path.relative(root, api),
    ...(packaged
      ? ['dist/agent/agent.cmd', 'dist/agent/output-writer.cjs']
      : ['out/cli/output-writer.cjs'])
  ])
  await fs.writeFile(
    path.join(evidence, 'source-artifact-before.json'),
    JSON.stringify(before, null, 2)
  )
  business = await prepareBusiness(evidence, true)
  await zero('import-before', [], true)
  await zero('help-before', ['--help'])
  const { result, audit } = await run('execute', [
    '--mode',
    'execute',
    '--cwd',
    business.project,
    '--workspace',
    business.project,
    '--permission',
    'full-access',
    '--prompt',
    business.prompt,
    '--output',
    'jsonl'
  ])
  const values = result.stdout
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  const final = values.filter((value) => value.type === 'result')
  assert.equal(final.length, 1, 'Exactly one healthy-output terminal record')
  assert.equal(result.exitCode, 0, result.stderr)
  assert.equal(final[0].exitCode, 0)
  assert.equal(final[0].task.state, 'completed', JSON.stringify(final[0]))
  assert.ok(values.every((value) => value.requestId === final[0].requestId))
  assert.ok(audit.spawns.every((spawn) => !spawn.hasModelCredential))
  assert.equal(audit.writers.length, 1)
  assert.ok(
    audit.writers.every(
      (writer) =>
        writer.closed &&
        writer.exitCode === 0 &&
        writer.sentWrites === writer.receivedAcks &&
        !writer.hasModelCredential &&
        !writer.hasNodeOptions &&
        writer.environmentNames.every((name) => /^(SystemRoot|WINDIR|TEMP|TMP)$/i.test(name))
    )
  )
  const pairs = cliPairs(values)
  await fs.writeFile(path.join(evidence, 'agent-tool-facts.json'), JSON.stringify(pairs, null, 2))
  const contexts = values
    .filter((value) => value.type === 'context')
    .map((value) => value.event ?? value.state ?? value)
  report.business = await validateBusiness(business, pairs, audit, contexts)
  report.uncovered.push(...report.business.uncovered)
  report.checks.push({
    name: 'actual single-task CLI reads materials, compacts with real model, and continues protected price task',
    pass: true
  })
} catch (error) {
  report.failures.push({ message: error.message, stack: error.stack })
} finally {
  if (business)
    try {
      report.independentDisk = await captureDiskFacts(business)
    } catch (error) {
      report.failures.push({ message: error.message, stack: error.stack })
    }
  try {
    await zero('import-after-completion', [], true)
    await zero('help-after-completion', ['--help'])
  } catch (error) {
    report.failures.push({ message: error.message, stack: error.stack })
  }
  if (before) {
    try {
      assert.deepEqual(
        await sourceIdentity(
          Object.keys(before).filter((name) => name.startsWith('out/') || name.startsWith('dist/'))
        ),
        before
      )
      report.checks.push({
        name: 'source and invoked artifacts unchanged during real validation',
        pass: true
      })
    } catch (error) {
      report.failures.push({ message: error.message, stack: error.stack })
    }
  }
  report.pass = report.failures.length === 0 && !!report.business
  if (!report.business)
    report.uncovered.push(
      'No passing real summary-to-business continuation chain; see preserved process/transport failure and actual budgets.'
    )
  await fs.writeFile(path.join(evidence, 'results.json'), JSON.stringify(report, null, 2))
  console.log(
    JSON.stringify({
      pass: report.pass,
      evidence,
      packaged,
      failures: report.failures.map((failure) => failure.message),
      uncovered: report.uncovered
    })
  )
  if (!report.pass) process.exitCode = 1
}
