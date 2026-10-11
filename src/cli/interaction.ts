import { createHash } from 'node:crypto'
import { createInterface, type Interface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import type { ExecutionApprovalInput } from '../shared/execution'
import {
  parseAgentUserInputAnswers,
  type AgentUserInputAnswer,
  type AgentUserInputRequest
} from '../shared/agent-user-input'
import { InteractionUnavailableError } from './host-contract'

type InteractionOutput = {
  diagnostic: (text: string) => void
  flush: () => Promise<void>
  unavailable: (error: InteractionUnavailableError) => void
  cancel: () => void
}

/** Only this task's unused interactive terminal can supply a pending decision. */
export class TerminalInteraction {
  private readline: Interface | null = null
  private pending = false
  private closed = false
  private readonly interactive: boolean

  constructor(
    private readonly input: Readable,
    private readonly stderr: Writable,
    taskUsesStdin: boolean,
    private readonly signal: AbortSignal,
    private readonly output: InteractionOutput
  ) {
    this.interactive =
      !taskUsesStdin &&
      Boolean((input as Readable & { isTTY?: boolean }).isTTY) &&
      Boolean((stderr as Writable & { isTTY?: boolean }).isTTY)
  }

  private unavailable(): InteractionUnavailableError {
    const error = new InteractionUnavailableError('当前任务缺少可用交互终端，或审批/问答输入已结束')
    this.output.unavailable(error)
    return error
  }

  private terminal(): Interface {
    this.signal.throwIfAborted()
    if (!this.interactive || this.closed) throw this.unavailable()
    if (!this.readline) {
      this.readline = createInterface({
        input: this.input,
        output: this.stderr,
        terminal: true,
        crlfDelay: Infinity,
        historySize: 0
      })
      this.readline.once('close', () => {
        this.closed = true
      })
      this.readline.on('SIGINT', this.output.cancel)
      this.readline.on('error', () => {
        this.unavailable()
        this.readline?.close()
      })
    }
    return this.readline
  }

  private async line(prompt: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted()
    const terminal = this.terminal()
    await this.output.flush()
    this.signal.throwIfAborted()
    signal.throwIfAborted()
    if (this.closed) throw this.unavailable()
    return new Promise<string>((resolve, reject) => {
      let settled = false
      const cleanup = (): void => {
        terminal.removeListener('close', close)
        for (const item of signals) item.removeEventListener('abort', abort)
      }
      const fail = (cause: unknown): void => {
        if (settled) return
        settled = true
        cleanup()
        reject(cause)
      }
      const signals = new Set([this.signal, signal])
      const reason = (): unknown => [...signals].find((item) => item.aborted)?.reason
      const close = (): void =>
        fail([...signals].some((item) => item.aborted) ? reason() : this.unavailable())
      const abort = (): void => {
        fail(reason())
        terminal.close()
      }
      terminal.once('close', close)
      for (const item of signals) item.addEventListener('abort', abort, { once: true })
      try {
        terminal.question(prompt, (answer) => {
          if (settled) return
          settled = true
          cleanup()
          if ([...signals].some((item) => item.aborted)) reject(reason())
          else resolve(answer)
        })
      } catch {
        fail(this.unavailable())
      }
      if ([...signals].some((item) => item.aborted)) abort()
    })
  }

  private async decide<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted()
    this.signal.throwIfAborted()
    this.terminal()
    if (this.pending) throw this.unavailable()
    this.pending = true
    try {
      const answer = await work()
      this.signal.throwIfAborted()
      signal.throwIfAborted()
      return answer
    } finally {
      this.pending = false
    }
  }

  approve = async (request: ExecutionApprovalInput, signal: AbortSignal): Promise<boolean> => {
    signal.throwIfAborted()
    return this.decide(async () => {
      this.output.diagnostic(`[批准 ${request.requestId}] ${request.kind}；目录 ${request.cwd}`)
      if (request.kind === 'command') {
        this.output.diagnostic(
          `程序：${request.program}\n参数：${JSON.stringify(request.args)}\n原因：${request.reason ?? '本次精确命令需要批准'}`
        )
      } else {
        const after = request.kind === 'create' ? request.content : request.after
        const digest = (text: string): string => createHash('sha256').update(text).digest('hex')
        this.output.diagnostic(
          `目标：${request.path}\n候选字符：${after.length}；SHA-256：${digest(after)}`
        )
        if (request.kind === 'edit')
          this.output.diagnostic(
            `原内容字符：${request.before.length}；SHA-256：${digest(request.before)}`
          )
        this.output.diagnostic(
          `候选内容${after.length > 4000 ? '（前4000字符，其余未展示）' : ''}：\n${after.slice(0, 4000)}`
        )
      }
      for (;;) {
        const value = (await this.line('批准本次操作？输入 yes 批准，no 拒绝：', signal))
          .trim()
          .toLowerCase()
        signal.throwIfAborted()
        if (value === 'yes') return true
        if (value === 'no') return false
        this.output.diagnostic('请输入明确的 yes 或 no；未作出批准。')
      }
    }, signal)
  }

  answer = async (
    request: AgentUserInputRequest,
    signal: AbortSignal
  ): Promise<AgentUserInputAnswer[]> => {
    signal.throwIfAborted()
    return this.decide(async () => {
      this.output.diagnostic(
        `[计划提问 ${request.requestId}/${request.inputId}] 回答只补充计划，不授予执行权限。`
      )
      const answers: AgentUserInputAnswer[] = []
      for (const question of request.questions) {
        this.output.diagnostic(`${question.header}：${question.question}`)
        question.options.forEach((option, i) =>
          this.output.diagnostic(`${i + 1}. ${option.label}：${option.description}`)
        )
        for (;;) {
          const choice = (
            await this.line(`输入 1～${question.options.length}，或 c 自定义：`, signal)
          ).trim()
          signal.throwIfAborted()
          let answer: string | undefined
          if (/^[1-3]$/.test(choice)) answer = question.options[Number(choice) - 1]?.label
          else if (choice.toLowerCase() === 'c')
            answer = await this.line('输入自定义回答（最多1000字符）：', signal)
          if (answer !== undefined && parseAgentUserInputAnswers([{ id: question.id, answer }])) {
            answers.push({ id: question.id, answer })
            break
          }
          this.output.diagnostic(
            '选择或回答无效；请输入列出的编号或非空、最多1000字符的自定义回答。'
          )
        }
      }
      signal.throwIfAborted()
      const checked = parseAgentUserInputAnswers(answers, request.questions)
      if (!checked) throw this.unavailable()
      return checked
    }, signal)
  }

  dispose(): void {
    this.readline?.close()
    this.readline = null
    this.input.pause()
    this.closed = true
  }
}
