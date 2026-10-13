import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type {
  GitPullRequestListRequest,
  GitPullRequestDetailRequest,
  GitPullRequestMergeRequest,
  GitPullRequestListData,
  GitPullRequestDetailData,
  GitPullRequestMergeData,
  GitPullRequestItem,
  GitPullRequestCheck,
  GitPullRequestMethod
} from '../../shared/git-pr'
import { parseGitPullRequestDetailResult, parseGitPullRequestListResult } from '../../shared/git-pr'
import type { GitWorkbenchActionContext } from './git-workbench-reader'
import { gitRemoteTransport } from './git-workbench-remote'
import { GitReadError, runGitProcess } from './git-process'
import type { GitProcessObservation } from './git-process'
import { SourceCapture, assertOrdinaryPath, decodeGitText } from './git-snapshot'
import { withGitRepositoryLock } from './git-workbench-lock'
import { redactGitNetworkError } from './git-workbench-network'

type HeldPullRequest = {
  viewId: string
  remoteName: string
  remoteUrl: string
  repository: string
  number: number
  detail?: GitPullRequestDetailData
  fingerprint?: string
}
type GhProgram = { executable: string; sha256: string }
const listFields = 'number,title,url,state,isDraft,headRefName,baseRefName,author'
const detailFields =
  listFields + ',body,headRefOid,baseRefOid,mergeable,mergeStateStatus,statusCheckRollup'
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new GitReadError('error', 'GitHub 返回格式无效')
  return value as Record<string, unknown>
}
function parseJSON(bytes: Buffer): unknown {
  try {
    return JSON.parse(decodeGitText(bytes))
  } catch {
    throw new GitReadError('error', 'GitHub 返回内容无法确认')
  }
}
function fresh(context: GitWorkbenchActionContext, signal?: AbortSignal): SourceCapture {
  const capture = new SourceCapture(signal)
  for (const [key, value] of context.snapshot.source.fingerprints)
    capture.fingerprints.set(key, value)
  return capture
}
function remoteRepository(
  context: GitWorkbenchActionContext,
  remoteId: string
): { name: string; url: string; repository: string } {
  if (context.location.scopePath) throw new GitReadError('unsupported', 'PR 需要选择仓库根目录')
  const remote = context.remotes.get(remoteId)
  const transport = remote && gitRemoteTransport(remote.url)
  if (!remote || !transport?.github)
    throw new GitReadError('unsupported', 'PR 需要 GitHub HTTPS 远程地址')
  const repository = new URL(transport.url).pathname
    .replace(/^\//, '')
    .replace(/\.git\/?$/, '')
    .replace(/\/$/, '')
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    repository.split('/').some((part) => part === '.' || part === '..')
  )
    throw new GitReadError('unsupported', 'GitHub 仓库地址格式不支持')
  return { name: remote.name, url: remote.url, repository }
}
function checkStatus(value: unknown): GitPullRequestCheck['status'] {
  const status = String(value ?? '').toUpperCase()
  if (['QUEUED', 'IN_PROGRESS', 'WAITING', 'PENDING', 'REQUESTED', 'EXPECTED'].includes(status))
    return 'pending'
  if (status === 'SUCCESS') return 'success'
  if (
    ['FAILURE', 'ERROR', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE'].includes(
      status
    )
  )
    return 'failure'
  if (status === 'NEUTRAL') return 'neutral'
  if (status === 'SKIPPED') return 'skipped'
  if (status === 'CANCELLED') return 'cancelled'
  return 'unknown'
}

/** Explicit PR interaction. Host retirement must await its actual process settlement. */
export function createGitWorkbenchPullRequests(
  options: {
    onProcess?: (event: GitProcessObservation) => void
    /** Main-process deployment configuration only; never accepted from renderer IPC. */
    programCandidates?: readonly string[]
  } = {}
): {
  list(
    context: GitWorkbenchActionContext,
    request: GitPullRequestListRequest,
    signal?: AbortSignal
  ): Promise<GitPullRequestListData>
  detail(
    context: GitWorkbenchActionContext,
    request: GitPullRequestDetailRequest,
    signal?: AbortSignal
  ): Promise<GitPullRequestDetailData>
  merge(
    context: GitWorkbenchActionContext,
    request: GitPullRequestMergeRequest,
    signal?: AbortSignal
  ): Promise<GitPullRequestMergeData>
  releaseView(viewId: string): Promise<void>
} {
  const held = new Map<string, HeldPullRequest>()
  const unsafeViews = new Set<string>()
  let programPromise: Promise<GhProgram | null> | undefined
  let blocked: string | undefined
  const candidates =
    options.programCandidates ??
    [process.env.ProgramW6432, process.env.ProgramFiles]
      .filter((base): base is string => !!base)
      .map((base) => path.join(base, 'GitHub CLI', 'gh.exe'))
  if (
    candidates.length > 4 ||
    candidates.some(
      (candidate) =>
        !path.isAbsolute(candidate) || path.basename(candidate).toLowerCase() !== 'gh.exe'
    )
  )
    throw new GitReadError('unsupported', 'GitHub CLI 部署路径无效')
  async function program(): Promise<GhProgram> {
    programPromise ??= (async () => {
      for (const executable of candidates) {
        try {
          await assertOrdinaryPath(executable)
          const bytes = await new SourceCapture().file(executable, 64 * 1024 * 1024)
          return { executable, sha256: createHash('sha256').update(bytes).digest('hex') }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
      return null
    })()
    const installed = await programPromise
    if (!installed) throw new GitReadError('unavailable', '请安装 GitHub CLI 并登录账户后使用 PR')
    return installed
  }
  function environment(token?: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {}
    for (const key of [
      'SystemRoot',
      'WINDIR',
      'TEMP',
      'TMP',
      'APPDATA',
      'LOCALAPPDATA',
      'USERPROFILE',
      'HOMEDRIVE',
      'HOMEPATH',
      'GH_TOKEN',
      'GITHUB_TOKEN'
    ])
      if (process.env[key]) env[key] = process.env[key]
    if (token) {
      env.GH_TOKEN = token
      delete env.GITHUB_TOKEN
    }
    env.PATH = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
    env.GH_HOST = 'github.com'
    env.GH_PROMPT_DISABLED = '1'
    env.GIT_TERMINAL_PROMPT = '0'
    env.NO_COLOR = '1'
    return env
  }
  async function gh(
    context: GitWorkbenchActionContext,
    args: string[],
    signal?: AbortSignal,
    token?: string
  ): Promise<Buffer> {
    if (blocked) throw new GitReadError('error', blocked)
    const installed = await program()
    const bytes = await new SourceCapture(signal).file(installed.executable, 64 * 1024 * 1024)
    if (createHash('sha256').update(bytes).digest('hex') !== installed.sha256)
      throw new GitReadError('unavailable', 'GitHub CLI 程序身份已变化')
    await fresh(context, signal).verify()
    const env = environment(token)
    try {
      return await runGitProcess({
        executable: installed.executable,
        args,
        cwd: context.snapshot.worktree,
        env,
        signal,
        timeoutMs: 60_000,
        stdoutBytes: 2 * 1024 * 1024,
        onProcess: options.onProcess
      })
    } catch (error) {
      const message = redactGitNetworkError(error, undefined, token)
      if (error instanceof Error && /退出未确认|清理失败/.test(error.message)) {
        blocked = message
        unsafeViews.add(context.view.info.viewId)
      }
      throw new GitReadError(error instanceof GitReadError ? error.status : 'error', message)
    } finally {
      delete env.GH_TOKEN
      delete env.GITHUB_TOKEN
    }
  }
  async function auth(
    context: GitWorkbenchActionContext,
    signal?: AbortSignal
  ): Promise<{ token: string; account: string }> {
    const token = decodeGitText(
      await gh(context, ['auth', 'token', '--hostname', 'github.com'], signal)
    ).trim()
    if (!token || token.length > 16000 || /[\s\p{Cc}]/u.test(token))
      throw new GitReadError('unavailable', '请先使用 GitHub CLI 登录账户')
    const user = object(
      parseJSON(await gh(context, ['api', '--hostname', 'github.com', 'user'], signal, token))
    )
    if (typeof user.login !== 'string' || !/^[A-Za-z0-9-]{1,256}$/.test(user.login))
      throw new GitReadError('error', 'GitHub 账户身份无法确认')
    return { token, account: user.login }
  }
  function find(
    context: GitWorkbenchActionContext,
    request: GitPullRequestDetailRequest
  ): HeldPullRequest {
    const item = held.get(request.prId)
    if (!item || item.viewId !== request.viewId || context.view.info.viewId !== request.viewId)
      throw new GitReadError('stale', 'PR 查看身份已失效，请刷新列表')
    const remote = [...context.remotes.values()].find(
      (entry) => entry.name === item.remoteName && entry.url === item.remoteUrl
    )
    if (!remote || context.location.scopePath)
      throw new GitReadError('stale', 'PR 远程或查看范围已变化，请刷新列表')
    return item
  }
  function item(
    raw: unknown,
    prId: string,
    record: HeldPullRequest,
    token: string
  ): GitPullRequestItem {
    const value = object(raw)
    if (
      value.number !== record.number ||
      value.url !== 'https://github.com/' + record.repository + '/pull/' + record.number
    )
      throw new GitReadError('error', 'PR 仓库或编号身份不匹配')
    return {
      prId,
      number: record.number,
      title: redactGitNetworkError(new Error(String(value.title ?? '')), undefined, token),
      url: String(value.url),
      state: value.state as GitPullRequestItem['state'],
      draft: value.isDraft as boolean,
      headRefName: String(value.headRefName ?? ''),
      baseRefName: String(value.baseRefName ?? ''),
      author: String(value.author ? (object(value.author).login ?? '') : '')
    }
  }
  async function readDetail(
    context: GitWorkbenchActionContext,
    prId: string,
    record: HeldPullRequest,
    authData: { token: string; account: string },
    signal?: AbortSignal
  ): Promise<GitPullRequestDetailData> {
    const value = object(
      parseJSON(
        await gh(
          context,
          [
            'pr',
            'view',
            String(record.number),
            '--repo',
            'github.com/' + record.repository,
            '--json',
            detailFields
          ],
          signal,
          authData.token
        )
      )
    )
    const settings = object(
      parseJSON(
        await gh(
          context,
          ['api', '--hostname', 'github.com', 'repos/' + record.repository],
          signal,
          authData.token
        )
      )
    )
    if (String(settings.full_name).toLowerCase() !== record.repository.toLowerCase())
      throw new GitReadError('error', 'GitHub 仓库身份无法确认')
    const mergeMethods: GitPullRequestMethod[] = []
    if (settings.allow_merge_commit === true) mergeMethods.push('merge')
    if (settings.allow_squash_merge === true) mergeMethods.push('squash')
    const rollup = value.statusCheckRollup ?? []
    if (!Array.isArray(rollup) || rollup.length > 200)
      throw new GitReadError('too-large', 'PR 检查项超过上限')
    const checks = rollup.map((entry): GitPullRequestCheck => {
      const check = object(entry)
      return {
        name: String(check.name ?? check.context ?? '检查'),
        status: checkStatus(check.conclusion || check.state || check.status)
      }
    })
    const data: GitPullRequestDetailData = {
      ...item(value, prId, record, authData.token),
      repository: record.repository,
      account: authData.account,
      prRevision: randomUUID(),
      body: String(value.body ?? ''),
      headOid: String(value.headRefOid ?? ''),
      baseOid: String(value.baseRefOid ?? ''),
      mergeable: value.mergeable as GitPullRequestDetailData['mergeable'],
      mergeStateStatus: String(value.mergeStateStatus ?? 'UNKNOWN'),
      mergeMethods,
      checks
    }
    // GitHub bodies are text, not executable HTML or model input. Only request-local credentials are removed.
    data.body = data.body.split(authData.token).join('[凭据已隐藏]')
    if (
      !parseGitPullRequestDetailResult({
        requestId: randomUUID(),
        viewId: record.viewId,
        status: 'ready',
        data
      })
    )
      throw new GitReadError('error', 'PR 详情字段无法确认')
    return data
  }
  function remember(
    record: HeldPullRequest,
    data: GitPullRequestDetailData
  ): GitPullRequestDetailData {
    const value: Partial<GitPullRequestDetailData> = { ...data }
    delete value.prRevision
    const fingerprint = createHash('sha256').update(JSON.stringify(value)).digest('hex')
    if (record.fingerprint === fingerprint && record.detail)
      data.prRevision = record.detail.prRevision
    record.fingerprint = fingerprint
    record.detail = data
    return data
  }
  async function list(
    context: GitWorkbenchActionContext,
    request: GitPullRequestListRequest,
    signal?: AbortSignal
  ): Promise<GitPullRequestListData> {
    if (context.view.info.viewId !== request.viewId)
      throw new GitReadError('stale', 'PR 查看范围已失效')
    const remote = remoteRepository(context, request.remoteId)
    const authData = await auth(context, signal)
    const values = parseJSON(
      await gh(
        context,
        [
          'pr',
          'list',
          '--repo',
          'github.com/' + remote.repository,
          '--state',
          request.state,
          '--limit',
          '100',
          '--json',
          listFields
        ],
        signal,
        authData.token
      )
    )
    if (!Array.isArray(values) || values.length > 100)
      throw new GitReadError('too-large', 'PR 列表超过上限')
    const pending: [string, HeldPullRequest][] = []
    const items = values.map((value) => {
      const number = object(value).number
      if (!Number.isSafeInteger(number) || Number(number) <= 0)
        throw new GitReadError('error', 'PR 编号无效')
      const existing = [...held.entries()].find(
        ([, entry]) =>
          entry.viewId === request.viewId &&
          entry.remoteName === remote.name &&
          entry.remoteUrl === remote.url &&
          entry.number === number
      )
      const prId = existing?.[0] ?? randomUUID()
      const record = existing?.[1] ?? {
        viewId: request.viewId,
        remoteName: remote.name,
        remoteUrl: remote.url,
        repository: remote.repository,
        number: Number(number)
      }
      pending.push([prId, record])
      return item(value, prId, record, authData.token)
    })
    const data = {
      repository: remote.repository,
      account: authData.account,
      items,
      capped: values.length === 100
    }
    if (
      !parseGitPullRequestListResult({
        requestId: request.requestId,
        viewId: request.viewId,
        status: 'ready',
        data
      })
    )
      throw new GitReadError('error', 'PR 列表字段无法确认')
    await fresh(context, signal).verify()
    for (const [id, record] of held)
      if (
        record.viewId === request.viewId &&
        record.remoteName === remote.name &&
        !pending.some(([next]) => next === id)
      )
        held.delete(id)
    for (const [id, record] of pending) held.set(id, record)
    if (held.size > 400) {
      for (const id of held.keys()) {
        if (held.size <= 400) break
        held.delete(id)
      }
    }
    return data
  }
  async function detail(
    context: GitWorkbenchActionContext,
    request: GitPullRequestDetailRequest,
    signal?: AbortSignal
  ): Promise<GitPullRequestDetailData> {
    const record = find(context, request)
    const data = await readDetail(
      context,
      request.prId,
      record,
      await auth(context, signal),
      signal
    )
    await fresh(context, signal).verify()
    return remember(record, data)
  }
  async function merge(
    context: GitWorkbenchActionContext,
    request: GitPullRequestMergeRequest,
    signal?: AbortSignal
  ): Promise<GitPullRequestMergeData> {
    return withGitRepositoryLock(context.location.common, signal, async () => {
      const record = find(context, request)
      const observed = record.detail
      if (!observed || observed.prRevision !== request.prRevision)
        throw new GitReadError('stale', 'PR 详情已失效，请刷新后再合并')
      const authData = await auth(context, signal)
      const current = await readDetail(context, request.prId, record, authData, signal)
      if (
        current.headOid !== observed.headOid ||
        current.baseOid !== observed.baseOid ||
        current.account !== observed.account ||
        current.headRefName !== observed.headRefName ||
        current.baseRefName !== observed.baseRefName ||
        current.state !== observed.state ||
        current.draft !== observed.draft
      ) {
        remember(record, current)
        throw new GitReadError(
          'stale',
          'PR 提交、目标分支、账户或状态已变化，未执行合并；请刷新详情'
        )
      }
      if (current.state !== 'OPEN' || current.draft || current.mergeable !== 'MERGEABLE')
        throw new GitReadError('unsupported', 'PR 当前不能合并，请先处理草稿、冲突或待确认状态')
      if (!current.mergeMethods.includes(request.method))
        throw new GitReadError('unsupported', '仓库当前不允许所选合并方式')
      await fresh(context, signal).verify()
      const finalIdentity = object(
        parseJSON(
          await gh(
            context,
            [
              'pr',
              'view',
              String(record.number),
              '--repo',
              'github.com/' + record.repository,
              '--json',
              'headRefOid,baseRefOid,state,isDraft,headRefName,baseRefName'
            ],
            signal,
            authData.token
          )
        )
      )
      if (
        finalIdentity.headRefOid !== current.headOid ||
        finalIdentity.baseRefOid !== current.baseOid ||
        finalIdentity.state !== current.state ||
        finalIdentity.isDraft !== current.draft ||
        finalIdentity.headRefName !== current.headRefName ||
        finalIdentity.baseRefName !== current.baseRefName
      )
        throw new GitReadError('stale', 'PR 在合并准备期间发生变化，未执行合并；请刷新详情')
      const base = { prId: request.prId, number: record.number, url: current.url }
      try {
        // GitHub offers atomic head matching. Its API has no atomic base-OID condition;
        // the precise base OID is checked immediately above and remote policy still applies.
        await gh(
          context,
          [
            'pr',
            'merge',
            String(record.number),
            '--repo',
            'github.com/' + record.repository,
            '--match-head-commit',
            current.headOid,
            request.method === 'squash' ? '--squash' : '--merge'
          ],
          signal,
          authData.token
        )
      } catch (error) {
        if (error instanceof Error && /退出未确认|清理失败/.test(error.message))
          return {
            ...base,
            outcome: 'partial-success',
            message:
              '合并远程结果可能已发生；' + redactGitNetworkError(error, undefined, authData.token)
          }
        if (signal?.aborted || (error instanceof Error && /超过|退出未确认/.test(error.message)))
          return {
            ...base,
            outcome: 'partial-success',
            message: '合并连接已中断，远程结果可能已发生；请刷新 PR 后再操作'
          }
        throw error
      }
      try {
        const after = await readDetail(context, request.prId, record, authData, signal)
        remember(record, after)
        if (after.state === 'MERGED' && after.headOid === current.headOid)
          return { ...base, outcome: 'success', message: 'PR #' + record.number + ' 已合并' }
        return {
          ...base,
          outcome: 'partial-success',
          message: '合并请求已执行，远程可能进入合并队列；请刷新核对结果'
        }
      } catch (error) {
        if (error instanceof Error && /退出未确认|清理失败/.test(error.message))
          return {
            ...base,
            outcome: 'partial-success',
            message:
              '合并请求已执行，最终远程状态尚未确认；' +
              redactGitNetworkError(error, undefined, authData.token)
          }
        return {
          ...base,
          outcome: 'partial-success',
          message: '合并请求已执行，但最终远程状态尚未确认；请刷新 PR'
        }
      }
    })
  }
  return {
    list,
    detail,
    merge,
    async releaseView(viewId) {
      if (unsafeViews.has(viewId))
        throw new GitReadError(
          'error',
          'PR 进程退出未确认或清理失败；保留查看范围供诊断。' + (blocked ?? '')
        )
      for (const [id, item] of held) if (item.viewId === viewId) held.delete(id)
    }
  }
}
