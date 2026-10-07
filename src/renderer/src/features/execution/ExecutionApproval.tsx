import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { ExecutionApproval as ApprovalRequest } from '../../../../shared/execution'
import { useAnchoredPosition } from '../../components/ui/useAnchoredPosition'
import type {
  AnchorMeasurement,
  AnchorPositionStyle
} from '../../components/ui/useAnchoredPosition'

function approvalPanelStyle({
  rect,
  viewportWidth,
  viewportHeight
}: AnchorMeasurement): AnchorPositionStyle {
  const width = Math.min(rect.width, viewportWidth - 24)
  const bottom = Math.min(viewportHeight - rect.top + 8, Math.max(12, viewportHeight - 172))
  return {
    width: `${width}px`,
    left: `${Math.max(12, Math.min(rect.left, viewportWidth - width - 12))}px`,
    bottom: `${Math.max(12, bottom)}px`,
    maxHeight: `${Math.max(160, Math.min(560, viewportHeight - bottom - 12))}px`
  }
}

const approvalTitles = {
  create: '允许新建此文件吗？',
  edit: '允许修改此文件吗？',
  command: '允许运行此命令吗？'
} as const

function formatCommand(program: string, args: string[]): string {
  // Display Windows argv quoting; this text is never passed to a shell.
  return [program, ...args]
    .map((argument) =>
      argument && !/[\s"]/u.test(argument)
        ? argument
        : `"${argument.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`
    )
    .join(' ')
}

export function ExecutionApproval({
  anchorRef,
  onPendingChange
}: {
  anchorRef: RefObject<HTMLDivElement | null>
  onPendingChange: (pending: boolean) => void
}): React.JSX.Element {
  const titleId = useId()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const pendingRef = useRef<ApprovalRequest | null>(null)
  const mountedRef = useRef(false)
  const updateVersion = useRef(0)
  const responseVersion = useRef(0)
  const submittingRef = useRef<string | null>(null)
  const closedIds = useRef(new Set<string>())
  const [pending, setPending] = useState<ApprovalRequest | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loadError, setLoadError] = useState(false)

  const rememberClosed = useCallback((id: string): void => {
    closedIds.current.add(id)
    if (closedIds.current.size > 100) {
      const oldest = closedIds.current.values().next().value
      if (oldest) closedIds.current.delete(oldest)
    }
  }, [])

  const applyPending = useCallback(
    (next: ApprovalRequest | null): void => {
      updateVersion.current += 1
      if (next && closedIds.current.has(next.approvalId)) return
      const previous = pendingRef.current
      if (previous?.approvalId === next?.approvalId) return
      if (previous) rememberClosed(previous.approvalId)
      pendingRef.current = next
      responseVersion.current += 1
      submittingRef.current = null
      setPending(next)
      setSubmitting(false)
      setError(null)
      setLoadError(false)
      onPendingChange(next !== null)
    },
    [onPendingChange, rememberClosed]
  )

  const readPending = useCallback(async (): Promise<void> => {
    const version = updateVersion.current
    try {
      const next = await window.api.getPendingExecutionApproval()
      if (!mountedRef.current || updateVersion.current !== version) return
      setLoadError(false)
      applyPending(next)
    } catch {
      if (mountedRef.current && updateVersion.current === version) setLoadError(true)
    }
  }, [applyPending])

  useEffect(() => {
    mountedRef.current = true
    const subscriptionVersion = updateVersion.current
    // Subscribe first so a pending/clear event wins over a late initial read.
    const off = window.api.onExecutionApprovalChange((next) => {
      if (mountedRef.current) applyPending(next)
    })
    queueMicrotask(() => {
      if (mountedRef.current && updateVersion.current === subscriptionVersion) void readPending()
    })
    return () => {
      mountedRef.current = false
      updateVersion.current += 1
      responseVersion.current += 1
      off()
    }
  }, [applyPending, readPending])

  const respond = useCallback(
    async (approvalId: string, approved: boolean): Promise<void> => {
      const approval = pendingRef.current
      if (!approval || approval.approvalId !== approvalId || submittingRef.current) return
      const id = approval.approvalId
      const version = ++responseVersion.current
      submittingRef.current = id
      setSubmitting(true)
      setError(null)
      const current = (): boolean =>
        mountedRef.current &&
        responseVersion.current === version &&
        pendingRef.current?.approvalId === id
      try {
        const accepted = await window.api.respondToExecutionApproval(id, approved)
        if (!current()) return
        if (accepted) {
          applyPending(null)
        } else {
          setError('这个请求已失效，正在读取当前确认请求。')
          await readPending()
        }
      } catch {
        if (current()) setError('提交失败，请重试。')
      } finally {
        if (current()) {
          submittingRef.current = null
          setSubmitting(false)
        }
      }
    },
    [applyPending, readPending]
  )

  const getAnchor = useCallback(
    () => anchorRef.current?.querySelector<HTMLElement>('.composer') ?? null,
    [anchorRef]
  )
  const position = useAnchoredPosition({
    active: pending !== null,
    panelRef: dialogRef,
    getAnchor,
    getStyle: approvalPanelStyle
  })

  useLayoutEffect(() => {
    const panel = dialogRef.current
    if (!panel) return
    if (!pending) {
      if (panel.open) panel.close()
      return
    }
    document.querySelectorAll<HTMLElement>('[popover]:popover-open').forEach((popover) => {
      popover.hidePopover()
    })
    position()
    if (!panel.open) panel.showModal()
    cancelRef.current?.focus({ preventScroll: true })
  }, [pending, position])

  return (
    <>
      {loadError && !pending && (
        <p className="execution-approval-feedback" role="alert">
          读取确认请求失败。
          <button type="button" className="quiet-button" onClick={() => void readPending()}>
            重试
          </button>
        </p>
      )}
      <dialog
        ref={dialogRef}
        className="execution-approval"
        aria-labelledby={titleId}
        onCancel={(event) => {
          event.preventDefault()
          if (pending) void respond(pending.approvalId, false)
        }}
      >
        {pending && (
          <>
            <header className="execution-approval-header">
              <h2 id={titleId}>{approvalTitles[pending.kind]}</h2>
            </header>
            <div className="execution-approval-body" tabIndex={0}>
              <dl className="execution-approval-details">
                <dt>原因</dt>
                <dd>
                  {pending.kind === 'command'
                    ? (pending.reason ?? '当前权限下，运行此命令需要你的批准。')
                    : '目标文件位于当前允许写入的目录之外，需要你的批准。'}
                </dd>
                {pending.kind === 'command' ? (
                  <>
                    <dt>工作目录</dt>
                    <dd>{pending.cwd}</dd>
                  </>
                ) : (
                  <>
                    <dt>{pending.kind === 'create' ? '新建文件' : '修改文件'}</dt>
                    <dd>{pending.path}</dd>
                  </>
                )}
              </dl>
              {pending.kind === 'command' && (
                <section>
                  <h3>命令</h3>
                  <pre>{formatCommand(pending.program, pending.args)}</pre>
                  <p>此程序可能访问其他文件、网络或启动子进程。</p>
                </section>
              )}
            </div>
            <footer className="execution-approval-footer">
              {(error || loadError) && (
                <p className="execution-approval-error" role="alert">
                  {error ?? '读取确认请求失败，请重试。'}
                </p>
              )}
              <div className="execution-approval-actions">
                <button
                  ref={cancelRef}
                  type="button"
                  className="execution-approval-cancel"
                  disabled={submitting}
                  onClick={(event) => {
                    if (event.detail <= 1) void respond(pending.approvalId, false)
                  }}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="execution-approval-confirm"
                  disabled={submitting}
                  onClick={(event) => {
                    if (event.detail <= 1) void respond(pending.approvalId, true)
                  }}
                >
                  确认
                </button>
              </div>
            </footer>
          </>
        )}
      </dialog>
    </>
  )
}
