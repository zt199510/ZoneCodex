import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  GitActionData,
  GitActionRequest,
  GitDiffData,
  GitFullFileData,
  GitGeneratedText,
  GitGenerateRequest,
  GitMetadata,
  GitReviewData,
  GitReviewFile,
  GitReviewSource,
  GitWorkbenchRequest,
  GitWorkbenchResult
} from '../../../../shared/git-workbench'
import { sameGitWorkbenchRequest } from '../../../../shared/git-workbench'
import type { GitViewState } from './useGitView'

type Payload<T> = T extends unknown ? Omit<T, keyof GitWorkbenchRequest | 'revision'> : never
export type GitActionInput = Payload<GitActionRequest>
export type GitWorkbenchState = {
  metadata: GitMetadata | null
  review: GitReviewData | null
  detail: GitDiffData | null
  detailRevision: string | null
  fullFiles: { base: GitFullFileData; current: GitFullFileData } | null
  selectedItemId: string | null
  source: GitReviewSource
  baseRefId: string
  commitId: string
  hideWhitespace: boolean
  busy: 'metadata' | 'review' | 'diff' | 'file' | 'action' | 'generation' | null
  notice: string
  noticeStatus: string
  actionResult: GitActionData | null
  refreshPending: boolean
  watchStatus: 'watching' | 'limited' | 'error' | null
  watchMessage: string
}
const initialState = (): GitWorkbenchState => ({
  metadata: null,
  review: null,
  detail: null,
  detailRevision: null,
  fullFiles: null,
  selectedItemId: null,
  source: 'uncommitted',
  baseRefId: '',
  commitId: '',
  hideWhitespace: false,
  busy: null,
  notice: '',
  noticeStatus: '',
  actionResult: null,
  refreshPending: false,
  watchStatus: null,
  watchMessage: ''
})

type Requester = (
  phase: NonNullable<GitWorkbenchState['busy']>,
  run: (request: GitWorkbenchRequest) => Promise<GitWorkbenchResult<unknown>>,
  token: number,
  viewId: string
) => Promise<unknown | null>

async function requestData<T>(
  request: Requester,
  phase: NonNullable<GitWorkbenchState['busy']>,
  run: (identity: GitWorkbenchRequest) => Promise<GitWorkbenchResult<T>>,
  token: number,
  viewId: string
): Promise<T | null> {
  return (await request(phase, run, token, viewId)) as T | null
}

/** Manual window-local Git state; no Agent, conversation, terminal, or persistence dependencies. */
export function useGitWorkbench(
  view: GitViewState,
  refreshPaused = false,
  active = true
): {
  state: GitWorkbenchState
  refresh: () => Promise<void>
  selectSource: (source: GitReviewSource) => Promise<void>
  selectBase: (refId: string) => Promise<void>
  selectCommit: (commitId: string) => Promise<void>
  setHideWhitespace: (enabled: boolean) => Promise<void>
  readFile: (file: GitReviewFile) => Promise<void>
  readFullFiles: (file: GitReviewFile) => Promise<void>
  execute: (action: GitActionInput, expectedRevision?: string) => Promise<boolean>
  generate: (
    options: Omit<GitGenerateRequest, keyof GitWorkbenchRequest | 'revision'>
  ) => Promise<GitGeneratedText | null>
  cancel: () => Promise<void>
  capability: (name: string) => { available: boolean; reason: string }
} {
  const [state, setState] = useState<GitWorkbenchState>(initialState)
  const mounted = useRef(false)
  const generation = useRef(0)
  const pending = useRef<string | null>(null)
  const retiring = useRef<Promise<boolean>>(Promise.resolve(true))
  const activeView = useRef<string | null>(null)
  const data = useRef<GitWorkbenchState>(initialState())
  const rememberedView = useRef<string | null>(null)
  const readyView =
    active && view.open && view.phase === 'ready' ? (view.view?.viewId ?? null) : null
  const invalidationSequence = useRef(0)
  const refreshPausedRef = useRef(refreshPaused)
  useEffect(() => {
    refreshPausedRef.current = refreshPaused
  }, [refreshPaused])

  const update = useCallback((changes: Partial<GitWorkbenchState>): void => {
    data.current = { ...data.current, ...changes }
    if (mounted.current) setState(data.current)
  }, [])
  const current = useCallback(
    (token: number, viewId: string): boolean =>
      mounted.current && generation.current === token && activeView.current === viewId,
    []
  )
  const cancelPrevious = useCallback(async (): Promise<boolean> => {
    const requestId = pending.current
    pending.current = null
    if (!requestId) return retiring.current
    const operation = retiring.current.then(async () => {
      try {
        const result = await window.api.cancelGitRead(requestId)
        if (result.status !== 'error') return true
        update({ busy: null, notice: result.error, noticeStatus: 'error' })
      } catch {
        update({ busy: null, notice: '上次 Git 操作尚未确认结束，请重试。', noticeStatus: 'error' })
      }
      pending.current = requestId
      return false
    })
    retiring.current = operation
    return operation
  }, [update])

  const request = useCallback(
    async (
      phase: NonNullable<GitWorkbenchState['busy']>,
      run: (identity: GitWorkbenchRequest) => Promise<GitWorkbenchResult<unknown>>,
      token: number,
      viewId: string
    ): Promise<unknown | null> => {
      if (!current(token, viewId)) return null
      const identity = { requestId: crypto.randomUUID(), viewId }
      pending.current = identity.requestId
      update({ busy: phase, notice: '', noticeStatus: '' })
      try {
        const result = await run(identity)
        if (!current(token, viewId)) return null
        if (pending.current === identity.requestId) pending.current = null
        if (!sameGitWorkbenchRequest(identity, result)) {
          update({ busy: null, notice: 'Git 返回身份已变化，请刷新。', noticeStatus: 'stale' })
          return null
        }
        if (result.status === 'ready') return result.data
        update({
          busy: null,
          notice: result.status === 'cancelled' ? '' : result.error,
          noticeStatus: result.status
        })
        return null
      } catch (error) {
        if (current(token, viewId)) {
          if (pending.current === identity.requestId) pending.current = null
          update({
            busy: null,
            notice:
              error instanceof Error ? error.message.slice(0, 500) : 'Git 操作未完成，请重试。',
            noticeStatus: 'error'
          })
        }
        return null
      }
    },
    [current, update]
  )

  const load = useCallback(
    async (includeMetadata: boolean): Promise<void> => {
      const viewId = activeView.current
      if (!viewId) return
      const token = ++generation.current
      const observedSequence = invalidationSequence.current
      update({ refreshPending: false })
      if (!(await cancelPrevious()) || !current(token, viewId)) return
      const selectedPath = data.current.review?.files.find(
        (file) => file.itemId === data.current.selectedItemId
      )?.path
      if (includeMetadata) {
        const previous = data.current
        const baseName = previous.metadata?.branches.find(
          (branch) => branch.refId === previous.baseRefId
        )?.name
        const commitSha = previous.metadata?.commits.find(
          (commit) => commit.commitId === previous.commitId
        )?.sha
        const metadata = await requestData(
          request,
          'metadata',
          window.api.getGitMetadata,
          token,
          viewId
        )
        if (!metadata || !current(token, viewId)) return
        const base =
          metadata.branches.find((branch) => branch.name === baseName) ??
          metadata.branches.find(
            (branch) => !branch.current && /^(main|master)$/.test(branch.name)
          ) ??
          metadata.branches.find((branch) => !branch.current) ??
          metadata.branches[0]
        const commit =
          metadata.commits.find((candidate) => candidate.sha === commitSha) ?? metadata.commits[0]
        update({ metadata, baseRefId: base?.refId ?? '', commitId: commit?.commitId ?? '' })
      }
      const options = data.current
      const review = await requestData(
        request,
        'review',
        (identity) =>
          window.api.reviewGitChanges({
            ...identity,
            source: options.source,
            hideWhitespace: options.hideWhitespace,
            ...(options.source === 'branch' && options.baseRefId
              ? { baseRefId: options.baseRefId }
              : {}),
            ...(options.source === 'commit' && options.commitId
              ? { commitId: options.commitId }
              : {})
          }),
        token,
        viewId
      )
      if (!review || !current(token, viewId)) return
      if (review.source !== options.source) {
        update({ busy: null, notice: '差异来源已变化，请重新选择。', noticeStatus: 'stale' })
        return
      }
      const selected = review.files.find((file) => file.path === selectedPath) ?? review.files[0]
      update({
        review,
        selectedItemId: selected?.itemId ?? null,
        ...(selected?.path === selectedPath ? {} : { detail: null, fullFiles: null }),
        busy: null,
        refreshPending: observedSequence !== invalidationSequence.current
      })
    },
    [cancelPrevious, current, request, update]
  )
  const readFile = useCallback(
    async (file: GitReviewFile): Promise<void> => {
      const viewId = activeView.current
      const review = data.current.review
      if (!viewId || !review?.files.some((candidate) => candidate.itemId === file.itemId)) return
      const token = ++generation.current
      const previousPath = data.current.review?.files.find(
        (candidate) => candidate.itemId === data.current.selectedItemId
      )?.path
      update({
        selectedItemId: file.itemId,
        ...(previousPath === file.path
          ? {}
          : { detail: null, detailRevision: null, fullFiles: null })
      })
      if (!(await cancelPrevious()) || !current(token, viewId)) return
      const detail = await requestData(
        request,
        'diff',
        (identity) =>
          window.api.readGitDiff({ ...identity, revision: review.revision, itemId: file.itemId }),
        token,
        viewId
      )
      if (!detail || !current(token, viewId)) return
      if (detail.itemId !== file.itemId) {
        update({ busy: null, notice: '所选文件身份已变化，请刷新。', noticeStatus: 'stale' })
        return
      }
      update({
        detail,
        detailRevision: `${review.revision}:${review.source}`,
        fullFiles: null,
        busy: null
      })
    },
    [cancelPrevious, current, request, update]
  )

  const readFullFiles = useCallback(
    async (file: GitReviewFile): Promise<void> => {
      const viewId = activeView.current
      const snapshot = data.current
      const review = snapshot.review
      if (
        !viewId ||
        !review ||
        snapshot.busy ||
        snapshot.selectedItemId !== file.itemId ||
        !review.files.some((candidate) => candidate.itemId === file.itemId)
      )
        return
      const token = ++generation.current
      if (!(await cancelPrevious()) || !current(token, viewId)) return
      const versions: Partial<{ base: GitFullFileData; current: GitFullFileData }> = {}
      // The main process owns one operation per document; each side must finish before the next.
      for (const side of ['base', 'current'] as const) {
        const value = await requestData(
          request,
          'file',
          (identity) =>
            window.api.readGitFullFile({
              ...identity,
              revision: review.revision,
              itemId: file.itemId,
              side
            }),
          token,
          viewId
        )
        if (!value || !current(token, viewId)) return
        if (value.itemId !== file.itemId || value.side !== side) {
          update({ busy: null, notice: '完整文件身份已变化，请刷新。', noticeStatus: 'stale' })
          return
        }
        versions[side] = value
      }
      if (versions.base && versions.current)
        update({
          fullFiles: {
            base: versions.base,
            current: versions.current
          },
          busy: null
        })
    },
    [cancelPrevious, current, request, update]
  )

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      activeView.current = null
      generation.current += 1
      const requestId = pending.current
      pending.current = null
      if (requestId) void window.api.cancelGitRead(requestId).catch(() => undefined)
    }
  }, [])
  useEffect(() => {
    activeView.current = readyView
    generation.current += 1
    if (!readyView) {
      void cancelPrevious()
      return
    }
    if (rememberedView.current !== readyView) {
      rememberedView.current = readyView
      invalidationSequence.current = 0
      data.current = initialState()
    }
    void load(true)
    return () => {
      generation.current += 1
      activeView.current = null
      void cancelPrevious()
    }
  }, [readyView, cancelPrevious, load])
  useEffect(() => {
    const file = state.review?.files.find((candidate) => candidate.itemId === state.selectedItemId)
    if (
      readyView &&
      file &&
      (state.detail?.itemId !== file.itemId ||
        state.detailRevision !== `${state.review?.revision}:${state.review?.source}`) &&
      !state.busy &&
      !state.notice
    )
      void readFile(file)
  }, [
    readyView,
    state.review,
    state.selectedItemId,
    state.detail,
    state.detailRevision,
    state.busy,
    state.notice,
    readFile
  ])

  useEffect(() => {
    if (!readyView || typeof window.api.onGitInvalidated !== 'function') return
    return window.api.onGitInvalidated((event) => {
      if (event.viewId !== readyView || event.sequence <= invalidationSequence.current) return
      invalidationSequence.current = event.sequence
      update({ refreshPending: true, watchStatus: event.status, watchMessage: event.message ?? '' })
    })
  }, [readyView, update])
  useEffect(() => {
    if (!readyView || !state.refreshPending || state.busy || refreshPaused) return
    const timer = setTimeout(() => {
      if (activeView.current !== readyView || data.current.busy || refreshPausedRef.current) return
      void load(true)
    }, 350)
    return () => clearTimeout(timer)
  }, [readyView, state.refreshPending, state.busy, refreshPaused, load])

  const selectSource = useCallback(
    async (source: GitReviewSource): Promise<void> => {
      update({ source, actionResult: null })
      await load(false)
    },
    [load, update]
  )
  const selectBase = useCallback(
    async (baseRefId: string): Promise<void> => {
      if (!data.current.metadata?.branches.some((branch) => branch.refId === baseRefId)) return
      update({ baseRefId })
      await load(false)
    },
    [load, update]
  )
  const selectCommit = useCallback(
    async (commitId: string): Promise<void> => {
      if (!data.current.metadata?.commits.some((commit) => commit.commitId === commitId)) return
      update({ commitId })
      await load(false)
    },
    [load, update]
  )
  const setHideWhitespace = useCallback(
    async (hideWhitespace: boolean): Promise<void> => {
      update({ hideWhitespace })
      await load(false)
    },
    [load, update]
  )
  const execute = useCallback(
    async (action: GitActionInput, expectedRevision?: string): Promise<boolean> => {
      const viewId = activeView.current
      const snapshot = data.current
      const revision =
        expectedRevision ??
        (action.action === 'stage' || action.action === 'unstage' || action.action === 'revert'
          ? snapshot.review?.revision
          : snapshot.metadata?.revision)
      if (!viewId || !revision || snapshot.busy === 'action') return false
      const token = ++generation.current
      if (!(await cancelPrevious()) || !current(token, viewId)) return false
      const result = await requestData(
        request,
        'action',
        (identity) => window.api.executeGitAction({ ...identity, revision, ...action }),
        token,
        viewId
      )
      if (!result || !current(token, viewId)) return false
      update({ actionResult: result, busy: null })
      await load(true)
      return result.outcome === 'success'
    },
    [cancelPrevious, current, load, request, update]
  )
  const capability = useCallback(
    (name: string): { available: boolean; reason: string } => {
      const value = state.metadata?.capabilities.find((candidate) => candidate.name === name)
      return {
        available: value?.available ?? false,
        reason:
          value?.reason ?? (state.metadata ? '当前仓库不支持此操作。' : '请先选择并读取仓库。')
      }
    },
    [state.metadata]
  )
  const generate = useCallback(
    async (
      options: Omit<GitGenerateRequest, keyof GitWorkbenchRequest | 'revision'>
    ): Promise<GitGeneratedText | null> => {
      const viewId = activeView.current
      const revision = data.current.metadata?.revision
      if (!viewId || !revision || data.current.busy) return null
      const token = ++generation.current
      if (!(await cancelPrevious()) || !current(token, viewId)) return null
      const candidate = await requestData(
        request,
        'generation',
        (identity) => window.api.generateGitText({ ...identity, revision, ...options }),
        token,
        viewId
      )
      if (!candidate || !current(token, viewId)) return null
      update({ busy: null })
      return candidate
    },
    [cancelPrevious, current, request, update]
  )
  const cancel = useCallback(async (): Promise<void> => {
    generation.current += 1
    if (await cancelPrevious()) update({ busy: null })
  }, [cancelPrevious, update])
  return {
    state,
    refresh: () => load(true),
    selectSource,
    selectBase,
    selectCommit,
    setHideWhitespace,
    readFile,
    readFullFiles,
    execute,
    generate,
    cancel,
    capability
  }
}
