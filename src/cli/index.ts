import { randomUUID } from 'node:crypto'
import type { Readable, Writable } from 'node:stream'
import { runAgentTask } from './agent-host'
import { CLIInputError, InteractionUnavailableError } from './host-contract'
import { HELP, parseCLIArguments, readTaskInput, requestedOutput } from './arguments'
import { CLIOutput, CLIOutputError, type CLIResult } from './output'
import { TerminalInteraction } from './interaction'
import { WindowsOutputBridge } from './output-bridge'

type CLIIO = { stdin: Readable; stdout: Writable; stderr: Writable; signals?: boolean }

/** CLI owns one controller; the public script entry is a separate, inert module. */
export async function runCLI(
  argv: readonly string[] = process.argv.slice(2),
  io: CLIIO = {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    signals: true
  }
): Promise<number> {
  const controller = new AbortController()
  let stopCode: 1 | 3 | 130 | null = null
  let interaction: TerminalInteraction | null = null
  const cancel = (cause: Error, code: 1 | 3 | 130): void => {
    if (stopCode !== null) return
    stopCode = code
    controller.abort(cause)
  }
  const interrupt = (): void => cancel(new Error('用户已取消任务'), 130)
  const bridge = new WindowsOutputBridge(io.stdout, io.stderr)
  const output = new CLIOutput(requestedOutput(argv), bridge.stdout, bridge.stderr, (error) =>
    cancel(error, 1)
  )
  const fallback = { requestId: randomUUID(), conversationId: randomUUID() }
  let exitCode = 1
  if (io.signals !== false) process.on('SIGINT', interrupt)
  try {
    const args = parseCLIArguments(argv)
    await bridge.ready(controller.signal)
    if (args.help) {
      output.help(HELP)
      await output.flush(controller.signal)
      exitCode = stopCode ?? 0
    } else {
      if (!args.mode) throw new CLIInputError('必须明确提供工作方式')
      const prompt = args.stdin ? await readTaskInput(io.stdin, controller.signal) : args.prompt!
      controller.signal.throwIfAborted()
      interaction = new TerminalInteraction(io.stdin, io.stderr, args.stdin, controller.signal, {
        diagnostic: (text) => output.diagnostic(text),
        flush: () => output.flush(controller.signal),
        unavailable: (error) => cancel(error, 3),
        cancel: interrupt
      })
      const result = await runAgentTask(
        {
          prompt,
          mode: args.mode,
          permission: args.permission,
          ...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
          ...(args.workspace !== undefined ? { workspace: args.workspace } : {})
        },
        {
          signal: controller.signal,
          onEvent: (event) => {
            if (controller.signal.aborted) return
            try {
              output.event(event)
            } catch (cause) {
              cancel(new CLIOutputError(), 1)
              throw cause
            }
          },
          approve: interaction.approve,
          answer: interaction.answer
        }
      )
      exitCode = stopCode ?? result.exitCode
      output.terminal({ ...result, exitCode })
      await output.flush(controller.signal)
    }
  } catch (cause) {
    const classified =
      cause instanceof CLIInputError
        ? 2
        : cause instanceof InteractionUnavailableError
          ? 3
          : cause instanceof CLIOutputError
            ? 1
            : 1
    exitCode = stopCode ?? classified
    const error =
      exitCode === 130
        ? '用户已取消任务'
        : cause instanceof CLIInputError ||
            cause instanceof InteractionUnavailableError ||
            cause instanceof CLIOutputError
          ? cause.message
          : '任务或宿主处理失败；请核对当前文件与命令结果后再决定是否重新请求'
    const failure: CLIResult = {
      ...fallback,
      task: { state: exitCode === 130 ? 'cancelled' : 'failed', error },
      answer: '',
      effects: { approved: false, started: false },
      toolResults: [],
      elapsedMs: 0,
      exitCode
    }
    try {
      output.terminal(failure)
      await output.flush(controller.signal)
    } catch {
      exitCode = stopCode ?? 1
    }
  } finally {
    interaction?.dispose()
    io.stdin.pause()
    if (io.signals !== false) process.removeListener('SIGINT', interrupt)
    try {
      await bridge.dispose()
    } catch {
      exitCode = stopCode ?? 1
    }
    output.dispose()
  }
  return exitCode
}

// The distributed CLI is CommonJS. Importing this module for validation does
// not run it, and the public Node library never imports this entry point.
if (typeof require !== 'undefined' && require.main === module) {
  void runCLI().then((exitCode) => {
    process.exitCode = exitCode
  })
}
