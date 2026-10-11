/* Synthetic model transport only; the Electron, PTY, IPC and storage adapters are real. */
function install(config) {
  const require = process.getBuiltinModule('module').createRequire(config.root + '/package.json')
  const fs = require('node:fs')
  const Module = require('node:module')
  const workerThreads = require('node:worker_threads')
  const childProcess = require('node:child_process')
  const { app, BrowserWindow, ipcMain } = require('electron')
  // The inspector is a test bootstrap only. A paused ConPTY pipe worker deadlocks spawn.
  const withoutInspector = (options = {}) => ({
    ...options,
    execArgv: (options.execArgv ?? process.execArgv).filter(
      (argument) => !argument.startsWith('--inspect')
    )
  })
  const Worker = workerThreads.Worker
  workerThreads.Worker = class extends Worker {
    constructor(filename, options = {}) {
      super(
        filename,
        String(filename)
          .replaceAll('\\', '/')
          .includes('/node-pty/lib/worker/conoutSocketWorker.js')
          ? withoutInspector(options)
          : options
      )
    }
  }
  const fork = childProcess.fork
  childProcess.fork = (filename, args = [], options = {}) => {
    const owned = String(filename)
      .replaceAll('\\', '/')
      .includes('/node-pty/lib/conpty_console_list_agent')
    const child = fork(filename, args, owned ? withoutInspector(options) : options)
    if (owned) {
      const record = { pid: child.pid, args, exitCode: null, signal: null }
      audit.helpers.push(record)
      save()
      child.once('exit', (exitCode, signal) => {
        record.exitCode = exitCode
        record.signal = signal
        save()
      })
    }
    return child
  }
  app.setPath('userData', config.userData)
  process.env.MODEL_ENDPOINT = 'https://lesson59-fixture.invalid/responses'
  process.env.MODEL_NAME = 'lesson59-synthetic'
  process.env.MODEL_API_KEY = 'synthetic-fixture-key'
  const audit = {
    pid: process.pid,
    realTransport: false,
    actualPTY: true,
    debuggerInheritanceRemoved: true,
    requests: [],
    ipc: [],
    events: [],
    terminals: [],
    helpers: [],
    windowDestroyed: false
  }
  let syntheticStartFailure = false
  let syntheticCloseFailures = 0
  const save = () => fs.writeFileSync(config.auditFile, JSON.stringify(audit, null, 2))
  const load = Module._load
  // Observe the actual packaged or development node-pty module, never replace its child.
  Module._load = function (name, parent, isMain) {
    const exported = load.call(this, name, parent, isMain)
    if (name !== 'node-pty') return exported
    return {
      ...exported,
      spawn(program, args, options) {
        const child = exported.spawn(program, args, options)
        const record = {
          pid: child.pid,
          program,
          args,
          cwd: options.cwd,
          initialSize: { cols: options.cols, rows: options.rows },
          writes: [],
          sizes: [],
          killCalls: 0,
          output: '',
          exit: null
        }
        audit.terminals.push(record)
        const kill = child.kill.bind(child)
        child.kill = (...args) => {
          record.killCalls += 1
          save()
          return kill(...args)
        }
        const write = child.write.bind(child)
        child.write = (data) => {
          record.writes.push(data)
          save()
          return write(data)
        }
        const resize = child.resize.bind(child)
        child.resize = (cols, rows) => {
          record.sizes.push({ cols, rows })
          save()
          return resize(cols, rows)
        }
        child.onData((data) => {
          record.output = (record.output + data).slice(-64000)
          save()
        })
        child.onExit((value) => {
          record.exit = { ...value, atUTC: new Date().toISOString() }
          save()
        })
        save()
        return child
      }
    }
  }
  const message = (text) => ({
    type: 'message',
    role: 'assistant',
    phase: 'final_answer',
    content: [{ type: 'output_text', text }]
  })
  globalThis.fetch = async (url, init = {}) => {
    if (String(url) !== process.env.MODEL_ENDPOINT || init.method !== 'POST')
      throw Error('Fixture rejects unexpected network')
    const body = JSON.parse(init.body)
    const category = body.instructions.includes('你负责为桌面聊天会话生成标题')
      ? 'title'
      : body.instructions.includes('独立风险评估器')
        ? 'approval'
        : body.tools.length
          ? 'main'
          : 'summary'
    const request = {
      category,
      input: body.input,
      toolNames: body.tools.map((tool) => tool.name),
      atUTC: new Date().toISOString()
    }
    audit.requests.push(request)
    save()
    if (category !== 'main') throw Error('Fixture rejects title/summary/approval requests')
    const number = audit.requests.length
    if (number === 3) {
      request.waitingForCancellation = true
      save()
      return await new Promise((_resolve, reject) => {
        const abort = () => {
          request.cancelled = true
          save()
          reject(new DOMException('User interrupted synthetic stream', 'AbortError'))
        }
        if (init.signal.aborted) abort()
        else init.signal.addEventListener('abort', abort, { once: true })
      })
    }
    let output
    if (number === 1)
      output = [
        {
          type: 'function_call',
          call_id: 'lesson59-current-time',
          name: 'get_current_time',
          arguments: JSON.stringify({ timeZone: 'Asia/Hong_Kong' })
        }
      ]
    else if (number === 2) {
      const result = body.input.find(
        (item) => item.type === 'function_call_output' && item.call_id === 'lesson59-current-time'
      )
      if (!result || !JSON.parse(result.output).ok) throw Error('Actual time tool output missing')
      output = [message('第59课固定时间业务完成，实际时间工具返回有效时间。')]
    } else throw Error('Unexpected extra request')
    const event = { type: 'response.completed', response: { status: 'completed', output } }
    return new Response('data: ' + JSON.stringify(event) + '\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' }
    })
  }
  const handle = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = (channel, handler) =>
    handle(channel, async (event, ...args) => {
      if (channel.startsWith('agent:') || channel.startsWith('terminal:')) {
        audit.ipc.push({ channel, args, atUTC: new Date().toISOString() })
        save()
      }
      if (channel === 'terminal:start' && syntheticStartFailure) {
        syntheticStartFailure = false
        const created = await handler(event, ...args)
        if (!created.ok) throw new Error('Real PTY did not start before synthetic response fault')
        throw new Error('LESSON59_SYNTHETIC_START_REPLY_FAILURE_' + 'x'.repeat(1000))
      }
      if (channel === 'terminal:close' && syntheticCloseFailures > 0) {
        syntheticCloseFailures -= 1
        return { ok: false, error: 'LESSON59_SYNTHETIC_CLOSE_FAILURE_' + 'x'.repeat(1000) }
      }
      const result = await handler(event, ...args)
      save()
      return result
    })
  handle('lesson59:observation', () => audit)
  handle('lesson59:synthetic-terminal-failure', () => {
    syntheticStartFailure = true
    syntheticCloseFailures = 1
    return true
  })
  handle('lesson59:resize-window', (event, width, height) => {
    BrowserWindow.fromWebContents(event.sender).setSize(width, height)
    return true
  })
  handle('lesson59:destroy-window', (event) => {
    // Allow the observation reply to cross IPC before intentionally retiring its sender.
    setTimeout(() => {
      BrowserWindow.fromWebContents(event.sender)?.destroy()
      audit.windowDestroyed = true
      save()
    }, 100)
    return true
  })
  handle('lesson59:quit', () => {
    setImmediate(() => {
      for (const window of BrowserWindow.getAllWindows()) window.destroy()
      audit.windowDestroyed = true
      save()
      setTimeout(() => app.exit(0), 200)
    })
    return true
  })
  app.on('web-contents-created', (_event, contents) => {
    const send = contents.send.bind(contents)
    contents.send = (channel, ...args) => {
      if (channel.startsWith('agent:') || channel === 'execution:approval-change')
        audit.events.push({ channel, value: args[0] })
      save()
      return send(channel, ...args)
    }
  })
  globalThis.__lesson59FixtureReady = true
  save()
}
module.exports = { install }
