import { useEffect, useRef, useState } from 'react'
import type { ChatMessage } from '../../../../shared/conversation'
import { MessageIcon } from './MessageIcon'

export function MessageCopyButton({
  message,
  onCopy
}: {
  message: ChatMessage
  onCopy: (message: ChatMessage) => Promise<boolean> | boolean
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const [copying, setCopying] = useState(false)
  const copyPending = useRef(false)
  const mounted = useRef(true)
  const request = useRef(0)
  const resetTimer = useRef<number | null>(null)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      request.current += 1
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current)
    }
  }, [])

  function copy(): void {
    if (copyPending.current || copied) return
    copyPending.current = true
    setCopying(true)
    const currentRequest = ++request.current
    void Promise.resolve()
      .then(() => onCopy(message))
      .then(
        (accepted) => {
          if (!accepted || !mounted.current || currentRequest !== request.current) return
          if (resetTimer.current !== null) window.clearTimeout(resetTimer.current)
          setCopied(true)
          resetTimer.current = window.setTimeout(() => {
            resetTimer.current = null
            setCopied(false)
          }, 2000)
        },
        () => undefined
      )
      .finally(() => {
        copyPending.current = false
        if (mounted.current && currentRequest === request.current) setCopying(false)
      })
  }

  const label = copied ? '已复制' : '复制消息'
  return (
    <button
      type="button"
      className="message-action message-copy-action"
      onClick={copied || copying ? undefined : copy}
      title={label}
      aria-label={label}
      data-copied={copied}
      aria-busy={copying}
      aria-disabled={copying || copied}
    >
      <MessageIcon name={copied ? 'copied' : 'copy'} />
    </button>
  )
}
