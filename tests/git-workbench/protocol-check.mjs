import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createEvidence, compile, checksFor } from './runtime.mjs'

const evidence = await createEvidence('protocol')
const { api, sourceHashes, compiledSHA256 } = await compile(evidence, [
  'src/shared/git-workbench.ts',
  'src/main/git/git-workbench-lock.ts'
])
const suite = checksFor(evidence, {
  sourceHashes,
  compiledSHA256,
  currentFunctions: true,
  nativeGit: false,
  syntheticInputs: true,
  agentCalls: 0
})
const base = { requestId: randomUUID(), viewId: randomUUID() }
const revision = randomUUID(),
  itemId = randomUUID(),
  hunkId = randomUUID()
const stage = { ...base, revision, action: 'stage', itemIds: [itemId] }
await suite.check('exact manual metadata envelope and no command/path authority', () => {
  assert.deepEqual(api.parseGitWorkbenchRequest(base), base)
  for (const field of [
    'cwd',
    'path',
    'argv',
    'env',
    'conversationId',
    'grantId',
    'approvalId',
    'ticket'
  ])
    assert.equal(api.parseGitWorkbenchRequest({ ...base, [field]: 'injected' }), null)
})
await suite.check('unknown prototype, symbols and accessors are rejected without execution', () => {
  let hit = false
  const accessor = {
    viewId: base.viewId,
    get requestId() {
      hit = true
      return base.requestId
    }
  }
  assert.equal(api.parseGitWorkbenchRequest(accessor), null)
  assert.equal(hit, false)
  assert.equal(
    api.parseGitWorkbenchRequest(Object.assign(Object.create({ inherited: true }), base)),
    null
  )
  assert.equal(api.parseGitWorkbenchRequest({ ...base, [Symbol('authority')]: true }), null)
})
await suite.check('five independent Git review sources and recorded Last Turn source', () => {
  for (const source of ['branch', 'commit', 'uncommitted', 'staged', 'unstaged', 'last-turn'])
    assert(api.parseGitReviewRequest({ ...base, source, hideWhitespace: true }))
  assert.equal(api.parseGitReviewRequest({ ...base, source: 'agent-command' }), null)
  assert.equal(
    api.parseGitReviewRequest({ ...base, source: 'staged', commitId: randomUUID() }),
    null
  )
  assert.equal(api.parseGitReviewRequest({ ...base, source: 'branch', baseRefId: 'HEAD~1' }), null)
})
await suite.check('file/hunk actions use opaque IDs and no renderer patch text', () => {
  assert.deepEqual(api.parseGitActionRequest(stage), stage)
  assert(api.parseGitActionRequest({ ...stage, hunkIds: [hunkId] }))
  for (const value of [
    { ...stage, patch: 'arbitrary' },
    { ...stage, itemIds: [] },
    { ...stage, itemIds: [itemId, itemId] },
    { ...stage, hunkIds: [] },
    { ...stage, itemIds: ['../../config'] }
  ])
    assert.equal(api.parseGitActionRequest(value), null)
})
await suite.check('handwritten commit message and bounded explicit identity', () => {
  const request = {
    ...base,
    revision,
    action: 'commit',
    message: '修复界面\n\n手工说明',
    includeUnstaged: false
  }
  assert(api.parseGitActionRequest(request))
  assert(
    api.parseGitActionRequest({
      ...request,
      authorName: 'Tester',
      authorEmail: 'fixture@example.invalid'
    })
  )
  for (const value of [
    { ...request, message: '' },
    { ...request, message: ' \n ' },
    { ...request, message: 'a\0b' },
    { ...request, includeUnstaged: 'true' },
    { ...request, authorEmail: 'a\n-b@example.invalid' },
    { ...request, sign: true }
  ])
    assert.equal(api.parseGitActionRequest(value), null)
})
await suite.check('branch, remote, worktree and PR have separate exact text/ID contracts', () => {
  for (const extra of [
    { action: 'create-branch', name: 'codex/feature' },
    { action: 'checkout', refId: randomUUID() },
    { action: 'push', remoteId: randomUUID(), forceWithLease: false },
    { action: 'fetch', remoteId: randomUUID() },
    { action: 'create-worktree', name: 'manual-worktree', refId: randomUUID() },
    { action: 'remove-worktree', worktreeId: randomUUID() },
    { action: 'create-pr', title: 'Manual change', body: '', draft: true, baseRefId: randomUUID() }
  ])
    assert(api.parseGitActionRequest({ ...base, revision, ...extra }))
  for (const extra of [
    { action: 'reset-hard' },
    { action: 'checkout', refId: 'main' },
    { action: 'push', remoteId: 'https://injected', forceWithLease: false },
    { action: 'create-worktree', name: '../escape', refId: randomUUID() }
  ])
    assert.equal(api.parseGitActionRequest({ ...base, revision, ...extra }), null)
})
await suite.check('partial success is an explicit validated result', () => {
  const value = {
    ...base,
    status: 'ready',
    data: {
      outcome: 'partial-success',
      stage: 'index',
      appliedItemIds: [itemId],
      message: '已更新暂存区；工作树变化后未覆盖。'
    }
  }
  assert.deepEqual(api.parseGitActionResult(value), value)
  assert.equal(
    api.parseGitActionResult({ ...value, data: { ...value.data, approval: true } }),
    null
  )
  assert.equal(api.parseGitActionResult({ ...value, status: 'success' }), null)
})
await suite.check('stale/cancelled/error results retain exact request identity', () => {
  assert(api.parseGitActionResult({ ...base, status: 'stale', error: '刷新后重试' }))
  assert(api.parseGitActionResult({ ...base, status: 'cancelled' }))
  assert.equal(api.parseGitActionResult({ ...base, status: 'cancelled', data: {} }), null)
  assert.equal(api.sameGitWorkbenchRequest(base, { ...base, viewId: randomUUID() }), false)
})
await suite.check('review file actions and stage counts are validated', () => {
  const value = {
    ...base,
    status: 'ready',
    data: {
      revision,
      source: 'unstaged',
      baseLabel: 'Index → worktree',
      files: [
        {
          itemId,
          path: '中文 空格.txt',
          previousPath: null,
          change: 'modified',
          additions: 1,
          deletions: 1,
          binary: false,
          actions: ['stage', 'revert']
        }
      ],
      stageCounts: { staged: 0, unstaged: 1, untracked: 0 },
      warnings: []
    }
  }
  assert(api.parseGitReviewResult(value))
  assert.equal(
    api.parseGitReviewResult({
      ...value,
      data: { ...value.data, files: [...value.data.files, ...value.data.files] }
    }),
    null
  )
  assert.equal(
    api.parseGitReviewResult({
      ...value,
      data: { ...value.data, stageCounts: { staged: -1, unstaged: 1, untracked: 0 } }
    }),
    null
  )
})
await suite.check('diff hunk IDs and byte cap stay separate from Agent capacity', () => {
  const value = {
    ...base,
    status: 'ready',
    data: {
      itemId,
      text: '@@ -1 +1 @@\n-old\n+new\n',
      binary: false,
      hunks: [{ hunkId, header: '@@ -1 +1 @@', startLine: 0, endLine: 3, actions: ['stage'] }]
    }
  }
  assert(api.parseGitDiffResult(value))
  assert.equal(
    api.parseGitDiffResult({
      ...value,
      data: { ...value.data, hunks: [{ ...value.data.hunks[0], endLine: -1 }] }
    }),
    null
  )
  assert.equal(api.gitWorkbenchLimits.diffBytes, 32 * 1024 * 1024)
  assert.equal(api.gitViewLimits, undefined)
})
await suite.check(
  'common repository queue serializes windows and aborts before mutation',
  async () => {
    const events = []
    let release
    const hold = new Promise((resolve) => {
      release = resolve
    })
    const first = api.withGitRepositoryLock(evidence, undefined, async () => {
      events.push('first')
      await hold
      events.push('first-end')
    })
    await new Promise((resolve) => setImmediate(resolve))
    const second = api.withGitRepositoryLock(evidence.toUpperCase(), undefined, async () => {
      events.push('second')
    })
    const controller = new AbortController()
    const third = api.withGitRepositoryLock(evidence, controller.signal, async () => {
      events.push('forbidden')
    })
    controller.abort()
    const rejected = assert.rejects(third, (error) => {
      assert.equal(error.status, 'cancelled')
      assert.match(error.message, /等待锁时已取消/)
      return true
    })
    release()
    await Promise.all([first, second, rejected])
    assert.deepEqual(events, ['first', 'first-end', 'second'])
  }
)
await suite.finish()
