import { useLayoutEffect, useRef, useState } from 'react'
import type { RefObject, UIEvent } from 'react'
import type { ChatMessage } from '../../../../shared/conversation'
import type { MessageChangeProposal } from '../../../../shared/change-proposal'
import type { MessageCommandProposal } from '../../../../shared/command-proposal'
import type { ConversationController } from '../conversation/useConversation'

type ScrollAnchor = { element: HTMLElement; offset: number }[]

function readingAnchor(area: HTMLDivElement, preferred?: HTMLElement): ScrollAnchor {
  const viewport = area.getBoundingClientRect()
  const candidates = area.querySelectorAll<HTMLElement>(
    '.markdown-body > *, .message-user .message-content, summary, .message-note'
  )
  let element = preferred
  if (!element) {
    for (const candidate of candidates) {
      const rect = candidate.getBoundingClientRect()
      if (!rect.height || rect.bottom <= viewport.top || rect.top >= viewport.bottom) continue
      element = candidate
      break
    }
  }
  if (!element) return []
  const anchors = [{ element, offset: element.getBoundingClientRect().top - viewport.top }]
  let parent = element.parentElement?.closest('details')
  while (parent && area.contains(parent)) {
    const summary = parent.querySelector<HTMLElement>(':scope > summary')
    if (summary && summary !== element)
      anchors.push({
        element: summary,
        offset: Math.max(0, summary.getBoundingClientRect().top - viewport.top)
      })
    parent = parent.parentElement?.closest('details') ?? null
  }
  return anchors
}

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
  send: (content: string) => boolean | Promise<boolean>
  suggest: (prompt: string) => void
  copyMessage: (message: ChatMessage) => Promise<boolean>
  openProposal: (proposal: MessageChangeProposal, trigger: HTMLButtonElement) => void
  openCommand: (proposal: MessageCommandProposal, trigger: HTMLButtonElement) => void
}

export function useChatWorkspace(conversation: ConversationController): ChatWorkspaceController {
  const [draft, setDraftState] = useState('')
  const drafts = useRef(new Map<string | null, string>())
  const currentDraft = useRef('')
  const draftVersion = useRef(0)
  const currentConversationId = useRef<string | null>(conversation.activeConversationId)
  const [confirmClear, setConfirmClear] = useState(false)
  const [executionApprovalPending, setExecutionApprovalPending] = useState(false)
  const composerRegionRef = useRef<HTMLDivElement>(null)
  const scrollArea = useRef<HTMLDivElement>(null)
  const previewTriggerRef = useRef<HTMLButtonElement>(null)
  const commandTriggerRef = useRef<HTMLButtonElement>(null)
  const followBottom = useRef(true)
  const anchor = useRef<ScrollAnchor>([])
  const adjustedScrollTop = useRef<number | null>(null)
  const lastScrollInput = useRef(-Infinity)
  const scrollDirection = useRef<'up' | 'down' | null>(null)
  const scrollInputTop = useRef(0)
  const draggingScrollbar = useRef(false)
  const { messages } = conversation
  const empty = messages.length === 0

  useLayoutEffect(() => {
    const nextConversationId = conversation.activeConversationId
    const previousConversationId = currentConversationId.current
    if (nextConversationId === previousConversationId) return
    drafts.current.set(previousConversationId, currentDraft.current)
    const nextDraft =
      drafts.current.get(nextConversationId) ??
      (previousConversationId === null && conversation.draftInheritanceTarget === nextConversationId
        ? currentDraft.current
        : '')
    currentConversationId.current = nextConversationId
    currentDraft.current = nextDraft
    draftVersion.current++
    followBottom.current = true
    anchor.current = []
    adjustedScrollTop.current = null
    lastScrollInput.current = -Infinity
    scrollDirection.current = null
    setConfirmClear(false)
    setDraftState(nextDraft)
  }, [conversation.activeConversationId, conversation.draftInheritanceTarget])

  function setDraft(value: string): void {
    currentDraft.current = value
    draftVersion.current++
    drafts.current.set(currentConversationId.current, value)
    setDraftState(value)
  }

  function settleScroll(area: HTMLDivElement): void {
    let top = area.scrollTop
    if (followBottom.current) top = area.scrollHeight - area.clientHeight
    else {
      const retained = anchor.current.find(
        (candidate) => candidate.element.isConnected && candidate.element.getClientRects().length
      )
      if (retained)
        top +=
          retained.element.getBoundingClientRect().top -
          area.getBoundingClientRect().top -
          retained.offset
    }
    top = Math.max(0, Math.min(top, area.scrollHeight - area.clientHeight))
    if (Math.abs(top - area.scrollTop) > 0.5) {
      area.scrollTop = top
      adjustedScrollTop.current = area.scrollTop
    }
    if (!followBottom.current) anchor.current = readingAnchor(area)
  }

  useLayoutEffect(() => {
    const area = scrollArea.current
    if (!area) return
    let frame: number | null = null
    const schedule = (): void => {
      if (frame !== null) window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => {
        frame = null
        settleScroll(area)
      })
    }
    const wheel = (event: WheelEvent): void => {
      if (!event.deltaY) return
      lastScrollInput.current = performance.now()
      scrollDirection.current = event.deltaY < 0 ? 'up' : 'down'
      scrollInputTop.current = area.scrollTop
      adjustedScrollTop.current = null
      if (event.deltaY < 0) {
        followBottom.current = false
        anchor.current = readingAnchor(area)
      }
    }
    const touch = (): void => {
      lastScrollInput.current = performance.now()
      scrollDirection.current = null
      scrollInputTop.current = area.scrollTop
      adjustedScrollTop.current = null
      followBottom.current = false
      anchor.current = readingAnchor(area)
    }
    const pointer = (event: PointerEvent): void => {
      draggingScrollbar.current =
        event.clientX >= area.getBoundingClientRect().left + area.clientWidth
      if (draggingScrollbar.current) {
        lastScrollInput.current = performance.now()
        scrollDirection.current = null
        scrollInputTop.current = area.scrollTop
      }
      if (!(event.target instanceof Element)) return
      const summary = event.target.closest<HTMLElement>('summary')
      if (summary && area.contains(summary)) {
        followBottom.current = false
        lastScrollInput.current = -Infinity
        adjustedScrollTop.current = null
        anchor.current = readingAnchor(area, summary)
      }
    }
    const releasePointer = (): void => {
      draggingScrollbar.current = false
    }
    const key = (event: KeyboardEvent): void => {
      if (!(event.target instanceof Element)) return
      if (event.target.closest('input, textarea, [contenteditable="true"]')) return
      const summary = event.target.closest<HTMLElement>('summary')
      if (summary && (event.key === 'Enter' || event.key === ' ')) {
        followBottom.current = false
        lastScrollInput.current = -Infinity
        adjustedScrollTop.current = null
        anchor.current = readingAnchor(area, summary)
      }
      const pageWithSpace =
        event.key === ' ' && !summary && !event.target.closest('button, a, [role="button"], select')
      if (
        pageWithSpace ||
        ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key)
      ) {
        lastScrollInput.current = performance.now()
        const upward =
          (pageWithSpace && event.shiftKey) || ['ArrowUp', 'PageUp', 'Home'].includes(event.key)
        scrollDirection.current = upward ? 'up' : 'down'
        scrollInputTop.current = area.scrollTop
        adjustedScrollTop.current = null
        if (upward) {
          followBottom.current = false
          anchor.current = readingAnchor(area)
        }
      }
    }
    const observer = new ResizeObserver(schedule)
    observer.observe(area)
    if (area.firstElementChild) observer.observe(area.firstElementChild)
    area.addEventListener('wheel', wheel, { passive: true })
    area.addEventListener('touchmove', touch, { passive: true })
    area.addEventListener('pointerdown', pointer, true)
    area.addEventListener('keydown', key, true)
    window.addEventListener('pointerup', releasePointer)
    window.addEventListener('pointercancel', releasePointer)
    settleScroll(area)
    return () => {
      observer.disconnect()
      if (frame !== null) window.cancelAnimationFrame(frame)
      area.removeEventListener('wheel', wheel)
      area.removeEventListener('touchmove', touch)
      area.removeEventListener('pointerdown', pointer, true)
      area.removeEventListener('keydown', key, true)
      window.removeEventListener('pointerup', releasePointer)
      window.removeEventListener('pointercancel', releasePointer)
    }
  }, [conversation.activeConversationId, empty])

  useLayoutEffect(() => {
    const area = scrollArea.current
    if (area) settleScroll(area)
  }, [messages, conversation.toolRuns, conversation.toolActivity])

  function send(content: string): boolean | Promise<boolean> {
    const draftAtSend = currentDraft.current
    const versionAtSend = draftVersion.current
    const conversationAtSend = currentConversationId.current
    const settle = (accepted: boolean): boolean => {
      if (accepted) {
        if (
          currentConversationId.current === conversationAtSend &&
          draftVersion.current === versionAtSend &&
          currentDraft.current === draftAtSend
        )
          setDraft('')
        followBottom.current = true
        anchor.current = []
        lastScrollInput.current = -Infinity
        scrollDirection.current = null
      }
      return accepted
    }
    const result = conversation.send(content)
    return typeof result === 'boolean' ? settle(result) : result.then(settle)
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
    if (
      adjustedScrollTop.current !== null &&
      Math.abs(area.scrollTop - adjustedScrollTop.current) < 1
    ) {
      adjustedScrollTop.current = null
      return
    }
    if (draggingScrollbar.current || performance.now() - lastScrollInput.current < 1000) {
      const direction =
        scrollDirection.current ?? (area.scrollTop > scrollInputTop.current ? 'down' : 'up')
      followBottom.current =
        direction === 'down' && area.scrollHeight - area.scrollTop - area.clientHeight < 4
      scrollInputTop.current = area.scrollTop
      anchor.current = readingAnchor(area)
    }
  }

  async function clear(): Promise<void> {
    if (await conversation.clear()) {
      setDraft('')
      followBottom.current = true
      anchor.current = []
      adjustedScrollTop.current = null
      lastScrollInput.current = -Infinity
      scrollDirection.current = null
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
