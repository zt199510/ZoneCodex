// eslint-disable-next-line @typescript-eslint/no-unused-vars -- The desktop driver reads and serializes this function for debugger injection.
function bootstrap(config) {
  const require = process.getBuiltinModule('module').createRequire(config.root + '/package.json')
  const { app, ipcMain, dialog, BrowserWindow } = require('electron')
  const fs = require('node:fs')
  const path = require('node:path')
  app.setPath('userData', config.userData)
  delete process.env.ELECTRON_RENDERER_URL
  try {
    process.loadEnvFile(path.join(config.root, '.env.local'))
  } catch {
    // An inherited explicit configuration is valid when the optional local env file is unavailable.
  }
  const configuredEndpoint = process.env.MODEL_ENDPOINT
  if (!configuredEndpoint || process.env.MODEL_NAME !== 'gpt-6.1-sol' || !process.env.MODEL_API_KEY)
    throw new Error('The current default gpt-6.1-sol model configuration is required')
  const audit = {
    synthetic: false,
    behavior: 'lesson55-real-task',
    stage: config.stage,
    modelMatches: process.env.MODEL_NAME === 'gpt-6.1-sol',
    configurationPresent: true,
    requests: [],
    allFetches: [],
    unexpectedFetches: [],
    spawns: [],
    ipc: [],
    tools: [],
    commandStarts: 0
  }
  const save = () => {
    try {
      const next = config.auditFile + '.next'
      fs.writeFileSync(next, JSON.stringify(audit))
      fs.renameSync(next, config.auditFile)
    } catch (error) {
      const issue = {
        atUTC: new Date().toISOString(),
        message: error.message,
        code: error.code ?? null,
        path: error.path ?? null,
        dest: error.dest ?? null,
        syscall: error.syscall ?? null
      }
      ;(audit.observerWriteFailures ??= []).push(issue)
      try {
        fs.writeFileSync(
          config.auditFile +
            '.observer-write-failure-' +
            require('node:crypto').randomUUID() +
            '.json',
          JSON.stringify({ issue, audit })
        )
      } catch {
        // Secondary evidence writing must not replace the original observed product outcome.
      }
    }
  }
  const control = () => JSON.parse(fs.readFileSync(config.controlFile, 'utf8'))
  const handle = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = (channel, handler) =>
    handle(channel, async (event, ...args) => {
      if (channel === 'agent:start') {
        audit.ipc.push({
          channel,
          requestId: args[0],
          mode: args[3]?.mode,
          context: args[3],
          atUTC: new Date().toISOString()
        })
        save()
      }
      const result = await handler(event, ...args)
      if (channel === 'agent:start') {
        const started = audit.ipc.findLast(
          (entry) => entry.channel === 'agent:start' && entry.requestId === args[0]
        )
        if (started) started.resultStatus = result.status
      }
      if (channel === 'conversation:save')
        audit.ipc.push({ channel, ok: result.ok, version: args[0]?.version })
      if (channel === 'agent:user-input-respond')
        audit.ipc.push({ channel, response: args[0], accepted: result })
      save()
      return result
    })
  handle('lesson55:observation', () => audit)
  handle('lesson55:quit', () => {
    setImmediate(() => app.exit(0))
    return true
  })
  handle('lesson55:resize', (event, width) => {
    BrowserWindow.fromWebContents(event.sender).setContentSize(width, 840)
    return true
  })
  dialog.showOpenDialog = async (_owner, options) => ({
    canceled: false,
    filePaths: options.properties.includes('openDirectory')
      ? [config.project]
      : [path.join(config.project, 'requirements.txt')]
  })
  const actualFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    audit.allFetches.push({
      atUTC: new Date().toISOString(),
      method: init.method,
      expectedEndpoint: url === configuredEndpoint
    })
    save()
    if (url !== configuredEndpoint || init.method !== 'POST' || typeof init.body !== 'string') {
      audit.unexpectedFetches.push({
        atUTC: new Date().toISOString(),
        method: init.method,
        expectedEndpoint: url === configuredEndpoint
      })
      save()
      throw new Error('Unexpected test network request')
    }
    const body = JSON.parse(init.body)
    if (body.model !== 'gpt-6.1-sol') throw new Error('Unexpected model')
    const title = body.instructions.includes('你负责为桌面聊天会话生成标题')
    const approval = body.instructions.includes('独立风险评估器')
    const fixture = control()
    if (
      body.input.some(
        (item) =>
          Array.isArray(item.content) && item.content.some((part) => part.type === 'input_image')
      )
    )
      throw new Error('This isolated file-only fixture does not upload images')
    const images = []
    const entry = {
      startedAtUTC: new Date().toISOString(),
      startedAtMs: Date.now(),
      requestBodySHA256: require('node:crypto')
        .createHash('sha256')
        .update(init.body)
        .digest('hex'),
      requestBodyBytes: Buffer.byteLength(init.body),
      title,
      approval,
      rawBody: body,
      fixture: fixture.id,
      tools: body.tools.map((t) => t.name),
      images,
      input: body.input.map((item) => ({
        type: item.type,
        role: item.role,
        phase: item.phase,
        name: item.name,
        call_id: item.call_id,
        output: item.output,
        arguments: item.arguments,
        content:
          typeof item.content === 'string'
            ? item.content
            : Array.isArray(item.content)
              ? item.content.filter((p) => p.type !== 'input_image')
              : item.content
      })),
      httpStatus: null,
      completed: false,
      answer: '',
      stream: { chunks: 0, bytes: 0, eof: false, eventTypes: {}, terminalEvents: [], error: null }
    }
    audit.requests.push(entry)
    save()

    let response
    try {
      response = await actualFetch(url, init)
    } catch (error) {
      entry.error = { message: error.message, code: error.cause?.code }
      save()
      throw error
    }
    entry.httpStatus = response.status
    save()
    if (!response.ok || !response.body) return response
    const reader = response.body.getReader(),
      decoder = new TextDecoder()
    let buffer = ''
    const accept = (chunk) => {
      buffer += chunk
      if (buffer.length > 1000000) throw new Error('Observation limit')
      let boundary
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, boundary.index)
        buffer = buffer.slice(boundary.index + boundary[0].length)
        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n')
        if (!data || data === '[DONE]') continue
        let event
        try {
          event = JSON.parse(data)
        } catch {
          continue
        }
        entry.stream.eventTypes[event.type] = (entry.stream.eventTypes[event.type] ?? 0) + 1
        if (['response.failed', 'response.incomplete', 'error'].includes(event.type))
          entry.stream.terminalEvents.push({
            type: event.type,
            status: event.response?.status,
            error: event.error ?? event.response?.error ?? null,
            incompleteDetails: event.response?.incomplete_details ?? null
          })
        if (event.type === 'response.completed') {
          entry.completed = true
          entry.completedAtUTC = new Date().toISOString()
          entry.elapsedMs = Date.now() - entry.startedAtMs
          entry.response = event.response
          entry.answer = event.response.output
            .filter((item) => item.type === 'message' && item.phase !== 'commentary')
            .flatMap((item) =>
              item.content.filter((p) => p.type === 'output_text').map((p) => p.text)
            )
            .join('\n')
          audit.tools.push(
            ...event.response.output
              .filter((item) => item.type === 'function_call')
              .map((item) => ({
                name: item.name,
                arguments: item.arguments,
                fixture: entry.fixture
              }))
          )
          save()
        }
      }
    }
    return new Response(
      new ReadableStream({
        async pull(controller) {
          try {
            const value = await reader.read()
            if (value.done) {
              accept(decoder.decode())
              entry.stream.eof = true
              entry.stream.eofAtUTC = new Date().toISOString()
              entry.stream.unparsedTailCharacters = buffer.length
              save()
              controller.close()
              reader.releaseLock()
            } else {
              entry.stream.chunks++
              entry.stream.bytes += value.value.byteLength
              accept(decoder.decode(value.value, { stream: true }))
              controller.enqueue(value.value)
            }
          } catch (error) {
            entry.stream.error = { message: error.message, code: error.cause?.code ?? null }
            save()
            controller.error(error)
          }
        },
        async cancel(reason) {
          await reader.cancel(reason)
        }
      }),
      { status: response.status, headers: response.headers }
    )
  }
  const cp = require('node:child_process'),
    originalSpawn = cp.spawn
  cp.spawn = function (program, ...args) {
    audit.spawns.push({
      program: String(program),
      args: Array.isArray(args[0]) ? args[0] : [],
      atUTC: new Date().toISOString()
    })
    save()
    if (/host\.exe|codex.*\.exe|powershell\.exe|cmd\.exe/i.test(String(program))) {
      audit.commandStarts++
      save()
    }
    return originalSpawn.call(this, program, ...args)
  }
  save()
  audit.events = []
  app.on('web-contents-created', (_event, contents) => {
    const send = contents.send.bind(contents)
    contents.send = (channel, ...args) => {
      if (/^agent:|^execution:|^task:/.test(channel)) {
        audit.events.push({ channel, args })
        save()
      }
      return send(channel, ...args)
    }
  })
  globalThis.__lesson55RecordCoreError = (error) => {
    try {
      const file = config.auditFile + '.core-error-' + require('node:crypto').randomUUID() + '.json'
      fs.writeFileSync(
        file,
        JSON.stringify({
          atUTC: new Date().toISOString(),
          name: error?.name,
          message: error?.message,
          stack: error?.stack,
          code: error?.code,
          path: error?.path,
          dest: error?.dest,
          syscall: error?.syscall
        })
      )
    } catch {
      // Exception observation must leave the original caught error and product control flow intact.
    }
  }
  globalThis.__lesson55ObserverReady = true
}
