import { useState } from 'react'
import type { ConversationController } from '../conversation/useConversation'
import type { OpenFileView } from '../files/file-view-origin'
import type { ThreadSummaryController } from './useThreadSummaryPanel'
import type { ThreadSummarySource } from './thread-summary-sources'
import { MessageIcon } from './MessageIcon'
import { ThreadSummaryIcon } from './ThreadSummaryIcon'

export function ThreadSummaryPanel({
  conversation,
  summary: { panelRef, visible, mode },
  sources,
  onOpenFile,
  onShowAll
}: {
  conversation: ConversationController
  summary: ThreadSummaryController
  sources: ThreadSummarySource[]
  onOpenFile: OpenFileView
  onShowAll: (trigger: HTMLButtonElement) => void
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(() => {
    try {
      return localStorage.getItem('zonecodex.summary.sources-expanded') !== 'false'
    } catch {
      return true
    }
  })
  const toggleSection = (): void => {
    setExpanded((previous) => {
      const next = !previous
      try {
        localStorage.setItem('zonecodex.summary.sources-expanded', String(next))
      } catch {
        // Expansion can remain a session preference.
      }
      return next
    })
  }
  return (
    <aside
      id="thread-summary-panel"
      ref={panelRef}
      className="thread-summary-panel"
      aria-label="会话摘要"
      hidden={!visible}
      inert={!visible}
      data-display-mode={mode}
    >
      <div className="thread-summary-scroll">
        <section className="thread-summary-section">
          <header className="thread-summary-section-header">
            <button
              type="button"
              className="thread-summary-section-toggle"
              aria-expanded={expanded}
              aria-controls="thread-summary-sources"
              onClick={toggleSection}
            >
              <span>来源</span>
              {!expanded && sources.length > 0 && (
                <span className="thread-summary-count">· {sources.length}</span>
              )}
              <MessageIcon name="chevron" size={14} />
            </button>
            {sources.length > 0 && (
              <button
                type="button"
                className="thread-summary-section-action"
                aria-label="添加文件"
                title="添加文件"
                disabled={!conversation.canEdit || conversation.operation !== 'idle'}
                onClick={() => void conversation.selectProjectFiles()}
              >
                <ThreadSummaryIcon name="plus" size={18} />
              </button>
            )}
          </header>
          <div
            className="thread-summary-section-content"
            id="thread-summary-sources"
            hidden={!expanded}
          >
            {sources.length > 0 ? (
              <>
                <div className="thread-summary-source-list" role="list" aria-label="来源">
                  {sources.slice(0, 3).map((source) => (
                    <div key={source.key} role="listitem">
                      <button
                        type="button"
                        className="thread-summary-row"
                        title={source.reference.path}
                        onClick={(event) =>
                          onOpenFile(source.reference, source.origin, event.currentTarget)
                        }
                      >
                        <span className="thread-summary-leading">
                          <ThreadSummaryIcon name="file" size={18} />
                        </span>
                        <span className="thread-summary-label">
                          {source.reference.path.split(/[\\/]/).filter(Boolean).at(-1) ??
                            source.reference.path}
                        </span>
                      </button>
                    </div>
                  ))}
                </div>
                <button
                  type="button"
                  className="thread-summary-row thread-summary-view-all"
                  onClick={(event) => onShowAll(event.currentTarget)}
                >
                  <span className="thread-summary-leading">
                    <ThreadSummaryIcon name="viewAll" size={18} />
                  </span>
                  <span className="thread-summary-label">查看全部</span>
                </button>
              </>
            ) : (
              <button
                type="button"
                className="thread-summary-row"
                disabled={!conversation.canEdit || conversation.operation !== 'idle'}
                onClick={() => void conversation.selectProjectFiles()}
              >
                <span className="thread-summary-leading">
                  <ThreadSummaryIcon name="plus" size={18} />
                </span>
                <span className="thread-summary-label">添加文件</span>
              </button>
            )}
          </div>
        </section>
      </div>
    </aside>
  )
}
