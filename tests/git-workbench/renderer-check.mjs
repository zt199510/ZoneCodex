import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { createEvidence, checksFor, hash, root } from './runtime.mjs'

const { load, microtasks, FakeClock } = createRequire(import.meta.url)(
  '../lesson55/shared/harness.cjs'
)
const evidence = await createEvidence('renderer')
const { check, finish } = checksFor(evidence, {
  classification:
    'current Hook, diff helpers and JSX event handlers with synthetic React and Git API',
  syntheticReact: true,
  syntheticGitAPI: true,
  realDOM: false,
  actualElectron: false,
  actualGitProcess: false,
  actualPTY: false,
  modelTransport: false
})
const sourceNames = [
  'src/renderer/src/features/git/useGitWorkbench.ts',
  'src/renderer/src/features/git/GitWorkbenchPanel.tsx',
  'src/renderer/src/features/git/workbench-diff.ts',
  'src/renderer/src/assets/git-workbench.css',
  'src/renderer/src/features/git/git-workbench-preferences.ts',
  'src/renderer/src/features/git/useGitRepositories.ts',
  'src/renderer/src/features/git/GitRepositoriesPanel.tsx',
  'src/renderer/src/features/git/GitPullRequestDialog.tsx',
  'src/renderer/src/App.tsx'
]
await fs.writeFile(
  path.join(evidence, 'source-identity.json'),
  JSON.stringify(
    Object.fromEntries(
      await Promise.all(
        sourceNames.map(async (name) => [name, hash(await fs.readFile(path.join(root, name)))])
      )
    ),
    null,
    2
  )
)

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function hooks() {
  const slots = [],
    effects = []
  let index = 0
  const changed = (previous, next) =>
    !previous ||
    !next ||
    previous.length !== next.length ||
    previous.some((item, i) => !Object.is(item, next[i]))
  function effect(action, deps) {
    const key = index++
    if (!slots[key] || changed(slots[key].deps, deps)) {
      const previous = slots[key]
      slots[key] = { deps, cleanup: previous?.cleanup }
      effects.push(() => {
        previous?.cleanup?.()
        slots[key].cleanup = action()
      })
    }
  }
  return {
    react: {
      useState(initial) {
        const key = index++
        slots[key] ??= { value: typeof initial === 'function' ? initial() : initial }
        return [
          slots[key].value,
          (value) => {
            slots[key].value = typeof value === 'function' ? value(slots[key].value) : value
          }
        ]
      },
      useRef(initial) {
        const key = index++
        slots[key] ??= { current: initial }
        return slots[key]
      },
      useCallback(action, deps) {
        const key = index++
        if (!slots[key] || changed(slots[key].deps, deps)) slots[key] = { value: action, deps }
        return slots[key].value
      },
      useMemo(action, deps) {
        const key = index++
        if (!slots[key] || changed(slots[key].deps, deps)) slots[key] = { value: action(), deps }
        return slots[key].value
      },
      useEffect: effect,
      useLayoutEffect: effect
    },
    render(action) {
      index = 0
      const value = action()
      while (effects.length) effects.shift()()
      return value
    },
    dispose() {
      for (const slot of slots) slot.cleanup?.()
    }
  }
}
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ids = {
  view: randomUUID(),
  metadata: randomUUID(),
  review: randomUUID(),
  file: randomUUID(),
  second: randomUUID(),
  ref: randomUUID(),
  commit: randomUUID(),
  hunk: randomUUID()
}
const file = (itemId = ids.file) => ({
  itemId,
  path: itemId === ids.file ? 'a.md' : 'b.txt',
  previousPath: null,
  change: 'modified',
  additions: 1,
  deletions: 1,
  binary: false,
  actions: ['stage', 'revert']
})
const metadata = () => ({
  revision: ids.metadata,
  branch: 'feature',
  headSha: 'a'.repeat(40),
  ahead: 1,
  behind: 0,
  branches: [{ refId: ids.ref, name: 'main', current: false, remote: false, oid: 'a'.repeat(40) }],
  commits: [
    { commitId: ids.commit, sha: 'a'.repeat(40), subject: 'Base', author: 'Fixture', timestamp: 1 }
  ],
  remotes: [],
  worktrees: [],
  capabilities: ['commit', 'generate', 'stage'].map((name) => ({
    name,
    available: true,
    reason: null
  }))
})
const review = (source = 'uncommitted') => ({
  revision: ids.review,
  source,
  baseLabel: 'HEAD → worktree',
  files: [file(), file(ids.second)],
  stageCounts: { staged: 0, unstaged: 2, untracked: 0 },
  warnings: []
})
const diffText =
  'diff --git a/a.md b/a.md\n--- a/a.md\n+++ b/a.md\n@@ -2 +2 @@\n-old words\n+new words\n'
const detail = (itemId = ids.file) => ({
  itemId,
  text: diffText,
  binary: false,
  hunks: [
    {
      hunkId: ids.hunk,
      header: '@@ -2 +2 @@',
      startLine: 3,
      endLine: 5,
      actions: ['stage', 'revert']
    }
  ]
})
const readyView = () => ({
  open: true,
  phase: 'ready',
  view: {
    viewId: ids.view,
    selectedPath: 'D:/owned',
    repositoryPath: 'D:/owned',
    scopePath: '',
    gitVersion: 'fixture',
    head: 'present',
    linkedWorktree: false
  },
  list: null,
  selectedItemId: null,
  detail: null,
  detailLoading: false,
  notice: null
})
const emptyView = () => ({ ...readyView(), open: false, phase: 'empty', view: null })

async function fixture(initial = readyView()) {
  const harness = hooks(),
    calls = [],
    queued = new Map()
  const clock = new FakeClock()
  const listeners = new Set()
  const config = { view: initial, cancel: null, cancelError: false, paused: false, active: true }
  const api = {}
  for (const name of [
    'getGitMetadata',
    'reviewGitChanges',
    'readGitDiff',
    'readGitFullFile',
    'executeGitAction',
    'generateGitText'
  ]) {
    queued.set(name, [])
    api[name] = (request) => {
      const held = deferred()
      const call = { name, request, ...held }
      calls.push(call)
      queued.get(name).push(call)
      return held.promise
    }
  }
  api.onGitInvalidated = (listener) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }
  api.cancelGitRead = async (requestId) => {
    calls.push({ name: 'cancelGitRead', requestId })
    if (config.cancel) return config.cancel.promise
    return config.cancelError
      ? { status: 'error', error: 'retirement failed' }
      : { status: 'ready' }
  }
  globalThis.window = {
    api: new Proxy(api, {
      get(object, name) {
        assert(
          Object.hasOwn(object, name),
          'Unexpected Agent, PTY, storage or workspace API: ' + String(name)
        )
        return object[name]
      }
    })
  }
  const module = await load(sourceNames[0], { react: harness.react }, { clock })
  const render = () =>
    harness.render(() => module.useGitWorkbench(config.view, config.paused, config.active))
  const settle = async () => {
    await microtasks()
    return render()
  }
  const resolve = (name, data, status = 'ready', override = {}) => {
    const call = queued.get(name).shift()
    assert(call, 'Expected request: ' + name)
    call.resolve({
      requestId: call.request.requestId,
      viewId: call.request.viewId,
      status,
      ...(status === 'ready'
        ? { data }
        : status === 'cancelled'
          ? {}
          : { error: 'fixture failure' }),
      ...override
    })
    return call
  }
  async function loaded() {
    render()
    await settle()
    resolve('getGitMetadata', metadata())
    await settle()
    resolve('reviewGitChanges', review())
    await settle()
    await settle()
    resolve('readGitDiff', detail())
    return settle()
  }
  render()
  return {
    calls,
    queued,
    config,
    clock,
    listeners,
    invalidate: (event) => {
      for (const listener of listeners) listener(event)
    },
    render,
    settle,
    resolve,
    loaded,
    dispose: () => harness.dispose()
  }
}

await check(
  'closed/empty/selecting panels make no metadata, model, terminal or storage requests',
  async () => {
    const f = await fixture(emptyView())
    await f.settle()
    f.config.view = { ...readyView(), phase: 'selecting' }
    await f.settle()
    f.config.view = { ...readyView(), phase: 'loading' }
    await f.settle()
    assert.equal(f.calls.length, 0)
    f.dispose()
  }
)
await check(
  'ready selection reads metadata, review and first diff once; all requests use new UUIDs',
  async () => {
    const f = await fixture()
    const state = (await f.loaded()).state
    assert.equal(state.metadata.branch, 'feature')
    assert.equal(state.detail.itemId, ids.file)
    for (let i = 0; i < 5; i++) await f.settle()
    assert.deepEqual(
      f.calls.map((call) => call.name),
      ['getGitMetadata', 'reviewGitChanges', 'readGitDiff']
    )
    const requests = f.calls.map((call) => call.request)
    assert.equal(new Set(requests.map((request) => request.requestId)).size, requests.length)
    requests.forEach((request) => {
      assert.match(request.requestId, uuidPattern)
      assert.equal(request.viewId, ids.view)
    })
    f.dispose()
  }
)
await check(
  'wrong metadata request identity is rejected and never starts review or repeats forever',
  async () => {
    const f = await fixture()
    await f.settle()
    f.resolve('getGitMetadata', metadata(), 'ready', { requestId: randomUUID() })
    const state = (await f.settle()).state
    assert.equal(state.noticeStatus, 'stale')
    assert.equal(state.metadata, null)
    for (let i = 0; i < 5; i++) await f.settle()
    assert.equal(f.calls.length, 1)
    f.dispose()
  }
)
await check(
  'rapid file switch waits for cancellation and cannot display a late old diff',
  async () => {
    const f = await fixture()
    await f.loaded()
    const first = f.render().readFile(file())
    await f.settle()
    const old = f.queued.get('readGitDiff').shift()
    f.config.cancel = deferred()
    const second = f.render().readFile(file(ids.second))
    await f.settle()
    assert.equal(f.queued.get('readGitDiff').length, 0)
    old.resolve({ ...old.request, status: 'ready', data: detail() })
    await first
    assert.equal(f.render().state.detail, null)
    f.config.cancel.resolve({ status: 'ready' })
    await f.settle()
    f.resolve('readGitDiff', detail(ids.second))
    await second
    assert.equal(f.render().state.detail.itemId, ids.second)
    f.dispose()
  }
)
await check(
  'full file versions are sequential owned UUID reads; wrong side is rejected',
  async () => {
    const f = await fixture()
    await f.loaded()
    const operation = f.render().readFullFiles(file())
    await f.settle()
    assert.equal(f.queued.get('readGitFullFile').length, 1)
    const base = f.queued.get('readGitFullFile')[0]
    assert.equal(base.request.side, 'base')
    f.resolve('readGitFullFile', {
      itemId: ids.file,
      path: 'a.md',
      side: 'base',
      format: 'text',
      text: 'lead\nold words\ntail\n'
    })
    await f.settle()
    const current = f.queued.get('readGitFullFile')[0]
    assert.equal(current.request.side, 'current')
    assert.notEqual(current.request.requestId, base.request.requestId)
    f.resolve('readGitFullFile', {
      itemId: ids.file,
      path: 'a.md',
      side: 'current',
      format: 'text',
      text: 'lead\nnew words\ntail\n'
    })
    await operation
    assert.equal(f.render().state.fullFiles.current.side, 'current')
    const mismatch = f.render().readFullFiles(file())
    await f.settle()
    f.resolve('readGitFullFile', {
      itemId: ids.file,
      path: 'a.md',
      side: 'current',
      format: 'missing'
    })
    await mismatch
    assert.equal(f.render().state.noticeStatus, 'stale')
    assert.equal(f.queued.get('readGitFullFile').length, 0)
    f.dispose()
  }
)
await check(
  'switching sources passes only selected bound refs and preserves no model interaction',
  async () => {
    const f = await fixture()
    await f.loaded()
    const operation = f.render().selectSource('branch')
    await f.settle()
    const call = f.queued.get('reviewGitChanges')[0]
    assert.equal(call.request.source, 'branch')
    assert.equal(call.request.baseRefId, ids.ref)
    assert.equal(call.request.commitId, undefined)
    f.resolve('reviewGitChanges', review('branch'))
    await operation
    await f.settle()
    await f.settle()
    f.resolve('readGitDiff', detail())
    await f.settle()
    assert.equal(f.calls.filter((call) => call.name === 'generateGitText').length, 0)
    f.dispose()
  }
)
await check(
  'manual action uses confirmation revision; partial success remains visible after refresh',
  async () => {
    const f = await fixture()
    await f.loaded()
    const confirmationRevision = randomUUID()
    const operation = f
      .render()
      .execute({ action: 'revert', itemIds: [ids.file], hunkIds: [ids.hunk] }, confirmationRevision)
    await f.settle()
    const call = f.queued.get('executeGitAction')[0]
    assert.equal(call.request.revision, confirmationRevision)
    assert.deepEqual(call.request.hunkIds, [ids.hunk])
    f.resolve('executeGitAction', {
      outcome: 'partial-success',
      stage: 'checkout',
      appliedItemIds: [ids.file],
      message: 'Some applied'
    })
    await f.settle()
    f.resolve('getGitMetadata', metadata())
    await f.settle()
    f.resolve('reviewGitChanges', review())
    assert.equal(await operation, false)
    assert.equal(f.render().state.actionResult.outcome, 'partial-success')
    f.dispose()
  }
)
await check(
  'AI generation is explicit, returns editable candidate and never executes a commit',
  async () => {
    const f = await fixture()
    await f.loaded()
    assert.equal(
      f.calls.some((call) => call.name === 'generateGitText'),
      false
    )
    const operation = f
      .render()
      .generate({ purpose: 'commit', includeUnstaged: false, guidance: '中文' })
    await f.settle()
    const call = f.queued.get('generateGitText')[0]
    assert.equal(call.request.purpose, 'commit')
    assert.equal(call.request.revision, ids.metadata)
    f.resolve('generateGitText', { subject: '候选标题', body: '候选说明' })
    assert.deepEqual(await operation, { subject: '候选标题', body: '候选说明' })
    assert.equal(
      f.calls.some((call) => call.name === 'executeGitAction'),
      false
    )
    const pending = f.render().generate({ purpose: 'pr', baseRefId: ids.ref })
    await f.settle()
    await f.render().cancel()
    f.resolve('generateGitText', { subject: 'Late', body: 'Ignored' })
    assert.equal(await pending, null)
    assert.equal(f.render().state.busy, null)
    f.dispose()
  }
)
await check(
  'document switch and unmount cancel pending reads and discard late replies',
  async () => {
    const f = await fixture()
    await f.settle()
    const old = f.queued.get('getGitMetadata').shift()
    f.config.view = { ...readyView(), view: { ...readyView().view, viewId: randomUUID() } }
    await f.settle()
    await f.settle()
    old.resolve({ ...old.request, status: 'ready', data: metadata() })
    await f.settle()
    assert.equal(f.render().state.metadata, null)
    const successor = f.queued.get('getGitMetadata').shift()
    f.dispose()
    await microtasks()
    successor.resolve({ ...successor.request, status: 'ready', data: metadata() })
    await microtasks()
    assert.equal(f.calls.filter((call) => call.name === 'cancelGitRead').length, 2)
  }
)
await check('failed retirement blocks successor reads instead of allowing overlap', async () => {
  const f = await fixture()
  await f.loaded()
  const first = f.render().readFile(file())
  await f.settle()
  const held = f.queued.get('readGitDiff').shift()
  f.config.cancelError = true
  await f.render().readFile(file(ids.second))
  await f.settle()
  assert.equal(f.queued.get('readGitDiff').length, 0)
  assert.equal(f.render().state.noticeStatus, 'error')
  held.resolve({ ...held.request, status: 'ready', data: detail() })
  await first
  f.config.cancelError = false
  f.dispose()
})

const helpers = await load(sourceNames[2])
await check('full context retains correct line numbers and original actionable hunks', async () => {
  const parsed = helpers.parseWorkbenchDiff(diffText)
  const expanded = helpers.expandWorkbenchDiff(
    parsed,
    'lead\nold words\ntail\n',
    'lead\nnew words\ntail\n'
  )
  assert.deepEqual(
    expanded.hunks.map((hunk) => hunk.sourceHunkIndex),
    [null, 0, null]
  )
  assert.deepEqual(
    expanded.hunks.flatMap((hunk) => hunk.lines).map((line) => [line.oldLine, line.newLine]),
    [
      [1, 1],
      [2, null],
      [null, 2],
      [3, 3]
    ]
  )
  const inserted = helpers.expandWorkbenchDiff(
    helpers.parseWorkbenchDiff('@@ -0,0 +1 @@\n+new\n'),
    '',
    'new\n'
  )
  assert.equal(inserted.hunks.length, 1)
  const renamed = helpers.expandWorkbenchDiff(
    helpers.parseWorkbenchDiff('rename from old\nrename to new\n'),
    'same\n',
    'same\n'
  )
  assert.equal(renamed.hunks[0].lines[0].text, 'same')
})
await check(
  'split alignment, bounded word matching, binary state and search cap preserve literal source',
  async () => {
    const parsed = helpers.parseWorkbenchDiff(
      '@@ -1,2 +1,2 @@\n-<script>old</script>\n+<script>new</script>\n context\n'
    )
    const pairs = helpers.splitHunkRows(parsed.hunks[0])
    assert.equal(pairs[0].before.oldLine, 1)
    assert.equal(pairs[0].after.newLine, 1)
    const words = helpers.diffWordSegments('one two', 'one three')
    assert.equal(words.after.map((part) => part.text).join(''), 'one three')
    assert(words.after.some((part) => part.changed))
    const long = 'word '.repeat(300)
    assert.equal(helpers.diffWordSegments(long, long + 'x').before.length, 1)
    const found = helpers.searchDiffRows(
      helpers.parseWorkbenchDiff('@@ -1 +1 @@\n+' + 'x '.repeat(600) + '\n'),
      'x',
      250
    )
    assert.equal(found.matches.length, 250)
    assert.equal(found.total, 600)
    assert.equal(found.capped, true)
    assert.equal(helpers.parseWorkbenchDiff('Binary files a/x and b/x differ').binary, true)
  }
)

const jsx = (type, props) => ({ type, props: props ?? {} })
globalThis.React = {
  createElement: (type, props, ...children) => jsx(type, { ...props, children }),
  Fragment: 'fragment'
}
const jsxRuntime = { jsx, jsxs: jsx, Fragment: 'fragment' }
const nodes = (value) =>
  Array.isArray(value)
    ? value.flatMap(nodes)
    : value && typeof value === 'object'
      ? [value, ...nodes(value.props?.children)]
      : []
const textOf = (value) =>
  Array.isArray(value)
    ? value.map(textOf).join('')
    : value && typeof value === 'object'
      ? textOf(value.props?.children)
      : typeof value === 'string' || typeof value === 'number'
        ? String(value)
        : ''
await check(
  'actual panel refresh uses new workbench only; complete-file and rich-preview controls are active',
  async () => {
    const harness = hooks(),
      events = []
    const state = {
      metadata: metadata(),
      review: review(),
      detail: detail(),
      fullFiles: null,
      selectedItemId: ids.file,
      source: 'uncommitted',
      baseRefId: ids.ref,
      commitId: ids.commit,
      hideWhitespace: false,
      busy: null,
      notice: '',
      noticeStatus: '',
      actionResult: null
    }
    const workbench = {
      state,
      refresh: async () => events.push('new refresh'),
      readFullFiles: async () => events.push('full files'),
      capability: () => ({ available: true, reason: '' }),
      generate: async () => null,
      execute: async () => true
    }
    const module = await load(sourceNames[1], {
      react: harness.react,
      'react/jsx-runtime': jsxRuntime,
      './useGitWorkbench': { useGitWorkbench: () => workbench },
      '../../assets/git-workbench.css': {},
      'react-markdown': () => null,
      'remark-gfm': () => null,
      '../files/source-highlight': { highlightedCode: (text) => text },
      '../../components/ui/Icon': { Icon: () => null }
    })
    const props = {
      state: readyView(),
      cleanupError: '',
      directoryDisabled: false,
      onSelectDirectory: async () => {},
      onRefresh: async () => events.push('old refresh'),
      onClose: () => {}
    }
    const render = () => harness.render(() => module.GitWorkbenchPanel(props))
    const tree = render()
    await nodes(tree)
      .find((node) => node.props.id === 'git-view-refresh')
      .props.onClick()
    await microtasks()
    assert.deepEqual(events, ['new refresh'])
    const labels = nodes(tree).filter((node) => node.type === 'label')
    const full = labels.find((node) => textOf(node).includes('完整文件'))
    const rich = labels.find((node) => textOf(node).includes('富预览'))
    assert(full && rich)
    assert.equal(nodes(full).find((node) => node.type === 'input').props.disabled, false)
    nodes(full)
      .find((node) => node.type === 'input')
      .props.onChange({ target: { checked: true } })
    render()
    await microtasks()
    assert.deepEqual(events, ['new refresh', 'full files'])
    assert.equal(textOf(tree).includes('尚未接入'), false)
    const commit = nodes(tree).find((node) => node.type === 'button' && textOf(node) === '提交改动')
    commit.props.onClick()
    const modal = nodes(render()).find(
      (node) => typeof node.type === 'function' && node.props.mode === 'commit'
    )
    const dialogHooks = hooks()
    const dialog = dialogHooks.render(() =>
      modal.type({ ...modal.props, busy: true, generating: true })
    )
    const stop = nodes(dialog).find((node) => node.type === 'button' && textOf(node) === '停止生成')
    assert.equal(stop.props.disabled, false)
    assert.equal(nodes(dialog).find((node) => node.type === 'fieldset').props.disabled, true)
    dialogHooks.dispose()
    harness.dispose()
  }
)
async function panelFixture(state, view = readyView()) {
  const parentHooks = hooks()
  let activeHooks = parentHooks
  const react = Object.fromEntries(
    Object.keys(parentHooks.react).map((name) => [
      name,
      (...args) => activeHooks.react[name](...args)
    ])
  )
  const events = [],
    stored = new Map(),
    initialization = deferred()
  const localStorage = {
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => {
      stored.set(key, value)
      events.push(['preferences', key])
    }
  }
  globalThis.window = {
    localStorage,
    api: new Proxy(
      {
        initializeGitRepository(requestId) {
          events.push(['initialize', requestId])
          return initialization.promise
        },
        cancelGitRead: async (requestId) => {
          events.push(['cancel', requestId])
          return { status: 'ready' }
        },
        releaseGitView: async (viewId) => {
          events.push(['release', viewId])
          return { status: 'ready' }
        }
      },
      {
        get(object, name) {
          assert(Object.hasOwn(object, name), 'Unexpected Agent/PTY/workspace API ' + String(name))
          return object[name]
        }
      }
    )
  }
  const workbench = {
    state,
    readFullFiles: async () => {},
    refresh: async () => {},
    capability: () => ({ available: true, reason: '' }),
    generate: async (options) => {
      events.push(['generate', options])
      return null
    },
    execute: async (action, revision) => {
      events.push(['execute', action, revision])
      return true
    }
  }
  const module = await load(sourceNames[1], {
    react,
    'react/jsx-runtime': jsxRuntime,
    './useGitWorkbench': { useGitWorkbench: () => workbench },
    '../../assets/git-workbench.css': {},
    'react-markdown': () => null,
    'remark-gfm': () => null,
    '../files/source-highlight': { highlightedCode: (text) => text },
    '../../components/ui/Icon': { Icon: () => null }
  })
  const props = {
    state: view,
    cleanupError: '',
    directoryDisabled: false,
    onSelectDirectory: async () => {},
    onRefresh: async () => {},
    onAdoptView: (selected) => events.push(['adopt', selected]),
    onClose: () => {}
  }
  return {
    state,
    events,
    stored,
    initialization,
    props,
    render() {
      activeHooks = parentHooks
      return parentHooks.render(() => module.GitWorkbenchPanel(props))
    },
    child(element, childHooks) {
      activeHooks = childHooks
      return childHooks.render(() => element.type(element.props))
    },
    dispose: () => parentHooks.dispose()
  }
}
const panelState = () => ({
  metadata: metadata(),
  review: review(),
  detail: detail(),
  fullFiles: null,
  selectedItemId: ids.file,
  source: 'uncommitted',
  baseRefId: ids.ref,
  commitId: ids.commit,
  hideWhitespace: false,
  busy: null,
  notice: '',
  noticeStatus: '',
  actionResult: null
})

await check(
  'hunk controls use exact main-issued actions, preserve IDs in complete files, and never infer from file actions',
  async () => {
    const state = panelState(),
      f = await panelFixture(state),
      tree = f.render()
    const element = nodes(tree).find(
      (node) => typeof node.type === 'function' && node.props.detail === state.detail
    )
    assert(element)
    const childHooks = hooks()
    const body = f.child(element, childHooks)
    const controls = nodes(body).filter(
      (node) => node.type === 'button' && node.props.title === '暂存此差异块'
    )
    assert.equal(controls.length, 1)
    assert.equal(controls[0].props.disabled, false)
    assert.equal(
      nodes(body).find((node) => node.props['data-hunk-id'] === ids.hunk).type,
      'section'
    )
    const noActions = {
      ...element,
      props: {
        ...element.props,
        detail: {
          ...state.detail,
          hunks: state.detail.hunks.map((hunk) => ({ ...hunk, actions: [] }))
        }
      }
    }
    const next = f.child(noActions, childHooks)
    assert.equal(nodes(next).filter((node) => node.props.title === '暂存此差异块').length, 0)
    assert(textOf(next).includes('请使用文件操作'))
    childHooks.dispose()
    f.dispose()
  }
)

await check(
  'same-path refresh with new file UUID preserves the viewed checkbox and file-tree marker',
  async () => {
    const state = panelState(),
      f = await panelFixture(state)
    const viewed = () =>
      nodes(f.render()).find(
        (node) => node.type === 'input' && node.props['aria-label'] === '标记文件已查看'
      )
    viewed().props.onChange({ target: { checked: true } })
    assert.equal(viewed().props.checked, true)
    const nextId = randomUUID()
    state.review = {
      ...state.review,
      revision: randomUUID(),
      files: state.review.files.map((file) =>
        file.itemId === ids.file ? { ...file, itemId: nextId } : file
      )
    }
    state.selectedItemId = nextId
    state.detail = { ...state.detail, itemId: nextId }
    const panel = f.render()
    assert.equal(viewed().props.checked, true)
    const treeElement = nodes(panel).find(
      (node) =>
        typeof node.type === 'function' &&
        node.props.files === state.review.files &&
        node.props.viewed
    )
    assert(treeElement)
    const childHooks = hooks()
    const tree = f.child(treeElement, childHooks)
    const row = nodes(tree).find(
      (node) => node.type === 'button' && node.props['aria-selected'] === true
    )
    assert(row)
    assert(row.props.className.includes('is-viewed'))
    assert(nodes(row).some((node) => node.props.name === 'check'))
    childHooks.dispose()
    f.dispose()
  }
)

await check('Git preferences validate and store only independent bounded UI defaults', async () => {
  const preferences = await load(sourceNames[4])
  const stored = new Map()
  const storage = {
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => stored.set(key, value)
  }
  assert.equal(preferences.loadGitWorkbenchPreferences(storage).branchPrefix, 'codex/')
  preferences.saveGitWorkbenchPreferences(storage, {
    forceWithLease: true,
    draftPR: false,
    branchPrefix: 'work/',
    commitGuidance: '中文提交',
    prGuidance: 'Explain tests',
    mergeMethod: 'merge'
  })
  assert.deepEqual(preferences.loadGitWorkbenchPreferences(storage), {
    forceWithLease: true,
    draftPR: false,
    branchPrefix: 'work/',
    commitGuidance: '中文提交',
    prGuidance: 'Explain tests',
    mergeMethod: 'merge'
  })
  assert.equal(stored.size, 1)
  assert(stored.has('zonecodex.git-ui.v1'))
  assert.throws(() =>
    preferences.saveGitWorkbenchPreferences(storage, {
      ...preferences.defaultGitWorkbenchPreferences,
      branchPrefix: '../'
    })
  )
  stored.set('zonecodex.git-ui.v1', '{invalid')
  assert.equal(preferences.loadGitWorkbenchPreferences(storage).draftPR, true)
})

await check(
  'settings apply to explicit generation, branch names and one commit-and-push action without hidden submission',
  async () => {
    const state = panelState()
    const remoteId = randomUUID()
    state.metadata.remotes = [
      { remoteId, name: 'origin', url: 'fixture', pushable: true, reason: null }
    ]
    const f = await panelFixture(state)
    nodes(f.render())
      .find((node) => node.type === 'button' && textOf(node) === 'Git 设置…')
      .props.onClick()
    let element = nodes(f.render()).find(
      (node) => typeof node.type === 'function' && node.props.preferences && node.props.onSave
    )
    const settingsHooks = hooks()
    let dialog = f.child(element, settingsHooks)
    const desired = {
      forceWithLease: true,
      draftPR: false,
      branchPrefix: 'work/',
      commitGuidance: '中文提交',
      prGuidance: 'Explain tests',
      mergeMethod: 'merge'
    }
    element.props.onSave(desired)
    assert(f.stored.has('zonecodex.git-ui.v1'))
    assert.equal(f.events.filter(([name]) => name === 'execute' || name === 'generate').length, 0)
    nodes(f.render())
      .find((node) => node.type === 'button' && textOf(node) === '提交并推送')
      .props.onClick()
    element = nodes(f.render()).find(
      (node) => typeof node.type === 'function' && node.props.mode === 'commit-and-push'
    )
    assert(element)
    const actionHooks = hooks()
    dialog = f.child(element, actionHooks)
    const generation = nodes(dialog).find(
      (node) => node.type === 'button' && textOf(node).includes('生成提交说明')
    )
    generation.props.onClick()
    await microtasks()
    assert.deepEqual(f.events.find(([name]) => name === 'generate')[1], {
      purpose: 'commit',
      guidance: '中文提交',
      includeUnstaged: false
    })
    const input = nodes(dialog).find(
      (node) => node.type === 'textarea' && node.props.placeholder === '描述本次改动…'
    )
    input.props.onChange({ target: { value: 'Manual message' } })
    dialog = f.child(element, actionHooks)
    nodes(dialog)
      .find((node) => node.type === 'form')
      .props.onSubmit({
        preventDefault() {
          return undefined
        }
      })
    await microtasks()
    const action = f.events.find(([name]) => name === 'execute')
    assert.deepEqual(action[1], {
      action: 'commit-and-push',
      message: 'Manual message',
      includeUnstaged: false,
      remoteId,
      forceWithLease: true
    })
    assert.equal(action[2], ids.metadata)
    nodes(f.render())
      .find((node) => node.type === 'button' && textOf(node) === '创建并切换分支')
      .props.onClick()
    element = nodes(f.render()).find(
      (node) => typeof node.type === 'function' && node.props.mode === 'create-branch'
    )
    const branchHooks = hooks()
    dialog = f.child(element, branchHooks)
    nodes(dialog)
      .find((node) => node.type === 'input' && node.props.placeholder === 'work/new-branch')
      .props.onChange({ target: { value: 'new-branch' } })
    dialog = f.child(element, branchHooks)
    nodes(dialog)
      .find((node) => node.type === 'form')
      .props.onSubmit({
        preventDefault() {
          return undefined
        }
      })
    await microtasks()
    assert.deepEqual(f.events.filter(([name]) => name === 'execute').at(-1)[1], {
      action: 'create-branch',
      name: 'work/new-branch'
    })
    settingsHooks.dispose()
    actionHooks.dispose()
    branchHooks.dispose()
    f.dispose()
  }
)

await check(
  'initialization adopts only explicit native UUID result; unmount cancels and releases a late owned view',
  async () => {
    const empty = {
      ...panelState(),
      metadata: null,
      review: null,
      detail: null,
      selectedItemId: null
    }
    const f = await panelFixture(empty, { ...emptyView(), open: true })
    const button = nodes(f.render()).find(
      (node) => node.type === 'button' && textOf(node) === '初始化仓库'
    )
    assert.equal(button.props.disabled, false)
    button.props.onClick()
    await microtasks()
    const requestId = f.events.find(([name]) => name === 'initialize')[1]
    assert.match(requestId, uuidPattern)
    assert.equal(
      f.events.some(([name]) => name === 'adopt'),
      false
    )
    f.initialization.resolve({ requestId, status: 'ready', view: readyView().view })
    await microtasks()
    assert.equal(f.events.find(([name]) => name === 'adopt')[1].viewId, ids.view)
    f.dispose()
    const late = await panelFixture(empty, { ...emptyView(), open: true })
    nodes(late.render())
      .find((node) => node.type === 'button' && textOf(node) === '初始化仓库')
      .props.onClick()
    await microtasks()
    const pending = late.events.find(([name]) => name === 'initialize')[1]
    late.dispose()
    await microtasks()
    late.initialization.resolve({ requestId: pending, status: 'ready', view: readyView().view })
    await microtasks()
    assert.equal(
      late.events.some(([name]) => name === 'adopt'),
      false
    )
    assert(late.events.some(([name, id]) => name === 'cancel' && id === pending))
    assert(late.events.some(([name, id]) => name === 'release' && id === ids.view))
  }
)

await check(
  'observer ignores other view and old sequences, debounces a burst and retains selected path across new item IDs',
  async () => {
    const f = await fixture()
    await f.loaded()
    f.invalidate({ viewId: randomUUID(), reason: 'worktree', sequence: 2, status: 'watching' })
    assert.equal(f.render().state.refreshPending, false)
    const event = { viewId: ids.view, reason: 'worktree', sequence: 1, status: 'watching' }
    f.invalidate(event)
    f.render()
    f.invalidate({ ...event, sequence: 2 })
    f.render()
    f.clock.advance(349)
    await f.settle()
    assert.equal(f.calls.filter((call) => call.name === 'getGitMetadata').length, 1)
    f.clock.advance(1)
    await f.settle()
    assert.equal(f.calls.filter((call) => call.name === 'getGitMetadata').length, 2)
    assert.equal(f.render().state.detail.itemId, ids.file)
    f.resolve('getGitMetadata', metadata())
    await f.settle()
    const next = review(),
      nextFile = randomUUID()
    next.files[0] = { ...next.files[0], itemId: nextFile }
    f.resolve('reviewGitChanges', next)
    await f.settle()
    await f.settle()
    assert.equal(f.render().state.selectedItemId, nextFile)
    f.resolve('readGitDiff', detail(nextFile))
    await f.settle()
    f.invalidate(event)
    f.render()
    f.clock.advance(500)
    await f.settle()
    assert.equal(f.calls.filter((call) => call.name === 'getGitMetadata').length, 2)
    f.dispose()
    assert.equal(f.listeners.size, 0)
  }
)
await check(
  'observer waits for a modal and explicit generation to settle without cancellation or hidden writes',
  async () => {
    const f = await fixture()
    await f.loaded()
    f.config.paused = true
    f.render()
    const operation = f.render().generate({ purpose: 'commit' })
    await f.settle()
    f.invalidate({
      viewId: ids.view,
      reason: 'metadata',
      sequence: 1,
      status: 'limited',
      message: 'manual refresh available'
    })
    f.render()
    f.clock.advance(2000)
    await f.settle()
    assert.equal(f.calls.filter((call) => call.name === 'getGitMetadata').length, 1)
    assert.equal(f.calls.filter((call) => call.name === 'cancelGitRead').length, 0)
    f.resolve('generateGitText', { subject: 'candidate', body: '' })
    await operation
    await f.settle()
    f.clock.advance(1000)
    await f.settle()
    assert.equal(f.calls.filter((call) => call.name === 'getGitMetadata').length, 1)
    f.config.paused = false
    f.render()
    f.clock.advance(350)
    await f.settle()
    assert.equal(f.calls.filter((call) => call.name === 'getGitMetadata').length, 2)
    assert.equal(
      f.calls.some((call) => call.name === 'executeGitAction'),
      false
    )
    f.dispose()
  }
)
await check(
  'inactive repository stays local and never overlaps aggregate or neighboring repository reads',
  async () => {
    const f = await fixture(emptyView())
    f.config.view = readyView()
    f.config.active = false
    await f.settle()
    assert.equal(f.calls.length, 0)
    assert.equal(f.listeners.size, 0)
    f.config.active = true
    await f.loaded()
    f.config.active = false
    f.render()
    await f.settle()
    assert.equal(f.listeners.size, 0)
    f.invalidate({ viewId: ids.view, reason: 'worktree', sequence: 1, status: 'watching' })
    f.clock.advance(1000)
    await f.settle()
    assert.equal(f.calls.filter((call) => call.name === 'getGitMetadata').length, 1)
    f.dispose()
  }
)
await check(
  'same owned view reactivation keeps its invalidation sequence and does not invent a second refresh',
  async () => {
    const f = await fixture()
    await f.loaded()
    f.config.paused = true
    f.render()
    f.invalidate({ viewId: ids.view, reason: 'metadata', sequence: 13, status: 'watching' })
    f.render()
    f.config.active = false
    await f.settle()
    assert.equal(f.listeners.size, 0)
    f.config.active = true
    f.config.paused = false
    await f.settle()
    for (let pass = 0; pass < 5 && !f.queued.get('getGitMetadata').length; pass++) await f.settle()
    f.resolve('getGitMetadata', metadata())
    await f.settle()
    f.resolve('reviewGitChanges', review())
    await f.settle()
    await f.settle()
    assert.equal(f.render().state.refreshPending, false)
    f.clock.advance(1000)
    await f.settle()
    assert.equal(f.calls.filter((call) => call.name === 'getGitMetadata').length, 2)
    f.invalidate({ viewId: randomUUID(), reason: 'metadata', sequence: 14, status: 'watching' })
    f.render()
    f.clock.advance(500)
    await f.settle()
    assert.equal(f.calls.filter((call) => call.name === 'getGitMetadata').length, 2)
    f.invalidate({ viewId: ids.view, reason: 'metadata', sequence: 14, status: 'watching' })
    f.render()
    f.clock.advance(350)
    await f.settle()
    assert.equal(f.calls.filter((call) => call.name === 'getGitMetadata').length, 3)
    assert(
      f.calls
        .filter((call) => call.name === 'getGitMetadata')
        .every((call) => call.request.viewId === ids.view)
    )
    f.dispose()
  }
)

await check(
  'failed automatic read stops until a new invalidation or manual refresh instead of retrying forever',
  async () => {
    const f = await fixture()
    await f.loaded()
    f.invalidate({ viewId: ids.view, reason: 'worktree', sequence: 1, status: 'watching' })
    f.render()
    f.clock.advance(350)
    await f.settle()
    f.resolve('getGitMetadata', null, 'error')
    await f.settle()
    f.clock.advance(2000)
    await f.settle()
    assert.equal(f.calls.filter((call) => call.name === 'getGitMetadata').length, 2)
    assert.equal(f.render().state.refreshPending, false)
    f.dispose()
  }
)

function guardedAPI(api) {
  return new Proxy(api, {
    get(object, key) {
      assert(
        Object.hasOwn(object, key),
        'Unexpected Agent, PTY, storage or grant API ' + String(key)
      )
      return object[key]
    }
  })
}
async function collectionFixture() {
  const harness = hooks(),
    selection = deferred(),
    calls = []
  const config = { blocked: false, releaseError: false, hostViews: [] }
  globalThis.document = { querySelector: () => null }
  globalThis.window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    api: guardedAPI({
      selectGitDirectories: async (requestId) => {
        calls.push(['select', requestId])
        return selection.promise
      },
      cancelGitRead: async (requestId) => {
        calls.push(['cancel', requestId])
        return { status: 'ready' }
      },
      releaseGitView: async (viewId) => {
        calls.push(['release', viewId])
        return config.releaseError
          ? { status: 'error', error: 'cleanup unconfirmed' }
          : { status: 'ready' }
      },
      getGitRepositories: async (requestId) => {
        calls.push(['collection', requestId])
        return {
          requestId,
          status: 'ready',
          views: config.hostViews,
          addedViewIds: [],
          warnings: [],
          limit: 8
        }
      }
    })
  }
  globalThis.requestAnimationFrame = (callback) => callback()
  const module = await load(sourceNames[5], { react: harness.react })
  const render = () => harness.render(() => module.useGitRepositories(true, config.blocked))
  render().open({ isConnected: false })
  render()
  return { render, calls, selection, config, dispose: () => harness.dispose() }
}
await check(
  'native multi-selection adopts only bound owned scopes; close releases every scope and preserves no path grants',
  async () => {
    const f = await collectionFixture()
    const promise = f.render().selectDirectory()
    const second = {
      ...readyView().view,
      viewId: randomUUID(),
      repositoryPath: 'D:/fixture/second',
      selectedPath: 'D:/fixture/second'
    }
    const first = readyView().view
    f.selection.resolve({
      requestId: f.calls[0][1],
      status: 'ready',
      views: [first, second],
      addedViewIds: [first.viewId, second.viewId],
      warnings: [],
      limit: 8
    })
    await promise
    assert.equal(f.render().views.length, 2)
    f.render().selectRepository('all')
    assert.equal(f.render().selected, 'all')
    f.render().close(false)
    await microtasks()
    assert.deepEqual(
      f.calls.filter((call) => call[0] === 'release').map((call) => call[1]),
      [first.viewId, second.viewId]
    )
    assert.equal(f.render().views.length, 0)
    f.dispose()
  }
)
await check(
  'late multi-selection after close releases added scopes and cannot resurrect a repository panel',
  async () => {
    const f = await collectionFixture()
    const promise = f.render().selectDirectory(),
      requestId = f.calls[0][1]
    f.render().close(false)
    const view = readyView().view
    f.selection.resolve({
      requestId,
      status: 'ready',
      views: [view],
      addedViewIds: [view.viewId],
      warnings: [],
      limit: 8
    })
    await promise
    assert.equal(f.render().state.open, false)
    assert(f.calls.some((call) => call[0] === 'release' && call[1] === view.viewId))
    f.dispose()
  }
)

await check(
  'failed repository release preserves the owned scope and cleanup failure across close and reopen',
  async () => {
    const f = await collectionFixture()
    const operation = f.render().selectDirectory(),
      view = readyView().view
    f.selection.resolve({
      requestId: f.calls[0][1],
      status: 'ready',
      views: [view],
      addedViewIds: [view.viewId],
      warnings: [],
      limit: 8
    })
    await operation
    f.config.releaseError = true
    f.config.hostViews = [view]
    await f.render().removeRepository(view.viewId)
    assert.equal(f.render().views.length, 1)
    assert.equal(f.render().cleanupError, 'cleanup unconfirmed')
    f.render().close(false)
    await microtasks()
    f.render().open({ isConnected: false })
    await microtasks()
    assert.equal(f.render().views.length, 1)
    assert.equal(f.render().cleanupError, 'cleanup unconfirmed')
    const before = f.calls.filter((call) => call[0] === 'select').length
    await f.render().selectDirectory()
    assert.equal(f.calls.filter((call) => call[0] === 'select').length, before)
    f.dispose()
  }
)

async function aggregateFixture(failure = false) {
  const harness = hooks(),
    clock = new FakeClock(),
    calls = [],
    listeners = new Set()
  const second = {
    ...readyView().view,
    viewId: randomUUID(),
    repositoryPath: 'D:/fixture/second',
    selectedPath: 'D:/fixture/second'
  }
  const scopes = [readyView().view, second]
  const config = { blocked: false, transportHold: null, transportError: false }
  globalThis.window = {
    api: guardedAPI({
      onGitInvalidated: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      getGitMetadata: async (request) => {
        calls.push(['metadata', request])
        if (config.transportHold) await config.transportHold.promise
        if (config.transportError) throw new Error('aggregate transport unavailable')
        return { ...request, status: 'ready', data: metadata() }
      },
      reviewGitChanges: async (request) => {
        calls.push(['review', request])
        return { ...request, status: 'ready', data: { ...review(), revision: request.viewId } }
      },
      executeGitAction: async (request) => {
        calls.push(['action', request])
        return failure
          ? { ...request, status: 'error', error: 'write stopped' }
          : {
              ...request,
              status: 'ready',
              data: {
                outcome: 'success',
                stage: request.action,
                appliedItemIds: request.itemIds,
                message: 'done'
              }
            }
      },
      cancelGitRead: async (requestId) => {
        calls.push(['cancel', requestId])
        return { status: 'ready' }
      }
    })
  }
  const controller = {
    state: readyView(),
    views: scopes,
    selected: 'all',
    selecting: false,
    cleanupError: '',
    close: () => {},
    selectDirectory: async () => {},
    adoptView: () => {},
    removeRepository: async () => {},
    selectRepository: (id) => {
      calls.push(['select', id])
      controller.selected = id
    }
  }
  const module = await load(
    sourceNames[6],
    {
      react: harness.react,
      'react/jsx-runtime': jsxRuntime,
      './GitWorkbenchPanel': { GitWorkbenchPanel: () => null },
      '../../components/ui/Icon': { Icon: () => null }
    },
    { clock }
  )
  const render = () =>
    harness.render(() =>
      module.GitRepositoriesPanel({ controller, directoryDisabled: config.blocked })
    )
  render()
  render()
  clock.advance(350)
  await microtasks()
  render()
  return { render, calls, controller, config, clock, listeners, dispose: () => harness.dispose() }
}
await check(
  'All repos reads and batch stage bind one repository revision at a time and show per-repository outcomes',
  async () => {
    const f = await aggregateFixture()
    assert.deepEqual(
      f.calls.slice(0, 4).map((call) => call[0]),
      ['metadata', 'review', 'metadata', 'review']
    )
    const stage = nodes(f.render()).find(
      (node) => node.type === 'button' && textOf(node) === '暂存全部仓库'
    )
    assert(stage)
    stage.props.onClick()
    await microtasks()
    f.render()
    const writes = f.calls.filter((call) => call[0] === 'action').map((call) => call[1])
    assert.equal(writes.length, 2)
    assert.equal(new Set(writes.map((request) => request.requestId)).size, 2)
    assert(writes.every((request) => request.viewId === request.revision))
    assert(textOf(f.render()).includes('done'))
    assert.equal(
      f.calls.some((call) => ['commit', 'push', 'generate'].includes(call[0])),
      false
    )
    f.dispose()
    assert.equal(f.listeners.size, 0)
  }
)
await check(
  'All repos stops after an unconfirmed write and never touches the following repository',
  async () => {
    const f = await aggregateFixture(true)
    nodes(f.render())
      .find((node) => node.type === 'button' && textOf(node) === '暂存全部仓库')
      .props.onClick()
    await microtasks()
    f.render()
    assert.equal(f.calls.filter((call) => call[0] === 'action').length, 1)
    assert(textOf(f.render()).includes('write stopped'))
    f.dispose()
  }
)

await check(
  'All repos transport failure preserves old groups, pauses automatic retries and resumes only on a new event or manual refresh',
  async () => {
    const f = await aggregateFixture()
    const oldRows = textOf(f.render())
    f.config.transportHold = deferred()
    const event = { viewId: ids.view, reason: 'metadata', sequence: 1, status: 'watching' }
    for (const listener of f.listeners) listener(event)
    f.render()
    f.clock.advance(350)
    f.render()
    f.config.transportError = true
    f.config.transportHold.resolve()
    await microtasks()
    f.render()
    f.config.transportHold = null
    const count = f.calls.filter((call) => call[0] === 'metadata').length
    for (let round = 0; round < 5; round++) {
      f.clock.advance(700)
      f.render()
      await microtasks()
      f.render()
    }
    assert.equal(f.calls.filter((call) => call[0] === 'metadata').length, count)
    assert(textOf(f.render()).includes('aggregate transport unavailable'))
    assert(oldRows.includes('a.md'))
    assert(textOf(f.render()).includes('a.md'))
    for (const listener of f.listeners) listener({ ...event, sequence: 2 })
    f.render()
    f.clock.advance(350)
    f.render()
    await microtasks()
    f.render()
    assert.equal(f.calls.filter((call) => call[0] === 'metadata').length, count + 1)
    nodes(f.render())
      .find((node) => node.props['aria-label'] === '刷新全部仓库')
      .props.onClick()
    f.render()
    await microtasks()
    f.render()
    assert.equal(f.calls.filter((call) => call[0] === 'metadata').length, count + 2)
    f.dispose()
  }
)
await check(
  'All repos source switch immediately disables old-source writes until its own review finishes',
  async () => {
    const f = await aggregateFixture()
    nodes(f.render())
      .find((node) => node.type === 'select' && node.props['aria-label'] === '全部仓库差异来源')
      .props.onChange({ target: { value: 'staged' } })
    const button = nodes(f.render()).find(
      (node) => node.type === 'button' && textOf(node) === '暂存全部仓库'
    )
    assert.equal(button.props.disabled, true)
    button.props.onClick()
    await microtasks()
    assert.equal(f.calls.filter((call) => call[0] === 'action').length, 0)
    f.dispose()
  }
)

async function prFixture() {
  const harness = hooks(),
    calls = []
  const remoteId = randomUUID(),
    prId = randomUUID(),
    prRevision = randomUUID()
  const meta = {
    ...metadata(),
    remotes: [
      {
        remoteId,
        name: 'origin',
        url: 'https://github.com/fixture/repo.git',
        pushable: true,
        reason: null
      }
    ]
  }
  const item = {
    prId,
    number: 12,
    title: 'Fixture PR',
    url: 'https://github.com/fixture/repo/pull/12',
    state: 'OPEN',
    draft: false,
    headRefName: 'work',
    baseRefName: 'main',
    author: 'fixture'
  }
  const info = {
    ...item,
    repository: 'fixture/repo',
    account: 'fixture-user',
    prRevision,
    body: 'description',
    headOid: 'a'.repeat(40),
    baseOid: 'b'.repeat(40),
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    mergeMethods: ['squash', 'merge'],
    checks: [{ name: 'tests', status: 'success' }]
  }
  globalThis.window = {
    api: guardedAPI({
      getGitPullRequests: async (request) => {
        calls.push(['list', request])
        return {
          ...request,
          status: 'ready',
          data: { repository: info.repository, account: info.account, items: [item], capped: false }
        }
      },
      getGitPullRequest: async (request) => {
        calls.push(['detail', request])
        return { ...request, status: 'ready', data: info }
      },
      mergeGitPullRequest: async (request) => {
        calls.push(['merge', request])
        return {
          ...request,
          status: 'ready',
          data: { prId, number: 12, url: item.url, outcome: 'success', message: 'merged' }
        }
      },
      cancelGitRead: async () => ({ status: 'ready' })
    })
  }
  const module = await load(sourceNames[7], {
    react: harness.react,
    'react/jsx-runtime': jsxRuntime,
    'react-markdown': () => null,
    'remark-gfm': () => null
  })
  const render = () =>
    harness.render(() =>
      module.GitPullRequestDialog({
        viewId: ids.view,
        metadata: meta,
        defaultMethod: 'squash',
        onCancel: () => calls.push(['close']),
        onChanged: () => calls.push(['changed'])
      })
    )
  return { render, calls, prId, prRevision, dispose: () => harness.dispose() }
}
await check(
  'PR list and details require manual clicks and show account, status and checks without model activity',
  async () => {
    const f = await prFixture()
    let tree = f.render()
    assert.equal(f.calls.length, 0)
    nodes(tree)
      .find((node) => node.type === 'button' && textOf(node) === '查看 PR')
      .props.onClick()
    await microtasks()
    tree = f.render()
    nodes(tree)
      .find((node) => node.type === 'button' && textOf(node).includes('Fixture PR'))
      .props.onClick()
    await microtasks()
    tree = f.render()
    assert(textOf(tree).includes('fixture-user'))
    assert(textOf(tree).includes('通过'))
    assert.deepEqual(
      f.calls.map((call) => call[0]),
      ['list', 'detail']
    )
    assert.equal(f.calls[1][1].prId, f.prId)
    f.dispose()
  }
)
await check(
  'PR merge needs two explicit clicks, uses owned PR revision and never auto-merges on a successful check',
  async () => {
    const f = await prFixture()
    nodes(f.render())
      .find((node) => node.type === 'button' && textOf(node) === '查看 PR')
      .props.onClick()
    await microtasks()
    nodes(f.render())
      .find((node) => node.type === 'button' && textOf(node).includes('Fixture PR'))
      .props.onClick()
    await microtasks()
    nodes(f.render())
      .find((node) => node.type === 'button' && textOf(node) === '合并 PR…')
      .props.onClick()
    assert.equal(f.calls.filter((call) => call[0] === 'merge').length, 0)
    nodes(f.render())
      .find((node) => node.type === 'button' && textOf(node) === '确认合并')
      .props.onClick()
    await microtasks()
    const write = f.calls.find((call) => call[0] === 'merge')[1]
    assert.equal(write.prId, f.prId)
    assert.equal(write.prRevision, f.prRevision)
    assert.equal(write.method, 'squash')
    assert.equal(write.viewId, ids.view)
    assert(uuidPattern.test(write.requestId))
    assert.equal(write.revision, ids.metadata)
    assert(textOf(f.render()).includes('已合并'))
    f.dispose()
  }
)

await finish()
