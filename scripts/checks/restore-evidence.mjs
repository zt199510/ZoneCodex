import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = await fs.realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'))
const slash = (value) => value.replaceAll('\\', '/')
const argv = process.argv.slice(2)
assert.ok(
  argv.every((arg) => arg === '--list' || arg.startsWith('--target=')),
  'Use --list or --target=<historical evidence directory>'
)
assert.ok(argv.length === 1, 'Provide exactly one option')
const run = (
  await fs.readFile(path.join(root, '.ui-check/test-engineering-current.txt'), 'utf8')
).trim()
assert.match(run, /^\.ui-check\/test-engineering\/cleanup-[0-9a-f-]+$/)
const plan = JSON.parse(await fs.readFile(path.join(root, run, 'plan.json'), 'utf8'))
assert.equal(plan.root, root)
const historicalPath = (relative) => {
  assert.match(relative, /^\.ui-check\/lesson(?:4[6-9]|5[0-2])\//)
  assert.ok(
    !relative.includes('\\') &&
      !relative.split('/').some((part) => part === '..' || part === '.' || part === '')
  )
}
const checkPath = async (relative) => {
  const full = path.resolve(root, relative)
  assert.ok(full.startsWith(root + path.sep), 'Path leaves project')
  let existing = full
  while (true) {
    try {
      const info = await fs.lstat(existing)
      assert.ok(!info.isSymbolicLink(), 'Refuse links')
      assert.equal(await fs.realpath(existing), existing, 'Refuse redirected paths')
      break
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      existing = path.dirname(existing)
      assert.ok(existing === root || existing.startsWith(root + path.sep))
    }
  }
  return full
}
const hashFile = async (full) => {
  const digest = createHash('sha256')
  for await (const bytes of createReadStream(full)) digest.update(bytes)
  return digest.digest('hex')
}
if (argv[0] === '--list') {
  console.log(
    JSON.stringify(
      plan.duplicates.map((item) => ({
        directory: item.directory,
        kind: item.kind,
        files: item.files.length,
        keeper: item.keeper
      })),
      null,
      2
    )
  )
} else {
  const target = slash(argv[0].slice(9)).replace(/\/$/, '')
  assert.match(target, /^\.ui-check\/lesson(?:4[6-9]|5[0-2])\/[^/]+/)
  assert.ok(!target.split('/').some((part) => part === '..' || part === '.'))
  const selected = plan.duplicates.filter(
    (item) => item.directory === target || item.directory.startsWith(target + '/')
  )
  assert.ok(selected.length > 0, 'Target is not in the duplicate recovery index')
  const jobs = []
  for (const item of selected) {
    historicalPath(item.directory)
    historicalPath(item.keeper)
    assert.ok(['dependencies', 'electron-runtime-file', 'command-runtime-file'].includes(item.kind))
    for (const directory of item.directories)
      assert.ok(
        directory &&
          !path.isAbsolute(directory) &&
          !directory.includes('\\') &&
          !directory.split('/').some((part) => part === '..' || part === '.' || part === '')
      )
    const keeper = plan.uniqueKeepers.find(
      (source) =>
        source.directory === item.keeper &&
        source.kind === item.kind &&
        source.identity === item.identity
    )
    assert.ok(keeper, 'Retained tree identity is missing')
    assert.deepEqual(item.files, keeper.files)
    assert.deepEqual(item.directories, keeper.directories)
    await checkPath(item.directory)
    for (const member of item.files) {
      assert.ok(
        !path.isAbsolute(member.relative) &&
          !member.relative.includes('\\') &&
          !member.relative.split('/').includes('..')
      )
      const source = await checkPath(item.keeper + '/' + member.relative)
      assert.equal((await fs.stat(source)).size, member.bytes)
      assert.equal(
        await hashFile(source),
        member.sha256,
        'Retained original changed: ' + member.relative
      )
      const destination = await checkPath(item.directory + '/' + member.relative)
      let exists = false
      try {
        assert.equal(
          await hashFile(destination),
          member.sha256,
          'Refuse to overwrite a changed historical file'
        )
        exists = true
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
      jobs.push({ source, destination, sha256: member.sha256, exists })
    }
  }
  // Complete the preflight for every selected file before restoring any bytes.
  for (const item of selected) {
    if (item.kind !== 'dependencies') continue
    for (const directory of ['', ...item.directories])
      await fs.mkdir(await checkPath(item.directory + (directory ? '/' + directory : '')), {
        recursive: true
      })
  }
  let restored = 0
  for (const job of jobs) {
    if (job.exists) continue
    await fs.mkdir(path.dirname(job.destination), { recursive: true })
    await fs.copyFile(job.source, job.destination, 1)
    assert.equal(await hashFile(job.destination), job.sha256)
    restored++
  }
  console.log(
    JSON.stringify({
      pass: true,
      target,
      trees: selected.length,
      restoredFiles: restored,
      alreadyPresent: jobs.length - restored,
      manifest: run + '/plan.json'
    })
  )
}
