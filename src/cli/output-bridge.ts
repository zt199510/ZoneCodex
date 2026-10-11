import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { Writable } from 'node:stream'
import { CLIOutputError } from './output'

const STARTUP_LIMIT_MS = 5000
const SHUTDOWN_LIMIT_MS = 1000
declare const __OUTPUT_WRITER_SHA256__: string

type NativeStdio = Writable & { _type?: string; _isStdio?: boolean; fd?: number }
type PendingWrite = { sequence: number; complete: (error?: Error | null) => void }
type WriterExit = { code: number | null; signal: NodeJS.Signals | null }

/** Windows inherited pipes cannot cancel a blocked OS write in this process. */
export class WindowsOutputBridge {
  readonly stdout: Writable
  readonly stderr: Writable
  private child: ChildProcess | null = null
  private starting: Promise<void> | null = null
  private exited: Promise<WriterExit> = Promise.resolve({ code: 0, signal: null })
  private sequence = 0
  private pending: PendingWrite | null = null
  private failure: CLIOutputError | null = null
  private closing = false
  private stopped = false
  private readonly proxies: Writable[] = []
  private readonly inherited: [Writable | 'ignore', Writable | 'ignore'] | null

  constructor(stdout: Writable, stderr: Writable) {
    const pipe = (stream: Writable, native: Writable, fd: number): boolean => {
      if (process.platform !== 'win32' || stream !== native) return false
      const candidate = stream as NativeStdio
      return candidate._type === 'pipe' && candidate._isStdio === true && candidate.fd === fd
    }
    const out = pipe(stdout, process.stdout, 1)
    const err = pipe(stderr, process.stderr, 2)
    this.stdout = out ? this.proxy(1) : stdout
    this.stderr = err ? this.proxy(2) : stderr
    this.inherited = out || err ? [out ? stdout : 'ignore', err ? stderr : 'ignore'] : null
  }

  private proxy(target: 1 | 2): Writable {
    const proxy = new Writable({
      write: (bytes: Buffer, _encoding, complete) => {
        void this.ready().then(
          () => {
            if (this.failure || this.closing || !this.child?.connected) {
              complete(this.failure ?? new CLIOutputError())
              return
            }
            if (this.pending !== null) {
              this.fail()
              complete(this.failure)
              return
            }
            const sequence = ++this.sequence
            this.pending = { sequence, complete }
            this.child.send(
              { type: 'write', sequence, target, text: bytes.toString('utf8') },
              (error) => {
                if (error) this.fail()
              }
            )
          },
          () => complete(this.failure ?? new CLIOutputError())
        )
      },
      destroy: (error, complete) => {
        this.terminate()
        complete(error)
      }
    })
    // Writable reports a failed write on a later tick. The bridge owns this
    // proxy and keeps its error receiver after CLIOutput releases its listeners.
    proxy.on('error', () => this.fail())
    this.proxies.push(proxy)
    return proxy
  }

  private fail(): void {
    if (this.failure) return
    this.failure = new CLIOutputError('Windows 输出进程启动、写入或确认失败，输出未完成')
    const pending = this.pending
    this.pending = null
    pending?.complete(this.failure)
    for (const proxy of this.proxies) proxy.destroy(this.failure)
    this.terminate()
  }

  private start(stdout: Writable | 'ignore', stderr: Writable | 'ignore'): Promise<void> {
    return new Promise<void>((resolveReady, rejectReady) => {
      const location = resolve(__dirname, 'output-writer.cjs')
      try {
        const install = resolve(__dirname)
        const ordinary = (filename: string, directory = false): void => {
          const info = lstatSync(filename)
          if (
            info.isSymbolicLink() ||
            (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1) ||
            realpathSync(filename).toLowerCase() !== filename.toLowerCase()
          )
            throw new Error()
        }
        ordinary(install, true)
        ordinary(location)
        const manifestPath = resolve(install, 'build-manifest.json')
        ordinary(manifestPath)
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
          entries?: Array<{ name?: unknown; sha256?: unknown }>
        }
        if (
          typeof __OUTPUT_WRITER_SHA256__ !== 'string' ||
          !/^[a-f0-9]{64}$/.test(__OUTPUT_WRITER_SHA256__) ||
          !Array.isArray(manifest.entries) ||
          manifest.entries.filter((entry) => entry.name === 'output-writer.cjs').length !== 1 ||
          manifest.entries.filter(
            (entry) =>
              entry.name === 'output-writer.cjs' && entry.sha256 === __OUTPUT_WRITER_SHA256__
          ).length !== 1 ||
          createHash('sha256').update(readFileSync(location)).digest('hex') !==
            __OUTPUT_WRITER_SHA256__
        )
          throw new Error()
      } catch {
        this.failure = new CLIOutputError('固定 Windows 输出资源缺失或身份不匹配，未启动任务')
        rejectReady(this.failure)
        return
      }
      const environment = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => /^(SystemRoot|WINDIR|TEMP|TMP)$/i.test(key))
      )
      const child = spawn(process.execPath, [location], {
        cwd: dirname(location),
        env: environment,
        windowsHide: true,
        stdio: ['ignore', stdout, stderr, 'ipc']
      })
      this.child = child
      this.exited = new Promise<WriterExit>((resolveExit) =>
        child.once('close', (code, signal) => resolveExit({ code, signal }))
      )
      let ready = false
      const timer = setTimeout(() => {
        this.fail()
        rejectReady(this.failure)
      }, STARTUP_LIMIT_MS)
      const failed = (): void => {
        clearTimeout(timer)
        if (!this.closing) this.fail()
        if (!ready) rejectReady(this.failure ?? new CLIOutputError())
      }
      child.on('error', failed)
      child.on('exit', failed)
      child.on('disconnect', failed)
      child.on('message', (value) => {
        if (this.closing) return
        if (!value || typeof value !== 'object' || Array.isArray(value)) return this.fail()
        const message = value as Record<string, unknown>
        const keys = Object.keys(message)
        if (!ready && message.type === 'ready' && keys.length === 1) {
          ready = true
          clearTimeout(timer)
          resolveReady()
          return
        }
        if (
          !ready ||
          message.type !== 'ack' ||
          keys.length !== 2 ||
          !keys.includes('sequence') ||
          this.pending === null ||
          message.sequence !== this.pending.sequence
        )
          return this.fail()
        const pending = this.pending
        this.pending = null
        pending.complete()
      })
    })
  }

  private terminate(): void {
    this.closing = true
    if (this.stopped) return
    this.stopped = true
    const pending = this.pending
    this.pending = null
    pending?.complete(this.failure ?? new CLIOutputError())
    if (this.child && this.child.exitCode === null) this.child.kill()
  }

  async ready(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    if (this.closing || this.stopped) throw this.failure ?? new CLIOutputError()
    if (this.starting === null && this.inherited !== null) {
      this.starting = this.start(...this.inherited)
      void this.starting.catch(() => {})
    }
    if (!signal) await this.starting
    else {
      let abort = (): void => {}
      const stopped = new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason)
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
      })
      try {
        await Promise.race([this.starting, stopped])
      } finally {
        signal.removeEventListener('abort', abort)
      }
    }
    if (this.failure) throw this.failure
  }

  async dispose(): Promise<void> {
    this.closing = true
    if (!this.child) {
      this.stopped = true
      return
    }
    if (!this.stopped && this.child.connected && this.pending === null)
      this.child.send({ type: 'finish' }, () => {})
    else this.terminate()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      this.terminate()
    }, SHUTDOWN_LIMIT_MS)
    let outcome: WriterExit
    try {
      outcome = await this.exited
    } finally {
      clearTimeout(timer)
    }
    if (timedOut && !this.failure) throw new CLIOutputError('Windows 输出进程未正常退出')
    if (!this.stopped && (outcome.code !== 0 || outcome.signal !== null))
      throw new CLIOutputError('Windows 输出进程未正常退出')
  }
}
