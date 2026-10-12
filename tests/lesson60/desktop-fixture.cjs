/* Test-only synthetic SSE, response faults and stale events; real Electron/IPC/PTY/disk owners. */
function install(config) {
  const require = process.getBuiltinModule('module').createRequire(config.root + '/package.json')
  const fs = require('node:fs')
  const crypto = require('node:crypto')
  const Module = require('node:module')
  const workerThreads = require('node:worker_threads')
  const childProcess = require('node:child_process')
  const { app, BrowserWindow, ipcMain } = require('electron')
  app.setPath('userData', config.userData)
  process.env.MODEL_ENDPOINT = 'https://lesson60-fixture.invalid/responses'
  process.env.MODEL_NAME = 'lesson60-synthetic'
  process.env.MODEL_API_KEY = 'synthetic-fixture-key'
  const audit = {
    pid: process.pid,
    stage: config.stage,
    realTransport: false,
    actualPTY: true,
    requests: [],
    ipc: [],
    events: [],
    synthetic: [],
    terminals: [],
    helpers: [],
    workers: [],
    nativeModules: [],
    ptyModulePaths: [],
    quitEvents: []
  }
  const save = () => fs.writeFileSync(config.auditFile, JSON.stringify(audit, null, 2))
  const injected = (kind, value = {}) => {
    audit.synthetic.push({ kind, ...value, atUTC: new Date().toISOString() })
    save()
  }
  let scenario = { name: 'idle', round: 0, reviewer: 'risky' }
  let faults = {}
  const releases = new Map()
  const hold = (name, value) =>
    new Promise((resolve) => {
      if (releases.has(name)) throw Error('Duplicate synthetic hold: ' + name)
      releases.set(name, () => {
        releases.delete(name)
        resolve(value)
      })
      injected('held-reply', { name })
    })
  // Only the two node-pty descendants must lose the paused test inspector flag.
  const withoutInspector = (options = {}) => ({
    ...options,
    execArgv: (options.execArgv ?? process.execArgv).filter(
      (argument) => !argument.startsWith('--inspect')
    )
  })
  const Worker = workerThreads.Worker
  workerThreads.Worker = class extends Worker {
    constructor(filename, options = {}) {
      const owned = String(filename)
        .replaceAll('\\', '/')
        .includes('/node-pty/lib/worker/conoutSocketWorker.js')
      super(filename, owned ? withoutInspector(options) : options)
      if (!owned) return
      const record = {
        filename: String(filename),
        threadId: this.threadId,
        online: false,
        exitCode: null,
        errors: []
      }
      audit.workers.push(record)
      this.once('online', () => {
        record.online = true
        save()
      })
      this.once('exit', (exitCode) => {
        record.exitCode = exitCode
        save()
      })
      this.on('error', (error) => {
        record.errors.push(error.message)
        save()
      })
      save()
    }
  }
  const fork = childProcess.fork
  childProcess.fork = (filename, args = [], options = {}) => {
    const owned = String(filename)
      .replaceAll('\\', '/')
      .includes('/node-pty/lib/conpty_console_list_agent')
    const child = fork(filename, args, owned ? withoutInspector(options) : options)
    if (owned) {
      const record = { pid: child.pid, args, exitCode: null, signal: null, errors: [] }
      audit.helpers.push(record)
      child.once('exit', (exitCode, signal) => {
        record.exitCode = exitCode
        record.signal = signal
        save()
      })
      child.on('error', (error) => {
        record.errors.push(error.message)
        save()
      })
      save()
    }
    return child
  }
  const load = Module._load
  Module._load = function (name, parent, isMain) {
    const exported = load.call(this, name, parent, isMain)
    if (/[/\\]conpty\.node$/.test(String(name))) {
      const resolved = Module._resolveFilename(name, parent)
      if (!audit.nativeModules.some((item) => item.resolved === resolved)) {
        audit.nativeModules.push({
          resolved,
          sha256: crypto.createHash('sha256').update(fs.readFileSync(resolved)).digest('hex')
        })
        save()
      }
    }
    if (name !== 'node-pty') return exported
    const resolved = Module._resolveFilename(name, parent)
    if (!audit.ptyModulePaths.includes(resolved)) audit.ptyModulePaths.push(resolved)
    return {
      ...exported,
      spawn(program, args, options) {
        const child = exported.spawn(program, args, options)
        const record = {
          pid: child.pid,
          program,
          args,
          cwd: options.cwd,
          writes: [],
          killCalls: 0,
          output: '',
          exit: null
        }
        audit.terminals.push(record)
        const kill = child.kill.bind(child)
        child.kill = (...values) => {
          record.killCalls += 1
          save()
          return kill(...values)
        }
        const write = child.write.bind(child)
        child.write = (data) => {
          record.writes.push(data)
          save()
          return write(data)
        }
        child.onData((data) => {
          record.output = (record.output + data).slice(-64000)
          save()
        })
        child.onExit((value) => {
          record.exit = value
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
  const call = (name, args) => ({
    type: 'function_call',
    call_id: 'lesson60-' + scenario.name + '-tool',
    name,
    arguments: JSON.stringify(args)
  })
  const response = (output) =>
    new Response(
      'data: ' +
        JSON.stringify({ type: 'response.completed', response: { status: 'completed', output } }) +
        '\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } }
    )
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
      scenario: scenario.name,
      category,
      input: body.input,
      toolNames: body.tools.map((tool) => tool.name),
      resumeSafety: body.instructions.includes('本次是用户明确触发的任务续接。'),
      atUTC: new Date().toISOString()
    }
    audit.requests.push(request)
    save()
    if (category === 'approval') {
      // Malformed successful review transport independently exercises manual fallback.
      return response([
        message(
          scenario.reviewer === 'malformed'
            ? 'invalid review JSON'
            : JSON.stringify({ risk: scenario.reviewer })
        )
      ])
    }
    if (category !== 'main') throw Error('Unexpected passive title or summary request')
    scenario.round += 1
    const time = () => call('get_current_time', { timeZone: 'Asia/Hong_Kong' })
    if (scenario.name === 'resume') {
      if (scenario.round === 1) return response([time()])
      if (scenario.round === 2)
        return response([message('第60课显式继续完成；本轮使用当前权限和新运行身份。')])
      throw Error('Unexpected extra resume request')
    }
    if (scenario.round === 1) {
      if (
        ['reject', 'approval-stop', 'effect-stop', 'review-risky', 'review-malformed'].includes(
          scenario.name
        )
      )
        return response([
          call('create_workspace_file', {
            path: scenario.target,
            content: 'LESSON60_CONTROLLED_REAL_EFFECT\n'
          })
        ])
      if (scenario.name === 'question-stop')
        return response([
          call('request_user_input', {
            questions: [
              {
                id: 'scope',
                header: '范围',
                question: '本次计划采用哪个范围？',
                options: [
                  { label: '局部', description: '保持隔离目录。' },
                  { label: '完整', description: '先完善说明。' }
                ]
              }
            ]
          })
        ])
      if (['running-stop', 'checkpoint', 'deletion'].includes(scenario.name))
        return response([time()])
      throw Error('Unexpected Agent start in idle/fault scenario: ' + scenario.name)
    }
    if (['running-stop', 'checkpoint', 'effect-stop'].includes(scenario.name)) {
      request.waitingForCancellation = true
      save()
      return new Promise((_resolve, reject) => {
        const finish = () => {
          releases.delete('abort')
          request.cancelled = true
          save()
          reject(
            new DOMException('Synthetic model transport interrupted by real owner', 'AbortError')
          )
        }
        const abort = () => {
          request.abortObserved = true
          save()
          if (faults.holdAbort) {
            releases.set('abort', finish)
            injected('held-transport-abort')
          } else finish()
        }
        if (init.signal.aborted) abort()
        else init.signal.addEventListener('abort', abort, { once: true })
      })
    }
    if (scenario.round !== 2) throw Error('Unexpected extra main request')
    return response([message('第60课固定回复完成；拒绝仅作用于本次操作。')])
  }
  const handle = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = (channel, handler) =>
    handle(channel, async (event, ...args) => {
      const observed =
        /^(agent:|execution:|task:|terminal:|conversation:|window:|command-directory:|command-execution:|workspace:|project:)/.test(
          channel
        )
      const record = observed
        ? { channel, args, scenario: scenario.name, atUTC: new Date().toISOString() }
        : null
      if (record) {
        audit.ipc.push(record)
        save()
      }
      try {
        if (channel === 'agent:cancel' && faults.cancelFailure) {
          injected('cancel-send-failure-before-owner', { requestId: args[0] })
          throw Error('LESSON60_SYNTHETIC_CANCEL_SEND_FAILURE')
        }
        if (channel === 'agent:cancel' && faults.cancelFalse) {
          injected('cancel-false-before-owner', { requestId: args[0] })
          record.result = false
          record.finishedAtUTC = new Date().toISOString()
          save()
          return false
        }
        if (channel === 'execution:permissions-get' && faults.readback === 'fail') {
          injected('permission-readback-failure')
          throw Error('LESSON60_SYNTHETIC_PERMISSION_READBACK_FAILURE')
        }
        let result = await handler(event, ...args)
        if (record) {
          record.ownerResult = result
          save()
        }
        if (channel === 'terminal:start' && result.ok) audit.terminals.at(-1).sessionId = args[0]
        if (channel === 'agent:resolve-execution' && faults.holdResolve)
          result = await hold('resolve', result)
        if (channel === 'execution:permissions-get' && faults.readback === 'hold')
          result = await hold('readback', result)
        if (channel === 'execution:permissions-set' && faults.setReplyFailure) {
          faults.setReplyFailure = false
          injected('permission-set-owner-accepted-reply-failure', { actual: result })
          throw Error('LESSON60_SYNTHETIC_PERMISSION_SET_REPLY_FAILURE')
        }
        if (record) {
          record.result = result
          record.finishedAtUTC = new Date().toISOString()
          save()
        }
        return result
      } catch (error) {
        if (record) {
          record.error = error.message
          record.finishedAtUTC = new Date().toISOString()
          save()
        }
        throw error
      }
    })
  handle('lesson60:observation', () => audit)
  handle('lesson60:configure', (_event, value) => {
    if (value.scenario) scenario = { reviewer: 'risky', ...value.scenario, round: 0 }
    if (value.faults) faults = { ...faults, ...value.faults }
    injected('configure', { value })
    return true
  })
  handle('lesson60:release', (_event, name) => {
    const release = releases.get(name)
    if (!release) return false
    if (name === 'readback') faults.readback = 'normal'
    if (name === 'resolve') faults.holdResolve = false
    if (name === 'abort') faults.holdAbort = false
    injected('release', { name })
    release()
    return true
  })
  handle('lesson60:replay', (event, channel, value) => {
    if (
      ![
        'execution:approval-change',
        'agent:user-input-change',
        'task:state',
        'agent:message-event'
      ].includes(channel)
    )
      throw Error('Invalid synthetic replay channel')
    injected('stale-event-replay', { channel, value })
    event.sender.send(channel, value)
    return true
  })
  handle('lesson60:quit', () => {
    setImmediate(() => {
      for (const window of BrowserWindow.getAllWindows()) window.destroy()
      for (const release of releases.values()) release()
      save()
      // Use the production terminal shutdown barrier, never app.exit().
      app.quit()
    })
    return true
  })
  app.on('web-contents-created', (_event, contents) => {
    const send = contents.send.bind(contents)
    contents.send = (channel, ...args) => {
      if (/^(agent:|execution:approval-change|task:state|model-stream:delta)/.test(channel)) {
        audit.events.push({ channel, value: args[0], atUTC: new Date().toISOString() })
        save()
      }
      return send(channel, ...args)
    }
  })
  app.on('before-quit', () => {
    audit.quitEvents.push({ type: 'before-quit' })
    save()
  })
  app.on('will-quit', () => {
    audit.quitEvents.push({
      type: 'will-quit',
      unsettledWorkers: audit.workers.filter((worker) => worker.exitCode === null).length
    })
    save()
  })
  app.on('quit', (_event, exitCode) => {
    audit.quitEvents.push({ type: 'quit', exitCode })
    save()
  })
  globalThis.__lesson60FixtureReady = true
  save()
}
module.exports = { install }
