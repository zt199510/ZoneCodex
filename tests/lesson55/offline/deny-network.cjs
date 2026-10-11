const http = require('node:http')
const https = require('node:https')

let attempts = 0
const deny = () => {
  attempts++
  throw new Error('Offline verification refuses network requests')
}
globalThis.fetch = deny
http.request = http.get = https.request = https.get = deny
process.on('exit', () => {
  if (attempts) {
    process.exitCode = 1
    console.error('Offline network guard rejected ' + attempts + ' request(s)')
  }
})
