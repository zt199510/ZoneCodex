import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { hash } from '../lesson55/real/task-contracts.mjs'

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export async function createEvidence(prefix) {
  assert.match(prefix, /^[a-z][a-z0-9-]*$/)
  const directory = path.join(root, '.ui-check/test-runs/lesson56', prefix + '-' + randomUUID())
  await fs.mkdir(directory, { recursive: true })
  return directory
}

export async function runProcess(program, args, options = {}, observationMs = 600000) {
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

export async function sourceIdentity(artifacts = []) {
  const names = [
    'package.json',
    'package-lock.json',
    'electron.vite.config.ts',
    'electron-builder.yml',
    'tsconfig.cli.json'
  ]
  for (const folder of ['src', 'scripts', 'tests/lesson56', 'tests/lesson55/real']) {
    async function visit(relative) {
      for (const item of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
        const next = path.join(relative, item.name)
        if (item.isDirectory()) await visit(next)
        else if (item.isFile()) names.push(next)
      }
    }
    await visit(folder)
  }
  names.push(...artifacts)
  return Object.fromEntries(
    await Promise.all(
      names
        .sort()
        .map(async (name) => [
          name.replaceAll('\\', '/'),
          hash(await fs.readFile(path.join(root, name)))
        ])
    )
  )
}

export async function loadRealConfiguration() {
  try {
    process.loadEnvFile(path.join(root, '.env.local'))
  } catch {
    /* Inherited explicit configuration is valid. */
  }
  assert.ok(
    process.env.MODEL_ENDPOINT && process.env.MODEL_API_KEY,
    'Actual model configuration is required'
  )
  assert.ok(
    !process.env.MODEL_NAME || process.env.MODEL_NAME === 'gpt-6.1-sol',
    'Actual default gpt-6.1-sol is required'
  )
}
