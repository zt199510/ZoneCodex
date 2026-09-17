import { useEffect, useRef, useState } from 'react'
import type { WindowAction } from '../../../../shared/window'

export function useWindowControls(): {
  maximized: boolean
  error: string | null
  run: (action: WindowAction) => Promise<void>
} {
  const [maximized, setMaximized] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(false)

  useEffect(() => {
    mounted.current = true
    let disposed = false
    let receivedEvent = false
    const unsubscribe = window.api.onWindowStateChanged((state) => {
      receivedEvent = true
      setMaximized(state.maximized)
    })
    void window.api
      .getWindowState()
      .then((state) => {
        if (!disposed && !receivedEvent) setMaximized(state.maximized)
      })
      .catch(() => {
        if (!disposed) setError('无法读取窗口状态')
      })
    return () => {
      disposed = true
      mounted.current = false
      unsubscribe()
    }
  }, [])

  async function run(action: WindowAction): Promise<void> {
    setError(null)
    try {
      await window.api.controlWindow(action)
    } catch {
      if (mounted.current) setError('窗口操作失败，请重试')
    }
  }

  return { maximized, error, run }
}
