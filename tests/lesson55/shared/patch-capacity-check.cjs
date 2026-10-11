const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { createHash, randomUUID } = require('node:crypto')
const { tmpdir } = require('node:os')
const { load } = require('./harness.cjs')

const checks = []
const evidence = path.join(__dirname, 'disk-' + randomUUID())
const freshSignal = () => new AbortController().signal
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const patchText = (...blocks) =>
  ['*** Begin Patch', '*** Update File: sample.ts', ...blocks.flat(), '*** End Patch'].join('\n')
const replacement = (before = 'OLD first', after = 'NEW first') =>
  patchText(['@@', '-' + before, '+' + after])
const body = () =>
  Array.from({ length: 650 }, (_, i) =>
    i === 83
      ? 'OLD first'
      : i === 487
        ? 'OLD second'
        : `// line ${String(i + 1).padStart(3, '0')} 保持正文 ${'unchanged padding '.repeat(4)}`
  ).join('\n')
const encode = (text, newline = '\n', bom = false, tails = 0) =>
  Buffer.from((bom ? '\uFEFF' : '') + text.replace(/\n/g, newline) + newline.repeat(tails), 'utf8')
const boundedBytes = (bytes, newline = '\n', bom = false, tails = 0) => {
  const text = body() + '\n'
  const remainder = bytes - encode(text, newline, bom, tails).length
  assert.ok(remainder >= 0)
  return encode(text + 'x'.repeat(remainder), newline, bom, tails)
}
let snapshotModule, preparationModule, commitModule, patchModule, capacityModule

async function test(name, fn) {
  const started = Date.now()
  try {
    const details = await fn()
    checks.push({
      name,
      passed: true,
      durationMs: Date.now() - started,
      ...(details ? { details } : {})
    })
  } catch (error) {
    checks.push({
      name,
      passed: false,
      durationMs: Date.now() - started,
      error: error.stack ?? String(error)
    })
    console.error(name, error)
  }
}

async function fixture(name, bytes, capacity = capacityModule.WORKSPACE_PATCH_CAPACITY) {
  const directory = path.join(evidence, name)
  await fs.mkdir(directory, { recursive: true })
  const filename = path.join(directory, 'sample.ts')
  await fs.writeFile(filename, bytes, { flag: 'wx' })
  const snapshot = await snapshotModule.createProjectSnapshot(
    directory,
    [filename],
    freshSignal(),
    capacity
  )
  const original = snapshot.files.get('sample.ts').join('\n')
  return { directory, filename, bytes, snapshot, original }
}

async function prepare(item, text = replacement()) {
  const patch = patchModule.applyWorkspacePatch(item.original, text, 'sample.ts')
  assert.equal(patch.status, 'candidate', JSON.stringify(patch))
  return {
    patch,
    prepared: await preparationModule.prepareChange(
      item.snapshot,
      'sample.ts',
      patch.text,
      freshSignal()
    )
  }
}

async function commit(
  item,
  prepared,
  signal = freshSignal(),
  canReplace = () => true,
  onPhase = () => {},
  io
) {
  return commitModule.commitChange(item.snapshot, prepared, signal, canReplace, onPhase, io)
}

async function main() {
  await fs.mkdir(evidence)
  ;[snapshotModule, preparationModule, commitModule, patchModule, capacityModule] =
    await Promise.all([
      load('src/main/tools/project-snapshot.ts'),
      load('src/main/tools/change-preparation.ts'),
      load('src/main/tools/change-commit.ts'),
      load('src/main/tools/workspace-patch.ts'),
      load('src/main/tools/change-capacity.ts')
    ])

  for (const newline of ['\n', '\r\n'])
    for (const bom of [false, true])
      for (const tails of [0, 1, 3]) {
        const format = (newline === '\n' ? 'lf' : 'crlf') + '-' + bom + '-' + tails
        await test('over-32-KiB real commit and recovery preserve ' + format, async () => {
          const bytes = encode(body(), newline, bom, tails)
          assert.ok(bytes.length > 32768 && bytes.length < 131072)
          const item = await fixture('format-' + format, bytes)
          const blocks = patchText(
            ['@@', '-OLD first', '+NEW first'],
            ['@@', '-OLD second', '+NEW second']
          )
          const { patch, prepared } = await prepare(item, blocks)
          assert.equal(prepared.status, 'prepared')
          assert.deepEqual(patch.locatedHunks, [
            { startLine: 84, before: ['OLD first'], atEnd: false },
            { startLine: 488, before: ['OLD second'], atEnd: false }
          ])
          const phases = []
          const outcome = await commit(
            item,
            prepared,
            freshSignal(),
            () => true,
            (phase) => phases.push(phase)
          )
          assert.equal(outcome.status, 'applied', JSON.stringify(outcome))
          const expected = encode(
            body().replace('OLD first', 'NEW first').replace('OLD second', 'NEW second'),
            newline,
            bom,
            tails
          )
          assert.deepEqual(await fs.readFile(item.filename), expected)
          assert.deepEqual(await fs.readFile(outcome.recovery.path), bytes)
          assert.equal(await commitModule.verifyRecovery(outcome.recovery), true)
          assert.equal(outcome.recovery.capacity, capacityModule.WORKSPACE_PATCH_CAPACITY)
          assert.deepEqual(phases, ['validating', 'staging', 'replacing', 'verifying', 'finished'])
          assert.equal(outcome.cleanupWarning, false)
          return {
            bytes: bytes.length,
            lines: 650 + tails,
            oldSha256: hash(bytes),
            newSha256: hash(expected),
            recoveryVerified: true
          }
        })
      }

  for (const format of [
    { newline: '\n', bom: false, tails: 0 },
    { newline: '\r\n', bom: true, tails: 3 }
  ]) {
    const name = format.newline === '\n' ? 'ascii-lf' : 'chinese-bom-crlf'
    await test(
      'exact 128 KiB source and encoded candidate commit and recovery ' + name,
      async () => {
        const bytes = boundedBytes(131072, format.newline, format.bom, format.tails)
        assert.equal(bytes.length, 131072)
        const item = await fixture('exact-' + name, bytes)
        const { prepared } = await prepare(item)
        assert.equal(prepared.status, 'prepared')
        assert.equal(prepared.candidateBytes.length, 131072)
        const outcome = await commit(item, prepared)
        assert.equal(outcome.status, 'applied', JSON.stringify(outcome))
        assert.deepEqual(await fs.readFile(item.filename), Buffer.from(prepared.candidateBytes))
        assert.equal(await commitModule.verifyRecovery(outcome.recovery), true)
        return { originalBytes: bytes.length, candidateBytes: prepared.candidateBytes.length }
      }
    )
  }

  await test('source 128 KiB plus 1 byte rejects before snapshot or write', async () => {
    const directory = path.join(evidence, 'oversize-source')
    await fs.mkdir(directory)
    const filename = path.join(directory, 'sample.ts')
    const bytes = boundedBytes(131073)
    await fs.writeFile(filename, bytes, { flag: 'wx' })
    await assert.rejects(
      snapshotModule.createProjectSnapshot(
        directory,
        [filename],
        freshSignal(),
        capacityModule.WORKSPACE_PATCH_CAPACITY
      ),
      /128 KiB/
    )
    assert.deepEqual(await fs.readFile(filename), bytes)
    assert.deepEqual(await fs.readdir(directory), ['sample.ts'])
  })

  for (const format of [
    { newline: '\n', bom: false, tails: 0 },
    { newline: '\r\n', bom: true, tails: 3 }
  ]) {
    const name = format.newline === '\n' ? 'lf' : 'bom-crlf'
    await test('encoded candidate 128 KiB plus 1 refuses before staging ' + name, async () => {
      const item = await fixture(
        'oversize-candidate-' + name,
        boundedBytes(131072, format.newline, format.bom, format.tails)
      )
      // Chinese increases bytes while decreasing UTF-16 length, so the pure character guard passes.
      const { patch, prepared } = await prepare(item, replacement('OLD first', '中A first'))
      assert.ok(patch.text.length <= 131072)
      assert.equal(prepared.status, 'error')
      assert.match(prepared.error, /候选编码超过 128 KiB/)
      assert.deepEqual(await fs.readFile(item.filename), item.bytes)
      assert.deepEqual(await fs.readdir(item.directory), ['sample.ts'])
    })
  }

  await test('Chinese candidate reaches exact encoded 128 KiB independently of character limit', async () => {
    const item = await fixture('exact-chinese-candidate', boundedBytes(131071, '\r\n', true, 1))
    const { prepared } = await prepare(item, replacement('OLD first', '中A first'))
    assert.equal(prepared.status, 'prepared')
    assert.equal(prepared.candidateBytes.length, 131072)
    const outcome = await commit(item, prepared)
    assert.equal(outcome.status, 'applied')
    assert.equal(await commitModule.verifyRecovery(outcome.recovery), true)
  })

  await test('default snapshot and attachment boundary remains 32 KiB', async () => {
    const item = await fixture('default-size-boundary', encode(body()))
    await assert.rejects(
      snapshotModule.createProjectSnapshot(item.directory, [item.filename], freshSignal()),
      /32 KiB/
    )
    // Attachment checks the complete path; .ui-check is deliberately a blocked hidden component.
    const directory = await fs.mkdtemp(path.join(tmpdir(), 'zonecodex-lesson52-capacity-'))
    const filename = path.join(directory, 'sample.ts')
    try {
      await fs.writeFile(filename, item.bytes, { flag: 'wx' })
      await assert.rejects(
        snapshotModule.createAttachmentSnapshot([filename], freshSignal()),
        /32 KiB/
      )
      assert.deepEqual(await fs.readFile(filename), item.bytes)
    } finally {
      await fs.unlink(filename)
      await fs.rmdir(directory)
    }
    assert.deepEqual(await fs.readFile(item.filename), item.bytes)
  })

  await test('default preparation still refuses over 80 lines and 2000 characters', async () => {
    for (const [name, text, raw] of [
      ['lines', 'x\n'.repeat(80), 'y'],
      ['characters', 'x'.repeat(2001), 'y'],
      ['candidate', 'x', 'y'.repeat(2001)]
    ]) {
      const item = await fixture(
        'default-' + name,
        Buffer.from(text),
        capacityModule.SMALL_CHANGE_CAPACITY
      )
      const prepared = await preparationModule.prepareChange(
        item.snapshot,
        'sample.ts',
        raw,
        freshSignal()
      )
      assert.equal(prepared.status, 'error')
      assert.match(prepared.error, /80 行或 2000 字符/)
      assert.deepEqual(await fs.readFile(item.filename), item.bytes)
    }
  })

  await test('patch canonical LF exact character limit allows many short lines without spread overflow', async () => {
    const original = '\n'.repeat(131070) + 'a\n'
    assert.equal(original.length, 131072)
    const result = patchModule.applyWorkspacePatch(original, replacement('a', 'b'), 'sample.ts')
    assert.equal(result.status, 'candidate', JSON.stringify(result))
    assert.equal(result.text, '\n'.repeat(131070) + 'b\n')
    assert.equal(result.locatedHunks[0].startLine, 131071)
  })
  await test('canonical LF source 131072 characters plus 1 refuses', async () => {
    assert.equal(
      patchModule.applyWorkspacePatch('x'.repeat(131073), replacement('x', 'y'), 'sample.ts')
        .status,
      'error'
    )
  })
  await test('canonical LF candidate 131072 characters plus 1 refuses', async () => {
    const original = 'a\n' + 'x'.repeat(131070)
    const result = patchModule.applyWorkspacePatch(original, replacement('a', 'ab'), 'sample.ts')
    assert.equal(result.status, 'error')
    assert.match(result.error, /候选内容超过 131072/)
  })

  await test('same candidate remains byte no_change with large format-preserving file', async () => {
    const item = await fixture('large-no-change', encode(body(), '\r\n', true, 3))
    const { prepared } = await prepare(item, replacement('OLD first', 'OLD first'))
    assert.equal(prepared.status, 'no_change')
    assert.deepEqual(await fs.readdir(item.directory), ['sample.ts'])
  })
  await test('external edit before preparation preserves newer bytes', async () => {
    const item = await fixture('external-before-prepare', encode(body()))
    const newer = Buffer.from('external replacement\n')
    await fs.writeFile(item.filename, newer)
    const { prepared } = await prepare(item)
    assert.equal(prepared.status, 'conflict')
    assert.deepEqual(await fs.readFile(item.filename), newer)
  })
  await test('external edit during staging stops replacement and retains verified large recovery', async () => {
    const item = await fixture('external-during-stage', encode(body(), '\r\n', true, 3))
    const { prepared } = await prepare(item)
    assert.equal(prepared.status, 'prepared')
    const newer = Buffer.from('external latest\n')
    let staged = false
    const io = {
      ...fs,
      async open(filename, ...args) {
        if (filename.endsWith('.tmp') && !staged) {
          staged = true
          await fs.writeFile(item.filename, newer)
        }
        return fs.open(filename, ...args)
      }
    }
    const outcome = await commit(
      item,
      prepared,
      freshSignal(),
      () => true,
      () => {},
      io
    )
    assert.equal(outcome.status, 'conflict')
    assert.deepEqual(await fs.readFile(item.filename), newer)
    assert.equal(await commitModule.verifyRecovery(outcome.recovery), true)
    assert.equal(
      (await fs.readdir(item.directory)).filter((name) => name.endsWith('.tmp')).length,
      0
    )
  })
  await test('cancel after staging retains original and verifies large backup', async () => {
    const item = await fixture('cancel-before-replace', encode(body()))
    const { prepared } = await prepare(item)
    const controller = new AbortController()
    const io = {
      ...fs,
      async open(filename, ...args) {
        if (filename.endsWith('.tmp')) controller.abort(new Error('isolated cancellation'))
        return fs.open(filename, ...args)
      }
    }
    const outcome = await commit(
      item,
      prepared,
      controller.signal,
      () => true,
      () => {},
      io
    )
    assert.equal(outcome.status, 'cancelled')
    assert.deepEqual(await fs.readFile(item.filename), item.bytes)
    assert.equal(await commitModule.verifyRecovery(outcome.recovery), true)
  })
  await test('expired replacement authorization preserves original and backup', async () => {
    const item = await fixture('expired-replacement-access', encode(body()))
    const { prepared } = await prepare(item)
    const outcome = await commit(item, prepared, freshSignal(), () => false)
    assert.equal(outcome.status, 'error')
    assert.deepEqual(await fs.readFile(item.filename), item.bytes)
    assert.equal(await commitModule.verifyRecovery(outcome.recovery), true)
    assert.equal(
      (await fs.readdir(item.directory)).filter((name) => name.endsWith('.tmp')).length,
      0
    )
  })
  await test('post-rename readback mismatch is uncertain without restoring target', async () => {
    const item = await fixture('uncertain-after-rename', encode(body(), '\r\n', true, 3))
    const { prepared } = await prepare(item)
    const newer = Buffer.from('new external content after rename\n')
    const io = {
      ...fs,
      async rename(from, to) {
        await fs.rename(from, to)
        await fs.writeFile(to, newer)
      }
    }
    const outcome = await commit(
      item,
      prepared,
      freshSignal(),
      () => true,
      () => {},
      io
    )
    assert.equal(outcome.status, 'uncertain')
    assert.equal(outcome.cleanupWarning, true)
    assert.deepEqual(await fs.readFile(item.filename), newer)
    assert.equal(await commitModule.verifyRecovery(outcome.recovery), true)
  })
  await test('large recovery tampering refuses byte verification', async () => {
    const item = await fixture('recovery-tamper', encode(body()))
    const { prepared } = await prepare(item)
    const outcome = await commit(item, prepared)
    assert.equal(outcome.status, 'applied')
    await fs.writeFile(outcome.recovery.path, 'tampered')
    assert.equal(await commitModule.verifyRecovery(outcome.recovery), false)
  })

  for (const [name, original, blocks, error] of [
    ['duplicate', 'same\nx\nsame', ['@@', '-same', '+new'], /不唯一/],
    ['missing', 'x\ny', ['@@', '-absent', '+new'], /未匹配/],
    ['overlap', 'a\nb\nc', ['@@', ' a', '-b', '+B', '@@', '-b', '+B', ' c'], /重叠/],
    ['insertion-no-anchor', 'a', ['@@', '+b'], /包含可匹配/],
    ['tail-format', 'a\n\n', ['@@', ' a', '+'], /尾换行/],
    ['empty-original', '', ['@@', '-', '+x'], /未匹配/]
  ])
    await test('whole-patch semantic rejection ' + name, async () => {
      const result = patchModule.applyWorkspacePatch(original, patchText(blocks), 'sample.ts')
      assert.equal(result.status, 'error')
      assert.match(result.error, error)
    })
  await test('EOF uses actual body end independent of format-only trailing empty lines', async () => {
    const result = patchModule.applyWorkspacePatch(
      'a\nb\n\n\n',
      patchText(['@@', '-b', '+B', '*** End of File']),
      'sample.ts'
    )
    assert.equal(result.status, 'candidate')
    assert.equal(result.text, 'a\nB\n\n\n')
    assert.deepEqual(result.locatedHunks, [{ startLine: 2, before: ['b'], atEnd: true }])
  })
  await test('delete all body retains format and distinguishes empty candidate from empty original', async () => {
    const result = patchModule.applyWorkspacePatch('a\n\n', patchText(['@@', '-a']), 'sample.ts')
    assert.equal(result.status, 'candidate')
    assert.equal(result.text, '\n\n')
  })
  await test('all-context and deleted lines are available from same located result', async () => {
    const result = patchModule.applyWorkspacePatch(
      'a\nb\nc\nd',
      patchText(['@@', ' b', '-c', '+C', ' d']),
      'sample.ts'
    )
    assert.equal(result.status, 'candidate')
    assert.deepEqual(result.locatedHunks, [{ startLine: 2, before: ['b', 'c', 'd'], atEnd: false }])
  })
  for (const [name, text] of [
    ['CR', '\r'],
    ['NUL', '\0'],
    ['DEL', '\x7f'],
    ['unpaired-unicode', '\ud800']
  ])
    await test('patch refuses invalid text ' + name, async () => {
      assert.equal(
        patchModule.applyWorkspacePatch('a', replacement('a', text), 'sample.ts').status,
        'error'
      )
    })
  for (const [name, text] of [
    ['mixed', 'a\r\nb\nc'],
    ['isolated-cr', 'a\rb']
  ])
    await test('prepare refuses unsupported newline ' + name, async () => {
      const item = await fixture('unsupported-' + name, Buffer.from(text))
      const result = await preparationModule.prepareChange(
        item.snapshot,
        'sample.ts',
        'new',
        freshSignal()
      )
      assert.equal(result.status, 'unsupported')
      assert.deepEqual(await fs.readFile(item.filename), item.bytes)
    })

  const result = {
    suite: 'lesson55 current patch capacity and real disk commit',
    generatedAt: new Date().toISOString(),
    passed: checks.every((check) => check.passed),
    total: checks.length,
    failed: checks.filter((check) => !check.passed).length,
    checks,
    boundary:
      'This suite uses real filesystem reads, writes, backup, staging, rename and recovery. Specific conflict/cancel/uncertain cases inject the existing internal CommitIO adapter; it does not call a model, UI or network and does not replace their acceptance.'
  }
  await fs.writeFile(path.join(evidence, 'results.json'), JSON.stringify(result, null, 2) + '\n')
  await fs.writeFile(
    path.join(__dirname, 'patch-capacity-results-final.json'),
    JSON.stringify({ ...result, evidence }, null, 2) + '\n'
  )
  console.log(
    JSON.stringify({ passed: result.passed, total: result.total, failed: result.failed, evidence })
  )
  if (!result.passed) process.exitCode = 1
}

main().catch(async (error) => {
  console.error(error)
  await fs.writeFile(path.join(evidence, 'fatal.txt'), error.stack ?? String(error))
  process.exitCode = 1
})
