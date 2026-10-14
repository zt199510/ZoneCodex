import assert from 'node:assert/strict'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { root, runProcess } from '../../tests/lesson57/runtime.mjs'

const groups = {
  offline: [
    ['skills', 'skills-check.mjs'],
    ['storage', 'storage-check.mjs'],
    ['renderer', 'renderer-check.mjs'],
    ['runtime', 'runtime-check.mjs']
  ],
  cli: [
    ['cli-development', 'cli-check.mjs'],
    ['cli-distributed', 'cli-check.mjs', '--packaged']
  ],
  desktop: [
    ['desktop-development', 'desktop-check.mjs'],
    ['desktop-packaged', 'desktop-check.mjs', '--packaged']
  ],
  live: [
    ['live-development', 'desktop-check.mjs', '--live'],
    ['live-packaged', 'desktop-check.mjs', '--packaged', '--live']
  ]
}
const [group = 'offline', ...args] = process.argv.slice(2)
if (group === 'list') {
  console.log(
    'lesson62 offline: current-source contracts, actual isolated file reads/store, synthetic IPC/hooks/transport; zero external model calls.'
  )
  console.log(
    'lesson62 cli: current built development entry and actual distributed launcher, synthetic transport, real checkpoint disk/process restart; help/import passive observations.'
  )
  console.log(
    'lesson62 desktop: current development and Windows package Electron/IPC/UI/disk; synthetic transport explicitly recorded. No automatic build.'
  )
  console.log(
    'lesson62 live: two explicit actual desktop code-review tasks using current default model/configuration; isolated userData and known defect evidence. Network calls occur only in this group.'
  )
  console.log(
    'Default npm test stays lesson58. Prior course open items and eight questions are unchanged.'
  )
  for (const [name, entries] of Object.entries(groups))
    console.log(name + ': ' + entries.map(([suite]) => suite).join(', '))
} else {
  assert(Object.hasOwn(groups, group), 'Unknown lesson62 group')
  assert(
    args.length <= 1 && args.every((arg) => arg.startsWith('--suite=')),
    'Only --suite=<listed name> accepted'
  )
  const selection = args[0]?.slice(8)
  const entries = groups[group].filter(([name]) => !selection || name === selection)
  assert(entries.length, 'Unknown suite')
  const evidence = path.join(root, '.ui-check/test-runs/lesson62', group + '-group-' + randomUUID())
  await fs.mkdir(evidence, { recursive: true })
  const runs = []
  for (const [name, filename, ...parameters] of entries) {
    const entry = path.join(root, 'tests/lesson62', filename)
    await fs.access(entry)
    const env = { ...process.env }
    for (const key of Object.keys(env))
      if (/^(MODEL_|NODE_OPTIONS$|ELECTRON_RUN_AS_NODE$)/i.test(key)) delete env[key]
    const guard = path.join(root, 'tests/lesson55/offline/deny-network.cjs')
    const result = await runProcess(
      process.execPath,
      [...(group === 'offline' ? ['--require', guard] : []), entry, ...parameters],
      { cwd: root, env },
      group === 'live' ? 600000 : group === 'desktop' ? 360000 : 180000
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
    actualElectron: ['desktop', 'live'].includes(group),
    realModelTransport: group === 'live',
    automaticBuild: false,
    defaultRegressionGroup: 'lesson58',
    runs
  }
  await fs.writeFile(path.join(evidence, 'results.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ pass: report.pass, group, evidence, suites: runs.length }))
  if (!report.pass) process.exitCode = 1
}
