import { writeSync } from 'node:fs'

const BYTE_LIMIT = 4 * 1024 * 1024

/** A supervised output process: only fixed stdout/stderr descriptors, no task capabilities. */
function main(): void {
  let sequence = 0
  let finished = false
  const stop = (): void => {
    finished = true
    process.exitCode = 1
    if (process.connected) process.disconnect()
  }
  // The parent owns cancellation and the terminal result. In particular, a
  // console Ctrl+C must not race the parent's model/tool cleanup.
  process.on('SIGINT', () => {})
  process.on('message', (value) => {
    if (finished || !value || typeof value !== 'object' || Array.isArray(value)) return stop()
    const message = value as Record<string, unknown>
    const keys = Object.keys(message)
    if (message.type === 'finish' && keys.length === 1) {
      finished = true
      process.exitCode = 0
      if (process.connected) process.disconnect()
      return
    }
    if (
      keys.length !== 4 ||
      !keys.every((key) => ['type', 'sequence', 'target', 'text'].includes(key)) ||
      message.type !== 'write' ||
      message.sequence !== sequence + 1 ||
      !Number.isSafeInteger(message.sequence) ||
      (message.target !== 1 && message.target !== 2) ||
      typeof message.text !== 'string' ||
      Buffer.byteLength(message.text) > BYTE_LIMIT
    )
      return stop()
    sequence++
    try {
      const bytes = Buffer.from(message.text)
      let offset = 0
      while (offset < bytes.length) {
        const written = writeSync(message.target, bytes, offset, bytes.length - offset)
        if (written <= 0) throw new Error()
        offset += written
      }
      process.send?.({ type: 'ack', sequence }, (error) => {
        if (error) stop()
      })
    } catch {
      process.send?.({ type: 'error', sequence }, () => stop())
    }
  })
  process.send?.({ type: 'ready' }, (error) => {
    if (error) stop()
  })
}

if (typeof require !== 'undefined' && require.main === module) main()
