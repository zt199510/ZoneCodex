// 检查真实主进程模块的分发与边界，窗口替身避免关闭正在使用的应用。
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { EventEmitter } = require('node:events')
const { runInNewContext } = require('node:vm')
const assert = require('node:assert/strict')
const ts = require('typescript')

const handlers = new Map()
const owner = new EventEmitter()
const frame = {}
const sender = { mainFrame: frame, isDestroyed: () => false, send: (...args) => events.push(args) }
const event = { sender, senderFrame: frame }
const calls = []
const events = []
let maximized = false
let destroyed = false
Object.assign(owner, {
  webContents: sender,
  isDestroyed: () => destroyed,
  isMaximized: () => maximized,
  minimize: () => calls.push('minimize'),
  maximize: () => {
    maximized = true
    calls.push('maximize')
    owner.emit('maximize')
  },
  unmaximize: () => {
    maximized = false
    calls.push('unmaximize')
    owner.emit('unmaximize')
  },
  close: () => calls.push('close')
})
const moduleExports = {}
const source = readFileSync(join(__dirname, '../src/main/window/window-controls.ts'), 'utf8')
runInNewContext(
  ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText,
  {
    exports: moduleExports,
    require: (name) => {
      assert.equal(name, 'electron')
      return {
        BrowserWindow: { fromWebContents: (value) => (value === sender ? owner : null) },
        ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }
      }
    }
  }
)
moduleExports.registerWindowControls()
moduleExports.observeWindowState(owner)
const command = handlers.get('window:command')
assert.equal(handlers.get('window:state')(event).maximized, false)
command(event, 'minimize')
command(event, 'toggle-maximize')
assert.equal(handlers.get('window:state')(event).maximized, true)
command(event, 'toggle-maximize')
command(event, 'close')
assert.deepEqual(calls, ['minimize', 'maximize', 'unmaximize', 'close'])
assert.deepEqual(
  events.map(([channel, state]) => [channel, state.maximized]),
  [
    ['window:state-changed', true],
    ['window:state-changed', false]
  ]
)
assert.throws(() => command(event, 'destroy'), /不支持/)
assert.throws(() => command({ ...event, senderFrame: {} }, 'close'), /不支持/)
assert.throws(() => command({ ...event, sender: {} }, 'close'), /不支持/)
destroyed = true
assert.throws(() => command(event, 'close'), /不支持/)
owner.emit('closed')
assert.equal(owner.listenerCount('maximize'), 0)
assert.equal(owner.listenerCount('unmaximize'), 0)
console.log('Window controls: commands, source validation, maximize events and cleanup passed.')
