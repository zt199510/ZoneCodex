import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import type { GitChangeItem, GitViewScope } from '../../shared/git-view'
import { GitReadError, runGitProcess } from './git-process'
import type { GitProcessObservation } from './git-process'
import {
  SourceCapture,
  assertOrdinaryPath,
  decodeGitText,
  failUnsupported,
  gitSnapshotLimits,
  parseIndex,
  validRepositoryPath,
  withinScope
} from './git-snapshot'
import type { IndexEntry } from './git-snapshot'
import { parseGitStatus } from './git-status'

interface GitProgram {
  executable: string
  version: string
  sha256: string
}
interface Location {
  selectedPath: string
  repositoryPath: string
  scopePath: string
  gitdir: string
  common: string
  linked: boolean
}
interface Snapshot {
  root: string
  gitdir: string
  worktree: string
  source: SourceCapture
  env: NodeJS.ProcessEnv
  entries: IndexEntry[]
  head: 'present' | 'unborn'
  revision: string
  items: GitChangeItem[]
  retained: boolean
  pathspecs: string[]
  ignoreCase: boolean
}
export interface GitReaderView {
  info: GitViewScope
  location: Location
  snapshot?: Snapshot
  disposed: boolean
  controller?: AbortController
  settled?: Promise<unknown>
  generation?: number
}
const META_LIMIT = gitSnapshotLimits.metadataBytes
const configSemantics: Record<string, RegExp> = {
  'core.autocrlf': /^(true|false|input)$/i,
  'core.eol': /^(lf|crlf|native)$/i,
  'core.filemode': /^(true|false)$/i,
  'core.ignorecase': /^(true|false)$/i,
  'core.symlinks': /^(true|false)$/i,
  'core.precomposeunicode': /^(true|false)$/i
}

function cleanEnvironment(emptyConfig: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'ComSpec', 'PATHEXT'])
    if (process.env[key]) env[key] = process.env[key]
  // Neither inherited PATH nor inherited Git/Node/model variables reach the reader.
  env.PATH = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: emptyConfig,
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_ATTR_NOSYSTEM: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_NO_LAZY_FETCH: '1',
    GIT_PAGER: '',
    GIT_LITERAL_PATHSPECS: '1',
    GIT_PROTOCOL_FROM_USER: '0',
    GIT_ALLOW_PROTOCOL: ''
  }
}

async function locate(selectedPath: string, capture: SourceCapture): Promise<Location> {
  await assertOrdinaryPath(selectedPath)
  if (!(await fs.lstat(selectedPath)).isDirectory()) failUnsupported('请选择普通本地目录')
  let repositoryPath = path.resolve(selectedPath)
  while (true) {
    const dotgit = path.join(repositoryPath, '.git')
    let found = false
    try {
      const stat = await fs.lstat(dotgit)
      found = true
      if (stat.isSymbolicLink()) failUnsupported('不支持链接 .git')
      let gitdir = dotgit
      if (stat.isFile()) {
        const text = decodeGitText(await capture.file(dotgit, 4096, 'metadata')).trim()
        if (!text.startsWith('gitdir: ') || /[\r\n\0]/.test(text.slice(8)))
          failUnsupported('无效的 linked worktree 指针')
        gitdir = path.resolve(repositoryPath, text.slice(8))
      } else if (!stat.isDirectory()) failUnsupported('不支持的 .git 类型')
      await capture.directory(gitdir)
      const commondir = await capture.optionalFile(path.join(gitdir, 'commondir'), 4096)
      const common = commondir ? path.resolve(gitdir, decodeGitText(commondir).trim()) : gitdir
      await capture.directory(common)
      const scopePath = path.relative(repositoryPath, selectedPath).split(path.sep).join('/')
      if (scopePath && !validRepositoryPath(scopePath)) failUnsupported('不支持的子目录范围')
      return {
        selectedPath: path.resolve(selectedPath),
        repositoryPath,
        scopePath,
        gitdir,
        common,
        linked: gitdir !== common
      }
    } catch (error) {
      if (found && (error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new GitReadError('error', 'Git 元数据或 linked worktree 指针目标缺失')
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const parent = path.dirname(repositoryPath)
    if (parent === repositoryPath)
      throw new GitReadError('not-repository', '所选目录不在 Git 工作树中（bare 仓库暂不支持）')
    repositoryPath = parent
  }
}

function checkAttributes(bytes: Buffer): void {
  for (const line of decodeGitText(bytes).split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    if (line.trimStart().startsWith('[attr]')) failUnsupported('首版不支持自定义 attributes 宏')
    // Refuse custom transformations even when the particular pattern currently matches no item.
    const attributes = line.trim().split(/\s+/).slice(1)
    for (const attribute of attributes) {
      if (/^[-!]?(filter|working-tree-encoding|ident)(=|$)/.test(attribute))
        failUnsupported('此范围含不支持的自定义内容转换属性')
      if (/^diff=/.test(attribute)) failUnsupported('此范围含自定义 diff driver，暂不支持')
      if (
        !/^[-!]?(text|binary|diff|merge|crlf|eol)(=(auto|true|false|lf|crlf|input))?$/.test(
          attribute
        )
      )
        failUnsupported('此范围含首版不支持的 attributes 语义')
    }
  }
}

export function createGitReader(options: {
  cacheRoot: string
  onProcess?: (event: GitProcessObservation) => void
}): {
  open: (selectedPath: string, signal?: AbortSignal) => Promise<GitReaderView>
  refresh: (
    view: GitReaderView,
    signal?: AbortSignal
  ) => Promise<{ revision: string; items: GitChangeItem[]; warnings: string[] }>
  read: (
    view: GitReaderView,
    revision: string,
    itemId: string,
    signal?: AbortSignal
  ) => Promise<{
    item: GitChangeItem
    format: 'diff' | 'content'
    baseline: 'head-index' | 'empty-index' | 'index-worktree' | 'untracked'
    text: string
    bytes: number
    lineCount: number
  }>
  dispose: (view: GitReaderView) => Promise<void>
} {
  let programPromise: Promise<GitProgram> | undefined
  let blocked: string | undefined
  const cacheRoot = path.resolve(options.cacheRoot)
  const emptyConfig = path.join(cacheRoot, 'empty.config')
  async function removeConfigData(filename: string): Promise<void> {
    if (blocked) return
    try {
      await fs.unlink(filename)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new GitReadError('error', 'Git 临时配置清理失败；保留缓存供诊断')
    }
  }
  async function run(
    program: GitProgram,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    signal?: AbortSignal,
    extra: Partial<Parameters<typeof runGitProcess>[0]> = {}
  ): Promise<Buffer> {
    if (blocked) throw new GitReadError('error', blocked)
    await assertOrdinaryPath(program.executable)
    const current = await new SourceCapture(signal).file(program.executable, 64 * 1024 * 1024)
    if (createHash('sha256').update(current).digest('hex') !== program.sha256)
      throw new GitReadError('unavailable', 'Git 程序身份已变化')
    return runGitProcess({
      executable: program.executable,
      args,
      cwd,
      env,
      signal,
      onProcess: options.onProcess,
      ...extra
    }).catch((error: unknown) => {
      if (error instanceof Error && error.message.includes('退出未确认')) blocked = error.message
      throw error
    })
  }
  async function program(): Promise<GitProgram> {
    programPromise ??= (async () => {
      await fs.mkdir(cacheRoot, { recursive: true })
      await assertOrdinaryPath(cacheRoot)
      await fs.writeFile(emptyConfig, '', { flag: 'w' })
      const candidates = [process.env.ProgramW6432, process.env.ProgramFiles]
        .filter((base): base is string => !!base)
        .map((base) => path.join(base, 'Git', 'cmd', 'git.exe'))
      let executable: string | undefined
      for (const candidate of candidates)
        try {
          await assertOrdinaryPath(candidate)
          if ((await fs.lstat(candidate)).isFile()) {
            executable = candidate
            break
          }
        } catch {
          /* Try the next fixed installation location. */
        }
      if (!executable)
        throw new GitReadError('unavailable', '未找到受支持的系统 Git，请先安装 Git for Windows')
      const bytes = await new SourceCapture().file(executable, 64 * 1024 * 1024)
      const provisional = {
        executable,
        version: '',
        sha256: createHash('sha256').update(bytes).digest('hex')
      }
      const version = decodeGitText(
        await run(provisional, ['--version'], cacheRoot, cleanEnvironment(emptyConfig))
      ).trim()
      const match = /^git version (\d+)\.(\d+)\.(\d+)/.exec(version)
      if (!match || Number(match[1]) < 2 || (Number(match[1]) === 2 && Number(match[2]) < 56))
        throw new GitReadError('unavailable', '首版需 Git 2.56 或更新版本以固定禁止懒抓取')
      return { ...provisional, version }
    })()
    return programPromise
  }
  async function configs(
    location: Location,
    capture: SourceCapture,
    git: GitProgram,
    signal?: AbortSignal
  ): Promise<Map<string, string>> {
    if (
      process.env.XDG_CONFIG_HOME &&
      path.resolve(process.env.XDG_CONFIG_HOME) !== path.join(os.homedir(), '.config')
    )
      failUnsupported('首版不支持自定义 XDG Git 配置位置')
    const files = [
      path.resolve(path.dirname(git.executable), '../etc/gitconfig'),
      path.join(os.homedir(), '.config/git/config'),
      path.join(os.homedir(), '.gitconfig'),
      path.join(location.common, 'config')
    ]
    const values = new Map<string, string>()
    for (const file of files) {
      const bytes = await capture.optionalFile(file, META_LIMIT)
      if (!bytes) continue
      // Parse captured data, never the live config after preflight.
      const safeFile = path.join(cacheRoot, 'config-data-' + randomUUID())
      await fs.writeFile(safeFile, bytes)
      let parsed: Buffer
      try {
        parsed = await run(
          git,
          ['config', '--file', safeFile, '--no-includes', '--null', '--list'],
          cacheRoot,
          cleanEnvironment(emptyConfig),
          signal
        )
      } finally {
        await removeConfigData(safeFile)
      }
      for (const record of decodeGitText(parsed).split('\0').filter(Boolean)) {
        const end = record.indexOf('\n')
        const key = (end < 0 ? record : record.slice(0, end)).toLowerCase()
        const value = end < 0 ? 'true' : record.slice(end + 1)
        if (key.startsWith('include.') || key.startsWith('includeif.'))
          failUnsupported('首版不支持 Git include 配置链')
        if (key === 'core.worktree' || key === 'core.attributesfile' || key === 'core.excludesfile')
          failUnsupported('首版不支持外部 worktree/attributes/excludes 配置')
        if (
          key === 'extensions.partialclone' ||
          (/^remote\..*\.promisor$/.test(key) && value !== 'false')
        )
          failUnsupported('首版不支持 partial clone / promisor')
        if (key === 'core.bare' && value === 'true') failUnsupported('首版不支持 bare 仓库')
        if (key === 'extensions.objectformat' && value !== 'sha1' && value !== 'sha256')
          failUnsupported('不支持的对象格式')
        if (configSemantics[key] && !configSemantics[key].test(value))
          failUnsupported('不支持的 Git 内建配置值：' + key)
        if (
          configSemantics[key] ||
          key === 'extensions.objectformat' ||
          key === 'extensions.worktreeconfig' ||
          key === 'core.repositoryformatversion'
        )
          values.set(key, value)
        if (
          key.startsWith('extensions.') &&
          !['extensions.objectformat', 'extensions.worktreeconfig'].includes(key)
        )
          failUnsupported('首版不支持此 Git 扩展：' + key)
      }
    }
    if (values.get('extensions.worktreeconfig') === 'true') {
      // Worktree-specific configuration is data too; no include or external source is imported.
      const bytes = await capture.optionalFile(
        path.join(location.gitdir, 'config.worktree'),
        META_LIMIT
      )
      if (bytes) {
        const safeFile = path.join(cacheRoot, 'config-data-' + randomUUID())
        await fs.writeFile(safeFile, bytes)
        let output: Buffer
        try {
          output = await run(
            git,
            ['config', '--file', safeFile, '--no-includes', '--null', '--list'],
            cacheRoot,
            cleanEnvironment(emptyConfig),
            signal
          )
        } finally {
          await removeConfigData(safeFile)
        }
        for (const record of decodeGitText(output).split('\0').filter(Boolean)) {
          const end = record.indexOf('\n')
          const key = record.slice(0, end).toLowerCase()
          const value = record.slice(end + 1)
          if (!configSemantics[key] || !configSemantics[key].test(value))
            failUnsupported('首版不支持此 worktree 配置语义：' + key)
          values.set(key, value)
        }
      }
    }
    return values
  }
  async function makeSnapshot(view: GitReaderView, signal?: AbortSignal): Promise<Snapshot> {
    const git = await program()
    const capture = new SourceCapture(signal)
    const location = await locate(view.location.selectedPath, capture)
    if (JSON.stringify(location) !== JSON.stringify(view.location))
      throw new GitReadError('stale', '仓库定位已变化，请重新选择')
    const values = await configs(location, capture, git, signal)
    const hashFormat = values.get('extensions.objectformat') === 'sha256' ? 'sha256' : 'sha1'
    const oidPattern = hashFormat === 'sha1' ? /^[a-f0-9]{40}$/ : /^[a-f0-9]{64}$/
    // This fixed metadata query checks ownership. No safe.directory override is ever supplied.
    const actualRoot = decodeGitText(
      await run(
        git,
        ['--no-optional-locks', 'rev-parse', '--show-toplevel'],
        location.selectedPath,
        cleanEnvironment(emptyConfig),
        signal
      )
    ).trim()
    if (path.resolve(actualRoot) !== location.repositoryPath)
      failUnsupported('Git 工作树重定向不支持')
    const headBytes = await capture.file(path.join(location.gitdir, 'HEAD'), 4096, 'metadata')
    const headText = decodeGitText(headBytes).trim()
    let oid: string | undefined
    if (oidPattern.test(headText)) oid = headText
    else if (headText.startsWith('ref: ')) {
      const ref = headText.slice(5)
      if (
        !/^refs\/[A-Za-z0-9_./-]+$/.test(ref) ||
        ref.split('/').some((part) => !part || part === '..' || part === '.')
      )
        failUnsupported('不支持的 HEAD ref')
      const loose = await capture.optionalFile(path.join(location.common, ...ref.split('/')), 4096)
      if (loose) oid = decodeGitText(loose).trim()
      else {
        const packed = await capture.optionalFile(
          path.join(location.common, 'packed-refs'),
          META_LIMIT
        )
        if (packed)
          for (const line of decodeGitText(packed).split('\n'))
            if (line.endsWith(' ' + ref)) oid = line.slice(0, line.indexOf(' '))
      }
      if (oid && !oidPattern.test(oid)) failUnsupported('不支持的 ref 内容')
    } else failUnsupported('不支持的 HEAD 内容')
    const index = await capture.optionalFile(path.join(location.gitdir, 'index'), META_LIMIT)
    const entries = index ? parseIndex(index, hashFormat) : []
    const ignoreCase = values.get('core.ignorecase')?.toLowerCase() === 'true'
    const pathKey = (filename: string): string => (ignoreCase ? filename.toLowerCase() : filename)
    const casing = new Map<string, string>()
    for (const entry of entries) {
      const key = pathKey(entry.path)
      if (casing.has(key) && casing.get(key) !== entry.path)
        failUnsupported('此 Windows 工作树含大小写冲突的 index 路径，暂不支持')
      casing.set(key, entry.path)
    }
    const scopeDepth = location.scopePath ? location.scopePath.split('/').length : 0
    const scopedEntries = entries.filter((entry) =>
      withinScope(entry.path, location.scopePath, ignoreCase)
    )
    const pathspecs = Array.from(
      new Set([
        location.scopePath || '.',
        ...(scopeDepth
          ? scopedEntries.map((entry) => entry.path.split('/').slice(0, scopeDepth).join('/'))
          : [])
      ])
    )
    const root = path.join(cacheRoot, 'query-' + randomUUID())
    const gitdir = path.join(root, 'git')
    const worktree = path.join(root, 'worktree')
    await fs.mkdir(path.join(gitdir, 'objects'), { recursive: true })
    await fs.mkdir(path.join(gitdir, 'refs/heads'), { recursive: true })
    await fs.mkdir(worktree, { recursive: true })
    const env = {
      ...cleanEnvironment(emptyConfig),
      GIT_DIR: gitdir,
      GIT_COMMON_DIR: gitdir,
      GIT_INDEX_FILE: path.join(gitdir, 'index'),
      GIT_WORK_TREE: worktree
    }
    const snapshot: Snapshot = {
      root,
      gitdir,
      worktree,
      source: capture,
      env,
      entries,
      head: oid ? 'present' : 'unborn',
      revision: randomUUID(),
      items: [],
      retained: false,
      pathspecs,
      ignoreCase
    }
    try {
      const config = [
        '[core]',
        'repositoryformatversion = ' + (hashFormat === 'sha256' ? '1' : '0'),
        'bare = false',
        'fsmonitor = false',
        'hooksPath = ' + path.join(root, 'no-hooks').replace(/\\/g, '/'),
        'attributesFile = ' + emptyConfig.replace(/\\/g, '/'),
        'excludesFile = ' + emptyConfig.replace(/\\/g, '/')
      ]
      for (const [key, value] of values)
        if (configSemantics[key]) config.push(key.slice(5) + ' = ' + value)
      if (hashFormat === 'sha256') config.push('[extensions]', 'objectFormat = sha256')
      config.push(
        '[protocol]',
        'allow = never',
        '[credential]',
        'helper =',
        '[diff]',
        'external =',
        '[submodule]',
        'recurse = false'
      )
      await fs.writeFile(path.join(gitdir, 'config'), config.join('\n') + '\n')
      await fs.writeFile(
        path.join(gitdir, 'HEAD'),
        oid ? oid + '\n' : 'ref: refs/heads/zonecodex-unborn\n'
      )
      if (index) await fs.writeFile(path.join(gitdir, 'index'), index)
      const objectRoot = path.join(location.common, 'objects')
      const info = path.join(objectRoot, 'info')
      for (const name of ['alternates', 'http-alternates'])
        if (await capture.optionalFile(path.join(info, name), META_LIMIT))
          failUnsupported('首版不支持对象库 alternates')
      async function copyObjects(
        source: string,
        dest: string,
        kind: 'root' | 'loose' | 'pack'
      ): Promise<void> {
        const names = await capture.directory(source)
        for (const name of names) {
          capture.check()
          if (kind === 'root') {
            if (name === 'info') continue
            if (name === 'pack' || /^[a-f0-9]{2}$/.test(name)) {
              await fs.mkdir(path.join(dest, name), { recursive: true })
              await copyObjects(
                path.join(source, name),
                path.join(dest, name),
                name === 'pack' ? 'pack' : 'loose'
              )
              continue
            }
            failUnsupported('不支持的对象库布局')
          }
          if (kind === 'pack' && name.endsWith('.promisor'))
            failUnsupported('首版不支持 promisor 对象库')
          if (kind === 'pack' && !/^pack-[a-f0-9]+\.(pack|idx|rev)$/.test(name)) {
            if (name === 'multi-pack-index' || name.endsWith('.bitmap') || name.endsWith('.keep'))
              continue
            failUnsupported('不支持的 pack 文件类型')
          }
          if (
            kind === 'loose' &&
            !new RegExp('^[a-f0-9]{' + (hashFormat === 'sha1' ? 38 : 62) + '}$').test(name)
          )
            failUnsupported('不支持的 loose 对象路径')
          const bytes = await capture.file(
            path.join(source, name),
            gitSnapshotLimits.objectBytes,
            'objects'
          )
          await fs.writeFile(path.join(dest, name), bytes)
        }
      }
      await copyObjects(objectRoot, path.join(gitdir, 'objects'), 'root')
      for (const name of ['shallow'])
        if (await capture.optionalFile(path.join(location.common, name), META_LIMIT))
          failUnsupported('首版不支持 shallow 仓库')
      // The selected subtree can inherit these small data files, but never sibling source content.
      async function copyData(relative: string): Promise<void> {
        const source = path.join(location.repositoryPath, ...relative.split('/'))
        const bytes = await capture.optionalFile(source, META_LIMIT)
        if (!bytes) return
        if (relative.endsWith('.gitattributes')) checkAttributes(bytes)
        const target = path.join(worktree, ...relative.split('/'))
        await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.writeFile(target, bytes)
      }
      const scopeParts = location.scopePath ? location.scopePath.split('/') : []
      for (let n = 0; n < scopeParts.length; n++)
        for (const name of ['.gitignore', '.gitattributes'])
          await copyData([...scopeParts.slice(0, n), name].join('/'))
      await fs.mkdir(path.join(gitdir, 'info'), { recursive: true })
      for (const name of ['exclude', 'attributes']) {
        const bytes = await capture.optionalFile(
          path.join(location.common, 'info', name),
          META_LIMIT
        )
        if (bytes) {
          if (name === 'attributes') checkAttributes(bytes)
          await fs.writeFile(path.join(gitdir, 'info', name), bytes)
        }
      }
      const tracked = new Map(scopedEntries.map((entry) => [pathKey(entry.path), entry]))
      const trackedDirectories = new Set<string>()
      for (const key of tracked.keys()) {
        const parts = key.split('/')
        for (let n = 1; n < parts.length; n++) trackedDirectories.add(parts.slice(0, n).join('/'))
      }
      async function walk(relative: string): Promise<void> {
        const source = relative
          ? path.join(location.repositoryPath, ...relative.split('/'))
          : location.repositoryPath
        const sourceNames = await capture.directory(source)
        if (relative && sourceNames.some((name) => name.toLowerCase() === '.git'))
          failUnsupported('首版不递归查看嵌套 Git 仓库，请单独选择该仓库')
        const names = sourceNames.filter((name) => name.toLowerCase() !== '.git')
        capture.worktreeEntries += names.length
        if (capture.worktreeEntries > gitSnapshotLimits.worktreeEntries)
          throw new GitReadError('too-large', '所选工作树超过 10000 项')
        for (const name of ['.gitignore', '.gitattributes'])
          if (names.some((actual) => actual.toLowerCase() === name))
            await copyData(relative ? relative + '/' + name : name)
        const candidates = names.map((name) => (relative ? relative + '/' + name : name))
        // Directory-only ignore patterns need actual cache directories to classify names.
        // This captures type only; it never enters an ignored source directory.
        for (const filename of candidates) {
          const stat = await fs.lstat(path.join(location.repositoryPath, ...filename.split('/')))
          if (stat.isDirectory() && !stat.isSymbolicLink())
            await fs.mkdir(path.join(worktree, ...filename.split('/')), { recursive: true })
        }
        const ignored = new Set<string>()
        if (candidates.length) {
          const result = await run(
            git,
            ['--no-optional-locks', 'check-ignore', '--no-index', '-z', '--stdin'],
            worktree,
            { ...env, GIT_LITERAL_PATHSPECS: undefined },
            signal,
            { input: Buffer.from(candidates.join('\0') + '\0'), acceptedCodes: [0, 1] }
          )
          decodeGitText(result)
            .split('\0')
            .filter(Boolean)
            .forEach((name) => ignored.add(name))
        }
        for (const filename of candidates) {
          capture.check()
          if (!validRepositoryPath(filename)) failUnsupported('所选目录含不支持的 Windows 文件名')
          const hasTracked =
            tracked.has(pathKey(filename)) || trackedDirectories.has(pathKey(filename))
          if (ignored.has(filename) && !hasTracked) continue
          const entry = tracked.get(pathKey(filename))
          const target = path.join(worktree, ...filename.split('/'))
          const sourceFile = path.join(location.repositoryPath, ...filename.split('/'))
          const stat = await fs.lstat(sourceFile)
          if (stat.isSymbolicLink()) failUnsupported('所选范围含符号链接或联接，首版不穿透')
          if (entry?.mode === '160000') {
            await fs.mkdir(target, { recursive: true })
            continue
          }
          if (stat.isDirectory()) {
            await fs.mkdir(target, { recursive: true })
            await walk(filename)
            continue
          }
          if (!stat.isFile()) failUnsupported('所选范围含非普通文件')
          await fs.mkdir(path.dirname(target), { recursive: true })
          if (
            entry ||
            filename.toLowerCase().endsWith('.gitignore') ||
            filename.toLowerCase().endsWith('.gitattributes')
          ) {
            const bytes = await capture.file(
              sourceFile,
              gitSnapshotLimits.trackedFileBytes,
              'worktree'
            )
            if (filename.toLowerCase().endsWith('.gitattributes')) checkAttributes(bytes)
            await fs.writeFile(target, bytes, { mode: stat.mode })
          } else {
            await capture.statFile(sourceFile)
            await fs.writeFile(target, '')
          }
        }
      }
      await fs.mkdir(path.join(worktree, ...scopeParts), { recursive: true })
      await walk(location.scopePath)
      if (oid) await run(git, ['cat-file', '-e', oid + '^{commit}'], worktree, env, signal)
      await capture.verify()
      return snapshot
    } catch (error) {
      if (error instanceof Error && error.message.includes('退出未确认')) snapshot.retained = true
      if (!snapshot.retained) await fs.rm(root, { recursive: true, force: true })
      throw error
    }
  }
  async function remove(snapshot?: Snapshot): Promise<void> {
    if (snapshot?.retained)
      throw new GitReadError('error', 'Git 进程退出未确认；查询缓存仍保留，请重启应用后重试')
    if (snapshot && !snapshot.retained) await fs.rm(snapshot.root, { recursive: true, force: true })
  }
  async function operation<T>(
    view: GitReaderView,
    signal: AbortSignal | undefined,
    body: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    if (view.disposed) throw new GitReadError('stale', 'Git 查看范围已释放')
    if (blocked) throw new GitReadError('error', blocked)
    const generation = (view.generation ?? 0) + 1
    view.generation = generation
    view.controller?.abort()
    await view.settled?.catch(() => {})
    if (blocked) throw new GitReadError('error', blocked)
    if (view.disposed || view.generation !== generation)
      throw new GitReadError('stale', 'Git 查看请求已替换或释放')
    const controller = new AbortController()
    view.controller = controller
    const abort = (): void => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) controller.abort()
    const timeout = setTimeout(abort, 10000)
    const work = body(controller.signal)
    view.settled = work
    try {
      return await work
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
      if (view.controller === controller) view.controller = undefined
    }
  }
  return {
    async open(selectedPath, signal) {
      const git = await program()
      const location = await locate(selectedPath, new SourceCapture(signal))
      const view: GitReaderView = {
        info: {
          viewId: randomUUID(),
          selectedPath: location.selectedPath,
          repositoryPath: location.repositoryPath,
          scopePath: location.scopePath,
          gitVersion: git.version,
          head: 'unborn',
          linkedWorktree: location.linked
        },
        location,
        disposed: false
      }
      view.snapshot = await operation(view, signal, (current) => makeSnapshot(view, current))
      view.info.head = view.snapshot.head
      return view
    },
    async refresh(view, signal) {
      return operation(view, signal, async (current) => {
        const snapshot = await makeSnapshot(view, current)
        try {
          if (snapshot.head !== view.info.head)
            throw new GitReadError('stale', '仓库 HEAD 状态已变化，请重新选择目录')
          const git = await program()
          const bytes = await run(
            git,
            [
              '--no-optional-locks',
              '--literal-pathspecs',
              'status',
              '--porcelain=v2',
              '-z',
              '--untracked-files=all',
              '--ignore-submodules=all',
              '--renames',
              '--',
              ...snapshot.pathspecs
            ],
            snapshot.worktree,
            snapshot.env,
            current
          )
          snapshot.items = parseGitStatus(bytes, view.location.scopePath, snapshot.ignoreCase)
          await snapshot.source.verify()
          await remove(view.snapshot)
          view.snapshot = snapshot
          view.info.head = snapshot.head
          return {
            revision: snapshot.revision,
            items: snapshot.items,
            warnings: ['仅查看所选范围，子模块内容未检查。文件变化后请刷新。']
          }
        } catch (error) {
          if (error instanceof Error && error.message.includes('退出未确认'))
            snapshot.retained = true
          await remove(snapshot)
          throw error
        }
      })
    },
    async read(view, revision, itemId, signal) {
      if (
        view.snapshot?.revision !== revision ||
        !view.snapshot.items.some((item) => item.itemId === itemId)
      )
        throw new GitReadError('stale', 'Git 列表或项目已失效，请刷新')
      return operation(view, signal, async (current) => {
        const snapshot = view.snapshot
        if (!snapshot || snapshot.revision !== revision)
          throw new GitReadError('stale', 'Git 列表已变化，请刷新')
        const item = snapshot.items.find((item) => item.itemId === itemId)
        if (!item) throw new GitReadError('stale', 'Git 列表项已失效')
        if (!item.previewable) failUnsupported(item.reason ?? '此项目不支持预览')
        // Fresh verifier clock starts with this request, not the older list capture.
        const verifier = new SourceCapture(current)
        for (const [key, value] of snapshot.source.fingerprints)
          verifier.fingerprints.set(key, value)
        await verifier.verify()
        let bytes: Buffer
        let baseline: 'head-index' | 'empty-index' | 'index-worktree' | 'untracked'
        if (item.group === 'untracked') {
          baseline = 'untracked'
          bytes = await verifier.file(
            path.join(view.location.repositoryPath, ...item.path.split('/')),
            262144
          )
        } else {
          baseline =
            item.group === 'staged'
              ? snapshot.head === 'present'
                ? 'head-index'
                : 'empty-index'
              : 'index-worktree'
          const git = await program()
          const args = [
            '--no-optional-locks',
            '--literal-pathspecs',
            'diff',
            '--no-ext-diff',
            '--no-textconv',
            '--no-color',
            '--ignore-submodules=all',
            ...(item.group === 'staged' ? ['--cached'] : [])
          ]
          const names = [item.path, ...(item.previousPath ? [item.previousPath] : [])]
          const stat = await run(
            git,
            [...args, '--numstat', '-z', '--', ...names],
            snapshot.worktree,
            snapshot.env,
            current,
            { stdoutBytes: 262144 }
          ).catch((error) => {
            if (error instanceof Error && error.message.includes('退出未确认'))
              snapshot.retained = true
            throw error
          })
          if (decodeGitText(stat).startsWith('-\t-\t')) failUnsupported('二进制文件不支持文本预览')
          bytes = await run(
            git,
            [...args, '--unified=3', '--', ...names],
            snapshot.worktree,
            snapshot.env,
            current,
            { stdoutBytes: 262144 }
          ).catch((error) => {
            if (error instanceof Error && error.message.includes('退出未确认'))
              snapshot.retained = true
            throw error
          })
        }
        if (bytes.includes(0)) failUnsupported('二进制内容不支持文本预览')
        const text = decodeGitText(bytes)
        const lineCount = text.split(/\r\n|\n|\r/).length
        if (lineCount > 4000) throw new GitReadError('too-large', '内容超过 4000 行')
        await verifier.verify()
        return {
          item,
          format: item.group === 'untracked' ? 'content' : 'diff',
          baseline,
          text,
          bytes: bytes.length,
          lineCount
        }
      })
    },
    async dispose(view) {
      view.disposed = true
      view.controller?.abort()
      await view.settled?.catch(() => {})
      if (blocked) throw new GitReadError('error', blocked)
      await remove(view.snapshot)
      view.snapshot = undefined
    }
  }
}
