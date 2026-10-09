export type ResponseRetryEvent = {
  retry: number
  maxRetries: 5
  delayMs: number
  reason: 'http' | 'connection' | 'stream'
  status?: number
}

export class RetryableResponseError extends Error {
  constructor(
    message: string,
    readonly reason: ResponseRetryEvent['reason'],
    readonly status?: number,
    readonly retryAfterMs = 0
  ) {
    super(message)
  }
}

const transientCodes = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET'
])

// Inspect transport causes only. Certificate, DNS-name and redirect errors
// require configuration changes, so they must not enter the retry loop.
export function isTransientConnectionError(error: unknown): boolean {
  let current = error
  for (let depth = 0; depth < 5; depth++) {
    if (typeof current !== 'object' || current === null) return false
    const value = current as { code?: unknown; cause?: unknown }
    if (typeof value.code === 'string') return transientCodes.has(value.code)
    if (value.cause === undefined)
      return current instanceof TypeError && current.message === 'fetch failed'
    current = value.cause
  }
  return false
}

export function retryAfterMilliseconds(value: string | null): number {
  if (!value) return 0
  const trimmed = value.trim()
  const maxDelay = 2_147_483_647
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) return Math.min(maxDelay, Math.ceil(Number(trimmed) * 1000))
  const date = Date.parse(trimmed)
  return Number.isFinite(date) ? Math.min(maxDelay, Math.max(0, date - Date.now())) : 0
}

export function waitForResponseRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, delayMs)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}
