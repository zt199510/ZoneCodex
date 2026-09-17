import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PreparationRequest, PreparationResult } from '../../../../shared/change-preparation'
import type { OperationControl } from '../conversation/useOperation'

type State = { status: 'idle' | 'loading' } | PreparationResult
export type PreparationController = {
  state: State
  check: () => Promise<void>
  cancel: () => void
  available: boolean
}

export function useChangePreparation(
  context: Omit<PreparationRequest, 'checkId'> | null,
  operations: OperationControl,
  canChange: () => boolean
): PreparationController {
  const [state, setState] = useState<State>({ status: 'idle' })
  const current = useRef(context)
  const mounted = useRef(true)
  const active = useRef<{ checkId: string; key: string; loading: boolean } | null>(null)
  const { begin, finish } = operations
  const key = JSON.stringify(context)
  const cancel = useCallback(() => {
    const task = active.current
    active.current = null
    if (task) {
      void window.api.cancelPreparation(task.checkId).catch(() => undefined)
      if (task.loading) finish('selecting')
    }
    if (mounted.current) setState({ status: 'idle' })
  }, [finish])
  useLayoutEffect(() => {
    current.current = context
  })
  useLayoutEffect(() => {
    cancel()
  }, [key, cancel])
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      cancel()
    }
  }, [cancel])
  useEffect(() => {
    if (state.status !== 'ready') return
    const timer = setTimeout(cancel, Math.max(0, state.expiresAt - Date.now()))
    return () => clearTimeout(timer)
  }, [state, cancel])

  async function check(): Promise<void> {
    const request = current.current
    if (!request || active.current?.loading || !canChange() || !begin('selecting')) return
    const old = active.current
    if (old) void window.api.cancelPreparation(old.checkId).catch(() => undefined)
    const task = { checkId: crypto.randomUUID(), key: JSON.stringify(request), loading: true }
    active.current = task
    setState({ status: 'loading' })
    try {
      const result = await window.api.prepareChange({ ...request, checkId: task.checkId })
      if (
        mounted.current &&
        active.current === task &&
        JSON.stringify(current.current) === task.key
      )
        setState(result)
      else void window.api.cancelPreparation(task.checkId).catch(() => undefined)
    } catch {
      if (mounted.current && active.current === task)
        setState({ status: 'error', error: '检查失败，请重试' })
    } finally {
      if (active.current === task) {
        task.loading = false
        finish('selecting')
      }
    }
  }
  return { state, check, cancel, available: context !== null }
}
