import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { evidenceFor, root, suite, hash } from './runtime.mjs'
import { runProcess } from '../lesson57/runtime.mjs'
const evidence = await evidenceFor('cli'), checks = suite(evidence)
const output = path.join(evidence, 'cli.cjs'), publicOutput = path.join(evidence, 'agent.cjs')
const writer = path.join(evidence, 'output-writer.cjs')
await build({ entryPoints: [path.join(root, 'src/cli/output-writer.ts')], outfile: writer, platform: 'node', format: 'cjs', bundle: true, logLevel: 'silent' })
const writerHash = hash(await fs.readFile(writer))
await fs.writeFile(path.join(evidence, 'build-manifest.json'), JSON.stringify({ entries: [{ name: 'output-writer.cjs', sha256: writerHash }] }))
await build({ entryPoints: [path.join(root, 'src/cli/index.ts')], outfile: output, platform: 'node', format: 'cjs', bundle: true, define: { __OUTPUT_WRITER_SHA256__: JSON.stringify(writerHash) }, logLevel: 'silent' })
await build({ entryPoints: [path.join(root, 'src/cli/agent-host.ts')], outfile: publicOutput, platform: 'node', format: 'cjs', bundle: true, logLevel: 'silent' })
const env = { ...process.env, APPDATA: path.join(evidence, 'appdata'), LOCALAPPDATA: path.join(evidence, 'localappdata') }
for (const key of Object.keys(env)) if (/^(MODEL_|OPENAI_|NODE_OPTIONS$)/.test(key)) delete env[key]
const guard = path.join(root, 'tests/lesson64/deny-network.cjs')
const run = (args, overrides = {}) => runProcess(process.execPath, ['--require', guard, output, ...args], { cwd: evidence, env: { ...env, ...overrides } }, 20000)
await checks.check('public script import is inert without configuration', async () => {
  let calls = 0; globalThis.fetch = async () => { calls++; throw Error('network') }
  const api = createRequire(import.meta.url)(publicOutput); assert.equal(typeof api.runAgentTask, 'function'); assert.equal(calls, 0)
})
await checks.check('CLI help is passive even with invalid model configuration', async () => {
  const result = await run(['--help'], { MODEL_PROVIDER: 'invalid' }); assert.equal(result.exitCode, 0); assert.match(result.stdout, /MODEL_PROVIDER/)
})
await checks.check('actual CLI process without login returns only offline explanation', async () => {
  const result = await run(['--mode', 'execute', '--prompt', 'write a file']); assert.equal(result.exitCode, 0, result.stderr)
  assert.match(result.stdout, /当前为离线模式，未调用推理模型，也未执行本轮任务。/)
  assert(!result.stdout.includes('function_call'))
  assert.equal(result.stdout.split('当前为离线模式，未调用推理模型，也未执行本轮任务。').length - 1, 1)
})
await checks.check('partial configuration fails honestly and offline resume preserves checkpoint bytes', async () => {
  const invalid = await run(['--mode', 'plan', '--prompt', 'hello'], { MODEL_NAME: 'partial' }); assert.equal(invalid.exitCode, 2, invalid.stderr)
  const checkpoint = path.join(evidence, 'unchanged.json'); await fs.writeFile(checkpoint, 'preserved original')
  const result = await run(['--resume', checkpoint]); assert.notEqual(result.exitCode, 0); assert.match(result.stderr, /CHECKPOINT_INVALID/)
  assert.equal(await fs.readFile(checkpoint, 'utf8'), 'preserved original')
})
await checks.finish({ actualCLIProcesses: true, actualNetworkRequests: 0 })
