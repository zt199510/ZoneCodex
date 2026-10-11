/* eslint-disable @typescript-eslint/explicit-function-return-type -- This byte-locked patch generator runs directly as Node JavaScript. */
// Exact replacements are guarded by the complete original/patched file hashes in manifest.json.
export const originalHashes = {
  'windowsPtyAgent.js': '8636d16b38266112204061a22b135734177c242837982fd3a4055be726efa64a',
  'windowsTerminal.js': 'c3a65716f53fed0135a8a633373d5f9c2ab092544d651f27ef0a67096dd3bcd9',
  'windowsConoutConnection.js': '1440f70908fb1f55911ac8e936a1230f68a9c00c03096fcef6788eac6aad9d62',
  'conpty_console_list_agent.js': '0d010879bb6680a0253d44363183d53e631f42972594eb6dcb1fb842c8c85e52'
}

function replaceOnce(text, from, to) {
  if (text.split(from).length !== 2)
    throw new Error('Expected one node-pty patch anchor: ' + from.slice(0, 80))
  return text.replace(from, to)
}

function replaceMethod(text, from, end, replacement) {
  const start = text.indexOf(from),
    finish = text.indexOf(end, start)
  if (start < 0 || finish < 0 || text.indexOf(from, start + 1) !== -1)
    throw new Error('Invalid node-pty method anchor')
  return text.slice(0, start) + replacement + '\n    ' + text.slice(finish)
}

export function patchStock(name, original) {
  let text = original.replaceAll('\r\n', '\n')
  if (name === 'windowsPtyAgent.js') {
    text = replaceOnce(
      text,
      'var windowsConoutConnection_1 = require("./windowsConoutConnection");',
      'var windowsConoutConnection_1 = require("./windowsConoutConnection");\nvar zonecodexCleanup = require("./zonecodexWindowsCleanup");'
    )
    text = replaceOnce(
      text,
      '            this._innerPid = connect.pid;\n        }\n    }',
      '            this._innerPid = connect.pid;\n        }\n        this._cleanup = new zonecodexCleanup.WindowsCleanup(this, {\n            fork: child_process_1.fork,\n            helperPath: path.join(__dirname, "conpty_console_list_agent"),\n            processKill: process.kill.bind(process)\n        });\n    }'
    )
    text = replaceMethod(
      text,
      'WindowsPtyAgent.prototype.kill = function () {',
      'WindowsPtyAgent.prototype._getConsoleProcessList = function () {',
      'WindowsPtyAgent.prototype.kill = function () {\n        return this._cleanup.kill();\n    };\n    Object.defineProperty(WindowsPtyAgent.prototype, "onExit", {\n        get: function () { return this._cleanup.onExit; }\n    });'
    )
    text = replaceMethod(
      text,
      'WindowsPtyAgent.prototype._$onProcessExit = function (exitCode) {',
      'WindowsPtyAgent.prototype._flushDataAndCleanUp = function () {',
      'WindowsPtyAgent.prototype._$onProcessExit = function (exitCode) {\n        this._cleanup.nativeExit(exitCode);\n    };'
    )
  } else if (name === 'windowsTerminal.js') {
    text = replaceOnce(
      text,
      '        _this._socket = _this._agent.outSocket;',
      '        _this._socket = _this._agent.outSocket;\n        _this._agent.onExit(function (code) {\n            _this.emit("exit", code);\n            _this._close();\n        });'
    )
    text = replaceOnce(
      text,
      "                _this.emit('exit', _this._agent.exitCode);\n                _this._close();",
      '                _this._close();'
    )
    text = replaceOnce(
      text,
      "                if (_this.listeners('error').length < 2) {\n                    throw err;\n                }",
      "                console.error('[ZoneCodex node-pty socket] ' + String(err.message || err).slice(0, 300));"
    )
    text = replaceMethod(
      text,
      'WindowsTerminal.prototype.destroy = function () {',
      'WindowsTerminal.prototype._deferNoArgs = function (deferredFn) {',
      `WindowsTerminal.prototype.destroy = function () { return this.kill(); };
    WindowsTerminal.prototype.kill = function (signal) {
        if (signal) throw new Error('Signals not supported on windows.');
        this._close();
        return this._agent.kill().catch(function (error) {
            console.error('[ZoneCodex node-pty cleanup] ' + String(error.message || error).slice(0, 300));
        });
    };`
    )
  } else throw new Error('Unknown stock patch: ' + name)
  return text.replace(/^\/\/# sourceMappingURL=.*\n?$/m, '')
}
