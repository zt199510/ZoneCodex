import { useEffect, useRef, type RefObject } from 'react'
import { commandTemplate, type MessageCommandProposal } from '../../../../shared/command-proposal'
import { useCommandPreparation } from './useCommandPreparation'

export function CommandReviewPanel({
  proposal,
  onClose,
  returnFocusRef
}: {
  proposal: MessageCommandProposal
  onClose: () => void
  returnFocusRef: RefObject<HTMLButtonElement | null>
}): React.JSX.Element {
  const preparation = useCommandPreparation(proposal)
  const closeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const trigger = returnFocusRef.current
    closeRef.current?.focus()
    const escape = (event: KeyboardEvent): void => {
      if (
        event.key === 'Escape' &&
        !!closeRef.current?.getClientRects().length &&
        !event.defaultPrevented &&
        !document.activeElement?.closest('.file-view-panel')
      ) {
        event.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('keydown', escape)
      requestAnimationFrame(() => {
        if (trigger?.isConnected && !trigger.disabled) trigger.focus()
        else document.getElementById('chat-input')?.focus()
      })
    }
  }, [onClose, returnFocusRef])
  return (
    <section className="command-review-panel" aria-label="命令提案审查">
      <h2>命令提案审查</h2>
      <div className="command-review-body" tabIndex={0}>
        <p>
          逻辑程序：<code>{commandTemplate.program}</code>
        </p>
        <p>
          参数：
          {commandTemplate.args.map((arg, index) => (
            <code key={arg}>
              {' '}
              {index + 1}. {arg}{' '}
            </code>
          ))}
        </p>
        <p>建议说明（模型提供）：{proposal.reason}</p>
        {preparation.state.status === 'unbound' && <p>工作目录：尚未选择并授权命令工作目录</p>}
        {preparation.state.status === 'reading' && <p>正在读取目录配置…</p>}
        {preparation.state.result && (
          <>
            <p>
              工作目录：<code>{preparation.state.result.directory}</code>
            </p>
            <p>
              pretypecheck：<code>{preparation.state.result.scripts.pretypecheck ?? '未配置'}</code>
            </p>
            <p>
              typecheck：<code>{preparation.state.result.scripts.typecheck}</code>
            </p>
            <p>
              posttypecheck：
              <code>{preparation.state.result.scripts.posttypecheck ?? '未配置'}</code>
            </p>
            <p>
              根目录 .npmrc：
              {preparation.state.result.npmrc === 'present' ? '存在（内容未展示）' : '不存在'}
            </p>
          </>
        )}
        {(preparation.state.status === 'error' ||
          preparation.state.status === 'conflict' ||
          preparation.state.status === 'cancelled' ||
          preparation.state.status === 'timed_out') && (
          <p role="alert">{preparation.state.error}</p>
        )}
        <p>可能影响：{commandTemplate.impact}</p>
        {preparation.state.status === 'ready' && (
          <p>
            <strong>
              准备完成。确认后只执行一次固定的 npm run typecheck；准备记录不会自动获得新的执行许可。
            </strong>
          </p>
        )}
        {['executing', 'finished', 'cancelled', 'timed_out'].includes(preparation.state.status) && (
          <pre aria-label="命令输出">{preparation.state.output || '暂无输出'}</pre>
        )}
        {preparation.state.status === 'executing' && <p>正在执行，输出达到上限后会截断。</p>}
        {preparation.state.status === 'finished' && (
          <p role="status">执行结束，退出码：{preparation.state.exitCode}</p>
        )}
        {preparation.state.status === 'unbound' || preparation.state.status === 'selected' ? (
          <p>尚未执行；本课仅审查，未取得执行授权。</p>
        ) : null}
      </div>
      {(preparation.state.status === 'unbound' ||
        preparation.state.status === 'conflict' ||
        preparation.state.status === 'error') && (
        <button type="button" onClick={() => void preparation.select()}>
          选择命令工作目录
        </button>
      )}
      {preparation.state.status === 'selected' && (
        <button type="button" onClick={() => void preparation.prepare()}>
          检查执行准备
        </button>
      )}
      {preparation.state.status === 'ready' && (
        <button type="button" onClick={() => void preparation.execute()}>
          确认执行一次
        </button>
      )}
      {preparation.state.status === 'executing' && (
        <button type="button" onClick={() => void preparation.cancel()}>
          取消执行
        </button>
      )}
      <button ref={closeRef} type="button" onClick={onClose}>
        关闭审查
      </button>
    </section>
  )
}
