import { useCallback, useRef, useState } from 'react'
import type { Conversation } from '../../../../shared/conversation-library'
import type { ProjectSelection } from '../../../../shared/project'
import {
  deriveMessageChangeProposal,
  type MessageChangeProposal
} from '../../../../shared/change-proposal'
import {
  deriveMessageCommandProposal,
  type MessageCommandProposal
} from '../../../../shared/command-proposal'
import type { OperationControl } from '../conversation/useOperation'
import { useChangePreview, type ChangePreviewController } from './useChangePreview'
import { useChangePreparation, type PreparationController } from './useChangePreparation'
import { useChangeCommit, type CommitController } from './useChangeCommit'
import { useCommandReview } from './useCommandReview'

export type ChangeProposalStatus = 'available' | 'stale'

function proposalKey(proposal: MessageChangeProposal): string {
  return `${proposal.conversationId}\u0000${proposal.requestId}\u0000${proposal.callId}`
}

export type ConversationReviewController = {
  commandProposals: Readonly<Record<string, MessageCommandProposal>>
  commandReview: ReturnType<typeof useCommandReview>
  commit: CommitController
  preparation: PreparationController
  changePreview: ChangePreviewController
  changeProposals: Readonly<Record<string, MessageChangeProposal>>
  changeProposalStatus: Readonly<Record<string, ChangeProposalStatus>>
  openProposal: (proposal: MessageChangeProposal) => Promise<boolean>
  closePreview: () => boolean
  discardProposal: () => boolean
}

export function useConversationReview({
  active,
  projectSelection,
  operations,
  canChange,
  ready,
  closePending,
  forgetSnapshot
}: {
  active: Conversation | null
  projectSelection: ProjectSelection | null
  operations: OperationControl
  canChange: () => boolean
  ready: boolean
  closePending: boolean
  forgetSnapshot: (snapshotId: string) => void
}): ConversationReviewController {
  const messages = active?.messages ?? []
  const hiddenProposalKeysRef = useRef(new Set<string>())
  const [hiddenProposalKeys, setHiddenProposalKeys] = useState<ReadonlySet<string>>(new Set())
  const [openedProposal, setOpenedProposal] = useState<MessageChangeProposal | null>(null)

  const changePreview = useChangePreview({
    conversationId: active?.id ?? null,
    selection: projectSelection,
    operations,
    canChange
  })

  const changeProposals: Record<string, MessageChangeProposal> = {}
  const changeProposalStatus: Record<string, ChangeProposalStatus> = {}
  if (active) {
    for (const run of active.toolRuns) {
      const proposal = deriveMessageChangeProposal(
        active.id,
        run,
        messages.find((message) => message.id === run.userId),
        messages.find((message) => message.id === run.assistantId)
      )
      if (!proposal || hiddenProposalKeys.has(proposalKey(proposal))) continue
      changeProposals[proposal.assistantId] = proposal
      changeProposalStatus[proposal.assistantId] =
        projectSelection?.snapshotId === proposal.snapshotId &&
        projectSelection.files.some((file) => file.path === proposal.path)
          ? 'available'
          : 'stale'
    }
  }

  const preview = changePreview.state.status === 'ready' ? changePreview.state.preview : null
  const commandProposals: Record<string, MessageCommandProposal> = {}
  for (const run of active?.toolRuns ?? []) {
    const proposal = deriveMessageCommandProposal(
      active!.id,
      run,
      messages.find((message) => message.id === run.userId),
      messages.find((message) => message.id === run.assistantId)
    )
    if (proposal) commandProposals[proposal.assistantId] = proposal
  }
  const commandReview = useCommandReview(
    commandProposals,
    projectSelection?.snapshotId ?? null,
    ready &&
      operations.operation === 'idle' &&
      !closePending &&
      changePreview.state.status === 'idle'
  )
  const source = openedProposal && changeProposals[openedProposal.assistantId]
  const preparation = useChangePreparation(
    source &&
      preview &&
      active?.id === source.conversationId &&
      changeProposalStatus[source.assistantId] === 'available' &&
      source.path === preview.path &&
      source.snapshotId === preview.snapshotId &&
      source.proposedText === preview.after &&
      source.requestId === openedProposal?.requestId &&
      source.callId === openedProposal?.callId
      ? {
          conversationId: source.conversationId,
          snapshotId: source.snapshotId,
          path: source.path,
          proposedText: source.proposedText,
          requestId: source.requestId,
          callId: source.callId
        }
      : null,
    operations,
    canChange
  )

  const commit = useChangeCommit(
    active?.id ?? null,
    preparation.available && preparation.state.status === 'ready' ? preparation.state : null,
    operations,
    canChange,
    (snapshotId, clearGrant) => {
      preparation.cancel()
      if (clearGrant) forgetSnapshot(snapshotId)
    }
  )

  async function openProposal(proposal: MessageChangeProposal): Promise<boolean> {
    if (
      hiddenProposalKeysRef.current.has(proposalKey(proposal)) ||
      !active ||
      active.id !== proposal.conversationId ||
      !projectSelection ||
      projectSelection.snapshotId !== proposal.snapshotId ||
      !projectSelection.files.some((file) => file.path === proposal.path) ||
      !canChange()
    ) {
      return false
    }
    const current = changeProposals[proposal.assistantId]
    if (
      !current ||
      current.requestId !== proposal.requestId ||
      current.callId !== proposal.callId ||
      current.path !== proposal.path ||
      current.proposedText !== proposal.proposedText
    ) {
      return false
    }

    preparation.cancel()
    setOpenedProposal(null)
    const opened = await changePreview.requestPreview(proposal.path, proposal.proposedText)
    if (opened) setOpenedProposal(proposal)
    return opened
  }

  const closePreview = useCallback((): boolean => {
    if (commit.isActive()) {
      commit.requestCancel()
      return false
    }
    preparation.cancel()
    setOpenedProposal(null)
    return changePreview.discard()
  }, [changePreview, preparation, commit])

  const discardProposal = useCallback((): boolean => {
    if (commit.isActive()) {
      commit.requestCancel()
      return false
    }
    preparation.cancel()
    const proposal = openedProposal
    const discarded = changePreview.discard()
    if (discarded && proposal) {
      hiddenProposalKeysRef.current.add(proposalKey(proposal))
      setHiddenProposalKeys(new Set(hiddenProposalKeysRef.current))
    }
    setOpenedProposal(null)
    return discarded
  }, [changePreview, preparation, openedProposal, commit])
  return {
    commandProposals,
    commandReview,
    commit,
    preparation,
    changePreview,
    changeProposals,
    changeProposalStatus,
    openProposal,
    closePreview,
    discardProposal
  }
}
