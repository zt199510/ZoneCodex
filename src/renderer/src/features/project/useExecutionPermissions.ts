import { useCallback, useEffect, useRef, useState } from 'react'
import type { ExecutionInfo, PermissionMode, PermissionsState } from '../../../../shared/execution'
import type { OperationControl } from '../conversation/useOperation'

export type ExecutionPermissionsController = {
  state: PermissionsState | null
  error: string | null
  loading: boolean
  getState: () => PermissionsState | null
  observe: (execution: ExecutionInfo) => void
  select: (mode: PermissionMode) => Promise<boolean>
}

/** The window has one permission setting; changing chats does not create another copy. */
export function useExecutionPermissions(
  operations: OperationControl,
  canChange: () => boolean
): ExecutionPermissionsController {
  const [state, setState] = useState<PermissionsState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const stateRef = useRef<PermissionsState | null>(null)
  const generationRef = useRef(0)
  const mountedRef = useRef(false)

  const updateState = useCallback((next: PermissionsState | null): void => {
    stateRef.current = next
    setState(next)
  }, [])

  useEffect(() => {
    mountedRef.current = true
    const generation = ++generationRef.current
    void window.api
      .getExecutionPermissions()
      .then((next) => {
        if (!mountedRef.current || generationRef.current !== generation) return
        updateState(next)
        setError(null)
      })
      .catch(() => {
        if (!mountedRef.current || generationRef.current !== generation) return
        setError('读取权限设置失败，请重新打开窗口。')
      })
      .finally(() => {
        if (mountedRef.current && generationRef.current === generation) setLoading(false)
      })
    return () => {
      mountedRef.current = false
      generationRef.current += 1
    }
  }, [updateState])

  const getState = useCallback(() => stateRef.current, [])
  const observe = useCallback(
    (execution: ExecutionInfo): void => {
      const current = stateRef.current
      if (!mountedRef.current || (current && execution.revision < current.revision)) return
      setError(null)
      if (current?.mode === execution.mode && current.revision === execution.revision) return
      updateState({ mode: execution.mode, revision: execution.revision })
    },
    [updateState]
  )

  const select = useCallback(
    async (mode: PermissionMode): Promise<boolean> => {
      if (!mountedRef.current || !stateRef.current || !canChange()) return false
      if (mode === stateRef.current.mode) return true
      if (!operations.begin('selecting')) return false
      const generation = ++generationRef.current
      setError(null)
      setLoading(true)
      try {
        const next = await window.api.setExecutionPermissions(mode)
        if (!mountedRef.current || generationRef.current !== generation) return false
        updateState(next)
        return true
      } catch (cause) {
        if (!mountedRef.current || generationRef.current !== generation) return false
        // The reply may fail after main has accepted the change. Read back the
        // effective state before enabling another request with an old setting.
        updateState(null)
        try {
          const next = await window.api.getExecutionPermissions()
          if (!mountedRef.current || generationRef.current !== generation) return false
          updateState(next)
        } catch {
          // An unknown permission state keeps sending disabled.
        }
        if (mountedRef.current && generationRef.current === generation) {
          setError(cause instanceof Error ? cause.message : '修改权限设置失败，请重试。')
        }
        return false
      } finally {
        if (mountedRef.current && generationRef.current === generation) setLoading(false)
        operations.finish('selecting')
      }
    },
    [canChange, operations, updateState]
  )

  return { state, error, loading, getState, observe, select }
}
