import { spawn } from 'node:child_process'
import type { SpawnOptionsWithoutStdio } from 'node:child_process'

export class GitReadError extends Error {
  constructor(
    public readonly status:
      | 'stale'
      | 'not-repository'
      | 'unavailable'
      | 'unsupported'
      | 'too-large'
      | 'cancelled'
      | 'error',
    message: string
  ) {
    super(message)
  }
}

export interface GitProcessObservation {
  event: 'spawn' | 'close' | 'unconfirmed'
  pid?: number
  executable: string
  args: string[]
  cwd: string
  code?: number | null
  signal?: string | null
}

/** Internal runner. No renderer can supply its executable, argv or environment. */
export async function runGitProcess(options: {
  executable: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  signal?: AbortSignal
  input?: Buffer
  stdoutBytes?: number
  stderrBytes?: number
  timeoutMs?: number
  acceptedCodes?: number[]
  onProcess?: (event: GitProcessObservation) => void
}): Promise<Buffer> {
  if (options.signal?.aborted) throw new GitReadError('cancelled', 'Git 读取已取消')
  return new Promise((resolve, reject) => {
    const child = spawn(options.executable, options.args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    } as SpawnOptionsWithoutStdio)
    const chunks: Buffer[] = []
    const errors: Buffer[] = []
    let bytes = 0
    let errorBytes = 0
    let failure: Error | undefined
    let settled = false
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const observe = (event: GitProcessObservation['event'], code?: number | null): void => {
      try {
        options.onProcess?.({
          event,
          pid: child.pid,
          executable: options.executable,
          args: [...options.args],
          cwd: options.cwd,
          ...(code !== undefined ? { code } : {})
        })
      } catch {
        failure ??= new GitReadError('error', 'Git 进程诊断回调失败')
      }
    }
    const stop = (error: Error): void => {
      failure ??= error
      killTimer ??= setTimeout(() => {
        if (settled) return
        settled = true
        observe('unconfirmed')
        cleanup()
        reject(new GitReadError('error', 'Git 进程退出未确认；保留查询缓存供诊断'))
      }, 2000)
      try {
        child.kill()
      } catch {
        failure = new GitReadError('error', 'Git 终止请求失败，仍在等待实际退出确认')
      }
    }
    const abort = (): void => stop(new GitReadError('cancelled', 'Git 读取已取消'))
    const timer = setTimeout(
      () => stop(new GitReadError('error', 'Git 读取超过 10 秒，已请求终止')),
      options.timeoutMs ?? 10000
    )
    const cleanup = (): void => {
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      options.signal?.removeEventListener('abort', abort)
    }
    options.signal?.addEventListener('abort', abort, { once: true })
    child.once('spawn', () => observe('spawn'))
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > (options.stdoutBytes ?? 1048576))
        stop(new GitReadError('too-large', 'Git 输出超过读取上限'))
      else chunks.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      errorBytes += chunk.length
      if (errorBytes > (options.stderrBytes ?? 16384))
        stop(new GitReadError('too-large', 'Git 错误输出超过上限'))
      else errors.push(chunk)
    })
    child.on('error', (error) => {
      failure ??= new GitReadError('unavailable', `Git 程序不可用：${error.message}`)
    })
    child.stdin.on('error', () => {
      // A cancelled or early-exiting child may close stdin before accepting the bounded input.
    })
    child.once('close', (code) => {
      observe('close', code)
      if (settled) return
      settled = true
      cleanup()
      if (failure) reject(failure)
      else if (!(options.acceptedCodes ?? [0]).includes(code ?? -1))
        reject(
          new GitReadError(
            'error',
            Buffer.concat(errors)
              .toString('utf8')
              .replace(/\p{Cc}/gu, ' ')
              .slice(0, 600) || `Git 读取失败（${code}）`
          )
        )
      else resolve(Buffer.concat(chunks))
    })
    child.stdin.end(options.input)
  })
}
