/* Only isolation, network rejection and passive timing; no PTY/Worker/fork replacements. */
function install(config) {
  const require = process.getBuiltinModule('module').createRequire(config.root + '/package.json')
  const fs = require('node:fs')
  const { app, BrowserWindow, ipcMain } = require('electron')
  app.setPath('userData', config.userData)
  const audit = {
    pid: process.pid,
    condition: config.condition,
    processExecArgv: process.execArgv,
    appArgv: process.argv,
    testOverridesPTYWorkerForkArguments: false,
    ipc: [],
    terminalEvents: [],
    networkRequests: [],
    quitEvents: [],
    heartbeat: 0
  }
  const save = () => {
    const temporary = config.auditFile + '.tmp'
    fs.writeFileSync(temporary, JSON.stringify(audit, null, 2))
    fs.renameSync(temporary, config.auditFile)
  }
  const timer = setInterval(() => {
    audit.heartbeat += 1
    audit.heartbeatAt = Date.now()
    save()
  }, 250)
  // Reject rather than synthesize any Agent/title/summary/reviewer transport.
  globalThis.fetch = async (url) => {
    audit.networkRequests.push({ url: String(url), at: Date.now() })
    save()
    throw Error('Independent terminal startup regression forbids networking')
  }
  const handle = ipcMain.handle.bind(ipcMain)
  const observeHandler =
    (channel, handler) =>
    async (event, ...args) => {
      const record = { channel, enteredAt: Date.now() }
      audit.ipc.push(record)
      save()
      try {
        const value = handler(event, ...args)
        record.synchronousReturnAt = Date.now()
        save()
        const result = await value
        record.returnedAt = Date.now()
        if (channel.startsWith('terminal:')) record.result = result
        save()
        return result
      } catch (error) {
        record.error = error.message
        record.returnedAt = Date.now()
        save()
        throw error
      }
    }
  ipcMain.handle = (channel, handler) => handle(channel, observeHandler(channel, handler))
  handle('terminal-startup:observation', () => audit)
  handle('terminal-startup:quit', () => {
    setImmediate(() => {
      for (const window of BrowserWindow.getAllWindows()) window.destroy()
      app.quit()
    })
    return true
  })
  const observeContents = (contents) => {
    const send = contents.send.bind(contents)
    contents.send = (channel, ...args) => {
      if (channel === 'terminal:event') {
        audit.terminalEvents.push({ at: Date.now(), event: args[0] })
        save()
      }
      return send(channel, ...args)
    }
  }
  app.on('web-contents-created', (_event, contents) => observeContents(contents))
  app.on('before-quit', () => {
    audit.quitEvents.push({ type: 'before-quit', at: Date.now() })
    save()
  })
  app.on('will-quit', () => {
    audit.quitEvents.push({ type: 'will-quit', at: Date.now() })
    save()
  })
  app.on('quit', (_event, exitCode) => {
    clearInterval(timer)
    audit.quitEvents.push({ type: 'quit', exitCode, at: Date.now() })
    save()
  })
  save()
  globalThis.__terminalStartupReady = true
}
module.exports = { install }
