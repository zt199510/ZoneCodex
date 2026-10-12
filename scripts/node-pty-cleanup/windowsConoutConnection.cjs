'use strict'
/**
 * Copyright (c) 2020, Microsoft Corporation (MIT License).
 * ZoneCodex local cleanup adaptation, node-pty 1.1.0 only (MIT License).
 */
const { Worker } = require('worker_threads')
const { join } = require('path')
const { getWorkerPipeName } = require('./shared/conout')
const { EventEmitter2 } = require('./eventEmitter2')

class ConoutConnection {
  constructor(conoutPipeName, useConptyDll) {
    this._conoutPipeName = conoutPipeName
    this._useConptyDll = useConptyDll
    this._isDisposed = false
    this._workerExited = false
    this._onReady = new EventEmitter2()
    let resolveReady, rejectReady, resolveExit
    this.ready = new Promise((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    this.ready.catch(() => undefined)
    this._exit = new Promise((resolve) => {
      resolveExit = resolve
    })
    const scriptPath = __dirname.replace('node_modules.asar', 'node_modules.asar.unpacked')
    this._worker = new Worker(join(scriptPath, 'worker/conoutSocketWorker.js'), {
      // Electron may inherit inspector flags even when process.execArgv appears empty.
      execArgv: [],
      workerData: { conoutPipeName }
    })
    this._worker.on('message', (value) => {
      if (value !== 1 /* READY: TypeScript const enum, no runtime export. */) {
        console.warn('Unexpected ConoutWorkerMessage', value)
        return
      }
      resolveReady()
      if (!this._isDisposed) this._onReady.fire()
    })
    this._worker.on('error', (error) => {
      rejectReady(error)
      console.error('[ZoneCodex node-pty worker] ' + String(error.message || error).slice(0, 300))
    })
    this._worker.once('exit', (code) => {
      this._workerExited = true
      rejectReady(new Error('ConPTY pipe worker exited before readiness'))
      resolveExit(code)
    })
  }

  get onReady() {
    return this._onReady.event
  }

  connectSocket(socket) {
    if (!this._isDisposed && !socket.destroyed)
      socket.connect(getWorkerPipeName(this._conoutPipeName))
  }

  dispose() {
    if (this._disposePromise) return this._disposePromise
    this._isDisposed = true
    const attempt = (async () => {
      if (!this._workerExited) await this._worker.terminate()
      await this._exit
    })()
    this._disposePromise = attempt.catch((error) => {
      this._disposePromise = null
      throw error
    })
    // Stock callers may ignore dispose's newly explicit completion value.
    this._disposePromise.catch(() => undefined)
    return this._disposePromise
  }
}

exports.ConoutConnection = ConoutConnection
