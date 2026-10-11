import type { Readable } from 'node:stream'
import { parseAgentMode, type AgentMode } from '../shared/agent'
import { parsePermissionMode, type PermissionMode } from '../shared/execution'
import { CLIInputError } from './host-contract'

export const STDIN_BYTE_LIMIT = 8192
export type OutputMode = 'text' | 'jsonl'
export type CLIArguments = {
  help: boolean
  mode?: AgentMode
  cwd?: string
  workspace?: string
  permission: PermissionMode
  output: OutputMode
  prompt?: string
  stdin: boolean
}

export const HELP = `ZoneCodex Agent — 一次明确任务

用法：
  zonecodex-agent --mode plan|execute --prompt "任务" [选项]
  zonecodex-agent --mode plan|execute --stdin [选项]

选项：
  --cwd <目录>                 本次工作目录；默认当前调用目录
  --workspace <目录>           可选工作区；宿主复核实际目录
  --permission <策略>          default（缺省）、auto-approve、full-access
  --output <格式>              text（缺省）或 jsonl
  --prompt <文字>              原字符串最多 2000 个 JS 字符，不能为空
  --stdin                      从标准输入读取任务；最多 8192 字节、严格 UTF-8
  --help                       单独显示帮助，不启动任务

任务只取 --prompt 或 --stdin 之一；mode 必须明确提供。
审批和计划问答只使用未被任务占用的交互终端；缺少交互时以 3 结束。
模型需预先配置 MODEL_ENDPOINT、MODEL_NAME、MODEL_API_KEY；密钥不放命令参数。
text 的 stdout 仅为最终回答；公开过程和交互提示在 stderr。
jsonl 的 stdout 为公开事件和一次安全结果；不包含原协议历史。
退出码：0 完成，1 任务/宿主/输出失败，2 输入/配置错误，3 缺少交互或仍待批准，130 取消。
`

/** Used only to select an error record format; it never grants task capabilities. */
export function requestedOutput(argv: readonly string[]): OutputMode {
  return argv.some(
    (token, i) => token === '--output=jsonl' || (token === '--output' && argv[i + 1] === 'jsonl')
  )
    ? 'jsonl'
    : 'text'
}

export function validatePrompt(value: string): string {
  if (!value.trim() || value.length > 2000)
    throw new CLIInputError('任务必须非空，且未经 trim 的 JS 字符长度不能超过 2000')
  return value
}

function directory(value: string): string {
  if (
    !value.trim() ||
    value.length > 4096 ||
    Array.from(value).some((character) => {
      const code = character.charCodeAt(0)
      return code < 32 || code === 127
    })
  )
    throw new CLIInputError('目录参数无效')
  return value
}

export function parseCLIArguments(argv: readonly string[]): CLIArguments {
  if (argv.length === 1 && argv[0] === '--help')
    return { help: true, permission: 'default', output: 'text', stdin: false }
  const values = new Map<string, string>()
  const seen = new Set<string>()
  const names = new Set(['mode', 'cwd', 'workspace', 'permission', 'output', 'prompt', 'stdin'])
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (typeof token !== 'string' || !token.startsWith('--'))
      throw new CLIInputError('只接受帮助中列出的命名参数')
    const split = token.indexOf('=')
    const name = token.slice(2, split < 0 ? undefined : split)
    if (!names.has(name)) throw new CLIInputError('未知参数；请使用 --help 查看用法')
    if (seen.has(name)) throw new CLIInputError('同一个参数不能重复提供')
    seen.add(name)
    if (name === 'stdin') {
      if (split >= 0) throw new CLIInputError('--stdin 不接受参数值')
      continue
    }
    const value = split < 0 ? argv[++i] : token.slice(split + 1)
    if (value === undefined || (split < 0 && value.startsWith('--')))
      throw new CLIInputError('参数缺少值')
    values.set(name, value)
  }
  const mode = parseAgentMode(values.get('mode'))
  if (!mode) throw new CLIInputError('--mode 必须明确为 plan 或 execute')
  const permission = values.has('permission')
    ? parsePermissionMode(values.get('permission'))
    : 'default'
  if (!permission)
    throw new CLIInputError('--permission 必须为 default、auto-approve 或 full-access')
  const output = values.get('output') ?? 'text'
  if (output !== 'text' && output !== 'jsonl')
    throw new CLIInputError('--output 必须为 text 或 jsonl')
  if (seen.has('stdin') === values.has('prompt'))
    throw new CLIInputError('必须且只能提供 --prompt 或 --stdin 之一')
  return {
    help: false,
    mode,
    permission,
    output,
    stdin: seen.has('stdin'),
    ...(values.has('cwd') ? { cwd: directory(values.get('cwd')!) } : {}),
    ...(values.has('workspace') ? { workspace: directory(values.get('workspace')!) } : {}),
    ...(values.has('prompt') ? { prompt: validatePrompt(values.get('prompt')!) } : {})
  }
}

/** Normal EOF completes task input; it is deliberately not a cancellation source. */
export async function readTaskInput(input: Readable, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  const chunks: Buffer[] = []
  let bytes = 0
  return new Promise<string>((resolve, reject) => {
    let settled = false
    const cleanup = (): void => {
      input.removeListener('data', data)
      input.removeListener('end', end)
      input.removeListener('error', error)
      input.removeListener('close', close)
      signal.removeEventListener('abort', abort)
      input.pause()
    }
    const fail = (cause: unknown): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(cause)
    }
    const data = (chunk: unknown): void => {
      if (!(chunk instanceof Uint8Array)) {
        fail(new CLIInputError('标准输入必须以原始 UTF-8 字节读取'))
        return
      }
      bytes += chunk.byteLength
      if (bytes > STDIN_BYTE_LIMIT) {
        fail(new CLIInputError(`标准输入超过 ${STDIN_BYTE_LIMIT} 字节预算，未启动任务`))
        return
      }
      chunks.push(Buffer.from(chunk))
    }
    const end = (): void => {
      if (settled) return
      try {
        // Preserve a leading BOM as a JS character for the original-length check.
        const prompt = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
          Buffer.concat(chunks)
        )
        validatePrompt(prompt)
        settled = true
        cleanup()
        resolve(prompt)
      } catch (cause) {
        fail(cause instanceof CLIInputError ? cause : new CLIInputError('标准输入不是有效 UTF-8'))
      }
    }
    const error = (): void => fail(new CLIInputError('标准输入读取失败，未启动任务'))
    const close = (): void => {
      if (!input.readableEnded) error()
    }
    const abort = (): void => fail(signal.reason)
    input.on('data', data)
    input.once('end', end)
    input.once('error', error)
    input.once('close', close)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    else if (input.readableEnded) end()
    else if (input.destroyed) error()
    else input.resume()
  })
}
