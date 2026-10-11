'use strict'
/**
 * Copyright (c) 2019, Microsoft Corporation (MIT License).
 * ZoneCodex local cleanup adaptation, node-pty 1.1.0 only (MIT License).
 * Console attachment requires a separate process; failures are data for its owner.
 */
const { loadNativeModule } = require('./utils')
let result
try {
  const getConsoleProcessList = loadNativeModule('conpty_console_list').module.getConsoleProcessList
  result = { consoleProcessList: getConsoleProcessList(Number(process.argv[2])) }
} catch (error) {
  result = { consoleProcessList: [], error: String(error.message || error).slice(0, 300) }
}
if (!process.send) {
  console.error('Console helper IPC is unavailable')
  process.exit(1)
} else {
  process.send(result, (error) => {
    if (error)
      console.error('Console helper reply failed: ' + String(error.message || error).slice(0, 300))
    process.exit(error ? 1 : 0)
  })
}
