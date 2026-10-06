import { useLayoutEffect, useRef, useState } from 'react'
import type { RefObject, UIEvent } from 'react'
import type { ChatMessage } from '../../../../shared/conversation'
import type { MessageChangeProposal } from '../../../../shared/change-proposal'
import type { MessageCommandProposal } from '../../../../shared/command-proposal'
import type { ConversationController } from '../conversation/useConversation'

export type ChatWorkspaceController = {
  draft: string
  setDraft: (value: string) => void
  confirmClear: boolean
  requestClear: () => void
  cancelClear: () => void
  clear: () => Promise<void>
  executionApprovalPending: boolean
  setExecutionApprovalPending: (pending: boolean) => void
  composerRegionRef: RefObject<HTMLDivElement | null>
  scrollArea: RefObject<HTMLDivElement | null>
  previewTriggerRef: RefObject<HTMLButtonElement | null>
  commandTriggerRef: RefObject<HTMLButtonElement | null>
  onScroll: (event: UIEvent<HTMLDivElement>) => void
  send: (content: string) => boolean
  suggest: (prompt: string) => void
  copyMessage: (message: ChatMessage) => Promise<boolean>
  openProposal: (proposal: MessageChangeProposal, trigger: HTMLButtonElement) => void
  openCommand: (proposal: MessageCommandProposal, trigger: HTMLButtonElement) => void
}

export function useChatWorkspace(conversation: ConversationController): ChatWorkspaceController {
  const [draft, setDraftState] = useState('')
  const drafts = useRef(new Map<string | null, string>())
  const currentDraft = useRef('')
  const currentConversationId = useRef<string | null>(conversation.activeConversationId)
  const [confirmClear, setConfirmClear] = useState(false)
  const [executionApprovalPending, setExecutionApprovalPending] = useState(false)
  const composerRegionRef = useRef<HTMLDivElement>(null)
  const scrollArea = useRef<HTMLDivElement>(null)
  const previewTriggerRef = useRef<HTMLButtonElement>(null)
  const commandTriggerRef = useRef<HTMLButtonElement>(null)
  const followBottom = useRef(true)
  const { messages } = conversation

  useLayoutEffect(() => {
    const nextConversationId = conversation.activeConversationId
    const previousConversationId = currentConversationId.current
    if (nextConversationId === previousConversationId) return
    drafts.current.set(previousConversationId, currentDraft.current)
    const nextDraft = drafts.current.get(nextConversationId) ?? ''
    currentConversationId.current = nextConversationId
    currentDraft.current = nextDraft
    followBottom.current = true
    setConfirmClear(false)
    setDraftState(nextDraft)
  }, [conversation.activeConversationId])

  function setDraft(value: string): void {
    currentDraft.current = value
    drafts.current.set(currentConversationId.current, value)
    setDraftState(value)
  }

  useLayoutEffect(() => {
    const area = scrollArea.current
    if (area && followBottom.current) {
      area.scrollTop = area.scrollHeight
    }
  }, [messages, conversation.toolActivity])

  function send(content: string): boolean {
    const accepted = conversation.send(content)
    if (accepted) {
      setDraft('')
      followBottom.current = true
    }
    return accepted
  }
  function suggest(prompt: string): void {
    setDraft(prompt)
    document.getElementById('chat-input')?.focus()
  }
  async function copyMessage(message: ChatMessage): Promise<boolean> {
    if (!navigator.clipboard) return false
    try {
      await navigator.clipboard.writeText(message.content)
      return true
    } catch {
      return false
    }
  }

  function onScroll(event: UIEvent<HTMLDivElement>): void {
    const area = event.currentTarget
    followBottom.current = area.scrollHeight - area.scrollTop - area.clientHeight < 80
  }

  async function clear(): Promise<void> {
    if (await conversation.clear()) {
      setDraft('')
      followBottom.current = true
      setConfirmClear(false)
    }
  }

  function openProposal(proposal: MessageChangeProposal, trigger: HTMLButtonElement): void {
    previewTriggerRef.current = trigger
    void conversation.openProposal(proposal)
  }

  function openCommand(proposal: MessageCommandProposal, trigger: HTMLButtonElement): void {
    commandTriggerRef.current = trigger
    conversation.commandReview.open(proposal)
  }

  return {
    draft,
    setDraft,
    confirmClear,
    requestClear: () => setConfirmClear(true),
    cancelClear: () => setConfirmClear(false),
    clear,
    executionApprovalPending,
    setExecutionApprovalPending,
    composerRegionRef,
    scrollArea,
    previewTriggerRef,
    commandTriggerRef,
    onScroll,
    send,
    suggest,
    copyMessage,
    openProposal,
    openCommand
  }
}
