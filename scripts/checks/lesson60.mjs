import assert from 'node:assert/strict'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { root, createEvidence, runProcess } from '../../tests/lesson60/runtime.mjs'

const groups = {
  offline: [
    ['authorization', 'authorization-check.mjs'],
    ['renderer', 'renderer-check.mjs'],
    ['cli-source', 'cli-check.mjs', '--offline']
  ],
  cli: [
    ['cli-development', 'cli-check.mjs', '--entry=out/cli/index.cjs'],
    ['cli-distributed', 'cli-check.mjs', '--entry=dist/agent/index.cjs']
  ],
  desktop: [
    ['desktop-development', 'desktop-check.mjs'],
    ['desktop-packaged', 'desktop-check.mjs', '--packaged']
  ]
}
const [group = 'offline', ...args] = process.argv.slice(2)
if (group === 'list') {
  console.log(
    'lesson60 offline: current-source permission, approval, task lifecycle and renderer/CLI adapters; synthetic Electron/model/backend, separately recorded isolated disk, zero network.'
  )
  console.log(
    'lesson60 cli / desktop: existing development/distribution artifacts, real Windows UI/ordinary Node/TTY/isolated disk, synthetic model/reviewer and injected response failures. No automatic build or real model request.'
  )
  console.log(
    'Default npm test remains the lesson58 eleven-suite behavior lock. Prior lesson56-59 open items and eight questions are unchanged.'
  )
  for (const [name, entries] of Object.entries(groups))
    console.log(name + ': ' + entries.map(([suite]) => suite).join(', '))
} else {
  assert(Object.hasOwn(groups, group), 'Unknown lesson60 group')
  assert(
    args.length <= 1 && args.every((arg) => arg.startsWith('--suite=')),
    'Only --suite=<listed name> accepted'
  )
  const selection = args[0]?.slice(8)
  const entries = groups[group].filter(([name]) => !selection || name === selection)
  assert(entries.length, 'Unknown suite')
  const evidence = await createEvidence(group + '-group')
  const runs = []
  for (const [name, filename, ...parameters] of entries) {
    const entry = path.join(root, 'tests/lesson60', filename)
    const env = { ...process.env }
    for (const key of Object.keys(env))
      if (/^(MODEL_|NODE_OPTIONS$|ELECTRON_RUN_AS_NODE$)/i.test(key)) delete env[key]
    const guard = path.join(root, 'tests/lesson55/offline/deny-network.cjs')
    const result = await runProcess(
      process.execPath,
      [...(group === 'offline' ? ['--require', guard] : []), entry, ...parameters],
      { cwd: root, env },
      group === 'offline' ? 120000 : 360000
    )
    await fs.writeFile(path.join(evidence, name + '.stdout.log'), result.stdout)
    await fs.writeFile(path.join(evidence, name + '.stderr.log'), result.stderr)
    process.stdout.write(result.stdout)
    process.stderr.write(result.stderr)
    runs.push({
      name,
      entry,
      parameters,
      pid: result.pid,
      exitCode: result.exitCode ?? null,
      signal: result.signal ?? null,
      elapsedMs: result.elapsedMs,
      forcedKill: result.forcedKill
    })
  }
  const report = {
    pass: runs.every((run) => run.exitCode === 0 && run.signal === null && !run.forcedKill),
    group,
    selection: selection ?? null,
    evidence,
    syntheticTransport: true,
    realTransport: false,
    actualElectron: group === 'desktop',
    actualOrdinaryNodeProcesses: group === 'cli',
    automaticBuild: false,
    defaultRegressionGroup: 'lesson58',
    runs
  }
  await fs.writeFile(path.join(evidence, 'results.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ pass: report.pass, group, evidence, suites: runs.length }))
  if (!report.pass) process.exitCode = 1
}
