import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ChatMessage } from '../../../../shared/conversation'
import type { ProtocolItem } from '../../../../shared/agent-history'
import { Icon } from '../../components/ui/Icon'
import type { FileViewOrigin, OpenFileReference, OpenFileView } from '../files/file-view-origin'
import { MarkdownContent } from './MarkdownContent'
import { ToolGroup } from './MessageToolGroup'
import { restoreCollapsedDetailsFocus } from './message-activity-focus'
import {
  activityBlocks,
  formatElapsed,
  resultLabels,
  toolIcon,
  toolLabels
} from './message-activity-model'

function ResponseRetryNotice({
  retry,
  delaySeconds,
  interrupted
}: {
  retry: number
  delaySeconds: number
  interrupted: boolean
}): React.JSX.Element {
  const [remaining, setRemaining] = useState(Math.ceil(delaySeconds))
  useEffect(() => {
    const deadline = performance.now() + delaySeconds * 1000
    const timer = window.setInterval(() => {
      const next = Math.max(0, Math.ceil((deadline - performance.now()) / 1000))
      setRemaining(next)
      if (next === 0) window.clearInterval(timer)
    }, 250)
    return () => window.clearInterval(timer)
  }, [delaySeconds])
  return (
    <div className="message-response-retry" role="status" aria-live="polite">
      <span>
        正在重试 {retry}/5 ·{' '}
        {remaining > 0 ? `等待 ${remaining} 秒` : `等待回复（间隔 ${delaySeconds} 秒）`}
      </span>
      {interrupted && <span>本次回复中断，正在重试</span>}
    </div>
  )
}

export function MessageActivity({
  messageId,
  entries,
  items = [],
  status = 'complete',
  answerStarted = false,
  fileOrigin,
  onOpenFile,
  onOpenMessageFile
}: {
  messageId: string
  entries: readonly string[]
  items?: readonly ProtocolItem[]
  status?: ChatMessage['status']
  answerStarted?: boolean
  fileOrigin?: FileViewOrigin
  onOpenFile?: OpenFileView
  onOpenMessageFile?: OpenFileReference
}): React.JSX.Element | null {
  const overview = useRef<HTMLDetailsElement>(null)
  const [runningElapsed, setRunningElapsed] = useState(0)
  const finalSeen = useRef(answerStarted || status === 'complete')
  const [expanded, setExpanded] = useState(!answerStarted && status !== 'complete')
  useEffect(() => {
    if (status !== 'pending') return
    const startedAt = performance.now()
    const timer = window.setInterval(() => {
      setRunningElapsed(Math.max(0, performance.now() - startedAt))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [status])
  useLayoutEffect(() => {
    if (!finalSeen.current && (answerStarted || status === 'complete')) {
      finalSeen.current = true
      restoreCollapsedDetailsFocus(overview.current)
      setExpanded(false)
    }
  }, [answerStarted, status])
  const blocks = activityBlocks(items)
  const timing = [...entries].reverse().find((line) => /^用时：\d+毫秒$/.test(line))
  const parsedElapsed = timing ? Number(timing.slice(3, -2)) : null
  const elapsed = Number.isSafeInteger(parsedElapsed) ? parsedElapsed : null
  const timingLabel =
    status === 'pending'
      ? `正在处理 · ${formatElapsed(runningElapsed, true)}`
      : elapsed !== null
        ? `用时 ${formatElapsed(elapsed)}`
        : '处理过程'
  const retryEntry =
    status === 'pending'
      ? [...entries]
          .reverse()
          .find((line) => /^正在重试 [1-5]\/5 · 等待 \d+(?:\.\d+)? 秒$/.test(line))
      : undefined
  const retry = retryEntry
    ? /^正在重试 ([1-5])\/5 · 等待 (\d+(?:\.\d+)?) 秒$/.exec(retryEntry)
    : null
  const retryNotice = retry ? (
    <ResponseRetryNotice
      key={retryEntry}
      retry={Number(retry[1])}
      delaySeconds={Number(retry[2])}
      interrupted={Boolean(answerStarted)}
    />
  ) : null
  if (blocks.length)
    return (
      <section className="message-tool-run" aria-label="本轮处理过程">
        {retryNotice}
        <details
          className="message-tool-overview"
          ref={overview}
          open={expanded}
          onToggle={(event) => {
            if (event.target !== event.currentTarget) return
            if (!event.currentTarget.open) restoreCollapsedDetailsFocus(event.currentTarget)
            setExpanded(event.currentTarget.open)
          }}
        >
          <summary className="message-tool-overview-summary">
            <span>{timingLabel}</span>
            <Icon name="chevron" size={12} />
          </summary>
          <div className="message-tool-timeline">
            {blocks.map((block) =>
              block.kind === 'commentary' ? (
                <div
                  className="message-tool-commentary"
                  key={`${messageId}-commentary-${block.id}`}
                >
                  <MarkdownContent content={block.text} onOpenFile={onOpenMessageFile} />
                </div>
              ) : (
                <ToolGroup
                  key={block.calls[0].id}
                  calls={block.calls}
                  status={status}
                  fileOrigin={fileOrigin}
                  onOpenFile={onOpenFile}
                />
              )
            )}
          </div>
        </details>
      </section>
    )
  // Legacy labels have no saved arguments/output; do not invent details.
  const legacy = entries.flatMap((line, index) => {
    const result = /^(?:工作区|本地)结果：([a-z_]+)：([a-z_]+)$/.exec(line)
    if (result) return [{ name: result[1], label: resultLabels[result[2]] ?? result[2], index }]
    const name = /^执行工具：([a-z_]+)(?:$|[；;])/.exec(line)?.[1]
    return name &&
      !['create_workspace_file', 'apply_workspace_patch', 'run_workspace_command'].includes(name)
      ? [{ name, label: toolLabels[name] ?? name, index }]
      : []
  })
  if (!legacy.length && status !== 'pending' && elapsed === null) return null
  return (
    <section className="message-tool-run" aria-label="本轮处理过程">
      {retryNotice}
      {(status === 'pending' || elapsed !== null) && (
        <div className="message-tool-overview-summary message-response-timing">{timingLabel}</div>
      )}
      {legacy.length > 0 && (
        <ul className="message-tool-activity" aria-label="工具活动">
          {legacy.map((item) => (
            <li key={`${messageId}-legacy-${item.index}`}>
              <Icon name={toolIcon(item.name)} size={14} />
              <span>{item.label}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
