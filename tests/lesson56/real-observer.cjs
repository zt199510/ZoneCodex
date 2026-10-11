/* Transparent observation only: original bytes, model responses and tool results pass through. */
function install(config) {
  const require = process.getBuiltinModule('module').createRequire(config.root + '/package.json')
  const fs = require('node:fs'),
    path = require('node:path'),
    cp = require('node:child_process')
  const { createHash } = require('node:crypto')
  const fingerprint = (value) =>
    createHash('sha256')
      .update(typeof value === 'string' ? value : JSON.stringify(value))
      .digest('hex')
  if (config.desktop) {
    const { app } = require('electron')
    app.setPath('userData', config.userData)
    delete process.env.ELECTRON_RENDERER_URL
    try {
      process.loadEnvFile(path.join(config.root, '.env.local'))
    } catch {
      /* Inherited explicit configuration is valid. */
    }
  }
  if (
    !process.env.MODEL_ENDPOINT ||
    !process.env.MODEL_API_KEY ||
    (process.env.MODEL_NAME && process.env.MODEL_NAME !== 'gpt-6.1-sol')
  )
    throw Error('Actual default gpt-6.1-sol configuration is required')
  const endpoint = process.env.MODEL_ENDPOINT
  const audit = {
    realTransport: true,
    syntheticHistory: !!config.desktop,
    stage: config.stage,
    pid: process.pid,
    requests: [],
    allFetches: [],
    spawns: [],
    writers: [],
    ipc: [],
    events: [],
    saveRetryEvents: [],
    writeFailures: []
  }
  const saveRetryDelays = [10, 25, 50, 100],
    saveWait = new Int32Array(new SharedArrayBuffer(4))
  const save = () => {
    const next = config.auditFile + '.next'
    try {
      for (let attempt = 0; ; attempt++) {
        fs.writeFileSync(next, JSON.stringify(audit, null, 2))
        try {
          fs.renameSync(next, config.auditFile)
          return
        } catch (error) {
          const retryDelayMs = saveRetryDelays[attempt]
          if (!['EPERM', 'EBUSY'].includes(error.code) || retryDelayMs === undefined) throw error
          audit.saveRetryEvents.push({
            operation: 'rename',
            code: error.code,
            attempt: attempt + 1,
            retryDelayMs,
            atUTC: new Date().toISOString()
          })
          Atomics.wait(saveWait, 0, 0, retryDelayMs)
        }
      }
    } catch (error) {
      audit.writeFailures.push({ code: error.code ?? null, message: error.message })
      try {
        // Preserve the failed candidate for diagnosis; it is never treated as published.
        fs.writeFileSync(next, JSON.stringify(audit, null, 2))
      } catch {
        // The in-memory writeFailures remains authoritative when even this write fails.
      }
    }
  }
  const text = (item) =>
    typeof item.content === 'string'
      ? item.content
      : Array.isArray(item.content)
        ? item.content
            .filter((part) => part.type === 'output_text' || part.type === 'input_text')
            .map((part) => part.text)
            .join('\n')
        : ''
  const derivedContextMetadata = (item) => {
    const value = text(item),
      marker = 'ZONECODEX_CONTEXT_KNOWLEDGE_V1\n'
    if (!value.startsWith(marker)) return undefined
    try {
      const separator = value.indexOf('\n', marker.length)
      if (separator < 0) return { parsed: false }
      const derived = JSON.parse(value.slice(separator + 1))
      return {
        parsed: true,
        sha256: fingerprint(derived),
        characters: JSON.stringify(derived).length,
        sources: (derived.sources ?? []).map((source) => ({
          id: source.id,
          origin: source.origin,
          fingerprint: source.fingerprint
        })),
        readProgress: (derived.readProgress ?? []).map((progress) => ({
          origin: progress.origin,
          path: progress.path,
          sha256: progress.sha256,
          totalLines: progress.totalLines,
          ranges: (progress.ranges ?? []).map((range) => ({
            startLine: range.startLine,
            endLine: range.endLine
          })),
          complete: progress.complete,
          sourceIds: progress.sourceIds
        })),
        observedToolFacts: (derived.observedToolFacts ?? []).map((fact) => ({
          sourceId: fact.sourceId,
          index: fact.index,
          name: fact.name,
          callId: fact.callId,
          outputFingerprint: fact.outputFingerprint,
          outputCharacters: fact.outputCharacters,
          sha256: fingerprint(fact),
          observedSHA256: fingerprint(fact.observed),
          observedCharacters: JSON.stringify(fact.observed).length
        }))
      }
    } catch {
      // Observation failures do not alter or reject the original request.
      return { parsed: false }
    }
  }
  const metadata = (item) => ({
    type: item.type ?? 'user-message',
    role: item.role ?? null,
    phase: item.phase ?? null,
    name: item.name ?? null,
    callId: item.call_id ?? null,
    sha256: fingerprint(item),
    characters: JSON.stringify(item).length,
    textCharacters: text(item).length,
    summaryMarker: text(item).startsWith('ZONECODEX_CONTEXT_KNOWLEDGE_V1\n'),
    outputSHA256: typeof item.output === 'string' ? fingerprint(item.output) : null,
    outputCharacters: typeof item.output === 'string' ? item.output.length : 0,
    imageCount: Array.isArray(item.content)
      ? item.content.filter((part) => part.type === 'input_image').length
      : 0
  })
  const actualFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const expectedEndpoint = String(url) === endpoint
    audit.allFetches.push({
      atUTC: new Date().toISOString(),
      expectedEndpoint,
      method: init.method ?? null
    })
    save()
    if (!expectedEndpoint || init.method !== 'POST' || typeof init.body !== 'string')
      throw Error('Unexpected validation network request')
    const body = JSON.parse(init.body)
    if (body.model !== 'gpt-6.1-sol') throw Error('Unexpected actual model')
    const title = body.instructions.includes('你负责为桌面聊天会话生成标题'),
      approval = body.instructions.includes('独立风险评估器')
    const category = title
      ? 'title'
      : approval
        ? 'approval'
        : body.tools.length === 0
          ? 'summary'
          : 'main'
    const entry = {
      category,
      model: body.model,
      atUTC: new Date().toISOString(),
      startedAtMs: Date.now(),
      bodySHA256: fingerprint(init.body),
      bodyBytes: Buffer.byteLength(init.body),
      instructionsCharacters: body.instructions.length,
      toolsCharacters: JSON.stringify(body.tools).length,
      toolNames: body.tools.map((tool) => tool.name),
      inputCharacters: JSON.stringify(body.input).length,
      inputItems: body.input.length,
      input: body.input.map((item) => ({
        ...metadata(item),
        ...(category === 'main' && { derivedContext: derivedContextMetadata(item) })
      })),
      httpStatus: null,
      completed: false,
      output: [],
      stream: { chunks: 0, bytes: 0, eof: false, eventTypes: {}, terminalEvents: [] }
    }
    if (category === 'summary') {
      const material = JSON.parse(body.input[0].content)
      entry.outputCharacterBudget = material.outputCharacterBudget ?? null
      if (material.currentTaskReference) {
        entry.currentTaskReference = {
          sha256: fingerprint(material.currentTaskReference),
          characters: JSON.stringify(material.currentTaskReference).length,
          mode: material.currentTaskReference.mode,
          scopeKind: material.currentTaskReference.scopeKind
        }
      }
      entry.sourceIds = material.sourceIds
      entry.sources = material.material.map((source) => ({
        sourceId: source.sourceId,
        origin: source.origin,
        mode: source.mode,
        scopeKind: source.scopeKind,
        visibleSHA256: fingerprint(source.visible),
        visibleCharacters: JSON.stringify(source.visible).length
      }))
    }
    audit.requests.push(entry)
    save()
    let response
    try {
      response = await actualFetch(url, init)
    } catch (error) {
      entry.error = { message: error.message, code: error.cause?.code ?? null }
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
      if (buffer.length > 2000000) throw Error('Observer frame limit')
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
            status: event.response?.status ?? null,
            errorCode: event.error?.code ?? event.response?.error?.code ?? null,
            incompleteReason: event.response?.incomplete_details?.reason ?? null
          })
        if (event.type === 'response.completed') {
          entry.completed = true
          entry.elapsedMs = Date.now() - entry.startedAtMs
          entry.output = (event.response.output ?? []).map(metadata)
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
          entry.stream.cancelled = true
          save()
          await reader.cancel(reason)
        }
      }),
      { status: response.status, headers: response.headers }
    )
  }
  const actualSpawn = cp.spawn
  cp.spawn = function (program, args, options) {
    const writer = Array.isArray(args) && args.length === 1 && /output-writer[.]cjs$/.test(args[0])
    const effectiveEnvironment = options?.env ?? process.env
    const entry = {
      program: String(program),
      args: Array.isArray(args) ? args : [],
      cwd: options?.cwd ?? null,
      environmentNames: Object.keys(effectiveEnvironment).sort(),
      hasModelCredential: !!effectiveEnvironment.MODEL_API_KEY,
      hasNodeOptions: !!effectiveEnvironment.NODE_OPTIONS,
      kind: writer ? 'output-writer' : 'command-or-helper',
      atUTC: new Date().toISOString()
    }
    ;(writer ? audit.writers : audit.spawns).push(entry)
    const child = actualSpawn.apply(this, arguments)
    entry.pid = child.pid
    child.once('close', (exitCode, signal) => {
      entry.exitCode = exitCode
      entry.signal = signal
      entry.closed = true
      save()
    })
    if (writer) {
      entry.sentWrites = 0
      entry.receivedAcks = 0
      const actualSend = child.send
      child.send = function (value) {
        if (value?.type === 'write') entry.sentWrites++
        save()
        return actualSend.apply(this, arguments)
      }
      child.on('message', (value) => {
        if (value?.type === 'ack') entry.receivedAcks++
        save()
      })
    }
    save()
    return child
  }
  if (config.desktop) {
    const { app, ipcMain, dialog } = require('electron')
    const handle = ipcMain.handle.bind(ipcMain)
    ipcMain.handle = (channel, handler) =>
      handle(channel, async (event, ...args) => {
        if (channel === 'agent:start')
          audit.ipc.push({
            channel,
            requestId: args[0],
            mode: args[3]?.mode ?? null,
            atUTC: new Date().toISOString()
          })
        const result = await handler(event, ...args)
        if (channel === 'conversation:save')
          audit.ipc.push({ channel, ok: result.ok, version: args[0]?.version ?? null })
        save()
        return result
      })
    handle('lesson56:observation', () => audit)
    handle('lesson56:quit', () => {
      setImmediate(() => app.exit(0))
      return true
    })
    dialog.showOpenDialog = async (_owner, options) => ({
      canceled: false,
      filePaths: options.properties.includes('openDirectory')
        ? [config.project]
        : [path.join(config.project, 'requirements.txt')]
    })
    app.on('web-contents-created', (_event, contents) => {
      const actualSend = contents.send.bind(contents)
      contents.send = (channel, ...args) => {
        if (
          [
            'agent:context',
            'agent:tool-event',
            'agent:retry',
            'agent:progress',
            'agent:message-event'
          ].includes(channel)
        )
          audit.events.push({ channel, value: args[0] })
        save()
        return actualSend(channel, ...args)
      }
    })
  }
  process.once('exit', (exitCode) => {
    audit.exitCode = exitCode
    save()
  })
  globalThis.__lesson56ObserverReady = true
  save()
  return audit
}

module.exports = { install }
if (process.env.LESSON56_OBSERVER_CONFIG) install(JSON.parse(process.env.LESSON56_OBSERVER_CONFIG))
