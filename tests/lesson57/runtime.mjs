import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import { spawn } from 'node:child_process'

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const hash = (value) => createHash('sha256').update(value).digest('hex')
export const fingerprint = (value) => hash(JSON.stringify(value))
export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export async function createEvidence(prefix) {
  assert.match(prefix, /^[a-z][a-z0-9-]*$/)
  const evidence = path.join(root, '.ui-check/test-runs/lesson57', prefix + '-' + randomUUID())
  await fs.mkdir(evidence, { recursive: true })
  return evidence
}

export async function compile(evidence, files) {
  const output = path.join(evidence, 'current-source.cjs')
  const bundle = await build({
    stdin: {
      contents: files.map((file) => `export * from ${JSON.stringify('./' + file)};`).join('\n'),
      resolveDir: root
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: output,
    metafile: true,
    logLevel: 'silent'
  })
  const inputs = Object.keys(bundle.metafile.inputs).filter((file) => file !== '<stdin>')
  assert(!inputs.some((file) => /(^|[/\\])electron([/\\]|$)|agent-runner|agent-ipc/.test(file)))
  const sourceHashes = Object.fromEntries(
    await Promise.all(
      inputs.map(async (file) => [file, hash(await fs.readFile(path.resolve(root, file)))])
    )
  )
  await fs.writeFile(
    path.join(evidence, 'source-identity.json'),
    JSON.stringify(sourceHashes, null, 2)
  )
  return {
    api: createRequire(import.meta.url)(output),
    sourceHashes,
    compiledSHA256: hash(await fs.readFile(output))
  }
}

export function checksFor(evidence, facts = {}) {
  const checks = []
  return {
    async check(name, action) {
      const started = Date.now()
      try {
        checks.push({ name, pass: true, details: await action(), elapsedMs: Date.now() - started })
      } catch (error) {
        checks.push({
          name,
          pass: false,
          error: error.stack ?? String(error),
          elapsedMs: Date.now() - started
        })
        console.error(name, error)
      }
    },
    async finish(extra = {}) {
      const report = {
        pass: checks.every((check) => check.pass),
        evidence,
        ...facts,
        ...extra,
        checks
      }
      await fs.writeFile(path.join(evidence, 'results.json'), JSON.stringify(report, null, 2))
      console.log(JSON.stringify({ pass: report.pass, evidence, checks: checks.length }))
      if (!report.pass) process.exitCode = 1
      return report
    }
  }
}

export async function runProcess(program, args, options = {}, observationMs = 120000) {
  const child = spawn(program, args, {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options
  })
  let stdout = '',
    stderr = ''
  child.stdout?.on('data', (bytes) => {
    stdout += bytes
  })
  child.stderr?.on('data', (bytes) => {
    stderr += bytes
  })
  const started = Date.now()
  const outcome = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (exitCode, signal) => resolve({ exitCode, signal }))
  })
  let timer
  const result = await Promise.race([
    outcome,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), observationMs)
    })
  ]).finally(() => clearTimeout(timer))
  if (!result) {
    child.kill()
    await Promise.race([outcome, delay(3000)])
  }
  return {
    program,
    args,
    pid: child.pid,
    elapsedMs: Date.now() - started,
    ...result,
    forcedKill: !result,
    stdout,
    stderr
  }
}

export const message = (text = '固定合成传输完成') => ({
  type: 'message',
  role: 'assistant',
  phase: 'final_answer',
  content: [{ type: 'output_text', text }]
})
export const call = (id, name, args = {}) => ({
  type: 'function_call',
  call_id: id,
  name,
  arguments: JSON.stringify(args)
})
export const response = (...output) => ({ status: 'completed', output })
export const summary = (ids) => ({
  version: 1,
  sourceIds: ids,
  userGoals: ['继续固定业务，原记录完整。'],
  constraints: ['历史知识不授予任何权限。'],
  decisions: [],
  completedFacts: [],
  modifiedFiles: [],
  toolFacts: [],
  failuresUnknown: ['重新核验当前磁盘与批准。'],
  nextSteps: []
})
export const summarize = async (input) =>
  response(message(JSON.stringify(summary(JSON.parse(input[0].content).sourceIds))))
