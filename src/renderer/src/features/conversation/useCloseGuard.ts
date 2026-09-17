import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ConversationController } from './useConversation'

/**
 * useCloseGuard 是一个自定义 Hook，用于处理关闭窗口时的逻辑。
 * 它会监听关闭请求，并根据当前会话的状态决定是否允许关闭窗口。
 **/
export function useCloseGuard(conversation: ConversationController): {
  open: boolean
  busy: boolean
  message: string | null
  choose: (allow: boolean) => void
  saveAndClose: () => Promise<void>
} {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const latest = useRef(conversation)
  const pendingId = useRef<string | null>(null)
  const busyRef = useRef(false)
  const mounted = useRef(false)
  const { setClosePending } = conversation

  // 订阅只建立一次；回调读取最近一次提交的会话，而不是最初的空数组。
  useLayoutEffect(() => {
    latest.current = conversation
  }, [conversation])

  const finish = useCallback(
    async (id: string, allow: boolean): Promise<void> => {
      try {
        const accepted = await window.api.finishClose(id, allow)
        if (mounted.current && !accepted) setMessage('关闭请求已失效，请再次点击关闭。')
      } catch {
        if (mounted.current) setMessage('关闭通信未完成，请再次点击关闭。')
      } finally {
        if (mounted.current && pendingId.current === id) {
          pendingId.current = null
          busyRef.current = false
          setBusy(false)
          setOpen(false)
          setClosePending(false)
        }
      }
    },
    [setClosePending]
  )

  useEffect(() => {
    mounted.current = true
    const unsubscribe = window.api.onCloseRequested((id) => {
      if (pendingId.current) return
      pendingId.current = id
      setClosePending(true)
      const current = latest.current
      const operation = current.getOperation()
      if (operation !== 'idle') {
        setMessage(
          operation === 'generating'
            ? '正在生成，请先停止或等待回复结束，再关闭窗口。'
            : operation === 'selecting'
              ? '正在选择项目文件，请完成或取消选择后再关闭。'
              : '正在读取或保存，请等待完成后再次关闭。'
        )
        busyRef.current = true
        void finish(id, false)
      } else if (current.storage.ready && !current.storage.dirty) {
        setMessage(null)
        busyRef.current = true
        void finish(id, true)
      } else {
        setMessage(
          current.storage.ready
            ? '有未保存的聊天修改，你希望如何关闭？'
            : '本地记录读取失败。关闭不会改写原文件，当前不能保存。'
        )
        setOpen(true)
      }
    })
    return () => {
      mounted.current = false
      unsubscribe()
      const id = pendingId.current
      pendingId.current = null
      if (id) {
        setClosePending(false)
        void window.api.finishClose(id, false).catch(() => undefined)
      }
    }
  }, [finish, setClosePending])

  function choose(allow: boolean): void {
    const id = pendingId.current
    if (!id || busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setMessage(null)
    void finish(id, allow)
  }

  async function saveAndClose(): Promise<void> {
    const id = pendingId.current
    if (!id || busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setMessage('正在保存，请稍候…')
    const saved = await latest.current.storage.save('close')
    if (!mounted.current || pendingId.current !== id) return
    if (!saved) {
      busyRef.current = false
      setBusy(false)
      setMessage('保存未成功，窗口保持打开。可以重试或继续编辑。')
      return
    }
    await finish(id, true)
  }

  return { open, busy, message, choose, saveAndClose }
}
