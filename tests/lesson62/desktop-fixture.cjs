/* Actual Electron/IPC/storage/file reads. Optional synthetic model/held IPC are explicitly audited. */
function install(config) {
  const require = process.getBuiltinModule('module').createRequire(config.root + '/package.json')
  const fs = require('node:fs')
  const promises = require('node:fs/promises')
  const path = require('node:path')
  const childProcess = require('node:child_process')
  const { app, ipcMain } = require('electron')
  app.setPath('userData', config.userData)
  const originalFetch = globalThis.fetch
  if (!config.live) {
    process.env.MODEL_ENDPOINT = 'https://lesson62-fixture.invalid/responses'
    process.env.MODEL_NAME = 'lesson62-synthetic'
    process.env.MODEL_API_KEY = 'synthetic-fixture-key'
  }
  const audit = {
    pid: process.pid,
    live: config.live,
    requests: [],
    ipc: [],
    events: [],
    skillReads: [],
    skillRootOperations: [],
    skillDirectoryScans: [],
    skillAttributeHelpers: [],
    held: []
  }
  const save = () => fs.writeFileSync(config.auditFile, JSON.stringify(audit, null, 2))
  const skillRoot = path.resolve(config.userData, 'skills').toLowerCase()
  const observeFileSystem = (operation, target) => {
    if (typeof target !== 'string') return
    const resolved = path.resolve(target).toLowerCase()
    let observed = false
    if (resolved === skillRoot) {
      audit.skillRootOperations.push({ operation, at: Date.now() })
      observed = true
    }
    if (
      /^(opendir|readdir)/.test(operation) &&
      (resolved === skillRoot || resolved.startsWith(skillRoot + path.sep))
    ) {
      audit.skillDirectoryScans.push({ operation, at: Date.now() })
      observed = true
    }
    if (observed) save()
  }
  const wrapFileSystem = (provider, operation) => {
    const original = provider[operation]
    const wrapped = function (...args) {
      observeFileSystem(operation, args[0])
      return original.apply(this, args)
    }
    Object.assign(wrapped, original)
    if (typeof original.native === 'function')
      wrapped.native = function (...args) {
        observeFileSystem(operation + '.native', args[0])
        return original.native.apply(this, args)
      }
    provider[operation] = wrapped
  }
  for (const provider of [promises, fs]) {
    for (const operation of [
      'access',
      'lstat',
      'stat',
      'realpath',
      'mkdir',
      'open',
      'opendir',
      'readdir',
      'readFile'
    ]) {
      wrapFileSystem(provider, operation)
    }
  }
  for (const operation of [
    'accessSync',
    'lstatSync',
    'statSync',
    'realpathSync',
    'mkdirSync',
    'openSync',
    'opendirSync',
    'readdirSync',
    'readFileSync'
  ]) {
    wrapFileSystem(fs, operation)
  }
  const originalSpawn = childProcess.spawn
  childProcess.spawn = function (program, args, ...rest) {
    if (
      path.basename(String(program)).toLowerCase() === 'powershell.exe' &&
      Array.isArray(args) &&
      args.some(
        (arg) =>
          typeof arg === 'string' &&
          arg.includes('if ($paths.Count -gt 129)') &&
          arg.includes('[IO.File]::GetAttributes') &&
          arg.includes('ReparsePoint')
      )
    ) {
      audit.skillAttributeHelpers.push({
        method: 'spawn',
        program: 'powershell.exe',
        at: Date.now()
      })
      save()
    }
    return originalSpawn.call(this, program, args, ...rest)
  }
  const holds = new Map()
  let scenario = { name: 'review', round: 0 }
  let callSerial = 0
  let faults = {}
  const hold = (name) =>
    new Promise((resolve) => {
      if (holds.has(name)) throw Error('Duplicate held operation: ' + name)
      holds.set(name, resolve)
      audit.held.push({ name, at: Date.now() })
      save()
    })
  const originalOpen = promises.open
  promises.open = async function (...args) {
    const handle = await originalOpen.apply(promises, args)
    if (!String(args[0]).endsWith('SKILL.md')) return handle
    const read = handle.read.bind(handle)
    handle.read = async function (...values) {
      const requested = values[2]
      if (faults.holdFullSkillRead && requested > 1) {
        faults.holdFullSkillRead = false
        await hold('full-skill-read')
      }
      const result = await read(...values)
      audit.skillReads.push({
        file: String(args[0]),
        requested,
        position: values[3],
        bytes: result.bytesRead
      })
      save()
      return result
    }
    return handle
  }
  const message = (text) => ({
    type: 'message',
    role: 'assistant',
    phase: 'final_answer',
    content: [{ type: 'output_text', text }]
  })
  const call = (name, args) => ({
    type: 'function_call',
    call_id: 'skills-' + scenario.name + '-' + ++callSerial,
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
  globalThis.fetch = async function (url, init = {}) {
    if (init.method !== 'POST') throw Error('Unexpected model request method')
    const body = JSON.parse(init.body)
    const category = body.instructions.includes('你负责为桌面聊天会话生成标题')
      ? 'title'
      : body.instructions.includes('独立风险评估器')
        ? 'approval'
        : body.tools?.length
          ? 'main'
          : 'summary'
    const observation = {
      scenario: scenario.name,
      category,
      instructions: body.instructions,
      input: body.input,
      tools: body.tools?.map((tool) => tool.name) ?? [],
      model: body.model,
      at: Date.now()
    }
    audit.requests.push(observation)
    save()
    if (config.live) return originalFetch(url, init)
    if (String(url) !== process.env.MODEL_ENDPOINT)
      throw Error('Synthetic fixture rejects unexpected network')
    if (category === 'title') return response([message('价格代码审查')])
    if (category !== 'main') throw Error('Unexpected summary/approval work in small read-only task')
    scenario.round++
    if (scenario.name === 'failure')
      return new Response(
        JSON.stringify({ error: { message: 'Controlled postacceptance response failure' } }),
        { status: 400 }
      )
    if (scenario.name === 'ordinary') return response([message('普通消息完成。')])
    if (scenario.name === 'resume')
      return response([
        message('原技能审查任务已显式继续。已保存的 business.mjs 第2行读取证据表明数量0被改为1。')
      ])
    if (scenario.round === 1)
      return response([
        call('read_workspace_file', { path: 'business.mjs', startLine: 1, endLine: 20 })
      ])
    if (scenario.name === 'checkpoint') {
      observation.waitingForCancellation = true
      save()
      return new Promise((_resolve, reject) => {
        const abort = () => {
          observation.cancelled = true
          save()
          reject(new DOMException('Synthetic owner cancellation', 'AbortError'))
        }
        if (init.signal.aborted) abort()
        else init.signal.addEventListener('abort', abort, { once: true })
      })
    }
    return response([
      message(
        '发现 [P2] 数量0被当作默认数量。business.mjs 第2行的 quantity || 1 将0替换为1，subtotal(199,0) 实际返回199，预期0。建议仅在 quantity 缺失时设置默认值，并增加数量0的测试；本轮未执行测试或修改文件。'
      )
    ])
  }
  const originalHandle = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = (channel, handler) =>
    originalHandle(channel, async (event, ...args) => {
      const item = { channel, args, at: Date.now() }
      if (/^(skills:|agent:|conversation:)/.test(channel)) audit.ipc.push(item)
      if (channel === 'skills:prepare' && faults.holdPrepare) {
        faults.holdPrepare = false
        await hold('prepare')
      }
      if (channel === 'agent:resolve-execution' && faults.holdExecution) {
        faults.holdExecution = false
        await hold('execution')
      }
      save()
      try {
        const result = await handler(event, ...args)
        item.result = result
        save()
        return result
      } catch (error) {
        item.error = error.message
        save()
        throw error
      }
    })
  originalHandle('lesson62:observation', () => audit)
  originalHandle('lesson62:configure', (_event, value) => {
    if (value.scenario) scenario = { ...value.scenario, round: 0 }
    if (value.faults) faults = value.faults
    if (value.release) {
      const resolve = holds.get(value.release)
      holds.delete(value.release)
      resolve?.()
    }
    return true
  })
  originalHandle('lesson62:quit', () => {
    setImmediate(() => app.exit(0))
    return true
  })
  app.on('web-contents-created', (_event, contents) => {
    const send = contents.send.bind(contents)
    contents.send = (channel, ...values) => {
      if (/^(agent:skill-accepted|agent:context|agent:tool-event)/.test(channel))
        audit.events.push({ channel, value: values[0], at: Date.now() })
      save()
      return send(channel, ...values)
    }
  })
  globalThis.__lesson62FixtureReady = true
  save()
}
module.exports = { install }
