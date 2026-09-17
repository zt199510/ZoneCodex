import { useCallback, useEffect, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { ConversationLibrary } from '../../../../shared/conversation-library'
import type { OperationControl } from './useOperation'

//定义了一个类型 StorageOptions，包含了会话快照、设置快照的函数、操作控制、关闭状态和检查关闭状态的函数。
type StorageOptions = {
  snapshot: ConversationLibrary
  setSnapshot: Dispatch<SetStateAction<ConversationLibrary>>
  operations: OperationControl
  closePending: boolean
  isClosePending: () => boolean

}

//创建了一个类型 ConversationStorage，表示会话存储的状态和操作，包括是否准备好、是否有未保存的修改、是否暂停、错误信息、状态描述和保存函数。
export type ConversationStorage = {
  ready: boolean
  dirty: boolean
  paused: boolean
  error: string | null
  status: string
  save: (reason?: 'normal' | 'close') => Promise<boolean>
}
//创建了一个自定义 Hook 函数 useConversationStorage，接收 StorageOptions 作为参数，返回 ConversationStorage。
export function useConversationStorage({
  snapshot,
  setSnapshot,
  operations,
  closePending,
  isClosePending
}: StorageOptions): ConversationStorage {
  const { operation, begin, finish } = operations
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedSignature, setSavedSignature] = useState<string | null>(null)
  const [paused, setPaused] = useState(false)
  const [hasFile, setHasFile] = useState(false)
  const mounted = useRef(false)
  const signature = JSON.stringify(snapshot)
  const dirty = ready && signature !== savedSignature

  useEffect(() => {
    mounted.current = true
    let disposed = false
    async function load(): Promise<void> {
      try {
        const result = await window.api.loadConversation()
        if (disposed) return
        if (!result.ok) {
          setError(result.error)
          return
        }
        setSnapshot(result.snapshot)
        // 缺失文件也以读取结果作为基线，启动本身不会触发写入。
        setSavedSignature(JSON.stringify(result.snapshot))
        setHasFile(!result.missing)
        setReady(true)
      } catch {
        if (!disposed) setError('无法读取本地记录，请重启应用后重试。原文件未修改。')
      } finally {
        if (!disposed) finish('loading')
      }
    }
    void load()
    return () => {
      disposed = true
      mounted.current = false
    }
  }, [setSnapshot, finish])

  const save = useCallback(async (reason: 'normal' | 'close' = 'normal'): Promise<boolean> => {
    if (!mounted.current || !ready ||
      (reason === 'normal' && isClosePending()) || !begin('saving')) return false
    setError(null)
    const submittedSignature = JSON.stringify(snapshot)
    try {
      const result = await window.api.saveConversation(snapshot)
      if (!mounted.current) return false
      if (!result.ok) {
        setError(result.error)
        setPaused(true)
        return false
      }
      setSavedSignature(submittedSignature)
      setHasFile(true)
      setPaused(false)
      return true
    } catch {
      if (mounted.current) {
        setError('保存结果未确认，请重试保存。')
        setPaused(true)
      }
      return false
    } finally {
      if (mounted.current) finish('saving')
    }
  }, [ready, snapshot, begin, finish, isClosePending])


  useEffect(() => {
    if (!ready || !dirty || operation !== 'idle' || paused || closePending) return
    const timer = window.setTimeout(() => {
      void save()
    }, 10000)
    return () => {
      window.clearTimeout(timer)
    }
  }, [ready, dirty, signature, operation, paused, closePending, save])


  const status = !ready
    ? error
      ? '读取失败'
      : '正在读取'
    : operation === 'saving'
      ? '正在保存'
      : paused
        ? '保存已暂停'
        : dirty
          ? '有未保存修改'
          : hasFile
            ? '已同步到本地'
            : '尚未保存'

  return { ready, dirty, paused, error, status, save }
}
