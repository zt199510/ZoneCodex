import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const evidenceRoot = path.join(root, '.ui-check/test-runs/lesson55')

export async function createEvidence(prefix) {
  assert.match(prefix, /^[a-z][a-z0-9-]*$/)
  assert.equal(
    JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).name,
    'zonecodex'
  )
  await fs.mkdir(evidenceRoot, { recursive: true })
  const directory = path.join(evidenceRoot, prefix + '-' + randomUUID())
  await fs.mkdir(directory)
  return directory
}
