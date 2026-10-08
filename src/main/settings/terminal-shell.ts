import { existsSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { TerminalShell } from '../../shared/settings'

export function resolveTerminalShell(shell: TerminalShell): { program: string; args: string[] } {
  if (process.platform !== 'win32') throw new Error('集成终端仅支持 Windows')
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
  if (!isAbsolute(systemRoot)) throw new Error('Windows 系统目录无效')
  const program =
    shell === 'powershell'
      ? join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : join(systemRoot, 'System32', 'cmd.exe')
  if (!existsSync(program) || !statSync(program).isFile())
    throw new Error(shell === 'powershell' ? '未找到 Windows PowerShell' : '未找到命令提示符')
  return {
    program: realpathSync(program),
    args: shell === 'powershell' ? ['-NoLogo', '-NoProfile'] : ['/d']
  }
}
