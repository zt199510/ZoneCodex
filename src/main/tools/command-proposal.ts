import { parseCommandJson, parseCommandProposalArgs } from '../../shared/command-proposal'
import type { ProjectExecutor } from './project-file-tools'

export const commandProposalTool = {
  type: 'function',
  name: 'propose_command',
  strict: true,
  description: '提出固定的 npm 类型检查建议，仅供审查，工作目录未绑定，不执行。每任务最多一份。',
  parameters: {
    type: 'object',
    properties: {
      template: { type: 'string', enum: ['npm_typecheck'] },
      reason: { type: 'string', minLength: 1, maxLength: 500 }
    },
    required: ['template', 'reason'],
    additionalProperties: false
  }
} as const

export function createCommandProposalExecutor(): ProjectExecutor {
  let accepted = false
  return async (name, raw, signal) => {
    signal.throwIfAborted()
    const args = parseCommandProposalArgs(parseCommandJson(raw))
    const error =
      name !== 'propose_command' || !args
        ? '命令提案参数无效'
        : accepted
          ? '每次任务最多接收一份命令提案'
          : null
    if (error) return JSON.stringify({ status: 'error', error })
    accepted = true
    return JSON.stringify({ status: 'proposal_ready', template: args!.template })
  }
}
