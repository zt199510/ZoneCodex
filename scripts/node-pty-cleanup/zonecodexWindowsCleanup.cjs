'use strict'
/**
 * Copyright (c) 2012-2015, Christopher Jeffrey, Peter Sunde (MIT License)
 * Copyright (c) 2016, Daniel Imms (MIT License).
 * Copyright (c) 2018, Microsoft Corporation (MIT License).
 * ZoneCodex local cleanup adaptation, node-pty 1.1.0 only (MIT License).
 */
const { EventEmitter2 } = require('./eventEmitter2')

const bounds = Object.freeze({
  helper: 5000,
  helperKill: 1000,
  quiet: 1000,
  flush: 2000,
  resources: 1500,
  complete: 9800
})
const message = (error) => String(error instanceof Error ? error.message : error).slice(0, 300)
const diagnostic = (error) => console.error('[ZoneCodex node-pty cleanup] ' + message(error))

function bounded(promise, ms, label) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label + ' timed out')), ms)
    })
  ]).finally(() => clearTimeout(timer))
}

function closeSocket(socket, ms) {
  if (socket.closed) return Promise.resolve()
  return new Promise((resolve, reject) => {
    let timer
    const remove = () => {
      clearTimeout(timer)
      socket.removeListener('close', close)
      socket.removeListener('error', fail)
    }
    const close = () => {
      remove()
      resolve()
    }
    const fail = (error) => {
      // A failed stream still needs its close acknowledgement.
      diagnostic(error)
    }
    socket.once('close', close)
    socket.on('error', fail)
    timer = setTimeout(() => {
      remove()
      reject(new Error('PTY socket close timed out'))
    }, ms)
    try {
      socket.destroy()
    } catch (error) {
      remove()
      reject(error)
    }
  })
}

class WindowsCleanup {
  constructor(agent, dependencies) {
    this.agent = agent
    this.dependencies = dependencies
    this.limits = { ...bounds, ...dependencies.limits }
    this.exited = false
    this.completed = false
    this.closing = false
    this.actionsPending = false
    this.nativeClosed = false
    this.killPromise = null
    this.retirePromise = null
    this.helper = null
    this.outputClosed = false
    this.exitEmitter = new EventEmitter2()
    this.waiters = new Set()
    this.onExit = this.exitEmitter.event
    agent.outSocket.on('data', () => this.scheduleRetirement())
    agent.outSocket.on('close', () => {
      this.outputClosed = true
      if (!agent._useConpty) this.nativeExit(agent.exitCode)
      else if (!this.exited && !this.closing) this.kill().catch(diagnostic)
      else this.scheduleRetirement()
    })
    // Own errors from both streams even before ready_datapipe is emitted.
    for (const socket of [agent.inSocket, agent.outSocket]) {
      socket.on('error', (error) => {
        diagnostic(error)
        if (!this.completed) this.kill().catch(diagnostic)
      })
    }
  }

  nativeExit(code) {
    if (this.exited) return
    this.agent._exitCode = code
    this.exited = true
    this.scheduleRetirement()
  }

  shellIsDead() {
    if (this.exited) return true
    try {
      this.dependencies.processKill(this.agent.innerPid, 0)
      return false
    } catch (error) {
      return error.code === 'ESRCH'
    }
  }

  async collectProcesses() {
    // A previous timeout may leave an owned helper awaiting its close event.
    if (this.helper) {
      const old = this.helper
      try {
        old.child.kill()
      } catch (error) {
        if (error.code !== 'ESRCH') diagnostic(error)
      }
      await bounded(old.closed, this.limits.helperKill, 'Previous console helper retirement')
      if (this.helper === old) this.helper = null
      if (this.exited) return []
    }
    const child = this.dependencies.fork(
      this.dependencies.helperPath,
      [String(this.agent.innerPid)],
      {
        // Never inherit the desktop host's inspector pause into this helper.
        execArgv: [],
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe', 'ipc']
      }
    )
    let finishClosed
    const owned = {
      child,
      closed: new Promise((resolve) => {
        finishClosed = resolve
      })
    }
    this.helper = owned
    const outcome = await new Promise((resolve, reject) => {
      let answer,
        failure = '',
        stderr = '',
        settled = false,
        timer,
        killTimer
      const finish = (code, signal) => {
        finishClosed()
        if (this.helper === owned) this.helper = null
        this.scheduleRetirement()
        if (settled) return
        settled = true
        clearTimeout(timer)
        clearTimeout(killTimer)
        resolve({ answer, failure, stderr, code, signal, helperPid: child.pid })
      }
      child.stderr?.on('data', (bytes) => {
        stderr = (stderr + bytes).slice(0, 2048)
      })
      child.on('message', (value) => {
        if (
          value &&
          Array.isArray(value.consoleProcessList) &&
          value.consoleProcessList.length <= 4096 &&
          value.consoleProcessList.every(
            (pid) => Number.isInteger(pid) && pid > 0 && pid <= 0xffffffff
          )
        ) {
          answer = value
        } else failure = 'Console helper returned an invalid process list'
      })
      child.on('error', (error) => {
        failure = message(error)
        // A failed spawn has no owned OS process to await.
        if (!child.pid) finish(null, null)
      })
      child.once('close', finish)
      timer = setTimeout(() => {
        failure = 'Console helper enumeration timed out'
        try {
          child.kill()
        } catch (error) {
          failure += ': ' + message(error)
        }
        killTimer = setTimeout(() => {
          if (settled) return
          settled = true
          reject(new Error('Console helper did not confirm retirement after termination'))
        }, this.limits.helperKill)
      }, this.limits.helper)
    })
    const failure =
      outcome.failure ||
      outcome.answer?.error ||
      (!outcome.answer ? 'Console helper exited without a process list' : '') ||
      (outcome.code !== 0 || outcome.signal ? 'Console helper exited abnormally' : '')
    if (outcome.stderr) diagnostic('Console helper stderr: ' + outcome.stderr)
    if (failure) {
      // Only a proven dead shell makes AttachConsole's exit race benign.
      if (this.shellIsDead() && /^AttachConsole failed/.test(failure)) return []
      diagnostic(failure)
      return this.shellIsDead() ? [] : [this.agent.innerPid]
    }
    return [...new Set(outcome.answer.consoleProcessList)].filter(
      (pid) => pid !== outcome.helperPid && pid !== process.pid
    )
  }

  closeNativeOnce() {
    if (this.nativeClosed) return
    this.nativeClosed = true
    try {
      this.agent._ptyNative.kill(this.agent.pty, this.agent._useConptyDll)
    } catch (error) {
      // A thrown native request was not acknowledged; a later explicit retry is allowed.
      this.nativeClosed = false
      throw error
    }
  }

  kill() {
    if (this.completed) return Promise.resolve()
    if (this.killPromise) return this.killPromise
    clearTimeout(this.quietTimer)
    clearTimeout(this.flushTimer)
    this.flushTimer = null
    this.closing = true
    this.actionsPending = true
    let finish, fail
    const completed = new Promise((resolve, reject) => {
      finish = resolve
      fail = reject
    })
    completed.catch(() => undefined)
    const waiter = { finish, fail }
    this.waiters.add(waiter)
    let actionsFinished = false
    const attempt = Promise.resolve().then(async () => {
      if (this.agent._useConpty) {
        if (!this.exited || this.helper) {
          const results = await Promise.allSettled([this.collectProcesses(), this.workerReady()])
          const failed = results.find((result) => result.status === 'rejected')
          if (failed) throw failed.reason
          // Helper has exited. Retire attached descendants while the root keeps the baton alive.
          // Killing innerPid here can let native's exit thread remove the baton before native kill.
          for (const pid of results[0].value) {
            if (pid === this.agent.innerPid) continue
            try {
              this.dependencies.processKill(pid)
            } catch (error) {
              if (error.code !== 'ESRCH') diagnostic(error)
            }
          }
        } else if (!this.nativeClosed) await this.workerReady()
        this.closeNativeOnce()
        // Native close precedes root force-kill so it can release the owned HPCON first.
        // A proven exited/dead shell needs no fallback PID operation.
        if (!this.shellIsDead()) {
          try {
            this.dependencies.processKill(this.agent.innerPid)
          } catch (error) {
            if (error.code !== 'ESRCH') diagnostic(error)
          }
        }
      } else {
        const list = this.agent._ptyNative.getProcessList(this.agent._pid)
        this.agent._ptyNative.kill(this.agent._pid, this.agent.innerPid)
        for (const pid of list) {
          try {
            this.dependencies.processKill(pid)
          } catch (error) {
            if (error.code !== 'ESRCH') diagnostic(error)
          }
        }
      }
    })
    this.killPromise = bounded(
      attempt.then(() => {
        actionsFinished = true
        this.actionsPending = false
        this.scheduleRetirement()
        return completed
      }),
      this.limits.complete,
      'PTY cleanup completion'
    ).then(
      () => {
        this.waiters.delete(waiter)
      },
      (error) => {
        this.actionsPending = false
        this.waiters.delete(waiter)
        this.killPromise = null
        if (!actionsFinished) this.scheduleRetirement()
        throw error
      }
    )
    return this.killPromise
  }

  workerReady() {
    return bounded(
      this.agent._conoutSocketWorker.ready,
      this.limits.helper,
      'ConPTY pipe worker readiness'
    )
  }

  scheduleRetirement() {
    if (!this.exited || this.completed || this.actionsPending || this.helper || this.retirePromise)
      return
    clearTimeout(this.quietTimer)
    if (this.outputClosed) {
      this.retire().catch(diagnostic)
      return
    }
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.retire().catch(diagnostic), this.limits.flush)
    }
    this.quietTimer = setTimeout(() => this.retire().catch(diagnostic), this.limits.quiet)
  }

  retire() {
    if (this.retirePromise) return this.retirePromise
    if (!this.exited || this.actionsPending || this.helper) return Promise.resolve()
    clearTimeout(this.quietTimer)
    clearTimeout(this.flushTimer)
    this.flushTimer = null
    const attempt = Promise.resolve().then(async () => {
      if (this.agent._useConpty && !this.nativeClosed) {
        await this.workerReady()
        this.closeNativeOnce()
      }
      await Promise.all([
        closeSocket(this.agent.inSocket, this.limits.resources),
        closeSocket(this.agent.outSocket, this.limits.resources),
        bounded(
          this.agent._conoutSocketWorker.dispose(),
          this.limits.resources,
          'ConPTY pipe worker retirement'
        )
      ])
    })
    this.retirePromise = attempt.then(
      () => {
        if (this.completed) return
        this.completed = true
        this.exitEmitter.fire(this.agent.exitCode)
        for (const waiter of this.waiters) waiter.finish()
      },
      (error) => {
        this.retirePromise = null
        for (const waiter of this.waiters) waiter.fail(error)
        throw error
      }
    )
    return this.retirePromise
  }
}

module.exports = { WindowsCleanup }
