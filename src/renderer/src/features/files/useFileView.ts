import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { FileReference, FileViewRequest, FileViewResult } from '../../../../shared/file-view'
import { isAbsoluteFilePath } from '../../../../shared/file-view'
import type { ConversationController } from '../conversation/useConversation'
import type { FileViewOrigin, OpenFileView } from './file-view-origin'

type ActiveView = {
  contextKey: string
  reference: FileReference
  origin: FileViewOrigin
  trigger: HTMLElement
}

export type FileViewState =
  | { status: 'idle' }
  | (ActiveView & { status: 'loading' })
  | (ActiveView & { status: 'ready'; result: Extract<FileViewResult, { status: 'ready' }> })
  | (ActiveView & { status: 'error'; error: string })

function canFocus(element: HTMLElement | null): boolean {
  return (
    !!element?.isConnected &&
    element.getClientRects().length > 0 &&
    !element.closest('[inert]') &&
    !element.matches(':disabled')
  )
}

function returnFocus(trigger?: HTMLElement): void {
  let target: HTMLElement | null = trigger ?? null
  while (target && !canFocus(target)) {
    const details = target.closest('details')
    const summary = details?.querySelector<HTMLElement>(':scope > summary')
    target =
      summary === target
        ? (details?.parentElement
            ?.closest('details')
            ?.querySelector<HTMLElement>(':scope > summary') ?? null)
        : (summary ?? null)
  }
  if (!canFocus(target)) target = document.getElementById('chat-input')
  if (!canFocus(target))
    target = document.querySelector<HTMLElement>('.chat-header button:not(:disabled)')
  if (canFocus(target)) target?.focus({ preventScroll: true })
}

/** Reading has its own request generation and never occupies the conversation operation lock. */
export function useFileView(conversation: ConversationController): {
  state: FileViewState
  open: OpenFileView
  close: () => void
} {
  const conversationId = conversation.activeConversationId
  const workspaceId = conversation.workspace.runtime?.workspaceId
  const contextKey = JSON.stringify([
    conversationId,
    workspaceId ?? null,
    conversation.contextSelection?.snapshotId ?? null,
    conversation.contextSelection?.files.map((file) => file.path) ?? [],
    conversation.executionPermissions.state?.revision ?? null
  ])
  const [state, setState] = useState<FileViewState>({ status: 'idle' })
  const generation = useRef(0)
  const currentKey = useRef(contextKey)
  const active = useRef<ActiveView | null>(null)
  const mounted = useRef(false)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      generation.current += 1
      active.current = null
    }
  }, [])

  useLayoutEffect(() => {
    if (currentKey.current === contextKey) return
    currentKey.current = contextKey
    generation.current += 1
    active.current = null
    const panelHadFocus = document.activeElement?.closest('.file-view-panel')
    setState({ status: 'idle' })
    if (panelHadFocus) returnFocus()
  }, [contextKey])

  useLayoutEffect(() => {
    const previous = active.current
    if (
      !previous ||
      conversation.messages.some((message) => message.id === previous.origin.messageId)
    )
      return
    generation.current += 1
    active.current = null
    setState({ status: 'idle' })
    returnFocus()
  }, [conversation.messages])

  const close = useCallback((): void => {
    const previous = active.current
    generation.current += 1
    active.current = null
    setState({ status: 'idle' })
    if (previous?.contextKey === currentKey.current) returnFocus(previous.trigger)
    else returnFocus()
  }, [])

  const open = useCallback<OpenFileView>(
    (reference, origin, trigger): void => {
      if (!conversationId || !mounted.current) return
      const requestGeneration = ++generation.current
      const view = { contextKey, reference, origin, trigger }
      active.current = view
      setState({ ...view, status: 'loading' })
      const localWorkspaceId = isAbsoluteFilePath(reference.path)
        ? workspaceId
        : origin.scope?.workspaceId
      const request: FileViewRequest = {
        requestId: crypto.randomUUID(),
        conversationId,
        reference,
        source:
          origin.source.kind === 'snapshot'
            ? origin.source
            : {
                kind: 'local',
                ...(localWorkspaceId ? { workspaceId: localWorkspaceId } : {}),
                ...(origin.scope?.executionId ? { executionId: origin.scope.executionId } : {})
              }
      }
      void window.api
        .readFileView(request)
        .then((result) => {
          if (
            !mounted.current ||
            generation.current !== requestGeneration ||
            currentKey.current !== view.contextKey
          )
            return
          if (result.status === 'ready') setState({ ...view, status: 'ready', result })
          else setState({ ...view, status: 'error', error: result.error })
        })
        .catch(() => {
          if (
            !mounted.current ||
            generation.current !== requestGeneration ||
            currentKey.current !== view.contextKey
          )
            return
          setState({ ...view, status: 'error', error: '无法读取文件，请重新点击引用。' })
        })
    },
    [contextKey, conversationId, workspaceId]
  )

  const visibleState: FileViewState =
    state.status !== 'idle' &&
    (state.contextKey !== contextKey ||
      !conversation.messages.some((message) => message.id === state.origin.messageId))
      ? { status: 'idle' }
      : state

  useEffect(() => {
    if (visibleState.status === 'idle') return
    function onKeyDown(event: KeyboardEvent): void {
      if (
        event.key !== 'Escape' ||
        event.defaultPrevented ||
        document.activeElement?.closest('.change-preview-panel, .command-review-panel') ||
        document.querySelector('dialog[open], [popover]:popover-open')
      )
        return
      event.preventDefault()
      event.stopImmediatePropagation()
      close()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [visibleState.status, close])

  return { state: visibleState, open, close }
}
