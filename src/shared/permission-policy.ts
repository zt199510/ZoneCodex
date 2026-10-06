import type { CommandProposalArgs } from './command-proposal'
import type { PermissionMode } from './execution'

export type LocalPermissionDecision = 'allow' | 'review' | 'ask' | 'deny'

/** Policy only; command isolation must be provided by a real execution backend. */
export function decideLocalPermission({
  operation,
  mode,
  withinWritableRoots,
  approvalPolicy = mode === 'full-access' ? 'never' : 'on-request',
  sandboxAvailable = false
}: {
  operation: 'read' | 'write' | 'command'
  mode: PermissionMode
  withinWritableRoots: boolean
  approvalPolicy?: 'on-request' | 'never'
  sandboxAvailable?: boolean
}): LocalPermissionDecision {
  if (mode === 'full-access') return 'allow'
  if (operation === 'read') return 'allow'
  if (operation === 'write' && withinWritableRoots) return 'allow'
  if (operation === 'command' && sandboxAvailable && withinWritableRoots) return 'allow'
  if (approvalPolicy === 'never') return 'deny'
  return mode === 'auto-approve' ? 'review' : 'ask'
}

export type PermissionRisk = 'read_only' | 'project_write' | 'command'
export type ApprovalRequirement = 'none' | 'user'
export type PermissionScope = { kind: 'project'; snapshotId: string }
export type PermissionDecision = {
  risk: PermissionRisk
  approval: ApprovalRequirement
  allowed: boolean
  scope: PermissionScope
  reason?: string
}

export type CommandTemplate = {
  template: 'npm_typecheck'
  program: 'npm'
  args: readonly ['run', 'typecheck']
  display: string
  impact: string
}

export const commandTemplates: Readonly<Record<CommandTemplate['template'], CommandTemplate>> = {
  npm_typecheck: {
    template: 'npm_typecheck',
    program: 'npm',
    args: ['run', 'typecheck'],
    display: 'npm run typecheck',
    impact:
      'npm 脚本及前后置脚本可运行项目代码，可能写文件、联网或启动子进程。模板名不能证明脚本存在或安全。'
  }
}

export function getCommandTemplate(template: unknown): CommandTemplate | null {
  return typeof template === 'string' && template in commandTemplates
    ? commandTemplates[template as CommandTemplate['template']]
    : null
}

export function decideCommandPermission(
  proposal: CommandProposalArgs,
  scope: PermissionScope | null
): PermissionDecision {
  const template = getCommandTemplate(proposal.template)
  if (!template) {
    return {
      risk: 'command',
      approval: 'user',
      allowed: false,
      scope: scope ?? { kind: 'project', snapshotId: '' },
      reason: '未知命令模板'
    }
  }
  if (!scope?.snapshotId) {
    return {
      risk: 'command',
      approval: 'user',
      allowed: false,
      scope: { kind: 'project', snapshotId: '' },
      reason: '缺少项目快照'
    }
  }
  return { risk: 'command', approval: 'user', allowed: true, scope }
}
