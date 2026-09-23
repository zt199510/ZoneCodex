import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CommitRequest, CommitResult } from '../../../../shared/change-commit'
import type { PreparationResult } from '../../../../shared/change-preparation'
import type { OperationControl } from '../conversation/useOperation'

type Ready = Extract<PreparationResult, { status: 'ready' }>
export type CommitController = {
  busy: boolean
  receipt: CommitResult | null
  notice: string | null
  confirm: () => Promise<void>
  requestCancel: () => void
  isActive: () => boolean
  dismiss: () => void
  reveal: () => Promise<void>
}
export function useChangeCommit(
  conversationId: string | null,
  ready: Ready | null,
  operations: OperationControl,
  canChange: () => boolean,
  settled: (snapshotId: string, clearGrant: boolean) => void
): CommitController {
  const [busy, setBusy] = useState(false)
  const [receipt, setReceipt] = useState<CommitResult | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const active = useRef<CommitRequest | null>(null)
  const mounted = useRef(false)
  const context = useRef({ conversationId, ready, settled })
  useLayoutEffect(() => {
    context.current = { conversationId, ready, settled }
  })
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      const task = active.current
      if (task) void window.api.cancelCommit(task.commitId).catch(() => undefined)
    }
  }, [])
  const requestCancel = useCallback(() => {
    const task = active.current
    if (!task) return
    setNotice('正在请求取消，请等待提交结果')
    void window.api
      .cancelCommit(task.commitId)
      .then((accepted) => {
        if (mounted.current && active.current === task && !accepted)
          setNotice('已进入提交收尾阶段，请等待实际结果')
      })
      .catch(() => {
        if (mounted.current && active.current === task)
          setNotice('未收到取消回执，请等待并检查文件')
      })
  }, [])
  async function confirm(): Promise<void> {
    const current = context.current.ready
    if (
      active.current ||
      !current ||
      current.conversationId !== context.current.conversationId ||
      current.expiresAt <= Date.now() ||
      !canChange() ||
      !operations.begin('committing')
    )
      return
    const task: CommitRequest = {
      conversationId: current.conversationId,
      snapshotId: current.snapshotId,
      preparationId: current.preparationId,
      checkId: current.checkId,
      commitId: crypto.randomUUID()
    }
    active.current = task
    setBusy(true)
    setReceipt(null)
    setNotice(null)
    const owns = (): boolean =>
      mounted.current &&
      active.current === task &&
      context.current.conversationId === task.conversationId
    try {
      const result = await window.api.commitChange(task)
      if (owns()) {
        setReceipt(result)
        context.current.settled(task.snapshotId, result.claimed)
      }
    } catch {
      if (owns()) {
        // The request might have failed before claim. Revoke that grant if it still exists;
        // a busy main-process commit retains occupancy and revokes it in its own finally.
        await window.api.revokeProjectFiles(task.snapshotId).catch(() => false)
        if (!owns()) return
        setReceipt({
          ...task,
          status: 'uncertain',
          claimed: true,
          recovery: null,
          cleanupWarning: true,
          message: '未收到提交结果，请检查文件及同目录备份，不要直接重试'
        })
        context.current.settled(task.snapshotId, true)
      }
    } finally {
      if (active.current === task) {
        active.current = null
        operations.finish('committing')
        if (mounted.current) {
          setBusy(false)
          setNotice(null)
        }
      }
    }
  }
  async function reveal(): Promise<void> {
    const id = receipt?.recovery?.id
    if (!id || receipt?.conversationId !== context.current.conversationId) return
    try {
      if (!(await window.api.revealBackup(id))) throw new Error()
    } catch {
      if (mounted.current && receipt?.conversationId === context.current.conversationId)
        setNotice('备份定位不可用，请在原文件同目录按备份名查找')
    }
  }
  return {
    busy,
    receipt: receipt?.conversationId === conversationId ? receipt : null,
    notice,
    confirm,
    requestCancel,
    isActive: () => active.current !== null,
    dismiss: () => {
      if (!active.current) {
        setReceipt(null)
        setNotice(null)
      }
    },
    reveal
  }
}
