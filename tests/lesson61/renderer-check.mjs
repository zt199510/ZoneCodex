import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { createEvidence, checksFor, hash, root } from './runtime.mjs'

const { load, microtasks } = createRequire(import.meta.url)('../lesson55/shared/harness.cjs')
const evidence = await createEvidence('renderer')
const { check, finish } = checksFor(evidence, {
  classification: 'actual current Hook/JSX callbacks with synthetic React, DOM and Git API',
  syntheticReact: true,
  syntheticGitAPI: true,
  realDOM: false,
  actualGitProcess: false,
  actualElectron: false,
  actualPTY: false,
  modelTransport: false
})
const sources = [
  'src/renderer/src/features/git/useGitView.ts',
  'src/renderer/src/features/git/GitViewPanel.tsx',
  'src/renderer/src/features/git/git-presentation.ts',
  'src/renderer/src/assets/git.css',
  'src/renderer/src/App.tsx',
  'src/renderer/src/components/layout/TitleBar.tsx'
]
await fs.writeFile(
  path.join(evidence, 'source-identity.json'),
  JSON.stringify(
    Object.fromEntries(
      await Promise.all(
        sources.map(async (name) => [name, hash(await fs.readFile(path.join(root, name)))])
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
  const changed = (before, next) =>
    !before ||
    !next ||
    before.length !== next.length ||
    before.some((value, i) => !Object.is(value, next[i]))
  const effect = (action, deps) => {
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
  const react = {
    useState(initial) {
      const key = index++
      slots[key] ??= { value: typeof initial === 'function' ? initial() : initial }
      return [
        slots[key].value,
        (next) => {
          slots[key].value = typeof next === 'function' ? next(slots[key].value) : next
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
  }
  return {
    react,
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
const jsx = (type, props) => ({ type, props: props ?? {} })
const jsxRuntime = { jsx, jsxs: jsx, Fragment: 'fragment' }
globalThis.React = {
  createElement: (type, props, ...children) => jsx(type, { ...props, children }),
  Fragment: 'fragment'
}
const marker = (name) => Object.assign(() => null, { displayName: name })
function nodes(value) {
  if (Array.isArray(value)) return value.flatMap(nodes)
  return value && typeof value === 'object' ? [value, ...nodes(value.props?.children)] : []
}
const textOf = (value) =>
  Array.isArray(value)
    ? value.map(textOf).join('')
    : value && typeof value === 'object'
      ? textOf(value.props?.children)
      : typeof value === 'string' || typeof value === 'number'
        ? String(value)
        : ''
const item = (id, group = 'unstaged', extra = {}) => ({
  itemId: id,
  group,
  change: 'modified',
  path: 'same.txt',
  previousPath: null,
  previewable: true,
  reason: null,
  ...extra
})
const view = (id = 'view-a') => ({
  viewId: id,
  selectedPath: 'D:\\fixture\\repo\\sub',
  repositoryPath: 'D:\\fixture\\repo',
  scopePath: 'sub',
  gitVersion: 'git version fixture',
  head: 'present',
  linkedWorktree: false
})
const detail = (
  request,
  selected,
  text = '--- a/same.txt\n+++ b/same.txt\n@@ -1 +1 @@\n-old\n+new\n'
) => ({
  ...request,
  status: 'ready',
  item: selected,
  format: 'diff',
  baseline: selected.group === 'staged' ? 'head-index' : 'index-worktree',
  text,
  bytes: Buffer.byteLength(text),
  lineCount: text.split('\n').length
})

async function fixture() {
  const harness = hooks(),
    listeners = new Map(),
    calls = [],
    selections = [],
    lists = [],
    reads = [],
    frames = []
  const config = {
    active: true,
    blocked: false,
    modal: false,
    cancelResult: { status: 'ready' },
    releaseResult: { status: 'ready' }
  }
  const target = {
    isConnected: true,
    getClientRects: () => [1],
    closest: () => null,
    matches: () => false,
    focusCalls: 0,
    focus() {
      this.focusCalls += 1
    }
  }
  globalThis.document = { querySelector: () => (config.modal ? {} : null), activeElement: null }
  globalThis.requestAnimationFrame = (action) => {
    frames.push(action)
    return frames.length
  }
  globalThis.window = {
    addEventListener(name, action) {
      listeners.set(name, action)
    },
    removeEventListener(name, action) {
      if (listeners.get(name) === action) listeners.delete(name)
    },
    api: new Proxy(
      {
        selectGitDirectory(requestId) {
          calls.push(['select', requestId])
          const held = deferred()
          selections.push({ requestId, ...held })
          return held.promise
        },
        refreshGitView(request) {
          calls.push(['list', request])
          const held = deferred()
          lists.push({ request, ...held })
          return held.promise
        },
        readGitItem(request) {
          calls.push(['read', request])
          const held = deferred()
          reads.push({ request, ...held })
          return held.promise
        },
        cancelGitRead(requestId) {
          calls.push(['cancel', requestId])
          return Promise.resolve(config.cancelResult)
        },
        releaseGitView(viewId) {
          calls.push(['release', viewId])
          return Promise.resolve(config.releaseResult)
        }
      },
      {
        get(object, name) {
          assert.ok(
            Object.hasOwn(object, name),
            'No Agent, PTY, storage or workspace API access: ' + String(name)
          )
          return object[name]
        }
      }
    )
  }
  const module = await load('src/renderer/src/features/git/useGitView.ts', { react: harness.react })
  const render = () => harness.render(() => module.useGitView(config.active, config.blocked))
  render()
  const open = () => {
    render().open(target)
    return render()
  }
  async function select(items = [item('item-a'), item('item-b', 'staged')], selectedView = view()) {
    const action = render().selectDirectory()
    await microtasks()
    const selection = selections.at(-1)
    selection.resolve({ status: 'ready', requestId: selection.requestId, view: selectedView })
    await microtasks()
    const listing = lists.at(-1)
    listing.resolve({
      ...listing.request,
      status: 'ready',
      revision: 'revision-' + lists.length,
      items,
      warnings: []
    })
    await action
    return render()
  }
  return {
    render,
    open,
    select,
    calls,
    selections,
    lists,
    reads,
    config,
    target,
    frames,
    listeners,
    dispose: () => harness.dispose()
  }
}

await check(
  'mount and opening the panel make zero APIs; reopening requires a new independent selection',
  async () => {
    const f = await fixture()
    assert.equal(f.render().state.open, false)
    assert.equal(f.open().state.open, true)
    assert.deepEqual(f.calls, [])
    await f.select()
    f.render().close()
    await microtasks()
    assert.equal(f.open().state.view, null)
    assert.equal(f.render().state.list, null)
    assert.equal(f.calls.filter(([name]) => name === 'select').length, 1)
    f.dispose()
  }
)
await check(
  'explicit selection queries exactly once and keeps same-path staged and unstaged identities',
  async () => {
    const f = await fixture()
    f.open()
    const state = (await f.select()).state
    assert.equal(f.calls.filter(([name]) => name === 'list').length, 1)
    assert.equal(state.view.scopePath, 'sub')
    assert.deepEqual(
      state.list.items.map(({ itemId, group, path }) => [itemId, group, path]),
      [
        ['item-a', 'unstaged', 'same.txt'],
        ['item-b', 'staged', 'same.txt']
      ]
    )
    f.render()
    f.render()
    assert.equal(f.calls.filter(([name]) => name === 'list').length, 1)
    f.dispose()
  }
)
await check(
  'cancelled native selection preserves the previous scope/list and does not refresh it',
  async () => {
    const f = await fixture()
    f.open()
    await f.select()
    const action = f.render().selectDirectory()
    await microtasks()
    const pending = f.selections.at(-1)
    pending.resolve({ status: 'cancelled', requestId: pending.requestId })
    await action
    assert.equal(f.render().state.view.viewId, 'view-a')
    assert.equal(f.render().state.list.revision, 'revision-1')
    assert.equal(f.calls.filter(([name]) => name === 'list').length, 1)
    f.dispose()
  }
)
await check(
  'rapid item switches cancel the old request and a late first result cannot replace the second detail',
  async () => {
    const f = await fixture()
    f.open()
    await f.select()
    const [a, b] = f.render().state.list.items
    const first = f.render().readItem(a)
    await microtasks()
    const old = f.reads.at(-1)
    const second = f.render().readItem(b)
    await microtasks()
    const latest = f.reads.at(-1)
    assert.equal(f.render().state.detail, null)
    assert.ok(f.calls.some(([name, id]) => name === 'cancel' && id === old.request.requestId))
    latest.resolve(detail(latest.request, b, '+SECOND'))
    await second
    old.resolve(detail(old.request, a, '+OLD'))
    await first
    assert.equal(f.render().state.detail.text, '+SECOND')
    assert.equal(f.render().state.selectedItemId, b.itemId)
    f.dispose()
  }
)
await check(
  'refresh clears old content, cancels reading and rejects items from the old list revision',
  async () => {
    const f = await fixture()
    f.open()
    await f.select()
    const oldItem = f.render().state.list.items[0]
    const first = f.render().readItem(oldItem)
    await microtasks()
    const old = f.reads.at(-1)
    const refresh = f.render().refresh()
    await microtasks()
    assert.equal(f.render().state.list, null)
    assert.equal(f.render().state.detail, null)
    const fresh = f.lists.at(-1)
    fresh.resolve({
      ...fresh.request,
      status: 'ready',
      revision: 'fresh-revision',
      items: [item('fresh-item')],
      warnings: []
    })
    await refresh
    old.resolve(detail(old.request, oldItem, 'LATE'))
    await first
    await f.render().readItem(oldItem)
    assert.equal(f.reads.length, 1)
    assert.equal(f.render().state.detail, null)
    assert.equal(f.render().state.list.revision, 'fresh-revision')
    f.dispose()
  }
)
await check(
  'close invalidates immediately, cancels and releases exact identities; late read is discarded and focus returns',
  async () => {
    const f = await fixture()
    f.open()
    await f.select()
    const selected = f.render().state.list.items[0]
    const action = f.render().readItem(selected)
    await microtasks()
    const old = f.reads.at(-1)
    f.render().close()
    assert.equal(f.render().state.open, false)
    assert.equal(f.render().state.view, null)
    await microtasks()
    assert.ok(f.calls.some(([name, id]) => name === 'cancel' && id === old.request.requestId))
    assert.ok(f.calls.some(([name, id]) => name === 'release' && id === 'view-a'))
    old.resolve(detail(old.request, selected, 'LATE'))
    await action
    assert.equal(f.render().state.detail, null)
    f.frames.forEach((action) => action())
    assert.equal(f.target.focusCalls, 1)
    f.dispose()
  }
)
await check(
  'closing during a chooser releases its late scope without querying or reopening the panel',
  async () => {
    const f = await fixture()
    f.open()
    const action = f.render().selectDirectory()
    await microtasks()
    const old = f.selections.at(-1)
    f.render().close()
    f.open()
    old.resolve({ status: 'ready', requestId: old.requestId, view: view('late-view') })
    await action
    assert.equal(f.render().state.view, null)
    assert.equal(f.lists.length, 0)
    assert.ok(f.calls.some(([name, id]) => name === 'release' && id === 'late-view'))
    f.dispose()
  }
)
await check(
  'replacement directory discards pending old detail and makes one new listing from the returned scope',
  async () => {
    const f = await fixture()
    f.open()
    await f.select()
    const oldItem = f.render().state.list.items[0]
    const reading = f.render().readItem(oldItem)
    await microtasks()
    const old = f.reads.at(-1)
    await f.select([item('new-item')], view('view-b'))
    old.resolve(detail(old.request, oldItem, 'OLD-REPOSITORY'))
    await reading
    assert.equal(f.render().state.view.viewId, 'view-b')
    assert.equal(f.render().state.list.viewId, 'view-b')
    assert.equal(f.render().state.detail, null)
    assert.equal(f.lists.length, 2)
    f.dispose()
  }
)
await check(
  'settings hide retains state, blocks actions and returning does not trigger a query',
  async () => {
    const f = await fixture()
    f.open()
    await f.select()
    const old = f.calls.length
    f.config.active = false
    await f.render().selectDirectory()
    await f.render().refresh()
    await f.render().readItem(f.render().state.list.items[0])
    assert.equal(f.calls.length, old)
    assert.equal(f.render().state.view.viewId, 'view-a')
    f.config.active = true
    f.render()
    assert.equal(f.calls.length, old)
    f.dispose()
  }
)
await check(
  'modal or question wait blocks a new chooser; existing scope still allows reads and refresh when only directory selection is blocked',
  async () => {
    const f = await fixture()
    f.open()
    await f.select()
    f.config.modal = true
    const count = f.selections.length
    await f.render().selectDirectory()
    f.config.modal = false
    f.config.blocked = true
    await f.render().selectDirectory()
    assert.equal(f.selections.length, count)
    const selected = f.render().state.list.items[0]
    const action = f.render().readItem(selected)
    await microtasks()
    const read = f.reads.at(-1)
    read.resolve(detail(read.request, selected))
    await action
    assert.equal(f.render().state.detail.item.itemId, selected.itemId)
    const refresh = f.render().refresh()
    await microtasks()
    const listing = f.lists.at(-1)
    listing.resolve({
      ...listing.request,
      status: 'ready',
      revision: 'busy-refresh',
      items: [],
      warnings: []
    })
    await refresh
    assert.equal(f.render().state.list.revision, 'busy-refresh')
    f.dispose()
  }
)
await check(
  'stale item response clears obsolete list and body, leaving an explicit refresh notice',
  async () => {
    const f = await fixture()
    f.open()
    await f.select()
    const action = f.render().readItem(f.render().state.list.items[0])
    await microtasks()
    const read = f.reads.at(-1)
    read.resolve({ ...read.request, status: 'stale', error: '文件已变化' })
    await action
    assert.equal(f.render().state.list, null)
    assert.equal(f.render().state.detail, null)
    assert.equal(f.render().state.notice.status, 'stale')
    f.dispose()
  }
)
await check(
  'unsupported item displays its reason without issuing an arbitrary file read',
  async () => {
    const f = await fixture()
    f.open()
    await f.select([
      item('special', 'unstaged', { previewable: false, reason: '符号链接不跟随读取' })
    ])
    await f.render().readItem(f.render().state.list.items[0])
    assert.equal(f.reads.length, 0)
    assert.match(f.render().state.notice.error, /不跟随/)
    assert.equal(f.render().state.selectedItemId, 'special')
    f.dispose()
  }
)
await check(
  'failed refresh never leaves an old complete list and too-large stays explicit',
  async () => {
    const f = await fixture()
    f.open()
    await f.select()
    const action = f.render().refresh()
    await microtasks()
    const listing = f.lists.at(-1)
    listing.resolve({ ...listing.request, status: 'too-large', error: '状态超过 1 MiB' })
    await action
    assert.equal(f.render().state.list, null)
    assert.equal(f.render().state.detail, null)
    assert.equal(f.render().state.notice.status, 'too-large')
    f.dispose()
  }
)
await check(
  'failed cancel exposes cleanup uncertainty and launches no replacement read before confirmation',
  async () => {
    const f = await fixture()
    f.open()
    await f.select()
    const selected = f.render().state.list.items[0]
    const action = f.render().readItem(selected)
    await microtasks()
    const old = f.reads.at(-1),
      count = f.lists.length
    f.config.cancelResult = { status: 'error', error: '受控取消失败' }
    await f.render().refresh()
    assert.equal(f.lists.length, count)
    assert.match(f.render().cleanupError, /受控取消失败/)
    assert.match(f.render().state.notice.error, /尚未确认/)
    f.config.cancelResult = { status: 'ready' }
    old.resolve(detail(old.request, selected, 'INVALIDATED'))
    await action
    assert.equal(f.render().state.detail, null)
    f.dispose()
  }
)
await check(
  'document disposal cancels and releases; a late chooser scope is released without state revival',
  async () => {
    const f = await fixture()
    f.open()
    await f.select()
    const action = f.render().selectDirectory()
    await microtasks()
    const old = f.selections.at(-1)
    f.dispose()
    await microtasks()
    old.resolve({ status: 'ready', requestId: old.requestId, view: view('after-disposal') })
    await action
    assert.equal(f.lists.length, 1)
    assert.ok(f.calls.some(([name, id]) => name === 'cancel' && id === old.requestId))
    assert.ok(f.calls.some(([name, id]) => name === 'release' && id === 'view-a'))
    assert.ok(f.calls.some(([name, id]) => name === 'release' && id === 'after-disposal'))
  }
)
await check(
  'foreign selection echo releases the scope and exits loading with a stale notice',
  async () => {
    const f = await fixture()
    f.open()
    const action = f.render().selectDirectory()
    await microtasks()
    f.selections
      .at(-1)
      .resolve({ status: 'ready', requestId: 'foreign-request', view: view('foreign-view') })
    await action
    assert.equal(f.render().state.phase, 'error')
    assert.equal(f.render().state.notice.status, 'stale')
    assert.equal(f.lists.length, 0)
    assert.ok(f.calls.some(([name, id]) => name === 'release' && id === 'foreign-view'))
    f.dispose()
  }
)
await check(
  'right request echo with a wrong returned item/path cannot display foreign content',
  async () => {
    const f = await fixture()
    f.open()
    await f.select()
    const action = f.render().readItem(f.render().state.list.items[0])
    await microtasks()
    const read = f.reads.at(-1)
    read.resolve(
      detail(
        read.request,
        item(read.request.itemId, 'unstaged', { path: 'foreign.txt' }),
        'FOREIGN'
      )
    )
    await action
    assert.equal(f.render().state.detail, null)
    assert.equal(f.render().state.list, null)
    assert.equal(f.render().state.notice.status, 'stale')
    f.dispose()
  }
)
await check(
  'plain-text JSX preserves HTML as text, makes ESC/bidi controls visible and colors only native diff rows',
  async () => {
    const presentation = await load('src/renderer/src/features/git/git-presentation.ts')
    const payload = '<img src=x onerror=alert(1)>\x1b[31m\u202eEVIL'
    assert.match(presentation.visibleGitText(payload), /⟨U\+001B⟩/)
    assert.match(presentation.visibleGitText(payload), /⟨U\+202E⟩/)
    assert.deepEqual(
      presentation
        .gitDisplayRows('--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new', 'diff')
        .map((row) => row.kind),
      ['meta', 'meta', 'meta', 'remove', 'add']
    )
    const harness = hooks()
    const module = await load('src/renderer/src/features/git/GitViewPanel.tsx', {
      react: harness.react,
      'react/jsx-runtime': jsxRuntime,
      '../../components/ui/Icon': { Icon: marker('Icon') }
    })
    const selected = item('malicious', 'untracked', { path: payload })
    let closeCalls = 0
    const tree = harness.render(() =>
      module.GitViewPanel({
        state: {
          open: true,
          phase: 'ready',
          view: view(),
          list: {
            status: 'ready',
            requestId: 'r',
            viewId: 'view-a',
            revision: 'v',
            items: [selected],
            warnings: []
          },
          selectedItemId: selected.itemId,
          detailLoading: false,
          notice: null,
          detail: {
            ...detail(
              { requestId: 'r', viewId: 'view-a', revision: 'v', itemId: selected.itemId },
              selected,
              payload
            ),
            format: 'content',
            baseline: 'untracked'
          }
        },
        cleanupError: '',
        directoryDisabled: false,
        onSelectDirectory: async () => {},
        onRefresh: async () => {},
        onReadItem: async () => {},
        onClose() {
          closeCalls += 1
        }
      })
    )
    assert.equal(
      nodes(tree).some((node) => node.props?.dangerouslySetInnerHTML),
      false
    )
    assert.equal(
      nodes(tree).some((node) => node.type === 'img' || node.type === 'script'),
      false
    )
    assert.match(textOf(tree), /<img src=x onerror=alert\(1\)>/)
    assert.match(textOf(tree), /没有 Git 基线/)
    assert.match(textOf(tree), /⟨U\+001B⟩/)
    assert.ok(nodes(tree).some((node) => node.props?.id === 'git-panel'))
    nodes(tree)
      .find((node) => node.props?.id === 'git-panel-close')
      .props.onClick()
    assert.equal(closeCalls, 1)
    harness.dispose()
  }
)

await check(
  'replacement read waits for the old cancellation confirmation and closing during that wait launches nothing',
  async () => {
    const f = await fixture()
    f.open()
    await f.select()
    const [a, b] = f.render().state.list.items
    const first = f.render().readItem(a)
    await microtasks()
    const old = f.reads.at(-1),
      held = deferred()
    f.config.cancelResult = held.promise
    const replacement = f.render().readItem(b)
    await microtasks()
    assert.equal(f.reads.length, 1)
    f.render().close(false)
    held.resolve({ status: 'ready' })
    await replacement
    old.resolve(detail(old.request, a))
    await first
    assert.equal(f.reads.length, 1)
    assert.equal(f.render().state.open, false)
    f.dispose()
  }
)

await check(
  'Escape respects a modal owner; an ordinary Escape closes Git and consumes the event before shell shortcuts',
  async () => {
    const f = await fixture()
    f.open()
    let prevented = 0,
      stopped = 0
    const event = {
      key: 'Escape',
      defaultPrevented: false,
      preventDefault() {
        prevented += 1
      },
      stopImmediatePropagation() {
        stopped += 1
      }
    }
    f.config.modal = true
    f.listeners.get('keydown')(event)
    assert.equal(f.render().state.open, true)
    assert.equal(prevented, 0)
    f.config.modal = false
    f.listeners.get('keydown')(event)
    assert.equal(f.render().state.open, false)
    assert.equal(prevented, 1)
    assert.equal(stopped, 1)
    f.dispose()
  }
)

await check(
  'actual App callbacks preserve new sidebar wiring, mutually replace Git/FileView and keep the mounted terminal hidden in settings',
  async () => {
    const harness = hooks(),
      calls = [],
      frames = []
    const sidebar = marker('Sidebar'),
      title = marker('TitleBar'),
      chat = marker('ChatWorkspace'),
      files = marker('FileViewPanel'),
      git = marker('GitWorkbenchPanel'),
      terminal = marker('TerminalPanel')
    let gitOpen = false,
      fileState = { status: 'idle' }
    const controller = {
      canNavigate: false,
      pendingPlanQuestion: null,
      setSearch: (value) => calls.push(['search', value]),
      select: async () => true
    }
    const gitController = {
      cleanupError: '',
      open: (trigger) => {
        calls.push(['git-open', trigger])
        gitOpen = true
      },
      close: (restore = true) => {
        calls.push(['git-close', restore])
        gitOpen = false
      },
      selectDirectory: async () => calls.push(['git-select']),
      refresh: async () => calls.push(['git-refresh']),
      readItem: async () => calls.push(['git-read'])
    }
    globalThis.document = {
      body: {},
      activeElement: null,
      querySelector: () => null,
      getElementById: () => null
    }
    globalThis.localStorage = {
      getItem: () => null,
      setItem: (key, value) => calls.push(['localStorage', key, value])
    }
    globalThis.requestAnimationFrame = (action) => {
      frames.push(action)
      return frames.length
    }
    globalThis.MutationObserver = class {
      constructor(action) {
        this.action = action
      }
      observe() {
        this.observing = true
      }
      disconnect() {
        this.observing = false
      }
    }
    globalThis.window = {
      innerWidth: 1280,
      addEventListener: (name) => calls.push(['listener', name]),
      removeEventListener: (name) => calls.push(['unlisten', name]),
      api: { onAgentUserInputChange: () => () => calls.push(['unsubscribe-question']) }
    }
    const module = await load('src/renderer/src/App.tsx', {
      react: harness.react,
      'react/jsx-runtime': jsxRuntime,
      './components/layout/Sidebar': { Sidebar: sidebar },
      './components/layout/SidebarSearch': { SidebarSearch: marker('SidebarSearch') },
      './components/layout/TitleBar': { TitleBar: title },
      './components/layout/SidebarToggle': { SidebarToggle: marker('SidebarToggle') },
      './components/layout/useSidebarLayout': {
        useSidebarLayout: () => ({
          open: true,
          present: true,
          expanded: true,
          transitioning: false,
          setOpen: (value) => calls.push(['sidebar-open', value]),
          finishTransition: () => calls.push(['sidebar-finish'])
        })
      },
      './features/chat/ChatWorkspace': { ChatWorkspace: chat },
      './features/conversation/useConversation': { useConversation: () => controller },
      './features/files/useFileView': {
        useFileView: () => ({
          state: fileState,
          open: (...args) => {
            calls.push(['file-open', ...args])
            fileState = { status: 'ready' }
          },
          close: () => {
            calls.push(['file-close'])
            fileState = { status: 'idle' }
          }
        })
      },
      './features/files/FileViewPanel': { FileViewPanel: files },
      './features/settings/SettingsPage': { SettingsPage: marker('SettingsPage') },
      './features/terminal/TerminalPanel': { TerminalPanel: terminal },
      './features/git/useGitView': {
        useGitView: (active, blocked) => {
          calls.push(['git-arguments', active, blocked])
          return { ...gitController, state: { open: gitOpen } }
        }
      },
      './features/git/GitWorkbenchPanel': { GitWorkbenchPanel: git }
    })
    const render = () => harness.render(() => module.default())
    const get = (tree, type) => nodes(tree).find((node) => node.type === type)
    let tree = render()
    assert.equal(get(tree, sidebar).props.disabled, true)
    assert.equal(
      get(tree, title).props.toolsDisabled,
      false,
      'Independent tools do not inherit chat busy disable'
    )
    const trigger = { name: 'git-trigger' }
    get(tree, title).props.onToggleGit(trigger)
    tree = render()
    assert.equal(get(tree, git).props.state.open, true)
    assert.equal(get(tree, files), undefined)
    assert.deepEqual(
      calls.filter(([name]) => name === 'file-close' || name === 'git-open'),
      [['file-close'], ['git-open', trigger]]
    )
    get(tree, title).props.onToggleTerminal()
    tree = render()
    assert.equal(get(tree, terminal).props.visible, true)
    const reference = { path: 'file.ts' },
      origin = { messageId: 'm' }
    get(tree, chat).props.onOpenFile(reference, origin, trigger)
    tree = render()
    assert.equal(get(tree, git), undefined)
    assert.ok(get(tree, files))
    assert.ok(calls.some(([name, restore]) => name === 'git-close' && restore === false))
    get(tree, title).props.onToggleGit(trigger)
    tree = render()
    get(tree, sidebar).props.onOpenSettings(trigger)
    tree = render()
    const shell = nodes(tree).find((node) => node.props?.className === 'workspace-shell')
    assert.equal(shell.props.hidden, true)
    assert.equal(shell.props.inert, true)
    assert.equal(get(tree, terminal).props.visible, false)
    assert.equal(get(tree, title).props.toolsDisabled, true)
    assert.equal(get(tree, git).props.state.open, true)
    assert.deepEqual(calls.findLast(([name]) => name === 'git-arguments').slice(1), [false, false])
    await get(tree, sidebar).props.onSelect('other-chat')
    tree = render()
    assert.equal(get(tree, terminal).props.visible, true)
    assert.equal(get(tree, git).props.state.open, true)
    assert.equal(
      calls.some(
        ([name]) => name === 'git-select' || name === 'git-refresh' || name === 'git-read'
      ),
      false
    )
    harness.dispose()
  }
)

await finish({
  notCovered: [
    'Synthetic DOM does not prove real keyboard focus, responsive layout, native dialog modal state, Git process close or OS file safety; these require separate actual desktop/Git suites.'
  ]
})
