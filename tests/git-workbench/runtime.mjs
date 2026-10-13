import assert from 'node:assert/strict'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
export { root, hash, compile, checksFor, runProcess, delay } from '../lesson57/runtime.mjs'
import { root } from '../lesson57/runtime.mjs'

export async function createEvidence(name) {
  assert.match(name, /^[a-z][a-z0-9-]*$/)
  const evidence = path.join(root, '.ui-check/test-runs/git-workbench', name + '-' + randomUUID())
  await fs.mkdir(evidence, { recursive: true })
  return evidence
}
export function assertOwnedPath(evidence, filename) {
  const relative = path.relative(
    path.join(root, '.ui-check/test-runs/git-workbench'),
    path.resolve(evidence)
  )
  assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative))
  const result = path.resolve(filename)
  const nested = path.relative(evidence, result)
  assert(nested && !nested.startsWith('..') && !path.isAbsolute(nested))
  return result
}
