import path from 'node:path'
import { createHash } from 'node:crypto'
import type { GitActionRequest, GitActionData, GitMetadata } from '../../shared/git-workbench'
import type { GitWorkbenchActionContext } from './git-workbench-reader'
import { SourceCapture, assertOrdinaryPath, decodeGitText } from './git-snapshot'
import { GitReadError, runGitProcess } from './git-process'
import type { GitProcessObservation } from './git-process'
import { withGitRepositoryLock } from './git-workbench-lock'
import { redactGitNetworkError as networkError } from './git-workbench-network'

type GhProgram = { executable: string; sha256: string }
export function gitRemoteTransport(
  raw: string
): { url: string; hostname: string; github: boolean } | null {
  try {
    const value = new URL(raw)
    if (
      value.protocol !== 'https:' ||
      !value.hostname ||
      value.username ||
      value.password ||
      value.search ||
      value.hash ||
      /[\p{Cc}]/u.test(raw)
    )
      return null
    return {
      url: value.toString(),
      hostname: value.hostname,
      github: value.hostname.toLowerCase() === 'github.com'
    }
  } catch {
    return null
  }
}
function fresh(context: GitWorkbenchActionContext, signal?: AbortSignal): SourceCapture {
  const capture = new SourceCapture(signal)
  for (const [key, value] of context.snapshot.source.fingerprints)
    capture.fingerprints.set(key, value)
  return capture
}
export function createGitWorkbenchRemote(
  options: { onProcess?: (event: GitProcessObservation) => void } = {}
): {
  metadata: (
    context: GitWorkbenchActionContext,
    data: GitMetadata,
    signal?: AbortSignal
  ) => Promise<GitMetadata>
  execute: (
    context: GitWorkbenchActionContext,
    request: GitActionRequest,
    signal?: AbortSignal
  ) => Promise<GitActionData>
  networkEnvironment: (
    context: GitWorkbenchActionContext,
    remoteId: string,
    signal?: AbortSignal
  ) => Promise<NodeJS.ProcessEnv>
} {
  let ghProgram: Promise<GhProgram | null> | undefined
  let blocked: string | undefined
  async function program(): Promise<GhProgram | null> {
    ghProgram ??= (async () => {
      for (const base of [process.env.ProgramW6432, process.env.ProgramFiles]) {
        if (!base) continue
        const executable = path.join(base, 'GitHub CLI', 'gh.exe')
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
    return ghProgram
  }
  function ghEnvironment(): NodeJS.ProcessEnv {
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
    env.PATH = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
    env.GH_PROMPT_DISABLED = '1'
    env.GIT_TERMINAL_PROMPT = '0'
    env.NO_COLOR = '1'
    return env
  }
  async function gh(
    context: GitWorkbenchActionContext,
    args: string[],
    signal?: AbortSignal,
    credentialToken?: string
  ): Promise<Buffer> {
    if (blocked) throw new GitReadError('error', blocked)
    const installed = await program()
    if (!installed) throw new GitReadError('unavailable', '请安装 GitHub CLI 并登录账户后使用 PR')
    const bytes = await new SourceCapture(signal).file(installed.executable, 64 * 1024 * 1024)
    if (createHash('sha256').update(bytes).digest('hex') !== installed.sha256)
      throw new GitReadError('unavailable', 'GitHub CLI 程序身份已变化')
    return runGitProcess({
      executable: installed.executable,
      args,
      cwd: context.snapshot.worktree,
      env: ghEnvironment(),
      signal,
      timeoutMs: 60_000,
      stdoutBytes: 1024 * 1024,
      onProcess: options.onProcess
    }).catch((error: unknown) => {
      const message = networkError(error, undefined, credentialToken)
      if (error instanceof Error && error.message.includes('退出未确认')) blocked = message
      if (error instanceof GitReadError) throw new GitReadError(error.status, message)
      throw new GitReadError('error', message)
    })
  }
  async function credential(
    context: GitWorkbenchActionContext,
    hostname: string,
    signal?: AbortSignal
  ): Promise<string | null> {
    if (!(await program())) return null
    try {
      const token = decodeGitText(
        await gh(context, ['auth', 'token', '--hostname', hostname], signal)
      ).trim()
      return token && token.length <= 16000 && !/[\s\p{Cc}]/u.test(token) ? token : null
    } catch (error) {
      if (
        signal?.aborted ||
        (error instanceof Error && /退出未确认|程序身份已变化/.test(error.message))
      )
        throw error
      return null
    }
  }
  async function metadata(
    context: GitWorkbenchActionContext,
    data: GitMetadata,
    signal?: AbortSignal
  ): Promise<GitMetadata> {
    const installed = await program()
    const root = !context.location.scopePath
    const github = [...context.remotes.values()].some(
      (remote) => gitRemoteTransport(remote.url)?.github
    )
    const records = data.remotes.map((item) => {
      const raw = context.remotes.get(item.remoteId)
      const transport = raw ? gitRemoteTransport(raw.url) : null
      return {
        ...item,
        pushable: root && !!transport,
        reason: !root
          ? '网络操作需要选择仓库根目录'
          : transport
            ? null
            : '此远程地址需要尚未接入的传输方式；目前支持 HTTPS'
      }
    })
    const available = root && records.some((remote) => remote.pushable)
    const capability = (name: string, enabled: boolean, reason: string | null): void => {
      const item = data.capabilities.find((entry) => entry.name === name)
      if (item) {
        item.available = enabled
        item.reason = enabled ? null : reason
      } else data.capabilities.push({ name, available: enabled, reason: enabled ? null : reason })
    }
    capability('push', available, root ? '没有受支持的 HTTPS 远程地址' : '推送需要选择仓库根目录')
    capability('fetch', available, root ? '没有受支持的 HTTPS 远程地址' : '获取需要选择仓库根目录')
    capability(
      'create-pr',
      root && github && !!installed,
      !installed
        ? '请安装 GitHub CLI 并登录账户'
        : !github
          ? '没有 GitHub HTTPS 远程地址'
          : 'PR 需要选择仓库根目录'
    )
    let modelConfigured = false
    try {
      const endpoint = new URL(process.env.MODEL_ENDPOINT ?? '')
      modelConfigured =
        endpoint.protocol === 'https:' &&
        !endpoint.username &&
        !endpoint.password &&
        !!process.env.MODEL_NAME &&
        !!process.env.MODEL_API_KEY
    } catch {
      /* Availability only; do not expose credentials. */
    }
    const modelReason = '请配置模型地址、名称和密钥后重启'
    capability('generate', modelConfigured, modelReason)
    capability('generate-commit', modelConfigured, modelReason)
    capability('generate-pr', modelConfigured, modelReason)
    await fresh(context, signal).verify()
    return { ...data, remotes: records }
  }
  async function networkEnvironment(
    context: GitWorkbenchActionContext,
    remoteId: string,
    signal?: AbortSignal
  ): Promise<NodeJS.ProcessEnv> {
    const remote = context.remotes.get(remoteId)
    const transport = remote && gitRemoteTransport(remote.url)
    if (!transport)
      throw new GitReadError('unsupported', '此远程传输方式尚未接入；请选择 HTTPS 远程地址')
    const env: NodeJS.ProcessEnv = {
      ...context.snapshot.env,
      GIT_ALLOW_PROTOCOL: 'https',
      GIT_PROTOCOL_FROM_USER: '0'
    }
    // Authentication is restricted to this explicit manual request, never Agent permissions.
    const token = transport.github ? await credential(context, transport.hostname, signal) : null
    if (token) {
      env.GIT_CONFIG_COUNT = '1'
      env.GIT_CONFIG_KEY_0 = 'http.' + transport.url + '.extraHeader'
      env.GIT_CONFIG_VALUE_0 =
        'Authorization: Basic ' + Buffer.from('x-access-token:' + token).toString('base64')
    }
    return env
  }
  async function execute(
    context: GitWorkbenchActionContext,
    request: GitActionRequest,
    signal?: AbortSignal
  ): Promise<GitActionData> {
    if (context.location.scopePath)
      throw new GitReadError('unsupported', '此操作需要选择仓库根目录')
    return withGitRepositoryLock(context.location.common, signal, async () => {
      await fresh(context, signal).verify()
      if (request.action === 'push') {
        const remote = context.remotes.get(request.remoteId)
        const transport = remote && gitRemoteTransport(remote.url)
        if (!remote || !transport)
          throw new GitReadError('unsupported', '所选远程不可用；目前支持 HTTPS 传输')
        const head = decodeGitText(
          await new SourceCapture(signal).file(path.join(context.location.gitdir, 'HEAD'), 4096)
        ).trim()
        if (!head.startsWith('ref: refs/heads/'))
          throw new GitReadError('unsupported', '请先切换到本地分支再推送')
        const ref = head.slice(5)
        const oid = decodeGitText(
          await context.run(['rev-parse', '--verify', 'HEAD'], signal)
        ).trim()
        if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid))
          throw new GitReadError('error', '推送提交身份无效')
        const args = [
          '-c',
          'maintenance.auto=false',
          '-c',
          'gc.auto=0',
          'push',
          '--porcelain',
          '--no-verify',
          '--no-recurse-submodules'
        ]
        if (request.forceWithLease) {
          const expected =
            [...context.refs.values()].find(
              (entry) => entry.ref === 'refs/remotes/' + remote.name + '/' + ref.slice(11)
            )?.oid ?? ''
          args.push('--force-with-lease=' + ref + ':' + expected)
        }
        args.push('--', transport.url, oid + ':' + ref)
        const env = await networkEnvironment(context, request.remoteId, signal)
        await fresh(context, signal).verify()
        try {
          await context.run(args, signal, { env, timeoutMs: 60_000 })
        } catch (error) {
          if (
            signal?.aborted ||
            (error instanceof GitReadError && /超过|退出未确认/.test(error.message))
          )
            throw new GitReadError(
              'error',
              '推送连接已中断，远程结果可能已发生；请获取并核对后再操作'
            )
          throw new GitReadError('error', networkError(error, env.GIT_CONFIG_VALUE_0))
        } finally {
          delete env.GIT_CONFIG_VALUE_0
        }
        return {
          outcome: 'success',
          stage: 'remote-push',
          appliedItemIds: [],
          message: '已推送 ' + ref.slice(11) + ' 到 ' + remote.name,
          headSha: oid
        }
      }
      if (request.action === 'create-pr') {
        const remote = [...context.remotes.values()].find(
          (item) => gitRemoteTransport(item.url)?.github
        )
        const transport = remote && gitRemoteTransport(remote.url)
        const base = context.refs.get(request.baseRefId)
        if (!transport || !base) throw new GitReadError('stale', 'GitHub 远程或目标分支已失效')
        const head = decodeGitText(
          await new SourceCapture(signal).file(path.join(context.location.gitdir, 'HEAD'), 4096)
        ).trim()
        if (!head.startsWith('ref: refs/heads/'))
          throw new GitReadError('unsupported', '请先切换到本地分支再创建 PR')
        const repository = new URL(transport.url).pathname
          .replace(/^\//, '')
          .replace(/\.git\/?$/, '')
          .replace(/\/$/, '')
        if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
          throw new GitReadError('unsupported', 'GitHub 仓库地址格式不支持')
        const token = await credential(context, transport.hostname, signal)
        if (!token) throw new GitReadError('unavailable', '请先使用 GitHub CLI 登录账户')
        const baseName = base.remote ? base.name.slice(base.name.indexOf('/') + 1) : base.name
        const args = [
          'pr',
          'create',
          '--repo',
          repository,
          '--head',
          head.slice(16),
          '--base',
          baseName,
          '--title',
          request.title,
          '--body',
          request.body
        ]
        if (request.draft) args.push('--draft')
        const output = decodeGitText(await gh(context, args, signal, token)).trim()
        const url = output
          .split(/\s+/)
          .find((value) => /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(value))
        if (!url)
          return {
            outcome: 'partial-success',
            stage: 'remote-pr',
            appliedItemIds: [],
            message: 'PR 请求已执行，返回地址未能确认；请检查 GitHub 后再操作'
          }
        return { outcome: 'success', stage: 'remote-pr', appliedItemIds: [], message: url }
      }
      throw new GitReadError('unsupported', '此动作不属于远程操作')
    })
  }
  return { metadata, execute, networkEnvironment }
}
