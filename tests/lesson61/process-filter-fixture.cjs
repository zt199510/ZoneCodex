/* Valid long-running Git filter protocol v2, used only by isolated control repositories. */
const fs = require('node:fs')
fs.appendFileSync(process.argv[2], 'process\n')
let buffered = Buffer.alloc(0)
let phase = 'handshake'
let lines = []
let content = []
function packet(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value)
  process.stdout.write(Buffer.from((bytes.length + 4).toString(16).padStart(4, '0')))
  process.stdout.write(bytes)
}
const flush = () => process.stdout.write('0000')
function accept(bytes) {
  if (bytes !== null) {
    if (phase === 'content') content.push(bytes)
    else lines.push(bytes.toString('utf8'))
    return
  }
  if (phase === 'handshake') {
    if (!lines.includes('git-filter-client\n') || !lines.includes('version=2\n')) process.exit(1)
    packet('git-filter-server\n')
    packet('version=2\n')
    flush()
    phase = 'capabilities'
  } else if (phase === 'capabilities') {
    packet('capability=clean\n')
    packet('capability=smudge\n')
    flush()
    phase = 'headers'
  } else if (phase === 'headers') {
    if (!lines.some((line) => line === 'command=clean\n' || line === 'command=smudge\n'))
      process.exit(2)
    content = []
    phase = 'content'
  } else {
    packet('status=success\n')
    flush()
    const bytes = Buffer.concat(content)
    for (let offset = 0; offset < bytes.length; offset += 65516)
      packet(bytes.subarray(offset, offset + 65516))
    flush()
    flush()
    phase = 'headers'
    content = []
  }
  lines = []
}
process.stdin.on('data', (bytes) => {
  buffered = Buffer.concat([buffered, bytes])
  while (buffered.length >= 4) {
    const count = Number.parseInt(buffered.toString('ascii', 0, 4), 16)
    if (count === 0) {
      buffered = buffered.subarray(4)
      accept(null)
      continue
    }
    if (!Number.isInteger(count) || count < 4 || count > 65520) process.exit(3)
    if (buffered.length < count) return
    const packet = buffered.subarray(4, count)
    buffered = buffered.subarray(count)
    accept(packet)
  }
})
