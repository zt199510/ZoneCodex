const assert = require('node:assert/strict')
const http = require('node:http')
const https = require('node:https')
const net = require('node:net')
const childProcess = require('node:child_process')
const fs = require('node:fs')
const promises = require('node:fs/promises')

const bundle = process.argv[2]
assert(bundle)
const counts = { network: 0, process: 0, writer: 0, checkpointRead: 0, credential: 0, exit: 0 }
const zeroCounts = { ...counts }
// An import may schedule microtasks and swallow their errors. The exit check
// keeps those attempts observable after the immediate import assertion.
process.on('exit', () => {
  if (Object.values(counts).some((count) => count !== 0)) {
    process.exitCode = 1
    console.error(JSON.stringify({ pass: false, counts }))
  }
})
function deny(kind) {
  return () => {
    counts[kind]++
    throw new Error('Inert import attempted ' + kind)
  }
}
globalThis.fetch = deny('network')
http.request = http.get = https.request = https.get = deny('network')
net.connect = net.createConnection = deny('network')
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'])
  childProcess[name] = deny('process')
for (const name of ['writeFile', 'appendFile', 'mkdir', 'rename', 'rm', 'unlink']) {
  fs[name] = deny('writer')
  fs[name + 'Sync'] = deny('writer')
  promises[name] = deny('writer')
}
const readFile = promises.readFile
promises.readFile = function (file, ...args) {
  if (/checkpoint|raw\.json/i.test(String(file))) return deny('checkpointRead')()
  return readFile.call(this, file, ...args)
}
const readFileSync = fs.readFileSync
fs.readFileSync = function (file, ...args) {
  if (/checkpoint|raw\.json/i.test(String(file))) return deny('checkpointRead')()
  return readFileSync.call(this, file, ...args)
}
const environment = process.env
process.env = new Proxy(environment, {
  get(target, key) {
    if (typeof key === 'string' && /^MODEL_/.test(key)) return deny('credential')()
    return Reflect.get(target, key)
  }
})
// This is a one-shot child process. Keep every guard installed until its
// natural exit so deferred work cannot escape after require() returns.
process.exit = deny('exit')
const beforeListeners = process.listenerCount('SIGINT')
const imported = require(bundle)
assert(Object.keys(imported).length > 0)
assert.equal(process.listenerCount('SIGINT'), beforeListeners)
assert.deepEqual(counts, zeroCounts)
console.log(JSON.stringify({ pass: true, counts, exports: Object.keys(imported).sort() }))
