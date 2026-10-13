import assert from 'node:assert/strict'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import { root, hash, createEvidence, checksFor } from './runtime.mjs'

const evidence = await createEvidence('ipc')
const handlers = new Map(),
  windows = new Map(),
  modal = new Set(),
  fixtureViews = new Map()
let api,
  writeCalls = 0,
  modelCalls = 0,
  refreshCalls = 0,
  held,
  initCalls = 0,
  fetchCalls = 0,
  remoteCalls = 0,
  remoteFailure = false,
  switchAfterCommit = false,
  prCalls = 0,
  prUnconfirmed = false,
  turnChanged,
  turnFailure = null,
  observerLimited = false
const tick = () => new Promise((resolve) => setImmediate(resolve))
function makeView() {
  const view = {
    info: {
      viewId: randomUUID(),
      head: 'unborn',
      repositoryPath: path.join(evidence, randomUUID()),
      selectedPath: evidence
    },
    snapshot: { revision: randomUUID(), items: [] },
    disposed: false,
    headSha: null,
    branch: 'main',
    remotes: new Map([
      [randomUUID(), { name: 'origin', url: 'https://example.invalid/fixture.git' }]
    ])
  }
  fixtureViews.set(view.info.viewId, view)
  return view
}
const fixture = {
  app: { getPath: () => evidence },
  BrowserWindow: { fromWebContents: (contents) => windows.get(contents) },
  dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [evidence] }) },
  ipcMain: {
    handle: (channel, handler) => {
      assert(!handlers.has(channel))
      handlers.set(channel, handler)
    }
  },
  createGitReader: () => ({
    open: async () => makeView(),
    refresh: async (view) => {
      refreshCalls++
      view.snapshot.revision = randomUUID()
      return { revision: view.snapshot.revision, items: [], warnings: [] }
    },
    dispose: async (view) => {
      view.disposed = true
    }
  }),
  createGitWorkbenchReader: () => ({
    metadata: async (view) => ({
      revision: view.snapshot.revision,
      branch: view.branch,
      headSha: view.headSha,
      remotes: [...view.remotes.entries()].map(([remoteId, data]) => ({ remoteId, ...data }))
    }),
    review: async (view) => ({ revision: view.snapshot.revision, files: [] }),
    diff: async () => ({ text: 'diff' }),
    context: async (view, revision) => {
      if (revision !== view.snapshot.revision) throw new api.GitReadError('stale', '版本失效')
      return { view, location: { scopePath: '' }, remotes: view.remotes }
    }
  }),
  createGitWorkbenchWriter: () => ({
    execute: async (context, request, signal) => {
      writeCalls++
      if (held) {
        held.started = true
        signal.addEventListener('abort', () => {
          held.aborted = true
        })
        await held.promise
      }
      if (request.action === 'commit') {
        context.view.headSha = 'a'.repeat(40)
        if (switchAfterCommit) context.view.branch = 'unexpected-target'
        return {
          outcome: 'success',
          stage: 'commit',
          appliedItemIds: [],
          message: '已提交',
          headSha: context.view.headSha
        }
      }
      return { outcome: 'success', stage: 'index', appliedItemIds: [], message: '实际阶段已完成' }
    }
  }),
  createGitWorkbenchRemote: () => ({
    metadata: async (_context, data) => data,
    networkEnvironment: async () => ({}),
    execute: async () => {
      remoteCalls++
      if (remoteFailure) throw new Error('合成推送失败')
      return { outcome: 'success', stage: 'remote-push', appliedItemIds: [], message: '已推送' }
    }
  }),
  gitRemoteTransport: (url) => (url.startsWith('https://') ? { url } : null),
  fetchGitWorkbench: async () => {
    fetchCalls++
    return { outcome: 'success', stage: 'remote-fetch', appliedItemIds: [], message: '已获取' }
  },
  initializeGitDirectory: async () => {
    initCalls++
  },
  createGitWorkbenchWorktrees: () => ({
    metadata: async (_context, data) => data,
    execute: async () => {
      writeCalls++
      return {}
    }
  }),
  generateGitText: async () => {
    modelCalls++
    return { subject: '候选', body: '' }
  },
  readGitFullFile: async () => ({ format: 'text', text: 'full' }),
  createGitWorkbenchObservers: (options) => {
    const watched = new WeakSet()
    return {
      watch: async (view) => {
        if (observerLimited && !watched.has(view)) {
          watched.add(view)
          options.onInvalidate(view, {
            reason: 'recovery',
            sequence: 1,
            status: 'limited',
            message: '256 项监听限制'
          })
        }
      },
      release: async () => {}
    }
  },
  createGitWorkbenchTurns: (options) => {
    turnChanged = options.onChanged
    return {
      start: async () => randomUUID(),
      complete: async () => {},
      release: async () => {},
      ownsRevision: () => false,
      state: () => ({ message: turnFailure })
    }
  },
  createGitWorkbenchPullRequests: () => ({
    list: async () => {
      prCalls++
      return { items: [] }
    },
    detail: async () => {
      prCalls++
      return { title: 'PR fixture' }
    },
    merge: async (_context, request, signal) => {
      prCalls++
      if (held) {
        held.started = true
        signal.addEventListener('abort', () => {
          held.aborted = true
        })
        await held.promise
      }
      return {
        prId: request.prId,
        number: 1,
        url: 'https://github.com/fixture/repo/pull/1',
        outcome: prUnconfirmed ? 'partial-success' : 'success',
        message: prUnconfirmed ? 'GitHub CLI 退出未确认，需人工核对' : '合并已确认'
      }
    },
    releaseView: async () => {}
  })
}
globalThis.__gitWorkbenchIPC = fixture
const outfile = path.join(evidence, 'current-ipc.cjs')
const mocked = [
  'git-reader',
  'git-workbench-reader',
  'git-workbench-writer',
  'git-workbench-remote',
  'git-workbench-worktrees',
  'git-workbench-generation',
  'git-workbench-file',
  'git-workbench-fetch',
  'git-workbench-init',
  'git-workbench-observers',
  'git-workbench-turns',
  'git-workbench-pr'
]
const bundle = await build({
  stdin: {
    contents:
      'export * from "./src/main/git/git-ipc.ts";export * from "./src/main/git/git-workbench-ipc.ts";export * from "./src/main/git/git-process.ts";',
    resolveDir: root
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile,
  metafile: true,
  logLevel: 'silent',
  plugins: [
    {
      name: 'synthetic-electron-and-services',
      setup(builder) {
        builder.onResolve({ filter: /^electron$/ }, () => ({
          path: 'electron',
          namespace: 'fixture'
        }))
        builder.onResolve(
          {
            filter:
              /^\.\/git-(?:reader|workbench-(?:reader|writer|remote|worktrees|generation|file|fetch|init|observers|turns|pr))$/
          },
          (args) => ({ path: args.path.slice(2), namespace: 'fixture' })
        )
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({
          contents:
            args.path === 'electron'
              ? 'export const {app,BrowserWindow,dialog,ipcMain}=globalThis.__gitWorkbenchIPC;'
              : 'export const {' +
                {
                  'git-reader': 'createGitReader',
                  'git-workbench-reader': 'createGitWorkbenchReader',
                  'git-workbench-writer': 'createGitWorkbenchWriter',
                  'git-workbench-remote': 'createGitWorkbenchRemote,gitRemoteTransport',
                  'git-workbench-worktrees': 'createGitWorkbenchWorktrees',
                  'git-workbench-generation': 'generateGitText',
                  'git-workbench-file': 'readGitFullFile',
                  'git-workbench-fetch': 'fetchGitWorkbench',
                  'git-workbench-init': 'initializeGitDirectory',
                  'git-workbench-observers': 'createGitWorkbenchObservers',
                  'git-workbench-turns': 'createGitWorkbenchTurns',
                  'git-workbench-pr': 'createGitWorkbenchPullRequests'
                }[args.path] +
                '}=globalThis.__gitWorkbenchIPC;',
          loader: 'js'
        }))
      }
    }
  ]
})
const sourceHashes = Object.fromEntries(
  await Promise.all(
    Object.keys(bundle.metafile.inputs)
      .filter((file) => file !== '<stdin>' && !file.startsWith('fixture:'))
      .map(async (file) => [file, hash(await fs.readFile(path.join(root, file)))])
  )
)
api = createRequire(import.meta.url)(outfile)
api.registerGitView((id) => modal.has(id), api.registerGitWorkbench)
let nextWindow = 0
function owner() {
  const window = new EventEmitter(),
    contents = new EventEmitter()
  window.id = ++nextWindow
  window.isDestroyed = () => false
  contents.isDestroyed = () => false
  contents.mainFrame = { document: 1 }
  window.webContents = contents
  contents.messages = []
  contents.send = (channel, value) => contents.messages.push({ channel, value })
  windows.set(contents, window)
  api.attachGitCleanup(window)
  return { window, event: { sender: contents, senderFrame: contents.mainFrame } }
}
const invoke = (channel, owner, value) => handlers.get(channel)(owner.event, value)
async function select(owner) {
  const value = await invoke('git:select', owner, randomUUID())
  assert.equal(value.status, 'ready')
  return value.view.viewId
}
async function metadata(owner, viewId) {
  const value = await invoke('git:metadata', owner, { requestId: randomUUID(), viewId })
  assert.equal(value.status, 'ready')
  return value.data
}
const suite = checksFor(evidence, {
  sourceHashes,
  compiledSHA256: hash(await fs.readFile(outfile)),
  actualCurrentIPCAndSourceGuard: true,
  syntheticElectron: true,
  syntheticServices: mocked,
  nativeGit: false,
  actualModel: false,
  realNetworking: false
})
const one = owner(),
  two = owner()
let viewId, revision
await suite.check(
  'initialization and repository selection make zero write/model requests',
  async () => {
    viewId = await select(one)
    const data = await metadata(one, viewId)
    revision = data.revision
    assert.equal(writeCalls, 0)
    assert.equal(modelCalls, 0)
    assert(refreshCalls > 0)
  }
)
await suite.check('old IPCs remain and repositories/PR workbench IPCs mount once', () => {
  assert.deepEqual(
    [...handlers.keys()].sort(),
    [
      'git:select',
      'git:list',
      'git:read',
      'git:cancel',
      'git:release',
      'git:metadata',
      'git:review',
      'git:diff',
      'git:action',
      'git:generate',
      'git:full-file',
      'git:init',
      'git:repositories',
      'git:add-repositories',
      'git:pr-list',
      'git:pr-detail',
      'git:pr-merge'
    ].sort()
  )
})
await suite.check(
  'another window cannot use view, review, mutation or generation IDs',
  async () => {
    for (const [channel, extra] of [
      ['git:metadata', {}],
      ['git:action', { revision, action: 'stage', itemIds: [randomUUID()] }],
      ['git:generate', { revision, purpose: 'commit' }]
    ]) {
      const result = await invoke(channel, two, { requestId: randomUUID(), viewId, ...extra })
      assert.equal(result.status, 'stale')
    }
    assert.equal(writeCalls, 0)
    assert.equal(modelCalls, 0)
  }
)
await suite.check(
  'subframe source and injected paths are rejected before service execution',
  async () => {
    await assert.rejects(
      handlers.get('git:action')(
        { sender: one.event.sender, senderFrame: {} },
        { requestId: randomUUID(), viewId, revision, action: 'stage', itemIds: [randomUUID()] }
      ),
      /来源/
    )
    await assert.rejects(
      invoke('git:action', one, {
        requestId: randomUUID(),
        viewId,
        revision,
        action: 'stage',
        itemIds: [randomUUID()],
        cwd: evidence
      }),
      /请求无效/
    )
    assert.equal(writeCalls, 0)
  }
)
await suite.check('stale revisions never enter writer', async () => {
  const result = await invoke('git:action', one, {
    requestId: randomUUID(),
    viewId,
    revision: randomUUID(),
    action: 'stage',
    itemIds: [randomUUID()]
  })
  assert.equal(result.status, 'stale')
  assert.equal(writeCalls, 0)
})
await suite.check(
  'approval/modal waits block manual actions and generation without Agent tickets',
  async () => {
    modal.add(one.window.id)
    for (const [channel, extra] of [
      ['git:action', { action: 'stage', itemIds: [randomUUID()] }],
      ['git:generate', { purpose: 'commit' }]
    ])
      assert.equal(
        (await invoke(channel, one, { requestId: randomUUID(), viewId, revision, ...extra }))
          .status,
        'error'
      )
    modal.delete(one.window.id)
    assert.equal(writeCalls, 0)
    assert.equal(modelCalls, 0)
  }
)
await suite.check('explicit generation is the sole IPC entering generation service', async () => {
  const result = await invoke('git:generate', one, {
    requestId: randomUUID(),
    viewId,
    revision,
    purpose: 'commit'
  })
  assert.equal(result.status, 'ready')
  assert.equal(modelCalls, 1)
  assert.equal(writeCalls, 0)
})
await suite.check('double click and refresh cannot abort or overlap active write', async () => {
  let release
  held = {
    promise: new Promise((resolve) => {
      release = resolve
    }),
    started: false,
    aborted: false
  }
  const first = invoke('git:action', one, {
    requestId: randomUUID(),
    viewId,
    revision,
    action: 'stage',
    itemIds: [randomUUID()]
  })
  await tick()
  assert(held.started)
  assert.equal(
    (
      await invoke('git:action', one, {
        requestId: randomUUID(),
        viewId,
        revision,
        action: 'stage',
        itemIds: [randomUUID()]
      })
    ).status,
    'error'
  )
  assert.equal(
    (await invoke('git:metadata', one, { requestId: randomUUID(), viewId })).status,
    'error'
  )
  assert.equal(held.aborted, false)
  assert.equal(writeCalls, 1)
  release()
  assert.equal((await first).status, 'ready')
  held = null
})
await suite.check(
  'release waits for actual write settlement before disposal, without claiming rollback',
  async () => {
    let release
    held = {
      promise: new Promise((resolve) => {
        release = resolve
      }),
      started: false,
      aborted: false
    }
    const active = invoke('git:action', one, {
      requestId: randomUUID(),
      viewId,
      revision,
      action: 'stage',
      itemIds: [randomUUID()]
    })
    await tick()
    let settled = false
    const closing = invoke('git:release', one, viewId).then((result) => {
      settled = true
      return result
    })
    await tick()
    assert.equal(settled, false)
    assert(held.aborted)
    release()
    await active
    assert.equal((await closing).status, 'ready')
    held = null
    assert.equal(
      (await invoke('git:metadata', one, { requestId: randomUUID(), viewId })).status,
      'stale'
    )
  }
)
await suite.check('new document retires former scope and cannot reuse its authority', async () => {
  const secondView = await select(one)
  one.event.sender.mainFrame = { document: 2 }
  one.event.sender.emit('did-start-navigation', {}, 'app://new', false, true)
  await tick()
  one.event.senderFrame = one.event.sender.mainFrame
  assert.equal(
    (await invoke('git:metadata', one, { requestId: randomUUID(), viewId: secondView })).status,
    'stale'
  )
})
await suite.check(
  'initialization is explicit, modal guarded and adopts only a new owned scope',
  async () => {
    const third = owner()
    modal.add(third.window.id)
    assert.equal((await invoke('git:init', third, randomUUID())).status, 'error')
    assert.equal(initCalls, 0)
    modal.delete(third.window.id)
    const initialized = await invoke('git:init', third, randomUUID())
    assert.equal(initialized.status, 'ready')
    assert.equal(initCalls, 1)
    assert.equal((await metadata(third, initialized.view.viewId)).branch, 'main')
    await assert.rejects(invoke('git:init', third, 'renderer-path'), /请求无效/)
  }
)
await suite.check(
  'manual fetch routes only to fetch service and never writer or model',
  async () => {
    const fourth = owner(),
      id = await select(fourth),
      data = await metadata(fourth, id)
    const before = writeCalls,
      beforeModel = modelCalls
    const result = await invoke('git:action', fourth, {
      requestId: randomUUID(),
      viewId: id,
      revision: data.revision,
      action: 'fetch',
      remoteId: data.remotes[0].remoteId
    })
    assert.equal(result.status, 'ready')
    assert.equal(fetchCalls, 1)
    assert.equal(writeCalls, before)
    assert.equal(modelCalls, beforeModel)
  }
)
await suite.check(
  'first manual commit marks unborn view present and remains refreshable',
  async () => {
    const fifth = owner(),
      id = await select(fifth),
      data = await metadata(fifth, id)
    const result = await invoke('git:action', fifth, {
      requestId: randomUUID(),
      viewId: id,
      revision: data.revision,
      action: 'commit',
      message: '首次提交',
      includeUnstaged: true
    })
    assert.equal(result.status, 'ready')
    assert.equal(result.data.headSha, 'a'.repeat(40))
    assert.equal(fixtureViews.get(id).info.head, 'present')
    assert.equal((await metadata(fifth, id)).headSha, result.data.headSha)
  }
)
await suite.check(
  'commit and push keeps the committed result when remote phase fails',
  async () => {
    const sixth = owner(),
      id = await select(sixth),
      data = await metadata(sixth, id)
    const request = {
      requestId: randomUUID(),
      viewId: id,
      revision: data.revision,
      action: 'commit-and-push',
      message: '说明',
      includeUnstaged: true,
      remoteId: data.remotes[0].remoteId,
      forceWithLease: false
    }
    const before = writeCalls
    const refused = await invoke('git:action', sixth, { ...request, remoteId: randomUUID() })
    assert.equal(refused.status, 'unsupported')
    assert.equal(writeCalls, before)
    remoteFailure = true
    try {
      const result = await invoke('git:action', sixth, request)
      assert.equal(result.status, 'ready')
      assert.equal(result.data.outcome, 'partial-success')
      assert.equal(result.data.headSha, 'a'.repeat(40))
      assert.match(result.data.message, /提交已完成/)
      assert.equal(writeCalls, before + 1)
      assert.equal(remoteCalls, 1)
      assert.equal((await metadata(sixth, id)).headSha, result.data.headSha)
    } finally {
      remoteFailure = false
    }
  }
)
await suite.check(
  'commit and push never pushes another branch with the same committed OID',
  async () => {
    const seventh = owner(),
      id = await select(seventh),
      data = await metadata(seventh, id)
    const beforeRemote = remoteCalls,
      beforeWrite = writeCalls
    switchAfterCommit = true
    try {
      const result = await invoke('git:action', seventh, {
        requestId: randomUUID(),
        viewId: id,
        revision: data.revision,
        action: 'commit-and-push',
        message: '说明',
        includeUnstaged: true,
        remoteId: data.remotes[0].remoteId,
        forceWithLease: false
      })
      assert.equal(result.status, 'ready')
      assert.equal(result.data.outcome, 'partial-success')
      assert.equal(result.data.headSha, 'a'.repeat(40))
      assert.match(result.data.message, /分支发生变化/)
      assert.equal(remoteCalls, beforeRemote)
      assert.equal(writeCalls, beforeWrite + 1)
    } finally {
      switchAfterCommit = false
    }
  }
)
await suite.check(
  'PR reads/merge preserve source ownership, modal guards, revision checks and zero model calls',
  async () => {
    const own = owner(),
      id = await select(own),
      data = await metadata(own, id)
    const request = {
      requestId: randomUUID(),
      viewId: id,
      revision: data.revision,
      prId: randomUUID(),
      prRevision: randomUUID(),
      method: 'merge'
    }
    const before = prCalls,
      beforeModel = modelCalls
    assert.equal((await invoke('git:pr-merge', two, request)).status, 'stale')
    modal.add(own.window.id)
    assert.equal((await invoke('git:pr-merge', own, request)).status, 'error')
    modal.delete(own.window.id)
    assert.equal(
      (await invoke('git:pr-merge', own, { ...request, revision: randomUUID() })).status,
      'stale'
    )
    assert.equal(prCalls, before)
    assert.equal(
      (
        await invoke('git:pr-detail', own, {
          requestId: randomUUID(),
          viewId: id,
          revision: data.revision,
          prId: request.prId
        })
      ).status,
      'ready'
    )
    assert.equal(
      (
        await invoke('git:pr-list', own, {
          requestId: randomUUID(),
          viewId: id,
          revision: data.revision,
          remoteId: data.remotes[0].remoteId,
          state: 'open'
        })
      ).status,
      'ready'
    )
    assert.equal(modelCalls, beforeModel)
  }
)
await suite.check(
  'PR merge owns the same actual-settlement write barrier and unconfirmed partial result blocks the window',
  async () => {
    const own = owner(),
      id = await select(own),
      data = await metadata(own, id)
    let release
    held = {
      promise: new Promise((resolve) => {
        release = resolve
      }),
      started: false,
      aborted: false
    }
    prUnconfirmed = true
    const request = {
      requestId: randomUUID(),
      viewId: id,
      revision: data.revision,
      prId: randomUUID(),
      prRevision: randomUUID(),
      method: 'squash'
    }
    const active = invoke('git:pr-merge', own, request)
    await tick()
    assert(held.started)
    assert.equal(
      (await invoke('git:metadata', own, { requestId: randomUUID(), viewId: id })).status,
      'error'
    )
    assert.equal(held.aborted, false)
    let stopped = false
    const cancellation = invoke('git:cancel', own, request.requestId).then((result) => {
      stopped = true
      return result
    })
    await tick()
    assert(held.aborted)
    assert.equal(stopped, false)
    release()
    const result = await active
    assert.equal(result.status, 'ready')
    assert.equal(result.data.outcome, 'partial-success')
    assert.equal((await cancellation).status, 'error')
    held = null
    prUnconfirmed = false
    assert.equal((await invoke('git:release', own, id)).status, 'error')
    assert.equal(fixtureViews.get(id).disposed, false)
    assert.equal((await invoke('git:repositories', own, randomUUID())).status, 'error')
  }
)
await suite.check(
  'an independent Last Turn unconfirmed cleanup blocks manual operations without Agent interaction',
  async () => {
    const own = owner(),
      id = await select(own)
    const beforeWrite = writeCalls,
      beforeModel = modelCalls
    turnFailure = '独立回合 Git 清理失败，退出未确认'
    turnChanged(fixtureViews.get(id))
    const result = await invoke('git:metadata', own, { requestId: randomUUID(), viewId: id })
    assert.equal(result.status, 'error')
    assert.match(result.error, /退出未确认/)
    assert.equal((await invoke('git:release', own, id)).status, 'error')
    assert.equal(fixtureViews.get(id).disposed, false)
    assert.equal(writeCalls, beforeWrite)
    assert.equal(modelCalls, beforeModel)
    turnFailure = null
  }
)
await suite.check(
  'initial limited-watch health is delivered once after selection and metadata cannot create a refresh loop',
  async () => {
    const own = owner()
    observerLimited = true
    const id = await select(own)
    assert.equal(own.window.webContents.messages.length, 1)
    await metadata(own, id)
    assert.equal(own.window.webContents.messages.length, 2)
    await metadata(own, id)
    await metadata(own, id)
    assert.equal(own.window.webContents.messages.length, 2)
    const events = own.window.webContents.messages.map((item) => item.value)
    assert.deepEqual(
      events.map((item) => item.sequence),
      [1, 2]
    )
    assert(events.every((item) => item.viewId === id && item.status === 'limited'))
    observerLimited = false
  }
)
await suite.finish()
