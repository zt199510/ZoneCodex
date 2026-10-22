// Product offline checks may replace fetch with an explicit synthetic transport.
// Native sockets/DNS remain blocked so those substitutes cannot reach a real server.
require('../lesson55/offline/deny-network.cjs')
let attempts = 0
const deny = () => { attempts++; throw Error('Lesson64 offline verification refuses native network access') }
const net = require('node:net'), tls = require('node:tls'), dns = require('node:dns')
net.connect = net.createConnection = tls.connect = deny
for (const name of ['lookup', 'resolve', 'resolve4', 'resolve6']) { dns[name] = deny; dns.promises[name] = deny }
process.on('exit', () => { if (attempts) { process.exitCode = 1; console.error('Native network guard rejected ' + attempts + ' attempt(s)') } })
