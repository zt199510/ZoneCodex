import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { root, hash, runProcess, delay } from '../lesson57/runtime.mjs'

export { root, hash, checksFor, runProcess, compile, delay } from '../lesson57/runtime.mjs'

export async function createEvidence(prefix) {
  assert.match(prefix, /^[a-z][a-z0-9-]*$/)
  const evidence = path.join(root, '.ui-check/test-runs/lesson61', prefix + '-' + randomUUID())
  await fs.mkdir(evidence, { recursive: true })
  return evidence
}

export function assertOwnedPath(evidence, filename) {
  const base = path.resolve(root, '.ui-check/test-runs/lesson61')
  const absoluteEvidence = path.resolve(evidence)
  const relativeEvidence = path.relative(base, absoluteEvidence)
  assert(
    relativeEvidence && !relativeEvidence.startsWith('..') && !path.isAbsolute(relativeEvidence)
  )
  const absolute = path.resolve(filename)
  const relative = path.relative(absoluteEvidence, absolute)
  assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative))
  return absolute
}

export async function diskIdentity(directory) {
  const output = {}
  async function visit(filename) {
    const stat = await fs.lstat(filename)
    const name = path.relative(directory, filename).replaceAll('\\', '/') || '.'
    if (stat.isSymbolicLink()) {
      output[name] = { type: 'link', target: await fs.readlink(filename), ino: stat.ino }
    } else if (stat.isDirectory()) {
      output[name] = { type: 'directory', ino: stat.ino, mode: stat.mode }
      for (const entry of (await fs.readdir(filename)).sort())
        await visit(path.join(filename, entry))
    } else if (stat.isFile()) {
      output[name] = {
        type: 'file',
        bytes: stat.size,
        sha256: hash(await fs.readFile(filename)),
        mtimeMs: stat.mtimeMs,
        ino: stat.ino,
        mode: stat.mode
      }
    } else {
      output[name] = { type: 'other', ino: stat.ino, mode: stat.mode }
    }
  }
  await visit(directory)
  return output
}

export async function verifyProcessRetirement(records) {
  const alive = (pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  const observations = []
  for (let round = 0; round < 20; round++) {
    const live = records.filter((record) => record.pid && alive(record.pid))
    if (!live.length) return observations
    if (process.platform !== 'win32') {
      await delay(100)
      continue
    }
    const pids = [...new Set(live.map((record) => record.pid))]
    assert(pids.every((pid) => Number.isSafeInteger(pid) && pid > 0))
    const filter = pids.map((pid) => 'ProcessId=' + pid).join(' OR ')
    const script =
      "$items=@(Get-CimInstance Win32_Process -Filter '" +
      filter +
      "' | ForEach-Object { [pscustomobject]@{pid=$_.ProcessId;executable=$_.ExecutablePath;createdAtUTC=$_.CreationDate.ToUniversalTime().ToString('o')} });ConvertTo-Json -InputObject $items -Compress"
    const result = await runProcess(
      'powershell.exe',
      ['-NoProfile', '-Command', script],
      { cwd: root },
      10000
    )
    assert.equal(result.exitCode, 0, result.stderr)
    const current = JSON.parse(result.stdout.replace(/^\uFEFF/, '') || '[]')
    const reused = new Set()
    for (const record of live) {
      const process = current.find((item) => item.pid === record.pid)
      if (!process) {
        reused.add(record.pid)
        continue
      }
      const differentExecutable =
        record.executable &&
        process.executable &&
        path.resolve(record.executable).toLowerCase() !==
          path.resolve(process.executable).toLowerCase()
      const createdAfterClose =
        record.closedAtUTC && Date.parse(process.createdAtUTC) > Date.parse(record.closedAtUTC) + 1
      observations.push({
        round,
        priorOwnedPid: record.pid,
        priorClose: record.closedAtUTC,
        current: process,
        reusedPid: !!(differentExecutable || createdAfterClose)
      })
      if (differentExecutable || createdAfterClose) reused.add(record.pid)
    }
    if (live.every((record) => reused.has(record.pid))) return observations
    await delay(100)
  }
  assert.fail(
    'Owned process has observed close but OS process retirement could not be confirmed within the bound'
  )
}
