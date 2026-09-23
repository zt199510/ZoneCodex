import type { ToolRun } from './agent-history'
import { parseProtocolTurn } from './agent-history'
import type { ChatMessage } from './conversation'

export type CommandProposalArgs = { template: 'npm_typecheck'; reason: string }
export type CommandProposalOutput =
  { status: 'proposal_ready'; template: 'npm_typecheck' } | { status: 'error'; error: string }
export type MessageCommandProposal = CommandProposalArgs & {
  conversationId: string
  requestId: string
  assistantId: string
  callId: string
  snapshotId: string
}
export const commandTemplate = {
  program: 'npm',
  args: ['run', 'typecheck'],
  cwdStatus: 'unbound',
  display: 'npm run typecheck',
  impact:
    'npm 脚本及前后置脚本可运行项目代码，可能写文件、联网或启动子进程。模板名不能证明脚本存在或安全。'
} as const

function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false
  const proto = Object.getPrototypeOf(value)
  return (
    (proto === Object.prototype || proto === null) &&
    Reflect.ownKeys(value).length === keys.length &&
    Reflect.ownKeys(value).every((key) => typeof key === 'string' && keys.includes(key)) &&
    Object.values(Object.getOwnPropertyDescriptors(value)).every((d) => 'value' in d)
  )
}
function text(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.trim().length <= 500 &&
    !Array.from(value).some(
      (c) => c.charCodeAt(0) < 32 || (c.charCodeAt(0) >= 127 && c.charCodeAt(0) <= 159)
    )
  )
}
export function parseCommandProposalArgs(value: unknown): CommandProposalArgs | null {
  try {
    return exact(value, ['template', 'reason']) &&
      value.template === 'npm_typecheck' &&
      text(value.reason)
      ? { template: value.template, reason: value.reason.trim() }
      : null
  } catch {
    return null
  }
}
export function parseCommandProposalOutput(value: unknown): CommandProposalOutput | null {
  try {
    if (
      exact(value, ['status', 'template']) &&
      value.status === 'proposal_ready' &&
      value.template === 'npm_typecheck'
    )
      return { status: value.status, template: value.template }
    if (
      exact(value, ['status', 'error']) &&
      value.status === 'error' &&
      text(value.error) &&
      (value.error as string).length <= 500
    )
      return { status: value.status, error: value.error }
    return null
  } catch {
    return null
  }
}
export function parseCommandJson(value: unknown): unknown {
  if (typeof value !== 'string' || value.length > 4096) return null
  try {
    return JSON.parse(value) as unknown
  } catch {
    return null
  }
}
export function deriveMessageCommandProposal(
  conversationId: string,
  run: ToolRun,
  user: ChatMessage | undefined,
  assistant: ChatMessage | undefined
): MessageCommandProposal | null {
  if (!parseProtocolTurn(run.items, run.scope)) return null
  if (
    !conversationId ||
    run.scope.kind !== 'project' ||
    user?.role !== 'user' ||
    assistant?.role !== 'assistant' ||
    user.status !== 'complete' ||
    assistant.status !== 'complete' ||
    user.id !== run.userId ||
    assistant.id !== run.assistantId
  )
    return null
  const successes: MessageCommandProposal[] = []
  for (const item of run.items) {
    if (
      item.type !== 'function_call' ||
      item.name !== 'propose_command' ||
      typeof item.call_id !== 'string'
    )
      continue
    const args = parseCommandProposalArgs(parseCommandJson(item.arguments))
    const calls = run.items.filter((i) => i.type === 'function_call' && i.call_id === item.call_id)
    const outputs = run.items.filter(
      (i) => i.type === 'function_call_output' && i.call_id === item.call_id
    )
    if (!args || calls.length !== 1 || outputs.length !== 1) continue
    const output = parseCommandProposalOutput(parseCommandJson(outputs[0].output))
    if (output?.status !== 'proposal_ready' || output.template !== args.template) continue
    successes.push({
      ...args,
      conversationId,
      requestId: run.requestId,
      assistantId: run.assistantId,
      callId: item.call_id,
      snapshotId: run.scope.snapshotId
    })
  }
  return successes.length === 1 ? successes[0] : null
}
