/* eslint-disable @typescript-eslint/explicit-function-return-type -- This dependency preparer runs directly as Node JavaScript. */
import { createHash, randomUUID } from 'node:crypto'
import { lstat, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { originalHashes, patchStock } from './node-pty-cleanup/patch-stock.mjs'

const scriptRoot = dirname(fileURLToPath(import.meta.url))
const resourceRoot = join(scriptRoot, 'node-pty-cleanup')
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')

async function ordinaryBytes(path, allowMissing = false) {
  let info
  try {
    info = await lstat(path)
  } catch (error) {
    if (allowMissing && error.code === 'ENOENT') return null
    throw error
  }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 1024 * 1024) {
    throw new Error('Refusing a linked or invalid node-pty patch file: ' + path)
  }
  return readFile(path)
}

/** Preflight every byte before writing; known original/previous/patched mixed states are recoverable. */
export async function prepareNodePtyCleanup({
  projectRoot = resolve(scriptRoot, '..'),
  checkOnly = false
} = {}) {
  const manifest = JSON.parse(await ordinaryBytes(join(resourceRoot, 'manifest.json')))
  if (manifest.package !== 'node-pty' || manifest.version !== '1.1.0') {
    throw new Error('Invalid node-pty cleanup manifest identity')
  }
  const directory = join(projectRoot, 'node_modules', 'node-pty')
  const installed = JSON.parse(await ordinaryBytes(join(directory, 'package.json')))
  if (installed.version !== manifest.version || installed.name !== manifest.package) {
    throw new Error('Unsupported node-pty identity; required node-pty@1.1.0')
  }
  const lib = join(directory, 'lib')
  const libInfo = await lstat(lib)
  if (!libInfo.isDirectory() || libInfo.isSymbolicLink()) {
    throw new Error('Refusing a linked node-pty lib directory')
  }
  const plan = []
  for (const [name, entry] of Object.entries(manifest.files)) {
    if (
      !/^[A-Za-z_]+\.js$/.test(name) ||
      !/^[a-f0-9]{64}$/.test(entry.patchedSha256) ||
      (entry.originalSha256 !== null && !/^[a-f0-9]{64}$/.test(entry.originalSha256)) ||
      (entry.previousPatchedSha256 !== undefined &&
        (!entry.resource ||
          !/^[a-f0-9]{64}$/.test(entry.previousPatchedSha256) ||
          entry.previousPatchedSha256 === entry.originalSha256 ||
          entry.previousPatchedSha256 === entry.patchedSha256))
    ) {
      throw new Error('Invalid node-pty cleanup file manifest')
    }
    const path = join(lib, name)
    const before = await ordinaryBytes(path, entry.originalSha256 === null)
    const beforeHash = before === null ? null : hash(before)
    if (
      beforeHash !== entry.originalSha256 &&
      beforeHash !== entry.previousPatchedSha256 &&
      beforeHash !== entry.patchedSha256
    ) {
      throw new Error('Unknown node-pty bytes; refusing to patch ' + name + ' (' + beforeHash + ')')
    }
    let after
    if (entry.resource) {
      if (!/^[A-Za-z_]+\.cjs$/.test(entry.resource)) throw new Error('Invalid patch resource name')
      after = await ordinaryBytes(join(resourceRoot, entry.resource))
    } else {
      if (entry.originalSha256 !== originalHashes[name])
        throw new Error('Stock hash manifest mismatch')
      after =
        beforeHash === entry.patchedSha256
          ? before
          : Buffer.from(patchStock(name, before.toString('utf8')))
    }
    if (hash(after) !== entry.patchedSha256) {
      throw new Error('Patched resource hash mismatch; refusing to patch ' + name)
    }
    plan.push({
      name,
      path,
      after,
      state:
        beforeHash === entry.patchedSha256
          ? 'patched'
          : beforeHash === entry.previousPatchedSha256
            ? 'previous'
            : 'original'
    })
  }
  if (plan.length !== 5 || !plan.some((entry) => entry.name === 'zonecodexWindowsCleanup.js')) {
    throw new Error('Incomplete node-pty cleanup manifest')
  }
  for (const entry of plan) {
    if (entry.state === 'patched' || checkOnly) continue
    const temporary = entry.path + '.zonecodex-' + randomUUID() + '.tmp'
    try {
      await writeFile(temporary, entry.after, { flag: 'wx' })
      await rename(temporary, entry.path)
    } finally {
      await unlink(temporary).catch((error) => {
        if (error.code !== 'ENOENT') throw error
      })
    }
  }
  return {
    package: manifest.package,
    version: manifest.version,
    mode: checkOnly ? 'check' : 'prepare',
    files: Object.fromEntries(plan.map(({ name, state }) => [name, state])),
    changed: checkOnly ? 0 : plan.filter((entry) => entry.state !== 'patched').length
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const unknown = process.argv.slice(2).filter((arg) => arg !== '--check')
  if (unknown.length) throw new Error('Only --check is supported')
  try {
    console.log(
      JSON.stringify(await prepareNodePtyCleanup({ checkOnly: process.argv.includes('--check') }))
    )
  } catch (error) {
    console.error('[ZoneCodex node-pty prepare] ' + String(error.message || error).slice(0, 500))
    process.exitCode = 1
  }
}
