import { useCallback, useEffect, useRef, useState } from 'react'
import type { GitViewScope } from '../../../../shared/git-view'
import type { GitViewState } from './useGitView'

const empty = (): GitViewState => ({
  open: false,
  phase: 'empty',
  view: null,
  list: null,
  selectedItemId: null,
  detail: null,
  detailLoading: false,
  notice: null
})

/** These scopes are selected in a native dialog and owned by this window only. */
export function useGitRepositories(
  activePage = true,
  directoryBlocked = false
): {
  state: GitViewState
  views: GitViewScope[]
  selected: string | 'all'
  selecting: boolean
  cleanupError: string
  open: (trigger: HTMLElement) => void
  close: (restoreFocus?: boolean) => void
  selectDirectory: () => Promise<void>
  selectRepository: (viewId: string | 'all') => void
  removeRepository: (viewId: string) => Promise<void>
  adoptView: (view: GitViewScope) => void
} {
  const [state, setState] = useState<GitViewState>(empty)
  const [views, setViews] = useState<GitViewScope[]>([])
  const [selected, setSelected] = useState<string | 'all'>('all')
  const [selecting, setSelecting] = useState(false)
  const [cleanupError, setCleanupError] = useState('')
  const owned = useRef<GitViewScope[]>([])
  const opened = useRef(false)
  const mounted = useRef(false)
  const epoch = useRef(0)
  const pending = useRef<string | null>(null)
  const trigger = useRef<HTMLElement | null>(null)
  const retirement = useRef<Promise<void>>(Promise.resolve())
  const retiring = useRef(false)
  const cleanupBlocked = useRef(false)

  const release = useCallback(async (viewId: string): Promise<boolean> => {
    try {
      const result = await window.api.releaseGitView(viewId)
      if (result.status !== 'error') {
        owned.current = owned.current.filter((scope) => scope.viewId !== viewId)
        return true
      }
      cleanupBlocked.current = true
      if (mounted.current) setCleanupError(result.error)
    } catch {
      cleanupBlocked.current = true
      if (mounted.current) setCleanupError('无法确认仓库已释放，请关闭查看后重试。')
    }
    return false
  }, [])
  const close = useCallback(
    (restoreFocus = true): void => {
      opened.current = false
      epoch.current += 1
      const requestId = pending.current
      const scopes = owned.current
      const previousTrigger = trigger.current
      pending.current = null
      trigger.current = null
      setState(empty())
      setViews([])
      setSelected('all')
      setSelecting(false)
      retiring.current = true
      retirement.current = retirement.current.then(async () => {
        if (requestId) {
          try {
            const result = await window.api.cancelGitRead(requestId)
            if (result.status === 'error') {
              cleanupBlocked.current = true
              if (mounted.current) setCleanupError(result.error)
            }
          } catch {
            cleanupBlocked.current = true
            if (mounted.current) setCleanupError('目录选择尚未确认结束，请关闭窗口后重试。')
          }
        }
        for (const scope of scopes) await release(scope.viewId)
        retiring.current = false
      })
      if (restoreFocus)
        requestAnimationFrame(() => {
          if (
            !document.querySelector('dialog[open], [popover]:popover-open') &&
            previousTrigger?.isConnected &&
            !previousTrigger.closest('[hidden], [inert]') &&
            !previousTrigger.matches(':disabled')
          )
            previousTrigger.focus({ preventScroll: true })
        })
    },
    [release]
  )
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      opened.current = false
      epoch.current += 1
      const requestId = pending.current
      const scopes = owned.current
      owned.current = []
      pending.current = null
      void (async () => {
        if (requestId) {
          try {
            await window.api.cancelGitRead(requestId)
          } catch {
            /* Retire scopes. */
          }
        }
        for (const scope of scopes) await release(scope.viewId)
      })()
    }
  }, [release])
  const open = useCallback(
    (element: HTMLElement): void => {
      if (
        !activePage ||
        opened.current ||
        document.querySelector('dialog[open], [popover]:popover-open')
      )
        return
      const value = ++epoch.current
      opened.current = true
      trigger.current = element
      setState({ ...empty(), open: true })
      if (!retiring.current && !cleanupBlocked.current && !owned.current.length) return
      setSelecting(true)
      void retirement.current.then(async () => {
        if (!mounted.current || !opened.current || epoch.current !== value) return
        const requestId = crypto.randomUUID()
        try {
          const result = await window.api.getGitRepositories(requestId)
          if (!mounted.current || !opened.current || epoch.current !== value) return
          if (result.requestId !== requestId || result.status !== 'ready') {
            cleanupBlocked.current = true
            setCleanupError(
              result.status !== 'ready' && result.status !== 'cancelled'
                ? result.error
                : '仓库清理身份未确认，请关闭窗口后重试。'
            )
            return
          }
          owned.current = result.views
          setViews(result.views)
          setSelected(result.views[0]?.viewId ?? 'all')
          setState({
            ...empty(),
            open: true,
            phase: result.views.length ? 'ready' : 'empty',
            view: result.views[0] ?? null
          })
          // A previously unconfirmed retirement stays blocked until the host confirms a retry.
          if (!cleanupBlocked.current) setCleanupError('')
        } catch {
          cleanupBlocked.current = true
          setCleanupError('无法确认仓库清理状态，请关闭窗口后重试。')
        } finally {
          if (mounted.current && epoch.current === value) setSelecting(false)
        }
      })
    },
    [activePage]
  )
  const selectRepository = useCallback((viewId: string | 'all'): void => {
    if (
      !opened.current ||
      (viewId !== 'all' && !owned.current.some((view) => view.viewId === viewId))
    )
      return
    setSelected(viewId)
    setState((previous) => ({
      ...previous,
      phase: owned.current.length ? 'ready' : 'empty',
      view: owned.current.find((view) => view.viewId === viewId) ?? owned.current[0] ?? null
    }))
  }, [])
  const selectDirectory = useCallback(async (): Promise<void> => {
    if (
      !activePage ||
      directoryBlocked ||
      cleanupBlocked.current ||
      retiring.current ||
      !opened.current ||
      pending.current ||
      document.querySelector('dialog[open], [popover]:popover-open')
    )
      return
    const value = ++epoch.current
    const requestId = crypto.randomUUID()
    pending.current = requestId
    setSelecting(true)
    try {
      const result = await window.api.selectGitDirectories(requestId)
      if (
        !mounted.current ||
        !opened.current ||
        epoch.current !== value ||
        result.requestId !== requestId
      ) {
        if (result.status === 'ready') {
          for (const viewId of result.addedViewIds) {
            const view = result.views.find((scope) => scope.viewId === viewId)!
            if (!owned.current.some((scope) => scope.viewId === viewId)) owned.current.push(view)
            await release(viewId)
          }
        }
        return
      }
      if (result.status === 'ready') {
        owned.current = result.views
        setViews(result.views)
        const next = result.addedViewIds[0] ?? result.views[0]?.viewId ?? 'all'
        setSelected(next)
        setState({
          ...empty(),
          open: true,
          phase: result.views.length ? 'ready' : 'empty',
          view: result.views.find((view) => view.viewId === next) ?? null,
          notice: result.warnings.length
            ? { status: 'error', error: result.warnings.join('；') }
            : null
        })
      } else if (result.status !== 'cancelled') {
        setState((previous) => ({ ...previous, notice: result }))
      }
    } catch {
      if (mounted.current && opened.current && epoch.current === value)
        setState((previous) => ({
          ...previous,
          notice: { status: 'error', error: '无法添加仓库，请重新选择。' }
        }))
    } finally {
      if (pending.current === requestId) pending.current = null
      if (mounted.current && epoch.current === value) setSelecting(false)
    }
  }, [activePage, directoryBlocked, release])
  const adoptView = useCallback(
    (view: GitViewScope): void => {
      if (!mounted.current || !opened.current) {
        if (!owned.current.some((scope) => scope.viewId === view.viewId)) owned.current.push(view)
        void release(view.viewId)
        return
      }
      if (!owned.current.some((scope) => scope.viewId === view.viewId))
        owned.current = [...owned.current, view]
      else
        owned.current = owned.current.map((scope) => (scope.viewId === view.viewId ? view : scope))
      setViews(owned.current)
      setSelected(view.viewId)
      setState({ ...empty(), open: true, phase: 'ready', view })
    },
    [release]
  )
  const removeRepository = useCallback(
    async (viewId: string): Promise<void> => {
      if (!owned.current.some((view) => view.viewId === viewId)) return
      if (!(await release(viewId))) return
      if (!mounted.current || !opened.current) return
      owned.current = owned.current.filter((view) => view.viewId !== viewId)
      setViews(owned.current)
      setSelected((previous) =>
        previous === viewId ? (owned.current[0]?.viewId ?? 'all') : previous
      )
      setState((previous) => ({
        ...previous,
        phase: owned.current.length ? 'ready' : 'empty',
        view: previous.view?.viewId === viewId ? (owned.current[0] ?? null) : previous.view
      }))
    },
    [release]
  )
  useEffect(() => {
    if (!activePage || !state.open) return
    const keydown = (event: KeyboardEvent): void => {
      if (
        event.key !== 'Escape' ||
        event.defaultPrevented ||
        document.querySelector('dialog[open], [popover]:popover-open')
      )
        return
      event.preventDefault()
      event.stopImmediatePropagation()
      close()
    }
    window.addEventListener('keydown', keydown, true)
    return () => window.removeEventListener('keydown', keydown, true)
  }, [activePage, state.open, close])
  return {
    state,
    views,
    selected,
    selecting,
    cleanupError,
    open,
    close,
    selectDirectory,
    selectRepository,
    removeRepository,
    adoptView
  }
}
