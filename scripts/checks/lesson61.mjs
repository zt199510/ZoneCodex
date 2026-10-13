import assert from 'node:assert/strict'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { root, createEvidence, runProcess } from '../../tests/lesson61/runtime.mjs'

const groups = {
  offline: [
    ['protocol', 'protocol-check.mjs'],
    ['ipc', 'ipc-check.mjs'],
    ['process', 'process-check.mjs'],
    ['isolation', 'isolation-check.mjs'],
    ['renderer', 'renderer-check.mjs']
  ],
  native: [['git-readonly', 'native-check.mjs']],
  desktop: [
    ['desktop-development', 'desktop-check.mjs'],
    ['desktop-packaged-debug', 'desktop-check.mjs', '--packaged'],
    ['desktop-packaged-ordinary', 'desktop-check.mjs', '--packaged', '--ordinary']
  ]
}
const [group = 'offline', ...args] = process.argv.slice(2)
if (group === 'list') {
  console.log(
    'lesson61 offline: current-source Git contracts, IPC/source, renderer and isolation; synthetic boundaries, zero networking.'
  )
  console.log(
    'lesson61 native: installed trusted Git and isolated test repositories; fixture writes are limited to new UUID evidence paths, product reads compare all material identities.'
  )
  console.log(
    'lesson61 desktop: existing development/package artifacts, real trusted UI input/Git/PTY/disk. Native directory selection returns are explicitly synthetic in debug audits; ordinary package observations have a smaller boundary. No automatic build or real model transport.'
  )
  console.log(
    'Default npm test remains lesson58. Prior lesson56–60 open items and eight questions are unchanged.'
  )
  for (const [name, entries] of Object.entries(groups))
    console.log(name + ': ' + entries.map(([suite]) => suite).join(', '))
} else {
  assert(Object.hasOwn(groups, group), 'Unknown lesson61 group')
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
    const entry = path.join(root, 'tests/lesson61', filename)
    await fs.access(entry)
    const env = { ...process.env }
    for (const key of Object.keys(env))
      if (/^(MODEL_|NODE_OPTIONS$|ELECTRON_RUN_AS_NODE$)/i.test(key)) delete env[key]
    const guard = path.join(root, 'tests/lesson55/offline/deny-network.cjs')
    const result = await runProcess(
      process.execPath,
      [...(group === 'offline' ? ['--require', guard] : []), entry, ...parameters],
      { cwd: root, env },
      group === 'desktop' ? 360000 : 180000
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
    realModelTransport: false,
    actualElectron: group === 'desktop',
    actualGit: group !== 'offline',
    fixtureWritesOnlyInNewEvidence: group !== 'offline',
    automaticBuild: false,
    defaultRegressionGroup: 'lesson58',
    runs
  }
  await fs.writeFile(path.join(evidence, 'results.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ pass: report.pass, group, evidence, suites: runs.length }))
  if (!report.pass) process.exitCode = 1
}
