import type { CommitController } from './useChangeCommit'

export function CommitReceipt({ commit }: { commit: CommitController }): React.JSX.Element | null {
  if (!commit.receipt) return null
  return (
    <section className="commit-receipt" role="status">
      <p>{commit.receipt.message}</p>
      {commit.receipt.recovery && (
        <p>
          备份：{commit.receipt.recovery.name}{' '}
          <button type="button" className="quiet-button" onClick={() => void commit.reveal()}>
            定位备份
          </button>
        </p>
      )}
      {commit.receipt.cleanupWarning && <p>请检查同目录中的备份与临时文件；未执行自动回滚。</p>}
      {commit.notice && <p>{commit.notice}</p>}
      <button type="button" className="quiet-button" onClick={commit.dismiss}>
        关闭结果
      </button>
    </section>
  )
}
