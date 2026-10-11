const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { createHash, randomUUID } = require('node:crypto')
const { load } = require('./harness.cjs')

const checks = []
const counters = { processStarts: 0, commandClaims: 0 }
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const signal = () => new AbortController().signal
const isolation = {
  '../execution/command-runner': {
    startCommandProcess() {
      counters.processStarts++
      throw new Error('Unexpected command launch in isolated patch validation')
    }
  },
  '../execution/command-plan': {
    discardCommandExecution() {
      /* Deliberate no-op fixture callback. */
    },
    claimCommandExecution() {
      counters.commandClaims++
      throw new Error('Unexpected command claim')
    }
  }
}
const patch = (lines, target = 'note.txt') =>
  ['*** Begin Patch', '*** Update File: ' + target, ...lines, '*** End Patch'].join('\n')
const call = (name, value, callId) => ({
  type: 'function_call',
  name,
  arguments: typeof value === 'string' ? value : JSON.stringify(value),
  call_id: callId
})
const finalMessage = (text) => ({
  type: 'message',
  role: 'assistant',
  phase: 'final_answer',
  content: [{ type: 'output_text', text }]
})
const response = (...output) => ({ status: 'completed', output })
const encode = (body, newline = '\n', bom = false, tails = 1) =>
  Buffer.from((bom ? '\uFEFF' : '') + body.replace(/\n/g, newline) + newline.repeat(tails), 'utf8')
const bodyLines = () =>
  Array.from({ length: 360 }, (_, index) =>
    index === 29
      ? 'export const firstTarget = "OLD_FIRST";'
      : index === 309
        ? 'export const secondTarget = "OLD_SECOND";'
        : '// neutral line ' +
          String(index + 1).padStart(3, '0') +
          ' 中文正文保持 ' +
          'x'.repeat(94)
  )
const body = () => bodyLines().join('\n')
const twoPatch = () =>
  patch([
    '@@',
    '-export const firstTarget = "OLD_FIRST";',
    '+export const firstTarget = "NEW_FIRST";',
    '@@',
    '-export const secondTarget = "OLD_SECOND";',
    '+export const secondTarget = "NEW_SECOND";'
  ])
let modules
let runDirectory

async function check(name, action) {
  const started = Date.now()
  try {
    const details = await action()
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
    console.error(name + ': ' + (error.stack ?? String(error)))
  }
}

async function fileCase(name, bytes, approval) {
  const directory = path.join(runDirectory, name)
  assert.ok(directory.startsWith(runDirectory + path.sep))
  await fs.mkdir(directory, { recursive: true })
  const filename = path.join(directory, 'note.txt')
  await fs.writeFile(filename, bytes, { flag: 'wx' })
  const state = { current: true, approvals: 0, effects: 0, commands: 0, proposals: 0, requests: [] }
  const approve = async (request, abort) => {
    state.approvals++
    state.requests.push(structuredClone(request))
    return approval ? approval(request, abort, state) : true
  }
  const execution = {
    info: { cwd: directory, scopeId: 'a'.repeat(64), mode: 'full-access', revision: 1 },
    writableRoots: [directory]
  }
  const options = (mode) => ({
    mode,
    execution,
    assertCurrent: () => state.current,
    approve,
    authorizeCommand: async () => {
      state.commands++
      throw new Error('Unexpected command authorization')
    },
    onEffect: () => {
      state.effects++
    },
    appendTrace() {
      /* Deliberate no-op fixture callback. */
    },
    onProgress() {
      /* Deliberate no-op fixture callback. */
    },
    projectSnapshot: null,
    projectExecutor: undefined,
    executeCommandProposal: async () => {
      state.proposals++
      throw new Error('Unexpected command proposal')
    }
  })
  const execute = modules.agent.createAgentToolExecutor(options('execute'))
  const read = async (startLine = 30, endLine = startLine, executor = execute, abort = signal()) =>
    JSON.parse(
      await executor(
        'read_workspace_file',
        JSON.stringify({ path: 'note.txt', startLine, endLine }),
        abort
      )
    )
  const args = (
    text = patch([
      '@@',
      '-export const firstTarget = "OLD_FIRST";',
      '+export const firstTarget = "NEW_FIRST";'
    ]),
    expected = hash(bytes)
  ) => ({ path: 'note.txt', patch: text, expectedSha256: expected })
  const apply = async (value = args(), executor = execute, abort = signal()) =>
    JSON.parse(await executor('apply_workspace_patch', JSON.stringify(value), abort))
  return {
    directory,
    filename,
    original: bytes,
    state,
    execution,
    options,
    execute,
    read,
    args,
    apply,
    fresh: (mode) => modules.agent.createAgentToolExecutor(options(mode))
  }
}

async function unchanged(item, expected = item.original) {
  assert.deepEqual(await fs.readFile(item.filename), expected)
  assert.deepEqual((await fs.readdir(item.directory)).sort(), ['note.txt'])
  assert.equal(item.state.effects, 0)
  assert.deepEqual(
    [item.state.commands, item.state.proposals, counters.processStarts, counters.commandClaims],
    [0, 0, 0, 0]
  )
}

function deferredApproval() {
  let complete
  let announce
  const entered = new Promise((resolve) => {
    announce = resolve
  })
  const answer = new Promise((resolve) => {
    complete = resolve
  })
  return {
    entered,
    resolve: (value) => complete(value),
    approve: async () => {
      announce()
      return answer
    }
  }
}
async function waitForApproval(deferred, pending) {
  let timer
  try {
    await Promise.race([
      deferred.entered,
      pending.then((value) => {
        throw new Error('Operation completed before approval: ' + JSON.stringify(value))
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Approval was not requested')), 5000)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}
async function deniedUnread(item, text, expected = hash(item.original)) {
  const result = await item.apply(item.args(text, expected))
  assert.equal(result.status, 'error')
  assert.match(result.error, /读取|行|片段|证据/)
  assert.equal(item.state.approvals, 0)
  await unchanged(item)
  return result
}

async function main() {
  runDirectory = path.join(__dirname, 'run-' + randomUUID())
  await fs.mkdir(runDirectory, { recursive: true })
  const [agent, loop, instructions, history, shared, review, evidence, patcher] = await Promise.all(
    [
      load('src/main/agent/agent-tools.ts', isolation),
      load('src/main/agent/tool-loop.ts'),
      load('src/main/agent/agent-instructions.ts', { electron: {} }),
      load('src/shared/agent-history.ts'),
      load('src/shared/execution.ts'),
      load('src/main/execution/approval-reviewer.ts', {
        '../model/response-client': {
          createLiveResponse: () => async () => {
            throw new Error('Risk reviewer must not send an over-budget payload')
          }
        }
      }),
      load('src/main/agent/workspace-read-evidence.ts'),
      load('src/main/tools/workspace-patch.ts')
    ]
  )
  modules = { agent, loop, instructions, history, shared, review, evidence, patcher }

  for (const newline of ['\n', '\r\n'])
    for (const bom of [false, true])
      for (const tails of [0, 1, 3]) {
        const format =
          (newline === '\n' ? 'LF' : 'CRLF') + '-' + (bom ? 'BOM' : 'no-BOM') + '-tails-' + tails
        await check('two windows large real commit byte preservation ' + format, async () => {
          const before = encode(body(), newline, bom, tails)
          const expected = encode(
            body().replace('OLD_FIRST', 'NEW_FIRST').replace('OLD_SECOND', 'NEW_SECOND'),
            newline,
            bom,
            tails
          )
          assert.ok(before.length > 32768 && before.length < 131072)
          const item = await fileCase('large-' + format, before)
          const first = await item.read(29, 32)
          const second = await item.read(309, 312)
          assert.equal(first.sha256, hash(before))
          assert.equal(second.sha256, hash(before))
          assert.deepEqual(
            first.lines.map((line) => line.line),
            [29, 30, 31, 32]
          )
          assert.ok(first.lines.length + second.lines.length < first.totalLines)
          assert.deepEqual(first.format, {
            encoding: 'utf-8',
            hasUtf8Bom: bom,
            newline: newline === '\n' ? 'lf' : 'crlf',
            trailingNewlines: tails
          })
          const result = await item.apply(item.args(twoPatch()))
          assert.equal(result.status, 'applied')
          assert.equal(result.hunks, 2)
          assert.equal(result.sha256, hash(expected))
          assert.deepEqual(await fs.readFile(item.filename), expected)
          assert.deepEqual([item.state.approvals, item.state.effects], [1, 1])
          const reread = await item.read(30, 30)
          assert.equal(reread.sha256, hash(expected))
          assert.equal(reread.lines[0].text, 'export const firstTarget = "NEW_FIRST";')
          assert.deepEqual(reread.format, first.format)
          return {
            bytes: before.length,
            totalLines: first.totalLines,
            originalReadLines: first.lines.length + second.lines.length,
            beforeSHA256: hash(before),
            afterSHA256: hash(expected),
            approvals: item.state.approvals,
            effects: item.state.effects
          }
        })
      }

  await check('known raw hash with no real read cannot authorize patch', async () => {
    const item = await fileCase('unread', encode(body()))
    await deniedUnread(item, item.args().patch)
  })
  await check('one missing old line rejects all hunks without partial writes', async () => {
    const item = await fileCase('multi-unread', encode(body()))
    await item.read(30, 30)
    await deniedUnread(item, twoPatch())
  })
  await check('context lines and deletion lines all require visible line evidence', async () => {
    const item = await fileCase('context-unread', encode(body()))
    await item.read(30, 30)
    await deniedUnread(
      item,
      patch([
        '@@',
        ' ' + bodyLines()[28],
        '-export const firstTarget = "OLD_FIRST";',
        '+export const firstTarget = "NEW_FIRST";',
        ' ' + bodyLines()[30]
      ])
    )
  })
  await check(
    'reading every required old line enables context patch with new lines unread',
    async () => {
      const item = await fileCase('context-valid', encode(body()))
      await item.read(29, 31)
      const text = patch([
        '@@',
        ' ' + bodyLines()[28],
        '-export const firstTarget = "OLD_FIRST";',
        '+export const firstTarget = "NEW_FIRST";',
        '+export const insertedValue = 42;',
        ' ' + bodyLines()[30]
      ])
      const result = await item.apply(item.args(text))
      assert.equal(result.status, 'applied')
      assert.deepEqual(
        await fs.readFile(item.filename),
        encode(
          body().replace(
            'export const firstTarget = "OLD_FIRST";',
            'export const firstTarget = "NEW_FIRST";\nexport const insertedValue = 42;'
          )
        )
      )
    }
  )
  await check('pure insertion requires a read old anchor', async () => {
    const item = await fileCase('insert-anchor', encode(body()))
    const text = patch([
      '@@',
      ' export const firstTarget = "OLD_FIRST";',
      '+export const insertedValue = 42;'
    ])
    await deniedUnread(item, text)
    await item.read(30, 30)
    assert.equal((await item.apply(item.args(text))).status, 'applied')
  })
  await check('search summaries cannot become visible old-line evidence', async () => {
    const item = await fileCase('search-unread', encode(body()))
    const searched = JSON.parse(
      await item.execute(
        'search_workspace_text',
        JSON.stringify({ path: '', query: 'OLD_FIRST' }),
        signal()
      )
    )
    assert.equal(searched.ok, true)
    assert.ok(searched.matches.length > 0)
    await deniedUnread(item, item.args().patch)
  })
  await check('same hash adjacent windows merge each visible row', async () => {
    const item = await fileCase('adjacent-merge', Buffer.from('alpha\nbeta\ngamma\ndelta\n'))
    await item.read(2, 2)
    await item.read(3, 3)
    const result = await item.apply(item.args(patch(['@@', '-beta', '-gamma', '+BETA', '+GAMMA'])))
    assert.equal(result.status, 'applied')
    assert.deepEqual(await fs.readFile(item.filename), Buffer.from('alpha\nBETA\nGAMMA\ndelta\n'))
  })
  await check('observing new raw hash replaces all previous version ranges', async () => {
    const item = await fileCase('different-hash', encode(body()))
    await item.read(30, 30)
    const external = encode(body().replace('neutral line 150', 'external line 150'))
    await fs.writeFile(item.filename, external)
    const read = await item.read(310, 310)
    assert.equal(read.sha256, hash(external))
    assert.notEqual(read.sha256, hash(item.original))
    const result = await item.apply(item.args(twoPatch(), read.sha256))
    assert.equal(result.status, 'error')
    assert.match(result.error, /读取|行|片段|证据/)
    assert.equal(item.state.approvals, 0)
    await unchanged(item, external)
  })
  await check('success does not relabel stale reads with the candidate hash', async () => {
    const item = await fileCase('after-success', encode(body()))
    await item.read(30, 30)
    await item.read(310, 310)
    const first = await item.apply()
    assert.equal(first.status, 'applied')
    const secondText = patch([
      '@@',
      '-export const secondTarget = "OLD_SECOND";',
      '+export const secondTarget = "NEW_SECOND";'
    ])
    const second = await item.apply(item.args(secondText, first.sha256))
    assert.equal(second.status, 'error')
    assert.equal(item.state.approvals, 1)
    assert.equal(item.state.effects, 1)
    await item.read(310, 310)
    assert.equal((await item.apply(item.args(secondText, first.sha256))).status, 'applied')
    assert.equal(item.state.effects, 2)
    assert.deepEqual(
      await fs.readFile(item.filename),
      encode(body().replace('OLD_FIRST', 'NEW_FIRST').replace('OLD_SECOND', 'NEW_SECOND'))
    )
  })
  await check('plan reads cannot authorize a newly explicit execute request', async () => {
    const item = await fileCase('plan-read', encode(body(), '\r\n', true, 3))
    const planned = item.fresh('plan')
    const read = await item.read(30, 30, planned)
    assert.equal(read.sha256, hash(item.original))
    await deniedUnread(item, item.args().patch)
  })
  await check('prior execute request read cannot authorize next request', async () => {
    const item = await fileCase('cross-request', encode(body()))
    await item.read(30, 30, item.fresh('execute'))
    await deniedUnread(item, item.args().patch)
  })
  await check(
    'plan historical read reaches model as context but grants no execute evidence',
    async () => {
      const item = await fileCase('history-read', encode(body()))
      const planned = item.fresh('plan')
      const readArgs = { path: 'note.txt', startLine: 30, endLine: 30 }
      const readOutput = await planned('read_workspace_file', JSON.stringify(readArgs), signal())
      const history = [
        { role: 'user', content: '计划阶段读取必要业务窗口' },
        call('read_workspace_file', readArgs, 'history-read'),
        { type: 'function_call_output', call_id: 'history-read', output: readOutput },
        finalMessage('计划阶段只读观察完成；明确执行仍需当前真实读取。')
      ]
      const events = []
      let rounds = 0
      const scope = { kind: 'time', executionId: 'a'.repeat(64) }
      const result = await modules.loop.runToolLoop(
        '明确执行此前方案',
        async (input) => {
          rounds++
          if (rounds === 1) {
            assert.equal(
              input.some(
                (value) => value.type === 'function_call_output' && value.output === readOutput
              ),
              true
            )
            return response(call('apply_workspace_patch', item.args(), 'execute-patch'))
          }
          return response(finalMessage('本轮还需重新读取'))
        },
        signal(),
        [],
        () => {},
        history,
        item.execute,
        scope,
        () => {},
        (event) => events.push(event),
        undefined,
        'execute'
      )
      assert.equal(result.answer, '本轮还需重新读取')
      const output =
        events.find((event) => event.type === 'tool-output')?.output ??
        events.find((event) => typeof event.output === 'string')?.output
      assert.equal(JSON.parse(output).status, 'error')
      assert.equal(item.state.approvals, 0)
      await unchanged(item)
    }
  )

  await check('individually truncated line cannot become old-line evidence', async () => {
    const long = 'X'.repeat(2001)
    const item = await fileCase('line-truncated', Buffer.from('small anchor\n' + long + '\nend\n'))
    const read = await item.read(1, 3)
    assert.equal(read.lines[1].truncated, true)
    assert.equal(read.lines[1].text.length, 2000)
    await deniedUnread(item, patch(['@@', '-' + long, '+' + 'Y'.repeat(2001)]))
  })
  await check('whole-result truncated still permits its complete returned row', async () => {
    const lines = [
      'visible anchor',
      ...Array.from({ length: 29 }, (_, index) => 'row-' + index + '-' + 'x'.repeat(550))
    ]
    const item = await fileCase('result-kept', Buffer.from(lines.join('\n') + '\n'))
    const read = await item.read(1, 30)
    assert.equal(read.truncated, true)
    assert.ok(read.lines.length < 30)
    assert.equal(read.lines[0].truncated, false)
    assert.ok(JSON.stringify(read).length <= 11000)
    assert.equal(
      (await item.apply(item.args(patch(['@@', '-visible anchor', '+visible NEW anchor'])))).status,
      'applied'
    )
  })
  await check('serialized result omitted rows do not count merely because requested', async () => {
    const lines = [
      'visible anchor',
      ...Array.from({ length: 29 }, (_, index) => 'row-' + index + '-' + 'x'.repeat(550))
    ]
    const item = await fileCase('result-omitted', Buffer.from(lines.join('\n') + '\n'))
    const read = await item.read(1, 30)
    assert.equal(read.truncated, true)
    assert.ok(!read.lines.some((line) => line.line === 30))
    await deniedUnread(item, patch(['@@', '-' + lines[29], '+last NEW row']))
  })
  await check(
    'a rejected individually truncated row does not invalidate neighboring visible rows',
    async () => {
      const item = await fileCase(
        'neighbor-visible',
        Buffer.from('visible anchor\n' + 'X'.repeat(2001) + '\nend\n')
      )
      const read = await item.read(1, 3)
      assert.equal(read.lines[1].truncated, true)
      assert.equal(read.lines[0].truncated, false)
      assert.equal(
        (await item.apply(item.args(patch(['@@', '-visible anchor', '+visible NEW anchor']))))
          .status,
        'applied'
      )
    }
  )

  for (const tails of [0, 1, 3])
    await check('EOF maps final body row independently of tail empty rows ' + tails, async () => {
      const item = await fileCase('eof-' + tails, encode('begin\nlast', '\r\n', true, tails))
      const read = await item.read(2, 2)
      assert.equal(read.totalLines, 2 + tails)
      assert.equal(
        (await item.apply(item.args(patch(['@@', '-last', '+LAST', '*** End of File'])))).status,
        'applied'
      )
      assert.deepEqual(await fs.readFile(item.filename), encode('begin\nLAST', '\r\n', true, tails))
    })
  await check('reading only format trailing blank rows does not read final body row', async () => {
    const item = await fileCase('eof-tail-only', encode('begin\nlast', '\n', false, 3))
    await item.read(3, 5)
    await deniedUnread(item, patch(['@@', '-last', '+LAST', '*** End of File']))
  })
  await check('no-op returns no_change before approval and staging', async () => {
    const item = await fileCase('no-change', encode(body()))
    await item.read(30, 30)
    const result = await item.apply(
      item.args(
        patch([
          '@@',
          '-export const firstTarget = "OLD_FIRST";',
          '+export const firstTarget = "OLD_FIRST";'
        ])
      )
    )
    assert.equal(result.status, 'no_change')
    assert.equal(item.state.approvals, 0)
    await unchanged(item)
  })
  await check('delete all read body differs from unanchored empty original', async () => {
    const item = await fileCase('empty-candidate', encode('one\ntwo', '\r\n', true, 3))
    await item.read(1, 2)
    assert.equal((await item.apply(item.args(patch(['@@', '-one', '-two'])))).status, 'applied')
    assert.deepEqual(await fs.readFile(item.filename), encode('', '\r\n', true, 3))
    const empty = await fileCase('empty-original', Buffer.from(''))
    await empty.read(1, 1)
    assert.equal((await empty.apply(empty.args(patch(['@@', '+added'])))).status, 'error')
    await unchanged(empty)
  })
  for (const [name, original, text] of [
    ['missing', 'a\nb\nc\n', patch(['@@', '-missing', '+new'])],
    ['duplicate', 'same\nx\nsame\n', patch(['@@', '-same', '+new'])],
    ['overlap', 'a\nb\nc\n', patch(['@@', ' a', '-b', '+B', '@@', '-b', '+BB', ' c'])],
    ['malformed', 'a\nb\nc\n', patch(['@@', '-a', 'invalid'])],
    ['wrong-path', 'a\nb\nc\n', patch(['@@', '-a', '+A'], 'other.txt')],
    ['tail-change', 'a\nb\nc\n', patch(['@@', ' c', '+'])],
    ['control', 'a\nb\nc\n', patch(['@@', '-a', '+A\u0000'])],
    ['unicode', 'a\nb\nc\n', patch(['@@', '-a', '+A\ud800'])],
    ['EOF-not-final', 'a\nb\nc\n', patch(['@@', '-a', '+A', '*** End of File', '@@', '-c', '+C'])]
  ])
    await check('whole patch rejects ' + name + ' before authorization', async () => {
      const item = await fileCase('invalid-' + name, Buffer.from(original))
      await item.read(1, 10)
      assert.equal((await item.apply(item.args(text))).status, 'error')
      assert.equal(item.state.approvals, 0)
      await unchanged(item)
    })
  for (const [name, text] of [
    ['mixed', 'a\r\nb\n'],
    ['isolated-CR', 'a\rb\r']
  ])
    await check('unsupported ' + name + ' format preserves bytes', async () => {
      const item = await fileCase('unsupported-' + name, Buffer.from(text))
      await item.read(1, 3)
      assert.equal((await item.apply(item.args(patch(['@@', '-a', '+A'])))).status, 'unsupported')
      assert.equal(item.state.approvals, 0)
      await unchanged(item)
    })

  await check('same text BOM-only raw-byte conflict before authorization', async () => {
    const item = await fileCase('hash-conflict', encode(body()))
    await item.read(30, 30)
    const external = encode(body(), '\n', true, 1)
    await fs.writeFile(item.filename, external)
    assert.equal((await item.apply()).status, 'conflict')
    assert.equal(item.state.approvals, 0)
    await unchanged(item, external)
  })
  await check('approval-time external change stays exact and yields conflict', async () => {
    const deferred = deferredApproval()
    const item = await fileCase('approval-conflict', encode(body()), deferred.approve)
    await item.read(30, 30)
    const pending = item.apply()
    await waitForApproval(deferred, pending)
    const external = encode(body().replace('OLD_FIRST', 'EXTERNAL_FIRST'))
    await fs.writeFile(item.filename, external)
    deferred.resolve(true)
    assert.equal((await pending).status, 'conflict')
    await unchanged(item, external)
  })
  await check('manual refusal rejects a read large file before staging', async () => {
    const item = await fileCase('approval-refusal', encode(body()), async () => false)
    await item.read(30, 30)
    assert.equal((await item.apply()).status, 'cancelled')
    assert.equal(item.state.approvals, 1)
    await unchanged(item)
  })
  await check('already-cancelled patch performs no approval or write', async () => {
    const item = await fileCase('cancel-before', encode(body()))
    await item.read(30, 30)
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(item.apply(item.args(), item.execute, controller.signal), /abort/i)
    assert.equal(item.state.approvals, 0)
    await unchanged(item)
  })
  await check('late approval cannot write after cancellation', async () => {
    const deferred = deferredApproval()
    const item = await fileCase('cancel-wait', encode(body()), deferred.approve)
    await item.read(30, 30)
    const controller = new AbortController()
    const pending = item.apply(item.args(), item.execute, controller.signal)
    await waitForApproval(deferred, pending)
    controller.abort()
    deferred.resolve(true)
    await assert.rejects(pending, /abort/i)
    await unchanged(item)
  })
  await check('permission invalidation while approval waits blocks late answer', async () => {
    const deferred = deferredApproval()
    const item = await fileCase('permission-wait', encode(body()), deferred.approve)
    await item.read(30, 30)
    const pending = item.apply()
    await waitForApproval(deferred, pending)
    item.state.current = false
    deferred.resolve(true)
    const result = await pending
    assert.equal(result.status, 'error')
    assert.match(result.error, /失效/)
    await unchanged(item)
  })
  await check('new-file limits remain eighty lines two thousand characters', async () => {
    const item = await fileCase('create-limits', encode(body()))
    for (const content of ['x'.repeat(2001), Array.from({ length: 81 }, () => 'x').join('\n')]) {
      const result = JSON.parse(
        await item.execute(
          'create_workspace_file',
          JSON.stringify({ path: 'new.txt', content }),
          signal()
        )
      )
      assert.equal(result.status, 'error')
    }
    assert.equal(item.state.approvals, 0)
    await unchanged(item)
  })

  const forbidden = [
    'apply_workspace_patch',
    'create_workspace_file',
    'run_workspace_command',
    'propose_file_change',
    'propose_command'
  ]
  await check(
    'plan plus each permission mode excludes writes commands and executable proposals',
    () => {
      for (const permission of ['default', 'auto-approve', 'full-access']) {
        const request = modules.instructions.buildAgentRequest({
          mode: 'plan',
          execution: { cwd: runDirectory, scopeId: 'a'.repeat(64), mode: permission, revision: 1 }
        })
        for (const name of forbidden)
          assert.equal(
            request.tools.some((tool) => tool.name === name),
            false
          )
      }
    }
  )
  await check(
    'captured plan mode forbids forged action even malformed arguments or mutable options',
    async () => {
      const item = await fileCase('plan-forgeries', encode(body()))
      const options = item.options('plan')
      const planned = modules.agent.createAgentToolExecutor(options)
      options.mode = 'execute'
      for (const name of forbidden)
        await assert.rejects(planned(name, 'not-json', signal()), /计划模式/)
      assert.equal(item.state.approvals, 0)
      await unchanged(item)
    }
  )
  await check(
    'large original and candidate parse manual approval but exceed independent reviewer JSON bytes',
    async () => {
      const before = body() + '\n' + 'x'.repeat(30000)
      assert.ok(Buffer.byteLength(before) < 131072)
      const input = {
        kind: 'edit',
        requestId: 'check-request',
        conversationId: 'check-conversation',
        cwd: runDirectory,
        path: path.join(runDirectory, 'note.txt'),
        before,
        after: before.replace('OLD_FIRST', 'NEW_FIRST')
      }
      assert.ok(modules.shared.parseExecutionApproval({ ...input, approvalId: 'check-approval' }))
      assert.ok(
        Buffer.byteLength(JSON.stringify({ userRequest: '修改一处', action: input })) > 131072
      )
      assert.equal(await modules.review.reviewExecutionApproval(input, '修改一处', signal()), 'ask')
    }
  )
  await check(
    'JSON escaping can trigger reviewer fallback without enlarging fixed budget',
    async () => {
      const before = '"'.repeat(40000)
      const input = {
        kind: 'edit',
        requestId: 'check-request',
        conversationId: 'check-conversation',
        cwd: runDirectory,
        path: path.join(runDirectory, 'note.txt'),
        before,
        after: before
      }
      assert.ok(modules.shared.parseExecutionApproval({ ...input, approvalId: 'check-approval' }))
      assert.equal(
        await modules.review.reviewExecutionApproval(input, '修改引号文本', signal()),
        'ask'
      )
    }
  )

  await authorizationChecks()
  await integratedPermissionChecks()
  await evidenceChecks()
  await retryChecks()

  const result = {
    generatedAt: new Date().toISOString(),
    suite: 'lesson55-original-tool-protection',
    method: {
      real: [
        'workspace file reads',
        'snapshot prepare commit and readback',
        'temporary backup and staging',
        'bytes and format comparison'
      ],
      synthetic: [
        'model response queue for loop and retry',
        'manual approval responses',
        'command launch isolation',
        'reviewer transport replacement for over-budget calls'
      ],
      noRealModelClaim: true
    },
    passed: checks.every((value) => value.passed),
    total: checks.length,
    failed: checks.filter((value) => !value.passed).length,
    checks,
    counters
  }
  await fs.writeFile(
    path.join(runDirectory, 'results.json'),
    JSON.stringify(result, null, 2) + '\n',
    { flag: 'wx' }
  )
  console.log(
    JSON.stringify({
      directory: runDirectory,
      passed: result.passed,
      total: result.total,
      failed: result.failed,
      counters
    })
  )
  if (!result.passed) process.exitCode = 1
}

async function evidenceChecks() {
  const filename = path.join(runDirectory, 'evidence-only.txt')
  const original = 'first\nsecond\nlast\n\n\n'
  const format = { encoding: 'utf-8', hasUtf8Bom: false, newline: 'lf', trailingNewlines: 3 }
  const sha256 = hash(Buffer.from(original))
  const located = modules.patcher.applyWorkspacePatch(
    original,
    patch(['@@', '-second', '+SECOND'], 'evidence-only.txt'),
    'evidence-only.txt'
  ).locatedHunks
  const output = (overrides) =>
    JSON.stringify({
      ok: true,
      path: filename,
      sha256,
      totalLines: 6,
      format,
      lines: [{ line: 2, text: 'second', truncated: false }],
      truncated: false,
      ...overrides
    })
  const matches = (evidence) => evidence.check(filename, sha256, original, format, located)
  await check('evidence follows serialized lines not whole fullText or requested range', () => {
    const evidence = new modules.evidence.WorkspaceReadEvidence()
    evidence.observe(
      output({
        lines: [{ line: 1, text: 'first', truncated: false }],
        fullText: original,
        startLine: 1,
        endLine: 6
      })
    )
    assert.match(matches(evidence), /2.*2/)
    evidence.observe(output({ truncated: true }))
    assert.equal(matches(evidence), null)
  })
  await check('final output replaced or cropped before observer cannot register prior rows', () => {
    for (const value of [
      '{"ok":true,"error":"replacement"}',
      output({ lines: [] }),
      output().slice(0, -1)
    ]) {
      const evidence = new modules.evidence.WorkspaceReadEvidence()
      evidence.observe(value)
      assert.notEqual(matches(evidence), null)
    }
  })
  await check('overlong final output cannot register a valid embedded line', () => {
    const evidence = new modules.evidence.WorkspaceReadEvidence()
    evidence.observe(output({ padding: 'x'.repeat(12000) }))
    assert.notEqual(matches(evidence), null)
  })
  await check('evidence rejects malformed or mismatched rows and metadata', () => {
    for (const value of [
      { lines: [{ line: 2, text: 'second', truncated: true }] },
      { lines: [{ line: 2, text: 'second' }] },
      { lines: [{ line: 2.5, text: 'second', truncated: false }] },
      { lines: [{ line: 0, text: 'second', truncated: false }] },
      { lines: [{ line: 7, text: 'second', truncated: false }] },
      { lines: [{ line: 2, text: 'second\n', truncated: false }] },
      { lines: [{ line: 2, text: 'x'.repeat(2001), truncated: false }] },
      { totalLines: 7 },
      { totalLines: 1.5 },
      { format: { ...format, trailingNewlines: 2 } },
      { sha256: 'BADHASH' }
    ]) {
      const evidence = new modules.evidence.WorkspaceReadEvidence()
      evidence.observe(output(value))
      assert.notEqual(matches(evidence), null)
    }
  })
  await check('same-hash contradictory metadata or text invalidates old range', () => {
    for (const value of [
      { totalLines: 7 },
      { format: { ...format, hasUtf8Bom: true } },
      { lines: [{ line: 2, text: 'different', truncated: false }] }
    ]) {
      const evidence = new modules.evidence.WorkspaceReadEvidence()
      evidence.observe(output())
      assert.equal(matches(evidence), null)
      evidence.observe(output(value))
      assert.notEqual(matches(evidence), null)
    }
  })
  await check('canonical Windows path casing shares evidence and forgetting invalidates it', () => {
    const evidence = new modules.evidence.WorkspaceReadEvidence()
    evidence.observe(output({ path: filename.toUpperCase() }))
    assert.equal(matches(evidence), null)
    evidence.forget(filename.toLowerCase())
    assert.notEqual(matches(evidence), null)
  })
  await check(
    'only deletion and space context old rows require evidence after unique matcher',
    () => {
      const evidence = new modules.evidence.WorkspaceReadEvidence()
      const candidate = modules.patcher.applyWorkspacePatch(
        original,
        patch(
          ['@@', ' first', '-second', '+SECOND', '+new extra row', ' last'],
          'evidence-only.txt'
        ),
        'evidence-only.txt'
      )
      assert.equal(candidate.status, 'candidate')
      evidence.observe(output())
      assert.match(
        evidence.check(filename, sha256, original, format, candidate.locatedHunks),
        /1.*3/
      )
      evidence.observe(
        output({
          lines: [
            { line: 1, text: 'first', truncated: false },
            { line: 3, text: 'last', truncated: false }
          ]
        })
      )
      assert.equal(evidence.check(filename, sha256, original, format, candidate.locatedHunks), null)
    }
  )
}

async function authorizationChecks() {
  const modes = ['default', 'auto-approve', 'full-access']
  for (const mode of modes)
    for (const outside of [false, true])
      await check(
        'authorization ' +
          mode +
          ' ' +
          (outside ? 'outside' : 'inside') +
          ' keeps original approval strategy',
        async () => {
          const state = {
            current: true,
            begins: 0,
            finishes: 0,
            reviews: 0,
            manual: 0,
            approved: 0
          }
          const target = path.join(runDirectory, outside ? '../outside.txt' : 'note.txt')
          const execution = {
            info: { cwd: runDirectory, scopeId: 'a'.repeat(64), mode, revision: 1 },
            writableRoots: [runDirectory]
          }
          const authorization = await load('src/main/execution/action-authorization.ts', {
            '../execution/execution-approval': {
              requestExecutionApproval: async () => {
                state.manual++
                return true
              }
            },
            './execution-approval': {
              requestExecutionApproval: async () => {
                state.manual++
                return true
              }
            },
            './approval-reviewer': {
              reviewExecutionApproval: async () => {
                state.reviews++
                return 'approve'
              }
            },
            electron: {}
          })
          const approve = authorization.createWorkspaceAuthorization({
            windowId: 1,
            requestId: 'request',
            conversationId: 'conversation',
            userRequest: '修改文件',
            execution,
            assertCurrent: () => state.current,
            beginApproval: () => {
              state.begins++
              return true
            },
            finishApproval: () => {
              state.finishes++
            },
            onApproved: () => {
              state.approved++
            }
          })
          assert.equal(
            await approve(
              { kind: 'edit', path: target, before: 'OLD', after: 'NEW', cwd: runDirectory },
              signal()
            ),
            true
          )
          const needsAsk = outside && mode !== 'full-access'
          assert.equal(state.manual, needsAsk && mode === 'default' ? 1 : 0)
          assert.equal(state.reviews, needsAsk && mode === 'auto-approve' ? 1 : 0)
          assert.equal(state.begins, needsAsk ? 1 : 0)
          assert.equal(state.finishes, state.begins)
        }
      )
  for (const decision of ['accept', 'refuse', 'cancel', 'expired'])
    await check('real reviewer over-budget fallback to manual ' + decision, async () => {
      const state = { current: true, begins: 0, finishes: 0, manual: 0, approved: 0 }
      const controller = new AbortController()
      const input = {
        kind: 'edit',
        path: path.resolve(runDirectory, '../outside.txt'),
        before: body() + '\n' + 'x'.repeat(30000),
        after: body() + '\n' + 'y'.repeat(30000),
        cwd: runDirectory
      }
      const authorization = await load('src/main/execution/action-authorization.ts', {
        './execution-approval': {
          requestExecutionApproval: async () => {
            state.manual++
            if (decision === 'cancel') controller.abort()
            if (decision === 'expired') state.current = false
            return decision !== 'refuse'
          }
        },
        './approval-reviewer': { reviewExecutionApproval: modules.review.reviewExecutionApproval },
        electron: {}
      })
      const approve = authorization.createWorkspaceAuthorization({
        windowId: 1,
        requestId: 'request',
        conversationId: 'conversation',
        userRequest: '修改文件',
        execution: {
          info: { cwd: runDirectory, scopeId: 'a'.repeat(64), mode: 'auto-approve', revision: 1 },
          writableRoots: [runDirectory]
        },
        assertCurrent: () => state.current,
        beginApproval: () => {
          state.begins++
          return true
        },
        finishApproval: () => {
          state.finishes++
        },
        onApproved: () => {
          state.approved++
        }
      })
      if (decision === 'cancel') await assert.rejects(approve(input, controller.signal), /abort/i)
      else assert.equal(await approve(input, controller.signal), decision === 'accept')
      assert.equal(state.manual, 1)
      assert.equal(state.begins, 1)
      assert.equal(state.finishes, 1)
      assert.equal(state.approved, decision === 'accept' ? 1 : 0)
    })
}

async function integratedPermissionChecks() {
  const scenarios = [
    ['default', 'accept'],
    ['default', 'refuse'],
    ['default', 'cancel'],
    ['default', 'expired'],
    ['auto-approve', 'review-approve'],
    ['auto-approve', 'fallback-accept'],
    ['auto-approve', 'fallback-refuse'],
    ['auto-approve', 'cancel'],
    ['auto-approve', 'expired'],
    ['full-access', 'allow'],
    ['full-access', 'cancel-before'],
    ['full-access', 'expired-before']
  ]
  for (const [mode, decision] of scenarios)
    await check('integrated file authorization ' + mode + ' ' + decision, async () => {
      const item = await fileCase(
        'integrated-' + mode + '-' + decision,
        encode(body(), '\r\n', true, 3)
      )
      item.execution.info.mode = mode
      item.execution.writableRoots = []
      const controller = new AbortController()
      const state = { manual: 0, reviews: 0, begins: 0, finishes: 0, approved: 0 }
      const authorization = await load('src/main/execution/action-authorization.ts', {
        './execution-approval': {
          requestExecutionApproval: async () => {
            state.manual++
            if (decision === 'cancel') controller.abort()
            if (decision === 'expired') item.state.current = false
            return !decision.includes('refuse')
          }
        },
        './approval-reviewer': {
          reviewExecutionApproval: async () => {
            state.reviews++
            return decision === 'review-approve' ? 'approve' : 'ask'
          }
        },
        electron: {}
      })
      const approve = authorization.createWorkspaceAuthorization({
        windowId: 1,
        requestId: 'integrated-request',
        conversationId: 'integrated-conversation',
        userRequest: '明确只修改受控目标的一处业务内容',
        execution: item.execution,
        assertCurrent: () => item.state.current,
        beginApproval: () => {
          state.begins++
          return true
        },
        finishApproval: () => {
          state.finishes++
        },
        onApproved: () => {
          state.approved++
        }
      })
      const options = item.options('execute')
      options.approve = approve
      const executor = modules.agent.createAgentToolExecutor(options)
      await item.read(30, 30, executor)
      if (decision === 'cancel-before') controller.abort()
      if (decision === 'expired-before') item.state.current = false
      const success = ['accept', 'fallback-accept', 'review-approve', 'allow'].includes(decision)
      if (decision.startsWith('cancel'))
        await assert.rejects(item.apply(item.args(), executor, controller.signal), /abort/i)
      else {
        const result = await item.apply(item.args(), executor, controller.signal)
        assert.equal(
          result.status,
          success
            ? 'applied'
            : decision === 'expired' || decision === 'expired-before'
              ? 'error'
              : 'cancelled'
        )
      }
      if (success) {
        assert.deepEqual(
          await fs.readFile(item.filename),
          encode(body().replace('OLD_FIRST', 'NEW_FIRST'), '\r\n', true, 3)
        )
        assert.equal(item.state.effects, 1)
      } else await unchanged(item)
      assert.equal(state.begins, state.finishes)
      assert.equal(state.manual, mode === 'full-access' || decision === 'review-approve' ? 0 : 1)
      assert.equal(state.reviews, mode === 'auto-approve' ? 1 : 0)
      return {
        mode,
        decision,
        ...state,
        effects: item.state.effects,
        realDiskWrites: success ? 1 : 0,
        syntheticApproval: true
      }
    })
}

async function retryChecks() {
  await check(
    'temporary HTTP 502 after completed patch retries frozen request without repeating side effect',
    async () => {
      const item = await fileCase('retry-after-patch', encode(body()))
      const { build } = require('esbuild')
      const Module = require('node:module')
      const root = process.cwd()
      const built = await build({
        stdin: {
          contents:
            "export { createLiveResponse } from './src/main/model/response-client'; export { runToolLoop } from './src/main/agent/tool-loop'",
          resolveDir: root,
          sourcefile: path.join(runDirectory, 'retry.ts'),
          loader: 'ts'
        },
        bundle: true,
        platform: 'node',
        format: 'cjs',
        write: false,
        logLevel: 'silent',
        define: {
          'process.env.MODEL_ENDPOINT': JSON.stringify('https://lesson55.invalid/responses'),
          'process.env.MODEL_NAME': JSON.stringify('synthetic-check-only'),
          'process.env.MODEL_API_KEY': JSON.stringify('synthetic-key')
        }
      })
      const loaded = new Module(path.join(runDirectory, 'retry.cjs'), module)
      loaded.filename = path.join(runDirectory, 'retry.cjs')
      loaded.paths = Module._nodeModulePaths(root)
      loaded._compile(built.outputFiles[0].text, loaded.filename)
      const queued = [
        response(
          call(
            'read_workspace_file',
            { path: 'note.txt', startLine: 30, endLine: 30 },
            'read-current'
          )
        ),
        response(call('apply_workspace_patch', item.args(), 'patch-once')),
        502,
        response(finalMessage('合成重试完成'))
      ]
      const requests = []
      const retries = []
      const originalFetch = globalThis.fetch
      globalThis.fetch = async (_url, init) => {
        requests.push(JSON.parse(init.body))
        const next = queued.shift()
        assert.notEqual(next, undefined)
        if (next === 502)
          return {
            ok: false,
            status: 502,
            headers: { get: () => null },
            body: { cancel: async () => {} }
          }
        return new Response(
          'data: ' + JSON.stringify({ type: 'response.completed', response: next }) + '\n\n',
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
        )
      }
      try {
        const send = loaded.exports.createLiveResponse([], '合成失败恢复，只验证重试不重放', {
          endpoint: 'https://lesson55.invalid/responses',
          model: 'synthetic-check-only',
          apiKey: 'synthetic-key'
        })
        const result = await loaded.exports.runToolLoop(
          '明确修改第一目标',
          send,
          signal(),
          [],
          () => {},
          [],
          item.execute,
          { kind: 'time', executionId: 'a'.repeat(64) },
          () => {},
          () => {},
          undefined,
          'execute',
          (event) => retries.push(event)
        )
        assert.equal(result.answer, '合成重试完成')
        assert.equal(retries.length, 1)
        assert.equal(retries[0].maxRetries, 5)
        assert.equal(requests.length, 4)
        assert.deepEqual(requests[2], requests[3])
        assert.equal(item.state.effects, 1)
        assert.equal(item.state.approvals, 1)
        assert.deepEqual(
          await fs.readFile(item.filename),
          encode(body().replace('OLD_FIRST', 'NEW_FIRST'))
        )
        return {
          syntheticHttpRequests: requests.length,
          retryEvents: retries.length,
          completedPatchExecutions: item.state.effects
        }
      } finally {
        globalThis.fetch = originalFetch
      }
    }
  )
}

main().catch((error) => {
  console.error(error.stack ?? error)
  process.exitCode = 1
})
