import { useCallback, useState } from 'react'
import type { MessageCommandProposal } from '../../../../shared/command-proposal'

type Source = Pick<
  MessageCommandProposal,
  'conversationId' | 'assistantId' | 'requestId' | 'callId' | 'snapshotId'
>
export function useCommandReview(
  proposals: Readonly<Record<string, MessageCommandProposal>>,
  snapshotId: string | null,
  available: boolean
): {
  proposal: MessageCommandProposal | null
  close: () => void
  open: (candidate: MessageCommandProposal) => boolean
} {
  const [source, setSource] = useState<Source | null>(null)
  const current = source ? proposals[source.assistantId] : null
  const valid =
    available &&
    current &&
    current.snapshotId === snapshotId &&
    source &&
    current.conversationId === source.conversationId &&
    current.requestId === source.requestId &&
    current.callId === source.callId &&
    current.snapshotId === source.snapshotId
  // Clear the source when it expires, so becoming idle cannot reopen an old review.
  if (source && !valid) setSource(null)
  const close = useCallback(() => setSource(null), [])
  return {
    proposal: valid ? current : null,
    close,
    open: (candidate: MessageCommandProposal): boolean => {
      const fresh = proposals[candidate.assistantId]
      if (
        !available ||
        !fresh ||
        fresh.snapshotId !== snapshotId ||
        fresh.conversationId !== candidate.conversationId ||
        fresh.requestId !== candidate.requestId ||
        fresh.callId !== candidate.callId ||
        fresh.snapshotId !== candidate.snapshotId
      )
        return false
      setSource({
        conversationId: fresh.conversationId,
        assistantId: fresh.assistantId,
        requestId: fresh.requestId,
        callId: fresh.callId,
        snapshotId: fresh.snapshotId
      })
      return true
    }
  }
}
