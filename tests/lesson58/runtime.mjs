import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { root } from '../lesson57/runtime.mjs'

export { root, hash, checksFor, runProcess } from '../lesson57/runtime.mjs'

export async function createEvidence(prefix) {
  assert.match(prefix, /^[a-z][a-z0-9-]*$/)
  const evidence = path.join(root, '.ui-check/test-runs/lesson58', prefix + '-' + randomUUID())
  await fs.mkdir(evidence, { recursive: true })
  return evidence
}
