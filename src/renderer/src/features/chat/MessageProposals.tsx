import type { MessageCommandProposal } from '../../../../shared/command-proposal'
import type { MessageChangeProposal } from '../../../../shared/change-proposal'
import type { ChangeProposalStatus } from '../review/useConversationReview'
import { Icon } from '../../components/ui/Icon'

export function MessageChangeProposalCard({
  proposal,
  proposalStatus,
  proposalOpenDisabled,
  onOpenProposal
}: {
  proposal: MessageChangeProposal
  proposalStatus?: ChangeProposalStatus
  proposalOpenDisabled: boolean
  onOpenProposal?: (proposal: MessageChangeProposal, trigger: HTMLButtonElement) => void
}): React.JSX.Element {
  return (
    <aside className="message-change-proposal" aria-label="修改建议">
      <div className="message-change-proposal-heading">
        <Icon name="code" size={15} />
        <div>
          <strong>{proposal.path.split('/').at(-1) ?? proposal.path}</strong>
          <span title={proposal.path}>{proposal.path}</span>
        </div>
      </div>
      <div className="message-change-proposal-meta">
        {proposalStatus === 'stale' ? '原快照已失效' : '修改建议 · 未写入'}
      </div>
      {proposalStatus === 'stale' ? (
        <span className="message-change-proposal-action message-change-proposal-stale">
          请重新提出修改要求
        </span>
      ) : (
        <button
          className="message-change-proposal-action"
          type="button"
          disabled={proposalOpenDisabled || !onOpenProposal}
          onClick={(event) => onOpenProposal?.(proposal, event.currentTarget)}
        >
          查看差异
        </button>
      )}
    </aside>
  )
}

export function MessageCommandProposalCard({
  command,
  commandSnapshotId,
  proposalOpenDisabled,
  onOpenCommand
}: {
  command: MessageCommandProposal
  commandSnapshotId: string | null
  proposalOpenDisabled: boolean
  onOpenCommand?: (proposal: MessageCommandProposal, trigger: HTMLButtonElement) => void
}): React.JSX.Element {
  return (
    <aside className="message-command-proposal" aria-label="命令提案">
      <strong>命令提案：npm run typecheck</strong>
      <span>尚未执行</span>
      {command.snapshotId !== commandSnapshotId ? (
        <span>历史提案，需重新生成</span>
      ) : (
        <button
          type="button"
          disabled={proposalOpenDisabled || !onOpenCommand}
          onClick={(event) => onOpenCommand?.(command, event.currentTarget)}
        >
          查看命令提案
        </button>
      )}
    </aside>
  )
}
