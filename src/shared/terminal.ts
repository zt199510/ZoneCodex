export type TerminalSize = { cols: number; rows: number }
export type TerminalResult = { ok: true } | { ok: false; error: string }
export type TerminalEvent =
  | { sessionId: string; type: 'data'; data: string }
  | { sessionId: string; type: 'exit'; exitCode: number }

export function isTerminalId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(value)
}

export function isTerminalSize(value: unknown): value is TerminalSize {
  if (typeof value !== 'object' || value === null) return false
  return (
    'cols' in value &&
    typeof value.cols === 'number' &&
    Number.isInteger(value.cols) &&
    value.cols >= 2 &&
    value.cols <= 500 &&
    'rows' in value &&
    typeof value.rows === 'number' &&
    Number.isInteger(value.rows) &&
    value.rows >= 1 &&
    value.rows <= 300
  )
}

export function parseTerminalResult(value: unknown): TerminalResult {
  if (typeof value === 'object' && value !== null && 'ok' in value) {
    if (value.ok === true) return { ok: true }
    if (value.ok === false && 'error' in value && typeof value.error === 'string') {
      return { ok: false, error: value.error }
    }
  }
  throw new Error('终端返回结果格式不正确')
}

export function parseTerminalEvent(value: unknown): TerminalEvent | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('sessionId' in value) ||
    !isTerminalId(value.sessionId) ||
    !('type' in value)
  ) {
    return null
  }
  if (value.type === 'data' && 'data' in value && typeof value.data === 'string') {
    return { sessionId: value.sessionId, type: 'data', data: value.data }
  }
  if (
    value.type === 'exit' &&
    'exitCode' in value &&
    typeof value.exitCode === 'number' &&
    Number.isInteger(value.exitCode)
  ) {
    return { sessionId: value.sessionId, type: 'exit', exitCode: value.exitCode }
  }
  return null
}
