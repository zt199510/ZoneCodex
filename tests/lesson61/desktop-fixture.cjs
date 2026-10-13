/* Test-only directory replies and synthetic model transport; production IPC/Git/PTY/disk. */
function install(config) {
  const require = process.getBuiltinModule('module').createRequire(config.root + '/package.json')
  const fs = require('node:fs')
  const { app, BrowserWindow, dialog, ipcMain, utilityProcess } = require('electron')
  const childProcess = require('node:child_process')
  app.setPath('userData', config.userData)
  process.env.MODEL_ENDPOINT = 'https://lesson61-fixture.invalid/responses'
  process.env.MODEL_NAME = 'lesson61-synthetic'
  process.env.MODEL_API_KEY = 'synthetic-fixture-key'
  const audit = {
    pid: process.pid,
    actualElectron: true,
    actualGit: true,
    actualPTY: true,
    realModelTransport: false,
    syntheticModelTransport: true,
    syntheticNativeDirectoryReplies: true,
    spawnArgumentsChanged: false,
    utilityForkArgumentsChanged: false,
    directoryReplies: [],
    requests: [],
    ipc: [],
    gitProcesses: [],
    utilityHosts: [],
    quitEvents: [],
    synthetic: []
  }
  const save = () => {
    const temporary = config.auditFile + '.tmp'
    fs.writeFileSync(temporary, JSON.stringify(audit, null, 2))
    fs.renameSync(temporary, config.auditFile)
  }
  let nextDirectory = config.directory
  let scenario = { name: 'idle', round: 0 }
  const originalDirectoryDialog = dialog.showOpenDialog.bind(dialog)
  dialog.showOpenDialog = async (...args) => {
    const options = args.at(-1)
    if (!options?.properties?.includes('openDirectory')) return originalDirectoryDialog(...args)
    const record = { directory: nextDirectory, options, atUTC: new Date().toISOString() }
    audit.directoryReplies.push(record)
    save()
    return nextDirectory
      ? { canceled: false, filePaths: [nextDirectory] }
      : { canceled: true, filePaths: [] }
  }
  const spawn = childProcess.spawn
  childProcess.spawn = function (...args) {
    const child = spawn.apply(childProcess, args)
    if (String(args[0]).toLowerCase() !== config.git.toLowerCase()) return child
    const record = {
      program: args[0],
      args: args[1],
      cwd: args[2]?.cwd,
      shell: args[2]?.shell ?? false,
      env: Object.fromEntries(
        Object.entries(args[2]?.env ?? {}).filter(([key]) =>
          /^GIT_|^HOME$|^USERPROFILE$/i.test(key)
        )
      ),
      pid: child.pid ?? null,
      startedAtUTC: new Date().toISOString(),
      exitCode: null,
      signal: null,
      closedAtUTC: null,
      stdoutBytes: 0,
      stderrBytes: 0,
      errors: []
    }
    audit.gitProcesses.push(record)
    child.stdout?.on('data', (bytes) => {
      record.stdoutBytes += bytes.byteLength
    })
    child.stderr?.on('data', (bytes) => {
      record.stderrBytes += bytes.byteLength
    })
    child.once('error', (error) => {
      record.errors.push(String(error.message).slice(0, 500))
      save()
    })
    child.once('close', (exitCode, signal) => {
      Object.assign(record, { exitCode, signal, closedAtUTC: new Date().toISOString() })
      save()
    })
    save()
    return child
  }
  const fork = utilityProcess.fork
  utilityProcess.fork = function (...args) {
    const child = fork.apply(utilityProcess, args)
    if (!String(args[0]).replaceAll('\\', '/').endsWith('/terminal-host.js')) return child
    const record = {
      pid: child.pid ?? null,
      sessionId: null,
      ready: false,
      output: '',
      nativeExit: null,
      exitCode: null,
      exitedAtUTC: null
    }
    audit.utilityHosts.push(record)
    child.once('spawn', () => {
      record.pid = child.pid
      save()
    })
    child.on('message', (value) => {
      if (!value || typeof value !== 'object') return
      if (typeof value.sessionId === 'string') record.sessionId ??= value.sessionId
      if (value.type === 'ready') record.ready = true
      else if (value.type === 'data' && typeof value.data === 'string')
        record.output = (record.output + value.data).slice(-64000)
      else if (value.type === 'exit')
        record.nativeExit = { exitCode: value.exitCode, atUTC: new Date().toISOString() }
      save()
    })
    child.once('exit', (exitCode) => {
      record.exitCode = exitCode
      record.exitedAtUTC = new Date().toISOString()
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
  const call = (name, args) => ({
    type: 'function_call',
    call_id: 'lesson61-' + scenario.name + '-' + scenario.round,
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
    const record = {
      category,
      scenario: scenario.name,
      input: body.input,
      atUTC: new Date().toISOString()
    }
    audit.requests.push(record)
    save()
    if (category === 'approval') return response([message(JSON.stringify({ risk: 'risky' }))])
    if (category !== 'main' || scenario.name === 'idle')
      throw Error('Passive Git action unexpectedly started model transport')
    scenario.round += 1
    if (scenario.round === 1) {
      if (scenario.name === 'running')
        return response([call('get_current_time', { timeZone: 'Asia/Hong_Kong' })])
      if (scenario.name === 'approval')
        return response([
          call('create_workspace_file', {
            path: config.userData + '/../isolated-approval.txt',
            content: 'synthetic task body\n'
          })
        ])
      if (scenario.name === 'question')
        return response([
          call('request_user_input', {
            questions: [
              {
                id: 'scope',
                header: '范围',
                question: '本次采用哪个范围？',
                options: [
                  { label: '局部', description: '隔离目录。' },
                  { label: '完整', description: '完整目录。' }
                ]
              }
            ]
          })
        ])
      throw Error('Unknown synthetic scenario')
    }
    if (scenario.name === 'running') {
      record.waitingForCancellation = true
      save()
      return new Promise((_resolve, reject) => {
        const finish = () => {
          record.cancelled = true
          save()
          reject(new DOMException('Synthetic reply aborted by actual owner', 'AbortError'))
        }
        if (init.signal.aborted) finish()
        else init.signal.addEventListener('abort', finish, { once: true })
      })
    }
    return response([message('第61课合成背景任务已收口。')])
  }
  const handle = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = (channel, handler) =>
    handle(channel, async (event, ...args) => {
      const observed =
        /^(git-view:|git:|agent:|execution:|workspace:|project:|terminal:|conversation:|task:|command-)/.test(
          channel
        )
      const record = observed ? { channel, args, atUTC: new Date().toISOString() } : null
      if (record) {
        audit.ipc.push(record)
        save()
      }
      try {
        const value = await handler(event, ...args)
        if (record) {
          record.result = value
          record.returnedAtUTC = new Date().toISOString()
          save()
        }
        return value
      } catch (error) {
        if (record) {
          record.error = String(error.message).slice(0, 500)
          save()
        }
        throw error
      }
    })
  handle('lesson61:observe', () => audit)
  handle('lesson61:configure', (_event, value) => {
    if (Object.hasOwn(value, 'directory')) nextDirectory = value.directory
    if (value.scenario) scenario = { name: value.scenario, round: 0 }
    audit.synthetic.push({ kind: 'configure', value, atUTC: new Date().toISOString() })
    save()
    return true
  })
  handle('lesson61:quit', () => {
    setImmediate(() => {
      for (const window of BrowserWindow.getAllWindows()) window.destroy()
      app.quit()
    })
    return true
  })
  for (const name of ['before-quit', 'will-quit', 'quit'])
    app.on(name, () => {
      audit.quitEvents.push({ name, atUTC: new Date().toISOString() })
      save()
    })
  globalThis.__lesson61Ready = true
  save()
}
module.exports = { install }
