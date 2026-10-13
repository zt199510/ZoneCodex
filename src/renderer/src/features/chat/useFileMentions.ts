import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent, RefObject } from 'react'
import type { WorkspaceFileSearchResult } from '../../../../shared/project'

export type FileReferenceController = {
  contextKey: string
  hasWorkspace: boolean
  search: (query: string) => Promise<WorkspaceFileSearchResult>
  add: (path: string) => Promise<boolean>
  selectWorkspace: () => Promise<boolean>
}

type Mention = { start: number; end: number; query: string; value: string; contextKey: string }
type SearchState = { key: string; paths: string[]; loading: boolean; error: string | null }

export type FileMentionsController = {
  open: boolean
  paths: string[]
  loading: boolean
  error: string | null
  activeIndex: number
  setActiveIndex: (index: number) => void
  close: () => void
  update: (element: HTMLTextAreaElement, composing?: boolean) => void
  choose: (path: string) => Promise<void>
  selectWorkspace: () => Promise<void>
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean
  adding: boolean
  hasWorkspace: boolean
}

export function useFileMentions({
  value,
  onChange,
  textarea,
  references,
  disabled,
  maxLength
}: {
  value: string
  onChange: (value: string) => void
  textarea: RefObject<HTMLTextAreaElement | null>
  references?: FileReferenceController
  disabled: boolean
  maxLength: number
}): FileMentionsController {
  const [mention, setMention] = useState<Mention | null>(null)
  const [dismissed, setDismissed] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const [searchState, setSearchState] = useState<SearchState>({
    key: '',
    paths: [],
    loading: false,
    error: null
  })
  const [adding, setAdding] = useState(false)
  const [workspaceRestore, setWorkspaceRestore] = useState<{ value: string; caret: number } | null>(
    null
  )
  const addingRef = useRef(false)
  const latest = useRef({ value, references, onChange })
  const mounted = useRef(true)
  useLayoutEffect(() => {
    latest.current = { value, references, onChange }
  }, [value, references, onChange])
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const contextKey = references?.contextKey ?? ''
  const query = mention?.query
  const key = mention ? JSON.stringify([mention.contextKey, mention.start, mention.query]) : ''
  const open = Boolean(
    references &&
    mention &&
    mention.contextKey === contextKey &&
    mention.value === value &&
    key !== dismissed &&
    !disabled &&
    !adding
  )
  const paths = searchState.key === key ? searchState.paths : []
  const loading = Boolean(
    open && references?.hasWorkspace && (searchState.key !== key || searchState.loading)
  )
  const error = searchState.key === key ? searchState.error : null
  const close = useCallback(() => setDismissed(key), [key])

  function update(element: HTMLTextAreaElement, composing = false): void {
    if (composing || !references || element.selectionStart !== element.selectionEnd) {
      setMention(null)
      return
    }
    const before = element.value.slice(0, element.selectionStart)
    const match = /(?:^|[\s(（])@([^\s@"`<>]*)$/u.exec(before)
    if (!match) {
      setMention(null)
      return
    }
    const start = before.length - match[1].length - 1
    const suffix = /^[^\s@"`<>]*/u.exec(element.value.slice(element.selectionStart))?.[0] ?? ''
    const next = {
      start,
      end: element.selectionStart + suffix.length,
      query: match[1],
      value: element.value,
      contextKey
    }
    if (
      !mention ||
      mention.start !== next.start ||
      mention.end !== next.end ||
      mention.query !== next.query ||
      mention.value !== next.value ||
      mention.contextKey !== next.contextKey
    ) {
      setMention(next)
      setDismissed('')
      setActiveIndex(0)
    }
  }

  useEffect(() => {
    if (!open || !references?.hasWorkspace || query === undefined) return
    let current = true
    const timer = window.setTimeout(() => {
      setSearchState({ key, paths: [], loading: true, error: null })
      void latest.current.references?.search(query).then(
        (result) => {
          if (!current) return
          setSearchState({
            key,
            paths: result.status === 'ready' ? result.files.map((file) => file.path) : [],
            loading: false,
            error: result.status === 'error' ? result.error : null
          })
          setActiveIndex(0)
        },
        () => {
          if (current)
            setSearchState({
              key,
              paths: [],
              loading: false,
              error: '文件列表读取失败，请重新输入。'
            })
        }
      )
    }, 120)
    return () => {
      current = false
      window.clearTimeout(timer)
    }
  }, [open, key, references?.hasWorkspace, query])

  async function choose(path: string): Promise<void> {
    if (!mention || !open || !references || addingRef.current) return
    const selected = mention
    const token = path.includes(' ') ? `@"${path}"` : `@${path}`
    const next =
      selected.value.slice(0, selected.start) + token + ' ' + selected.value.slice(selected.end)
    if (next.length > maxLength) {
      setSearchState({
        key,
        paths,
        loading: false,
        error: '引用路径超出消息长度上限，请缩短消息。'
      })
      return
    }
    addingRef.current = true
    setAdding(true)
    try {
      const accepted = await references.add(path)
      const current = latest.current
      if (!mounted.current || current.references?.contextKey !== selected.contextKey) return
      if (accepted && current.value === selected.value) {
        current.onChange(next)
        setMention(null)
        requestAnimationFrame(() => {
          const element = textarea.current
          if (!element || latest.current.references?.contextKey !== selected.contextKey) return
          element.focus({ preventScroll: true })
          element.setSelectionRange(
            selected.start + token.length + 1,
            selected.start + token.length + 1
          )
        })
      }
    } finally {
      addingRef.current = false
      if (mounted.current) setAdding(false)
    }
  }

  async function selectWorkspace(): Promise<void> {
    const element = textarea.current
    if (!references || !element || addingRef.current) return
    const caret = element.selectionStart
    const originalValue = value
    addingRef.current = true
    setAdding(true)
    try {
      if (await references.selectWorkspace()) {
        if (mounted.current) setWorkspaceRestore({ value: originalValue, caret })
      }
    } finally {
      addingRef.current = false
      if (mounted.current) setAdding(false)
    }
  }

  useLayoutEffect(() => {
    if (!workspaceRestore || !references?.hasWorkspace || disabled || adding) return
    const frame = requestAnimationFrame(() => {
      const input = textarea.current
      if (input && latest.current.value === workspaceRestore.value) {
        input.focus({ preventScroll: true })
        input.setSelectionRange(workspaceRestore.caret, workspaceRestore.caret)
        const before = input.value.slice(0, workspaceRestore.caret)
        const match = /(?:^|[\s(（])@([^\s@"`<>]*)$/u.exec(before)
        if (match) {
          setMention({
            start: workspaceRestore.caret - match[1].length - 1,
            end: workspaceRestore.caret,
            query: match[1],
            value: input.value,
            contextKey: latest.current.references?.contextKey ?? ''
          })
          setDismissed('')
          setActiveIndex(0)
        }
      }
      setWorkspaceRestore(null)
    })
    return () => cancelAnimationFrame(frame)
  }, [workspaceRestore, references?.hasWorkspace, contextKey, disabled, adding, textarea])

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
    if (!open || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return false
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close()
      return true
    }
    if (event.key === 'Tab') {
      close()
      return false
    }
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (paths.length)
        setActiveIndex(
          (index) => (index + (event.key === 'ArrowDown' ? 1 : -1) + paths.length) % paths.length
        )
      return true
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      if (paths[activeIndex]) void choose(paths[activeIndex])
      else if (!references?.hasWorkspace) void selectWorkspace()
      return true
    }
    return false
  }

  return {
    open,
    paths,
    loading,
    error,
    activeIndex,
    setActiveIndex,
    close,
    update,
    choose,
    selectWorkspace,
    onKeyDown,
    adding,
    hasWorkspace: Boolean(references?.hasWorkspace)
  }
}
