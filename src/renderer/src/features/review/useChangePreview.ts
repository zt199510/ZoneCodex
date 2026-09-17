import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ChangePreview } from '../../../../shared/change-preview'
import type { ProjectSelection } from '../../../../shared/project'
import type { OperationControl } from '../conversation/useOperation'

export type ChangePreviewState =
  | { status: 'idle' }
  | { status: 'loading'; path: string; generation: number }
  | { status: 'ready'; preview: ChangePreview; generation: number }
  | { status: 'error'; error: string; path: string; generation: number }

type ChangePreviewOptions = {
  conversationId: string | null
  selection: ProjectSelection | null
  operations: OperationControl
  canChange: () => boolean
}

export type ChangePreviewController = {
  state: ChangePreviewState
  requestPreview: (path: string, proposedText: string) => Promise<boolean>
  discard: () => boolean
}

type ActiveRequest = {
  generation: number
  conversationId: string
  snapshotId: string
}

export function useChangePreview({
  conversationId,
  selection,
  operations,
  canChange
}: ChangePreviewOptions): ChangePreviewController {
  const { begin, finish } = operations
  const [state, setState] = useState<ChangePreviewState>({ status: 'idle' })
  const generation = useRef(0)
  const activeRequest = useRef<ActiveRequest | null>(null)
  const mounted = useRef(false)
  const currentContext = useRef({
    conversationId,
    snapshotId: selection?.snapshotId ?? null
  })
  const previousContext = useRef({
    conversationId,
    snapshotId: selection?.snapshotId ?? null
  })

  const ownsRequest = useCallback((request: ActiveRequest): boolean => {
    const current = activeRequest.current
    return (
      mounted.current &&
      current === request &&
      generation.current === request.generation &&
      currentContext.current.conversationId === request.conversationId &&
      currentContext.current.snapshotId === request.snapshotId
    )
  }, [])

  const invalidate = useCallback((): void => {
    generation.current += 1
    const request = activeRequest.current
    activeRequest.current = null
    if (request) finish('selecting')
  }, [finish])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      invalidate()
    }
  }, [invalidate])

  useLayoutEffect(() => {
    currentContext.current = {
      conversationId,
      snapshotId: selection?.snapshotId ?? null
    }
  }, [conversationId, selection?.snapshotId])

  useLayoutEffect(() => {
    const nextContext = {
      conversationId,
      snapshotId: selection?.snapshotId ?? null
    }
    const previous = previousContext.current
    previousContext.current = nextContext
    if (
      previous.conversationId !== nextContext.conversationId ||
      previous.snapshotId !== nextContext.snapshotId
    ) {
      invalidate()
      setState({ status: 'idle' })
    }
  }, [conversationId, invalidate, selection?.snapshotId])

  const requestPreview = useCallback(
    async (path: string, proposedText: string): Promise<boolean> => {
      if (
        activeRequest.current ||
        !conversationId ||
        !selection ||
        !canChange() ||
        !begin('selecting')
      ) {
        return false
      }

      const request: ActiveRequest = {
        generation: generation.current + 1,
        conversationId,
        snapshotId: selection.snapshotId
      }
      generation.current = request.generation
      activeRequest.current = request
      setState({ status: 'loading', path, generation: request.generation })

      try {
        const result = await window.api.previewChange({
          conversationId: request.conversationId,
          snapshotId: request.snapshotId,
          path,
          proposedText
        })
        if (!ownsRequest(request)) return false
        if (result.status === 'ready') {
          setState({ status: 'ready', preview: result.preview, generation: request.generation })
          return true
        }
        setState({ status: 'error', error: result.error, path, generation: request.generation })
        return false
      } catch {
        if (!ownsRequest(request)) return false
        setState({
          status: 'error',
          error: '修改预览失败，请重试。',
          path,
          generation: request.generation
        })
        return false
      } finally {
        if (ownsRequest(request)) {
          activeRequest.current = null
          finish('selecting')
        }
      }
    },
    [begin, canChange, conversationId, finish, ownsRequest, selection]
  )

  const discard = useCallback((): boolean => {
    invalidate()
    if (state.status === 'idle') return true
    setState({ status: 'idle' })
    return true
  }, [invalidate, state.status])

  return { state, requestPreview, discard }
}
