import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { root, evidenceFor } from '../../tests/lesson64/runtime.mjs'
import { runProcess } from '../../tests/lesson57/runtime.mjs'
const [group = 'offline', ...args] = process.argv.slice(2)
const groups = { offline: [['model', 'model-check.mjs'], ['mcp', 'mcp-check.mjs'], ['cli', 'cli-check.mjs']], desktop: [['development', 'desktop-check.mjs'], ['packaged', 'desktop-check.mjs', '--packaged']] }
if (group === 'list') {
  console.log('lesson64 offline: compiled production model/Agent/MCP, synthetic SSE and scripted test-only Provider, real stdio children and CLI processes. External HTTP blocked. No automatic build or model requests.')
  console.log('lesson64 desktop: current development + separately rebuilt Windows directory package, isolated userData, production offline Provider, actual UI input and process cleanup. Build first. No automatic build, no remote model.')
  for (const [key, suites] of Object.entries(groups)) console.log(key + ': ' + suites.map(([name]) => name).join(', '))
} else {
  assert(Object.hasOwn(groups, group)); assert(args.length <= 1 && args.every((v) => v.startsWith('--suite=')))
  const entries = groups[group].filter(([name]) => !args.length || name === args[0].slice(8)); assert(entries.length)
  const evidence = await evidenceFor(group + '-group'), runs = []
  for (const [name, file, ...parameters] of entries) {
    const env = { ...process.env }
    for (const key of Object.keys(env)) if (/^(MODEL_|OPENAI_|NODE_OPTIONS$|ELECTRON_RUN_AS_NODE$)/i.test(key)) delete env[key]
    const result = await runProcess(process.execPath, [...(group === 'offline' ? ['--require', path.join(root, 'tests/lesson64/deny-network.cjs')] : []), path.join(root, 'tests/lesson64', file), ...parameters], { cwd: root, env }, group === 'desktop' ? 300000 : 180000)
    await fs.writeFile(path.join(evidence, name + '.stdout.log'), result.stdout); await fs.writeFile(path.join(evidence, name + '.stderr.log'), result.stderr)
    process.stdout.write(result.stdout); process.stderr.write(result.stderr)
    runs.push({ name, exitCode: result.exitCode, signal: result.signal, forcedKill: result.forcedKill, elapsedMs: result.elapsedMs })
  }
  const pass = runs.every((run) => run.exitCode === 0 && run.signal === null && !run.forcedKill)
  await fs.writeFile(path.join(evidence, 'results.json'), JSON.stringify({ pass, evidence, group, runs, automaticBuild: false, realModelRequests: 0 }, null, 2))
  console.log(JSON.stringify({ pass, evidence, group })); if (!pass) process.exitCode = 1
}
