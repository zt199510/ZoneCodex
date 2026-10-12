import type { TerminalResult, TerminalSize } from '../../shared/terminal'

export type TerminalHostRequest =
  | {
      type: 'init'
      sessionId: string
      program: string
      args: string[]
      cwd: string
      size: TerminalSize
    }
  | { type: 'write'; sessionId: string; sequence: number; data: string }
  | { type: 'resize'; sessionId: string; sequence: number; size: TerminalSize }
  | { type: 'close'; sessionId: string; sequence: number }
  | { type: 'retire'; sessionId: string }

export type TerminalHostMessage =
  | { type: 'ready'; sessionId: string }
  | { type: 'data'; sessionId: string; data: string }
  | { type: 'result'; sessionId: string; sequence: number; result: TerminalResult }
  | { type: 'exit'; sessionId: string; exitCode: number }
  | { type: 'error'; sessionId: string; error: string }

export function terminalHostError(error: unknown): string {
  return (error instanceof Error ? error.message : '终端宿主通信失败').slice(0, 300)
}
