// Called by the existing attachment harness. All mutations stay in its verified temporary directory.
module.exports = async function ({
  directory,
  handlers,
  owner,
  event,
  access,
  agent,
  preparation,
  setPick,
  electron
}) {
  const assert = require('node:assert/strict')
  const fs = require('node:fs/promises')
  const path = require('node:path')
  const { randomUUID } = require('node:crypto')
  const { createAttachmentSnapshot } = require('../src/main/tools/project-snapshot.ts')
  const { prepareChange } = require('../src/main/tools/change-preparation.ts')
  const { commitChange } = require('../src/main/tools/change-commit.ts')
  const commit = require('../src/main/agent/change-commit-ipc.ts')
  const { parseCommitRequest, parseCommitResult } = require('../src/shared/change-commit.ts')
  const signal = new AbortController().signal
  const file = path.join(directory, 'commit.ts')
  const original = 'export const value = 1\n'
  const candidate = 'export const value = 2\n'
  const adapter = { open: fs.open, rename: fs.rename, unlink: fs.unlink }
  async function fixture(before = original, after = candidate) {
    await fs.writeFile(file, before)
    const snapshot = await createAttachmentSnapshot([file], signal)
    const content = await prepareChange(snapshot, snapshot.selection.files[0].path, after, signal)
    assert.equal(content.status, 'prepared')
    return { snapshot, content }
  }
  async function run(f, controller = new AbortController(), io = adapter, phases = []) {
    return commitChange(
      f.snapshot,
      f.content,
      controller.signal,
      () => true,
      (phase) => phases.push(phase),
      io
    )
  }
  // Actual NTFS replace and byte-preserving backup, including empty and newline cases.
  for (const [before, after, expected] of [
    [original, candidate, candidate],
    ['a\r\n', 'b\n', 'b\r\n'],
    ['\uFEFFa\r\n', '', '\uFEFF'],
    ['a', '', ''],
    ['a\n', 'b', 'b']
  ]) {
    const f = await fixture(before, after)
    const phases = []
    const result = await run(f, undefined, undefined, phases)
    assert.equal(result.status, 'applied')
    assert.equal(await fs.readFile(file, 'utf8'), expected)
    assert.equal(await fs.readFile(result.recovery.path, 'utf8'), before)
    assert.deepEqual(phases, ['validating', 'staging', 'replacing', 'verifying', 'finished'])
    const recovered = path.join(directory, `recovered-${randomUUID()}.ts`)
    await fs.copyFile(result.recovery.path, recovered, require('node:fs').constants.COPYFILE_EXCL)
    assert.equal(await fs.readFile(recovered, 'utf8'), before)
    assert.equal(await fs.readFile(file, 'utf8'), expected)
  }
  for (const changed of [
    original.replace('1', '3'),
    original.replace(/\n/g, '\r\n'),
    '\uFEFF' + original
  ]) {
    const f = await fixture()
    await fs.writeFile(file, changed)
    assert.equal((await run(f)).status, 'conflict')
    assert.equal(await fs.readFile(file, 'utf8'), changed)
  }
  let f = await fixture()
  await fs.unlink(file)
  assert.equal((await run(f)).status, 'conflict')
  f = await fixture()
  const moved = path.join(directory, 'old-identity.ts')
  await fs.rename(file, moved)
  await fs.writeFile(file, original)
  assert.equal((await run(f)).status, 'conflict')
  f = await fixture()
  const linked = path.join(directory, 'hard-linked.ts')
  await fs.link(file, linked)
  assert.equal((await run(f)).status, 'conflict')
  await fs.unlink(linked)

  // Handles are proxied only inside tests to exercise partial writes and I/O failures.
  function wrappedOpen(transform) {
    return async (...args) => {
      const handle = await fs.open(...args)
      const overrides = transform(args[0], handle)
      return new Proxy(handle, {
        get(target, key) {
          if (key in overrides) return overrides[key]
          const value = Reflect.get(target, key)
          return typeof value === 'function' ? value.bind(target) : value
        }
      })
    }
  }
  f = await fixture()
  let result = await run(f, undefined, {
    ...adapter,
    open: wrappedOpen((_name, h) => ({
      write: (bytes, offset, length, position) =>
        h.write(bytes, offset, Math.min(3, length), position)
    }))
  })
  assert.equal(result.status, 'applied', 'short writes are completed')
  for (const suffix of ['.bak', '.tmp']) {
    f = await fixture()
    result = await run(f, undefined, {
      ...adapter,
      open: wrappedOpen((name, h) =>
        name.endsWith(suffix)
          ? {
              write: async () => {
                await h.write(Buffer.from('partial'))
                throw new Error('ENOSPC')
              }
            }
          : {}
      )
    })
    assert.equal(result.status, 'error')
    assert.equal(await fs.readFile(file, 'utf8'), original)
    if (suffix === '.tmp') assert.equal(await fs.readFile(result.recovery.path, 'utf8'), original)
  }
  f = await fixture()
  result = await run(f, undefined, {
    ...adapter,
    open: async () => {
      throw new Error('EACCES')
    }
  })
  assert.equal(result.status, 'error')
  assert.equal(await fs.readFile(file, 'utf8'), original)
  f = await fixture()
  result = await run(f, undefined, {
    ...adapter,
    open: wrappedOpen((name, h) =>
      name.endsWith('.tmp')
        ? {
            close: async () => {
              await h.close()
              await fs.writeFile(file, 'external before final read')
            }
          }
        : {}
    )
  })
  assert.equal(result.status, 'conflict')
  assert.equal(await fs.readFile(file, 'utf8'), 'external before final read')
  f = await fixture()
  const beforeCancel = new AbortController()
  result = await run(f, beforeCancel, {
    ...adapter,
    open: wrappedOpen((name, h) =>
      name.endsWith('.tmp')
        ? {
            sync: async () => {
              await h.sync()
              beforeCancel.abort()
            }
          }
        : {}
    )
  })
  assert.equal(result.status, 'cancelled')
  assert.equal(await fs.readFile(file, 'utf8'), original)
  f = await fixture()
  result = await run(f, undefined, {
    ...adapter,
    rename: async () => {
      throw new Error('EPERM')
    }
  })
  assert.equal(result.status, 'uncertain')
  assert.equal(await fs.readFile(file, 'utf8'), original)
  assert.equal(await fs.readFile(result.recovery.path, 'utf8'), original)
  f = await fixture()
  const afterCancel = new AbortController()
  result = await run(f, afterCancel, {
    ...adapter,
    rename: async (...args) => {
      afterCancel.abort()
      await fs.rename(...args)
    }
  })
  assert.equal(result.status, 'applied', 'cancel after issuing rename cannot undo the commit')
  f = await fixture()
  result = await run(f, undefined, {
    ...adapter,
    rename: async (...args) => {
      await fs.rename(...args)
      await fs.writeFile(file, 'newer external edit')
    }
  })
  assert.equal(result.status, 'uncertain')
  assert.equal(await fs.readFile(file, 'utf8'), 'newer external edit', 'no blind rollback')
  f = await fixture()
  result = await run(f, undefined, {
    ...adapter,
    rename: async (...args) => {
      await fs.writeFile(file, 'external in residual race')
      await fs.rename(...args)
    }
  })
  assert.equal(result.status, 'applied')
  assert.equal(await fs.readFile(file, 'utf8'), candidate)
  assert.equal(await fs.readFile(result.recovery.path, 'utf8'), original)
  console.log(
    'Residual race demonstrated: an external write after final validation can still be replaced; no zero-race guarantee.'
  )

  f = await fixture()
  let collision
  result = await run(f, undefined, {
    ...adapter,
    open: async (...args) => {
      collision = args[0]
      await fs.writeFile(collision, 'preexisting foreign artifact', { flag: 'wx' })
      return fs.open(...args)
    }
  })
  assert.equal(result.status, 'error')
  assert.equal(await fs.readFile(collision, 'utf8'), 'preexisting foreign artifact')
  assert.equal(await fs.readFile(file, 'utf8'), original)
  f = await fixture()
  result = await commitChange(
    f.snapshot,
    f.content,
    signal,
    () => false,
    () => undefined
  )
  assert.equal(result.status, 'error', 'recheck current authority immediately before replacement')
  assert.equal(await fs.readFile(file, 'utf8'), original)
  f = await fixture()
  result = await run(f, undefined, {
    ...adapter,
    open: wrappedOpen((name) =>
      name.endsWith('.tmp') ? { write: async () => ({ bytesWritten: 0 }) } : {}
    ),
    unlink: async () => {
      throw new Error('cleanup failure')
    }
  })
  assert.equal(result.status, 'error')
  assert.equal(result.cleanupWarning, true)
  assert.equal(await fs.readFile(file, 'utf8'), original)

  // Production IPC: no awaits before claim, lifecycle, expiry and authority boundaries.
  access.cleanupProjectAccess(owner.id)
  agent.registerAgentPractice(
    (id) => preparation.hasChangePreparation(id) || commit.hasChangeCommit(id)
  )
  access.registerProjectAccess({
    isAgentJobActive: (id) =>
      agent.hasAgentJob(id) || preparation.hasChangePreparation(id) || commit.hasChangeCommit(id),
    abortProjectJob: agent.abortProjectJob,
    onAccessChanged: (id) => {
      preparation.cleanupChangePreparation(id)
      commit.cancelChangeCommit(id)
    }
  })
  preparation.registerChangePreparation(
    (id) => agent.hasAgentJob(id) || access.hasProjectSelection(id) || commit.hasChangeCommit(id)
  )
  commit.registerChangeCommit(
    (id) =>
      agent.hasAgentJob(id) ||
      access.hasProjectSelection(id) ||
      preparation.hasChangePreparation(id)
  )
  commit.attachCommitCleanup(owner)
  setPick(async () => ({ canceled: false, filePaths: [file] }))
  async function ready() {
    access.cleanupProjectAccess(owner.id)
    await fs.writeFile(file, original)
    const selection = await access.selectProjectFiles(owner, 'c')
    const request = {
      conversationId: 'c',
      snapshotId: selection.selection.snapshotId,
      checkId: randomUUID(),
      requestId: 'q',
      callId: 'call_1',
      path: selection.selection.files[0].path,
      proposedText: candidate
    }
    const response = await handlers.get('preparation:check')(event, request)
    assert.equal(response.status, 'ready')
    return {
      conversationId: 'c',
      snapshotId: request.snapshotId,
      checkId: request.checkId,
      preparationId: response.preparationId,
      commitId: randomUUID()
    }
  }
  const apply = (req) => handlers.get('commit:apply')(event, req)
  let req = await ready()
  for (const invalid of [
    { ...req, path: file },
    { ...req, proposedText: candidate },
    [],
    Object.defineProperty({ ...req }, 'commitId', {
      get() {
        throw new Error('accessor')
      }
    })
  ])
    assert.equal(parseCommitRequest(invalid), null)
  await assert.rejects(handlers.get('commit:apply')({ ...event, senderFrame: {} }, req))
  await assert.rejects(handlers.get('commit:apply')({ ...event, sender: {} }, req))
  assert.equal((await apply({ ...req, conversationId: 'forged' })).claimed, false)
  assert.equal((await apply({ ...req, snapshotId: 'forged' })).claimed, false)
  const now = Date.now
  Date.now = () => now() + 121000
  try {
    assert.equal((await apply(req)).claimed, false)
  } finally {
    Date.now = now
  }
  assert(access.captureProjectAccess(owner.id, 'c', req.snapshotId), 'invalid claim keeps grant')
  req = await ready()
  const pending = apply(req)
  assert(commit.hasChangeCommit(owner.id))
  assert.equal((await apply(req)).claimed, false)
  assert.equal((await access.selectProjectFiles(owner, 'c')).status, 'error')
  assert.equal(handlers.get('project:revoke')(event, req.snapshotId), false)
  assert.equal(
    (await handlers.get('agent:start')(event, 'blocked', '你好', 'mock')).status,
    'error'
  )
  assert.equal(handlers.get('commit:cancel')(event, 'wrong'), false)
  result = await pending
  assert.equal(result.status, 'applied')
  assert(parseCommitResult(result))
  assert(!parseCommitResult({ ...result, path: file }))
  assert(!JSON.stringify(result).includes(directory))
  assert.equal(access.captureProjectAccess(owner.id, 'c', req.snapshotId), null)
  assert.equal((await apply(req)).claimed, false)
  assert(!commit.hasChangeCommit(owner.id))
  let revealed = null
  electron.shell = {
    showItemInFolder: (value) => {
      revealed = value
    }
  }
  assert.equal(await handlers.get('commit:reveal-backup')(event, result.recovery.id), true)
  assert.equal(path.basename(revealed), result.recovery.name)
  assert.equal(await handlers.get('commit:reveal-backup')(event, 'wrong'), false)

  // Two windows may select the same path, but only one can own its commit at a time.
  req = await ready()
  const { EventEmitter } = require('node:events')
  const second = new EventEmitter()
  Object.assign(second, { id: 43, isDestroyed: () => false, webContents: new EventEmitter() })
  Object.assign(second.webContents, { mainFrame: {}, isDestroyed: () => false })
  const secondEvent = { sender: second.webContents, senderFrame: second.webContents.mainFrame }
  const fromContents = electron.BrowserWindow.fromWebContents
  const picker = electron.dialog.showOpenDialog
  electron.BrowserWindow.fromWebContents = (sender) =>
    sender === second.webContents ? second : fromContents(sender)
  electron.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  try {
    const otherSelection = await access.selectProjectFiles(second, 'other')
    const otherReady = await handlers.get('preparation:check')(secondEvent, {
      conversationId: 'other',
      snapshotId: otherSelection.selection.snapshotId,
      path: otherSelection.selection.files[0].path,
      proposedText: candidate,
      requestId: 'other-q',
      callId: 'other_call',
      checkId: randomUUID()
    })
    assert.equal(otherReady.status, 'ready')
    const firstPending = apply(req)
    const denied = await handlers.get('commit:apply')(secondEvent, {
      conversationId: 'other',
      snapshotId: otherReady.snapshotId,
      checkId: otherReady.checkId,
      preparationId: otherReady.preparationId,
      commitId: randomUUID()
    })
    assert.equal(denied.claimed, false)
    assert.equal(await handlers.get('commit:reveal-backup')(secondEvent, result.recovery.id), false)
    assert.equal((await firstPending).status, 'applied')
  } finally {
    access.cleanupProjectAccess(second.id)
    commit.cleanupChangeCommit(second.id)
    electron.BrowserWindow.fromWebContents = fromContents
    electron.dialog.showOpenDialog = picker
  }
  req = await ready()
  const cancelled = apply(req)
  assert.equal(handlers.get('commit:cancel')(event, req.commitId), true)
  assert.equal((await cancelled).status, 'cancelled')
  assert.equal(access.captureProjectAccess(owner.id, 'c', req.snapshotId), null)
  assert.equal(await fs.readFile(file, 'utf8'), original)
  req = await ready()
  const detached = apply(req)
  owner.webContents.emit('did-start-loading')
  await assert.rejects(detached, /页面已失效/)
  assert(!commit.hasChangeCommit(owner.id))
  assert.equal(await fs.readFile(file, 'utf8'), original)

  req = await ready()
  await fs.writeFile(file, 'external after ready')
  result = await apply(req)
  assert.equal(result.status, 'conflict')
  assert.equal(result.claimed, true)
  assert.equal(access.captureProjectAccess(owner.id, 'c', req.snapshotId), null)
  assert.equal(await fs.readFile(file, 'utf8'), 'external after ready')

  // Refresh after rename was issued suppresses the old page reply, but still finishes verification.
  req = await ready()
  const serviceModule = require('../src/main/tools/change-commit.ts')
  const productionCommit = serviceModule.commitChange
  serviceModule.commitChange = (...args) =>
    productionCommit(...args, {
      ...adapter,
      rename: async (...paths) => {
        owner.webContents.emit('did-start-loading')
        assert(
          commit.hasChangeCommit(owner.id),
          'refresh must not release occupancy after replacement starts'
        )
        await fs.rename(...paths)
      }
    })
  try {
    await assert.rejects(apply(req), /页面已失效/)
    assert.equal(await fs.readFile(file, 'utf8'), candidate)
    assert.equal(access.captureProjectAccess(owner.id, 'c', req.snapshotId), null)
    assert(!commit.hasChangeCommit(owner.id))
  } finally {
    serviceModule.commitChange = productionCommit
  }

  // Main close guard refuses even a matching forged allow while committing.
  const guard = require('../src/main/window/close-guard.ts')
  let closeRequest
  const oldSend = owner.webContents.send
  owner.webContents.send = (_channel, id) => {
    closeRequest = id
  }
  let closed = false
  owner.close = () => {
    closed = true
  }
  guard.registerCloseGuard(commit.hasChangeCommit)
  guard.attachCloseGuard(owner)
  req = await ready()
  const closing = apply(req)
  owner.emit('close', { preventDefault: () => undefined })
  assert.equal(handlers.get('window:finish-close')(event, closeRequest, true), false)
  assert.equal(closed, false)
  await closing
  owner.webContents.send = oldSend
  commit.cleanupChangeCommit(owner.id)
  console.log(
    'Lesson 25 passed: actual commit, exact backup/recovery copy, conflicts, failure injection, short writes, cancellation boundaries, expiry, ownership, single-use IDs, grant invalidation, refresh and close guard.'
  )
}
