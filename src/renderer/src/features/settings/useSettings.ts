import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AppSettings, SettingsChange } from '../../../../shared/settings'

export function useSettings(
  open: boolean,
  canChange: boolean,
  onSavingChange: (saving: boolean) => void
): {
  settings: AppSettings | null
  loading: boolean
  saving: boolean
  error: string | null
  reload: () => Promise<void>
  update: (change: SettingsChange) => Promise<void>
  selectTaskRoot: () => Promise<void>
} {
  const [snapshot, setSnapshot] = useState<{
    key: object | null
    settings: AppSettings | null
    error: string | null
  }>({ key: null, settings: null, error: null })
  const [refresh, setRefresh] = useState(0)
  const [saving, setSaving] = useState(false)
  const mounted = useRef(false)
  const visible = useRef(false)
  const reading = useRef(false)
  const writing = useRef(false)
  const generation = useRef(0)
  const confirmed = useRef<AppSettings | null>(null)
  const requestKey = useMemo(() => ({ open, refresh }), [open, refresh])
  const loading = open && snapshot.key !== requestKey && !saving

  const reload = useCallback(async (): Promise<void> => {
    if (!mounted.current || !visible.current || writing.current) return
    reading.current = true
    setRefresh((previous) => previous + 1)
  }, [])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      generation.current += 1
    }
  }, [])

  useEffect(() => {
    visible.current = open
    const request = ++generation.current
    if (open && !writing.current) {
      reading.current = true
      void window.api
        .getSettings()
        .then((next) => {
          if (!mounted.current || !visible.current || generation.current !== request) return
          confirmed.current = next
          setSnapshot({ key: requestKey, settings: next, error: null })
        })
        .catch((cause) => {
          if (!mounted.current || !visible.current || generation.current !== request) return
          confirmed.current = null
          setSnapshot({
            key: requestKey,
            settings: null,
            error: cause instanceof Error ? cause.message : '读取设置失败，请重试。'
          })
        })
        .finally(() => {
          if (mounted.current && generation.current === request) reading.current = false
        })
    }
    return () => {
      visible.current = false
      generation.current += 1
    }
  }, [open, requestKey])

  const save = useCallback(
    async (operation: () => Promise<AppSettings | null>): Promise<void> => {
      if (
        !mounted.current ||
        !visible.current ||
        !canChange ||
        !confirmed.current ||
        snapshot.key !== requestKey ||
        reading.current ||
        writing.current
      )
        return
      writing.current = true
      onSavingChange(true)
      const request = ++generation.current
      setSaving(true)
      setSnapshot((previous) => ({ ...previous, error: null }))
      try {
        const next = await operation()
        if (!mounted.current || !visible.current || generation.current !== request) return
        if (next) {
          confirmed.current = next
          setSnapshot({ key: requestKey, settings: next, error: null })
        }
      } catch (cause) {
        if (!mounted.current || !visible.current || generation.current !== request) return
        setSnapshot((previous) => ({
          ...previous,
          error: cause instanceof Error ? cause.message : '保存设置失败，请重试。'
        }))
      } finally {
        writing.current = false
        if (mounted.current) {
          onSavingChange(false)
          setSaving(false)
          // A reopened view reads the outcome only after the pending write has finished.
          if (visible.current && generation.current !== request) void reload()
        }
      }
    },
    [canChange, onSavingChange, reload, requestKey, snapshot.key]
  )

  const update = useCallback(
    async (change: SettingsChange): Promise<void> => {
      await save(() => window.api.updateSettings(change))
    },
    [save]
  )
  const selectTaskRoot = useCallback(async (): Promise<void> => {
    await save(async () => {
      const result = await window.api.selectTaskRoot()
      return result.status === 'selected' ? result.settings : null
    })
  }, [save])

  return {
    settings: snapshot.settings,
    loading,
    saving,
    error: snapshot.key === requestKey ? snapshot.error : null,
    reload,
    update,
    selectTaskRoot
  }
}
