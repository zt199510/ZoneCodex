/* Synthetic model transport only; the Electron, PTY, IPC and storage adapters are real. */
function install(config) {
  const require = process.getBuiltinModule('module').createRequire(config.root + '/package.json')
  const fs = require('node:fs')
  const { app, BrowserWindow, ipcMain, utilityProcess } = require('electron')
  app.setPath('userData', config.userData)
  process.env.MODEL_ENDPOINT = 'https://lesson59-fixture.invalid/responses'
  process.env.MODEL_NAME = 'lesson59-synthetic'
  process.env.MODEL_API_KEY = 'synthetic-fixture-key'
  const audit = {
    pid: process.pid,
    realTransport: false,
    actualPTY: true,
    debuggerInheritanceRemoved: false,
    testOverridesPTYWorkerForkArguments: false,
    testOverridesUtilityForkArguments: false,
    observerMovedToUtility: true,
    unobservedInternalPTY: ['node-pty spawn/native module', 'conout Worker', 'process-list helper'],
    requests: [],
    ipc: [],
    events: [],
    terminals: [],
    helpers: [],
    workers: [],
    nativeModules: [],
    ptyModulePaths: [],
    windowDestroyed: false,
    quitEvents: []
  }
  let syntheticStartFailure = false
  let syntheticCloseFailures = 0
  const save = () => {
    const temporary = config.auditFile + '.tmp'
    fs.writeFileSync(temporary, JSON.stringify(audit, null, 2))
    fs.renameSync(temporary, config.auditFile)
  }
  const fork = utilityProcess.fork
  // Observe the real utility host; delegate its original filename/args/options unchanged.
  utilityProcess.fork = function (...values) {
    const child = fork.apply(utilityProcess, values)
    if (!/[/\\]terminal-host\.js$/.test(String(values[0]))) return child
    const options = values[2] ?? {}
    const record = {
      filename: String(values[0]),
      hostPid: child.pid ?? null,
      forkArgs: values[1],
      forkOptions: {
        cwd: options.cwd,
        execArgv: options.execArgv,
        serviceName: options.serviceName,
        debuggerEnvironmentKeys: Object.keys(options.env ?? {}).filter((name) =>
          /^(NODE_OPTIONS|VSCODE_INSPECTOR_OPTIONS|ELECTRON_RUN_AS_NODE|V8_INSPECTOR_(?:BRK_)?PORT)$/i.test(
            name
          )
        )
      },
      sessionId: null,
      program: null,
      args: null,
      cwd: null,
      initialSize: null,
      spawned: false,
      ready: false,
      requests: [],
      messages: [],
      writes: [],
      sizes: [],
      closeMessages: 0,
      hostKillCalls: 0,
      outputBeforeClose: '',
      output: '',
      nativeExit: null,
      hostExit: null,
      errors: [],
      stderr: ''
    }
    audit.terminals.push(record)
    const postMessage = child.postMessage.bind(child)
    child.postMessage = function (...messages) {
      const message = messages[0]
      record.requests.push({ message, atUTC: new Date().toISOString() })
      if (message?.type === 'init') {
        record.sessionId = message.sessionId
        record.program = message.program
        record.args = message.args
        record.cwd = message.cwd
        record.initialSize = message.size
      } else if (message?.type === 'write') record.writes.push(message.data)
      else if (message?.type === 'resize') record.sizes.push(message.size)
      else if (message?.type === 'close') {
        record.closeMessages += 1
        record.outputBeforeClose = record.output
      }
      save()
      return postMessage(...messages)
    }
    const kill = child.kill.bind(child)
    child.kill = function (...args) {
      record.hostKillCalls += 1
      save()
      return kill(...args)
    }
    child.once('spawn', () => {
      record.hostPid = child.pid
      record.spawned = true
      record.spawnedAtUTC = new Date().toISOString()
      save()
    })
    child.on('message', (message) => {
      record.messages.push({ message, atUTC: new Date().toISOString() })
      if (message?.sessionId === record.sessionId) {
        if (message.type === 'ready') record.ready = true
        else if (message.type === 'data')
          record.output = (record.output + message.data).slice(-64000)
        else if (message.type === 'exit')
          record.nativeExit = { exitCode: message.exitCode, atUTC: new Date().toISOString() }
        else if (message.type === 'error') record.errors.push(message.error)
      }
      save()
    })
    child.once('exit', (exitCode) => {
      record.hostExit = { exitCode, atUTC: new Date().toISOString() }
      save()
    })
    child.on('error', (...details) => {
      record.errors.push(details.map(String).join(': '))
      save()
    })
    child.stderr?.on('data', (bytes) => {
      record.stderr = (record.stderr + bytes.toString()).slice(-4096)
      save()
    })
    save()
    return child
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
      if (
        channel.startsWith('agent:') ||
        channel.startsWith('terminal:') ||
        channel.startsWith('window:')
      ) {
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
      // Failed checks still use the production quit barrier before the driver's bounded rescue.
      app.quit()
    })
    return true
  })
  app.on('web-contents-created', (_event, contents) => {
    const send = contents.send.bind(contents)
    contents.send = (channel, ...args) => {
      if (
        channel.startsWith('agent:') ||
        channel === 'execution:approval-change' ||
        channel === 'window:close-requested'
      )
        audit.events.push({ channel, value: args[0] })
      save()
      return send(channel, ...args)
    }
  })
  app.on('before-quit', () => {
    audit.quitEvents.push({ type: 'before-quit', atUTC: new Date().toISOString() })
    save()
  })
  app.on('will-quit', () => {
    audit.quitEvents.push({
      type: 'will-quit',
      atUTC: new Date().toISOString(),
      unsettledTerminalHosts: audit.terminals.filter((terminal) => terminal.hostExit === null)
        .length
    })
    save()
  })
  app.on('quit', (_event, exitCode) => {
    audit.quitEvents.push({ type: 'quit', exitCode, atUTC: new Date().toISOString() })
    save()
  })
  globalThis.__lesson59FixtureReady = true
  save()
}
module.exports = { install }
