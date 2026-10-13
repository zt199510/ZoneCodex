import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  GitChangeItem,
  GitControlResult,
  GitFailureStatus,
  GitItemResult,
  GitListResult,
  GitViewScope
} from '../../../../shared/git-view'
import { sameGitItemRequest, sameGitListRequest } from '../../../../shared/git-view'

type ReadyList = Extract<GitListResult, { status: 'ready' }>
type ReadyItem = Extract<GitItemResult, { status: 'ready' }>
type Notice = { status: GitFailureStatus; error: string }
export type GitViewState = {
  open: boolean
  phase: 'empty' | 'selecting' | 'loading' | 'ready' | 'error'
  view: GitViewScope | null
  list: ReadyList | null
  selectedItemId: string | null
  detail: ReadyItem | null
  detailLoading: boolean
  notice: Notice | null
}
const emptyState = (): GitViewState => ({
  open: false,
  phase: 'empty',
  view: null,
  list: null,
  selectedItemId: null,
  detail: null,
  detailLoading: false,
  notice: null
})

function modalOpen(): boolean {
  return !!document.querySelector('dialog[open], [popover]:popover-open')
}

/** Window-only display state: no conversation, workspace grant or persistence dependencies. */
export function useGitView(
  activePage = true,
  directoryBlocked = false
): {
  state: GitViewState
  cleanupError: string
  open: (trigger: HTMLElement) => void
  close: (restoreFocus?: boolean) => void
  selectDirectory: () => Promise<void>
  adoptView: (view: GitViewScope) => void
  refresh: () => Promise<void>
  readItem: (item: GitChangeItem) => Promise<void>
} {
  const [state, setState] = useState<GitViewState>(emptyState)
  const [cleanupError, setCleanupError] = useState('')
  const mounted = useRef(false)
  const opened = useRef(false)
  const generation = useRef(0)
  const scope = useRef<GitViewScope | null>(null)
  const list = useRef<ReadyList | null>(null)
  const pending = useRef<string | null>(null)
  const trigger = useRef<HTMLElement | null>(null)

  const cleanupFailure = useCallback((error: string): void => {
    const message = error.slice(0, 500)
    console.error('Git 查看清理未确认：', message)
    if (mounted.current) setCleanupError(message)
  }, [])
  const control = useCallback(
    async (operation: Promise<GitControlResult>): Promise<boolean> => {
      try {
        const result = await operation
        if (result.status === 'error') {
          cleanupFailure(result.error)
          return false
        }
        return true
      } catch {
        cleanupFailure('无法确认 Git 读取已结束，请重试或关闭查看。')
        return false
      }
    },
    [cleanupFailure]
  )
  const release = useCallback(
    async (viewId: string): Promise<void> => {
      await control(window.api.releaseGitView(viewId))
    },
    [control]
  )
  const current = useCallback(
    (value: number): boolean => mounted.current && opened.current && generation.current === value,
    []
  )
  const stopPrevious = useCallback(
    async (requestId: string | null, value: number): Promise<boolean> => {
      if (requestId && !(await control(window.api.cancelGitRead(requestId)))) {
        if (current(value)) {
          pending.current = requestId
          setState((previous) => ({
            ...previous,
            phase: previous.list ? 'ready' : 'error',
            detailLoading: false,
            notice: { status: 'error', error: '上次读取的取消尚未确认，请重试。' }
          }))
        }
        return false
      }
      return current(value)
    },
    [control, current]
  )

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      opened.current = false
      generation.current += 1
      const requestId = pending.current
      const viewId = scope.current?.viewId
      pending.current = null
      scope.current = null
      list.current = null
      void (async () => {
        if (requestId) await control(window.api.cancelGitRead(requestId))
        if (viewId) await release(viewId)
      })()
    }
  }, [control, release])

  const open = useCallback(
    (element: HTMLElement): void => {
      if (!mounted.current || !activePage || modalOpen()) return
      if (opened.current) return
      generation.current += 1
      opened.current = true
      trigger.current = element
      setState({ ...emptyState(), open: true })
    },
    [activePage]
  )
  const close = useCallback(
    (restoreFocus = true): void => {
      generation.current += 1
      opened.current = false
      const requestId = pending.current
      const viewId = scope.current?.viewId
      const previousTrigger = trigger.current
      pending.current = null
      scope.current = null
      list.current = null
      trigger.current = null
      setState(emptyState())
      void (async () => {
        if (requestId) await control(window.api.cancelGitRead(requestId))
        if (viewId) await release(viewId)
      })()
      if (restoreFocus)
        requestAnimationFrame(() => {
          if (modalOpen()) return
          if (
            previousTrigger?.isConnected &&
            previousTrigger.getClientRects().length &&
            !previousTrigger.closest('[inert], [hidden]') &&
            !previousTrigger.matches(':disabled')
          )
            previousTrigger.focus({ preventScroll: true })
        })
    },
    [control, release]
  )

  const loadList = useCallback(
    async (view: GitViewScope, value: number): Promise<void> => {
      if (!current(value)) return
      const request = { requestId: crypto.randomUUID(), viewId: view.viewId }
      pending.current = request.requestId
      list.current = null
      setState((previous) => ({
        ...previous,
        phase: 'loading',
        view,
        list: null,
        selectedItemId: null,
        detail: null,
        detailLoading: false,
        notice: null
      }))
      try {
        const result = await window.api.refreshGitView(request)
        if (!current(value) || scope.current?.viewId !== view.viewId) return
        pending.current = null
        if (!sameGitListRequest(result, request)) {
          setState((previous) => ({
            ...previous,
            phase: 'error',
            notice: { status: 'stale', error: '列表身份已变化，请刷新。' }
          }))
        } else if (result.status === 'ready') {
          list.current = result
          setState((previous) => ({ ...previous, phase: 'ready', list: result }))
        } else {
          setState((previous) => ({
            ...previous,
            phase: result.status === 'cancelled' ? 'empty' : 'error',
            notice: result.status === 'cancelled' ? null : result
          }))
        }
      } catch {
        if (!current(value)) return
        pending.current = null
        setState((previous) => ({
          ...previous,
          phase: 'error',
          notice: { status: 'error', error: '无法读取改动列表，请刷新重试。' }
        }))
      }
    },
    [current]
  )

  const selectDirectory = useCallback(async (): Promise<void> => {
    if (!activePage || directoryBlocked || modalOpen() || !opened.current) return
    const value = ++generation.current
    const oldRequest = pending.current
    pending.current = null
    setState((previous) => ({
      ...previous,
      phase: 'selecting',
      selectedItemId: null,
      detail: null,
      detailLoading: false,
      notice: null
    }))
    if (!(await stopPrevious(oldRequest, value))) return
    const requestId = crypto.randomUUID()
    pending.current = requestId
    try {
      const result = await window.api.selectGitDirectory(requestId)
      if (!current(value) || result.requestId !== requestId) {
        if (result.status === 'ready') await release(result.view.viewId)
        if (current(value)) {
          pending.current = null
          setState((previous) => ({
            ...previous,
            phase: 'error',
            notice: { status: 'stale', error: '目录选择身份已失效，请重新选择。' }
          }))
        }
        return
      }
      pending.current = null
      if (result.status === 'ready') {
        scope.current = result.view
        await loadList(result.view, value)
      } else {
        setState((previous) => ({
          ...previous,
          phase: result.status === 'cancelled' ? (previous.list ? 'ready' : 'empty') : 'error',
          notice: result.status === 'cancelled' ? null : result
        }))
      }
    } catch {
      if (!current(value)) return
      pending.current = null
      setState((previous) => ({
        ...previous,
        phase: 'error',
        notice: { status: 'error', error: '无法选择 Git 目录，请重试。' }
      }))
    }
  }, [activePage, directoryBlocked, stopPrevious, current, release, loadList])

  const refresh = useCallback(async (): Promise<void> => {
    const view = scope.current
    if (!activePage || !opened.current || !view || modalOpen()) return
    const value = ++generation.current
    const oldRequest = pending.current
    pending.current = null
    list.current = null
    setState((previous) => ({
      ...previous,
      phase: 'loading',
      list: null,
      selectedItemId: null,
      detail: null,
      detailLoading: false,
      notice: null
    }))
    if (await stopPrevious(oldRequest, value)) await loadList(view, value)
  }, [activePage, stopPrevious, loadList])

  const readItem = useCallback(
    async (item: GitChangeItem): Promise<void> => {
      const listing = list.current
      if (!activePage || !opened.current || modalOpen() || !listing) return
      if (!listing.items.some((candidate) => candidate.itemId === item.itemId)) return
      const value = ++generation.current
      const oldRequest = pending.current
      pending.current = null
      setState((previous) => ({
        ...previous,
        selectedItemId: item.itemId,
        detail: null,
        detailLoading: item.previewable,
        notice: item.previewable
          ? null
          : { status: 'unsupported', error: item.reason ?? '此项暂不支持预览。' }
      }))
      if (!(await stopPrevious(oldRequest, value)) || !item.previewable) return
      const request = {
        requestId: crypto.randomUUID(),
        viewId: listing.viewId,
        revision: listing.revision,
        itemId: item.itemId
      }
      pending.current = request.requestId
      try {
        const result = await window.api.readGitItem(request)
        if (!current(value) || scope.current?.viewId !== listing.viewId) return
        pending.current = null
        const matched = sameGitItemRequest(result, request)
        const matchedItem =
          result.status === 'ready' &&
          result.item.itemId === item.itemId &&
          result.item.group === item.group &&
          result.item.path === item.path &&
          result.item.previousPath === item.previousPath
        if (matched && result.status === 'ready' && matchedItem) {
          setState((previous) => ({ ...previous, detailLoading: false, detail: result }))
        } else {
          const stale =
            !matched || result.status === 'stale' || (result.status === 'ready' && !matchedItem)
          if (stale) list.current = null
          setState((previous) => ({
            ...previous,
            list: stale ? null : previous.list,
            phase: stale ? 'error' : previous.phase,
            detailLoading: false,
            notice:
              !matched || (result.status === 'ready' && !matchedItem)
                ? { status: 'stale', error: '内容身份已变化，请刷新列表。' }
                : result.status === 'cancelled' || result.status === 'ready'
                  ? null
                  : result
          }))
        }
      } catch {
        if (!current(value)) return
        pending.current = null
        setState((previous) => ({
          ...previous,
          detailLoading: false,
          notice: { status: 'error', error: '无法读取所选改动，请重试或刷新。' }
        }))
      }
    },
    [activePage, stopPrevious, current]
  )

  useEffect(() => {
    if (!activePage || !state.open) return
    const keydown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented || modalOpen()) return
      if (document.activeElement?.closest('.change-preview-panel, .command-review-panel')) return
      event.preventDefault()
      event.stopImmediatePropagation()
      close()
    }
    window.addEventListener('keydown', keydown, true)
    return () => window.removeEventListener('keydown', keydown, true)
  }, [activePage, state.open, close])

  const adoptView = useCallback(
    (view: GitViewScope): void => {
      if (!mounted.current || !opened.current) {
        void release(view.viewId)
        return
      }
      generation.current += 1
      pending.current = null
      scope.current = view
      list.current = null
      setState({ ...emptyState(), open: true, phase: 'ready', view })
    },
    [release]
  )

  return { state, cleanupError, open, close, selectDirectory, adoptView, refresh, readItem }
}
