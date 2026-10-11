const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs/promises')
const path = require('node:path')
const Module = require('node:module')
const { build } = require('esbuild')

const root = process.cwd()

async function load(relativeFile, dependencies = {}, options = {}) {
  const filename = path.resolve(root, relativeFile)
  const bundled = await build({
    entryPoints: [filename],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    external: ['electron'],
    logLevel: 'silent',
    plugins: [
      {
        name: 'question-test-isolation',
        setup(builder) {
          builder.onResolve({ filter: /.*/ }, ({ path: id, importer }) => {
            const scope = options.dependencyScopes?.[id]
            if (
              !Object.hasOwn(dependencies, id) ||
              (scope && !importer.replace(/\\/g, '/').includes(scope))
            )
              return null
            return { path: '@isolated/' + id, external: true }
          })
        }
      }
    ]
  })
  const loaded = new Module(filename, module)
  loaded.filename = filename
  loaded.paths = Module._nodeModulePaths(path.dirname(filename))
  loaded.require = (id) =>
    id.startsWith('@isolated/')
      ? dependencies[id.slice(10)]
      : id === 'electron'
        ? dependencies.electron
        : require(id)
  loaded.__clock = options.clock
  const timerBindings = options.clock
    ? 'const setTimeout = module.__clock.setTimeout.bind(module.__clock); const clearTimeout = module.__clock.clearTimeout.bind(module.__clock); const setInterval = module.__clock.setInterval.bind(module.__clock); const clearInterval = module.__clock.clearTimeout.bind(module.__clock);\n'
    : ''
  loaded._compile(timerBindings + bundled.outputFiles[0].text, filename)
  return loaded.exports
}

class FakeClock {
  constructor() {
    this.now = 0
    this.nextId = 1
    this.timers = new Map()
  }
  setTimeout(callback, duration) {
    const id = this.nextId++
    this.timers.set(id, { callback, at: this.now + duration, duration })
    return id
  }
  clearTimeout(id) {
    this.timers.delete(id)
  }
  setInterval(callback, duration) {
    const id = this.nextId++
    this.timers.set(id, { callback, at: this.now + duration, duration, repeat: true })
    return id
  }
  advance(duration) {
    const target = this.now + duration
    while (true) {
      const candidates = [...this.timers]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)
      if (!candidates.length) break
      const [id, timer] = candidates[0]
      this.now = timer.at
      if (timer.repeat) timer.at += timer.duration
      else this.timers.delete(id)
      timer.callback()
    }
    this.now = target
  }
}

function electronFixture() {
  const handlers = new Map()
  const windows = new Map()
  function window(id) {
    const owner = new EventEmitter()
    const sender = new EventEmitter()
    const events = []
    owner.id = id
    owner.destroyed = false
    owner.isDestroyed = () => owner.destroyed
    sender.destroyed = false
    sender.mainFrame = { identity: 'document-' + id }
    sender.isDestroyed = () => sender.destroyed
    sender.send = (channel, value) => events.push({ channel, value: structuredClone(value) })
    owner.webContents = sender
    windows.set(id, owner)
    return {
      owner,
      sender,
      events,
      event: () => ({ sender, senderFrame: sender.mainFrame }),
      reload() {
        sender.emit('did-start-loading')
        sender.mainFrame = { identity: 'new-document-' + id }
      },
      destroy() {
        sender.destroyed = true
        sender.emit('destroyed')
        owner.destroyed = true
        owner.emit('closed')
      }
    }
  }
  const electron = {
    ipcMain: {
      handle: (channel, handler) => {
        assert.equal(handlers.has(channel), false, 'duplicate IPC channel: ' + channel)
        handlers.set(channel, handler)
      }
    },
    BrowserWindow: {
      fromId: (id) => windows.get(id) ?? null,
      fromWebContents: (sender) =>
        [...windows.values()].find((owner) => owner.webContents === sender) ?? null
    }
  }
  return { handlers, windows, electron, window }
}

async function microtasks(count = 20) {
  for (let index = 0; index < count; index++) await Promise.resolve()
}

function suite(name) {
  const checks = []
  async function test(checkName, action) {
    const started = Date.now()
    try {
      await action()
      checks.push({ name: checkName, passed: true, durationMs: Date.now() - started })
    } catch (error) {
      checks.push({
        name: checkName,
        passed: false,
        error: error.stack ?? String(error),
        durationMs: Date.now() - started
      })
    }
  }
  async function finish(extra = {}) {
    const evidence = {
      suite: name,
      generatedAt: new Date().toISOString(),
      passed: checks.every((check) => check.passed),
      total: checks.length,
      failed: checks.filter((check) => !check.passed).length,
      checks,
      ...extra
    }
    await fs.writeFile(
      path.join(__dirname, name + '-results.json'),
      JSON.stringify(evidence, null, 2) + '\n',
      { flag: 'wx' }
    )
    console.log(
      JSON.stringify({
        suite: name,
        passed: evidence.passed,
        total: evidence.total,
        failed: evidence.failed
      })
    )
    for (const check of checks.filter((item) => !item.passed))
      console.error(check.name + ': ' + check.error)
    if (!evidence.passed) process.exitCode = 1
    return evidence
  }
  return { checks, test, finish }
}

module.exports = { assert, fs, path, root, load, FakeClock, electronFixture, microtasks, suite }
