import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { TerminalShell } from '../../../../shared/settings'
import type { McpServerConfig, McpServerStatus } from '../../../../shared/mcp'
import type { ModelStatus } from '../../../../shared/model'
import { Icon } from '../../components/ui/Icon'
import { permissionModeOptions, permissionModeTitles } from '../execution/permissionPresentation'
import { useSettings } from './useSettings'

function canFocus(element: HTMLElement | undefined): boolean {
  return Boolean(
    element?.isConnected &&
    element.getClientRects().length &&
    !element.closest('[inert]') &&
    !element.matches(':disabled')
  )
}

export function SettingsPage({
  open,
  canChange,
  returnFocus,
  onSavingChange,
  onClose
}: {
  open: boolean
  canChange: boolean
  returnFocus?: HTMLElement
  onSavingChange: (saving: boolean) => void
  onClose: () => void
}): React.JSX.Element {
  const titleId = useId()
  const statusId = useId()
  const page = useRef<HTMLElement>(null)
  const backButton = useRef<HTMLButtonElement>(null)
  const { settings, loading, saving, error, reload, update, selectTaskRoot } = useSettings(
    open,
    canChange,
    onSavingChange
  )
  const disabled = !canChange || loading || saving || !settings
  const [mcpServers, setMcpServers] = useState<McpServerStatus[]>([])
  const [modelStatus, setModelStatus] = useState<ModelStatus | null>(null)
  const [modelError, setModelError] = useState('')
  const [mcpError, setMcpError] = useState('')
  const [mcpBusy, setMcpBusy] = useState<string | null>(null)
  const [mcpDraft, setMcpDraft] = useState({ id: '', name: '', command: '', args: '', cwd: '', enabled: true })
  useEffect(() => {
    if (!open) return
    let active = true
    void window.api.getModelStatus().then((item) => { if (active) { setModelStatus(item); setModelError('') } })
      .catch(() => { if (active) setModelError('模型状态读取失败，请重新打开设置') })
    void window.api.listMcpServers().then((items) => { if (active) setMcpServers(items) }).catch((error) => { if (active) setMcpError(error instanceof Error ? error.message : 'MCP 设置读取失败') })
    const off = window.api.onMcpStatus((item) => setMcpServers((items) => items.map((current) => current.id === item.id ? item : current)))
    return () => { active = false; off() }
  }, [open])
  const saveMcp = async (): Promise<void> => {
    const config: McpServerConfig = { id: mcpDraft.id.trim(), name: mcpDraft.name.trim(), transport: 'stdio', command: mcpDraft.command, args: mcpDraft.args.split(/\r?\n/).filter(Boolean), ...(mcpDraft.cwd.trim() ? { cwd: mcpDraft.cwd.trim() } : {}), enabled: mcpDraft.enabled, timeoutMs: 60000 }
    setMcpError(''); try { await window.api.upsertMcpServer(config); setMcpServers(await window.api.listMcpServers()); setMcpDraft({ id: '', name: '', command: '', args: '', cwd: '', enabled: true }) } catch (error) { setMcpError(error instanceof Error ? error.message : 'MCP 设置保存失败') }
  }
  const editMcp = async (id: string): Promise<void> => {
    const config = (await window.api.listMcpConfigs()).find((item) => item.id === id)
    if (config) setMcpDraft({ id: config.id, name: config.name, command: config.command, args: config.args.join('\n'), cwd: config.cwd ?? '', enabled: config.enabled })
  }

  useLayoutEffect(() => {
    const element = page.current
    if (!open || !element) return
    const previous =
      returnFocus ??
      (document.activeElement instanceof HTMLElement ? document.activeElement : undefined)
    backButton.current?.focus({ preventScroll: true })
    return () => {
      requestAnimationFrame(() => {
        if (!element.hidden || document.querySelector('dialog[open], [popover]:popover-open'))
          return
        const active = document.activeElement
        if (active !== document.body && active !== null && !element.contains(active)) return
        const target = canFocus(previous)
          ? previous
          : (document.getElementById('chat-input') ?? undefined)
        if (canFocus(target)) target?.focus({ preventScroll: true })
      })
    }
  }, [open, returnFocus])

  return (
    <main
      ref={page}
      className="settings-page"
      hidden={!open}
      inert={!open}
      aria-labelledby={titleId}
    >
      <header className="settings-header">
        <h1 id={titleId}>设置</h1>
        <button
          ref={backButton}
          type="button"
          className="quiet-button settings-back"
          onClick={onClose}
        >
          <Icon name="chevron" size={15} style={{ transform: 'rotate(180deg)' }} />
          返回聊天
        </button>
      </header>
      <div className="settings-content" aria-busy={loading || saving}>
        <h2 className="settings-page-title">常规</h2>
        {loading && <p className="settings-notice">正在读取设置…</p>}
        {settings && (
          <>
            <section className="settings-section" aria-labelledby="settings-model-title">
              <h3 id="settings-model-title">模型</h3>
              <p role="status">{modelStatus?.label ?? (modelError || '正在读取模型状态…')}</p>
              <p className="settings-description">模型通过环境配置切换，修改后重启生效。离线模式仍可管理本地 MCP；聊天不进行模型推理或执行任务。</p>
              {modelStatus?.errorCode && <p className="settings-error" role="alert">{modelStatus.errorCode}</p>}
            </section>
            <section className="settings-section" aria-labelledby="settings-permissions-title">
              <h3 id="settings-permissions-title">权限</h3>
              <p className="settings-description" id="settings-permissions-description">
                默认模式在新窗口生效，当前聊天的权限模式保持不变。
              </p>
              <fieldset
                className="settings-permissions"
                disabled={disabled}
                aria-describedby="settings-permissions-description"
              >
                <legend className="sr-only">默认授权模式</legend>
                {permissionModeOptions.map(({ mode, description }) => (
                  <label className="settings-permission-option" key={mode}>
                    <input
                      type="radio"
                      name="default-permission-mode"
                      value={mode}
                      checked={settings.defaultPermissionMode === mode}
                      onChange={() => void update({ defaultPermissionMode: mode })}
                    />
                    <span>
                      <strong>{permissionModeTitles[mode]}</strong>
                      <small>{description}</small>
                    </span>
                  </label>
                ))}
              </fieldset>
            </section>
            <section className="settings-section" aria-labelledby="settings-general-title">
              <h3 id="settings-general-title">常规</h3>
              <div className="settings-row settings-directory-row">
                <div className="settings-row-copy">
                  <strong>无项目任务文件夹</strong>
                  <p className="settings-path" title={settings.taskRoot}>
                    {settings.taskRoot}
                  </p>
                  <small>新建的无项目会话使用此位置，已有会话和聊天记录不搬移。</small>
                </div>
                <button
                  type="button"
                  className="quiet-button"
                  disabled={disabled}
                  onClick={() => void selectTaskRoot()}
                >
                  更改
                </button>
              </div>
              <div className="settings-row">
                <label className="settings-row-copy" htmlFor="settings-terminal-shell">
                  <strong>集成终端 Shell</strong>
                  <small>下次创建终端时生效，已有终端保持运行。</small>
                </label>
                <select
                  id="settings-terminal-shell"
                  value={settings.terminalShell}
                  disabled={disabled}
                  onChange={(event) =>
                    void update({ terminalShell: event.currentTarget.value as TerminalShell })
                  }
                >
                  <option value="powershell">PowerShell</option>
                  <option value="cmd">命令提示符</option>
                </select>
              </div>
            </section>
            <section className="settings-section" aria-labelledby="settings-mcp-title">
              <h3 id="settings-mcp-title">本地 MCP</h3>
              <p className="settings-description">仅支持本机 stdio Server；不会保存网络地址、环境变量或凭据。</p>
              {mcpServers.map((server) => (
                <div className="settings-row" key={server.id}>
                  <div className="settings-row-copy">
                    <strong>{server.name}</strong>
                    <small>{server.id} · {server.state} · {server.tools.length} 个工具{server.error ? ` · ${server.error}` : ''}</small>
                    {server.lastRefresh && <small>最近刷新：{server.lastRefresh}</small>}
                    {server.tools.length > 0 && <details><summary>查看工具</summary><ul>{server.tools.map((tool) => <li key={tool.qualifiedName}><strong>{tool.qualifiedName}</strong><small>{tool.description}</small></li>)}</ul></details>}
                  </div>
                  <div>
                    <button type="button" className="quiet-button" disabled={mcpBusy === server.id} onClick={() => void window.api.setMcpServerEnabled(server.id, !server.enabled).then(() => window.api.listMcpServers()).then(setMcpServers).catch((error) => setMcpError(error instanceof Error ? error.message : 'MCP 状态更新失败'))}>{server.enabled ? '禁用' : '启用'}</button>
                    <button type="button" className="quiet-button" onClick={() => void editMcp(server.id)}>编辑</button>
                    {server.state === 'connected' ? <button type="button" className="quiet-button" disabled={mcpBusy === server.id} onClick={() => { setMcpBusy(server.id); void window.api.disconnectMcpServer(server.id).then(() => window.api.listMcpServers()).then(setMcpServers).catch((error) => setMcpError(error instanceof Error ? error.message : 'MCP 断开失败')).finally(() => setMcpBusy(null)) }}>断开</button> : <button type="button" className="quiet-button" disabled={!server.enabled || mcpBusy === server.id} onClick={() => { setMcpBusy(server.id); void window.api.connectMcpServer(server.id).then(() => window.api.listMcpServers()).then(setMcpServers).catch((error) => setMcpError(error instanceof Error ? error.message : 'MCP 连接失败')).finally(() => setMcpBusy(null)) }}>连接</button>}
                    <button type="button" className="quiet-button" disabled={mcpBusy === server.id} onClick={() => { setMcpBusy(server.id); void window.api.refreshMcpServer(server.id).then(() => window.api.listMcpServers()).then(setMcpServers).catch((error) => setMcpError(error instanceof Error ? error.message : 'MCP 刷新失败')).finally(() => setMcpBusy(null)) }}>刷新工具</button>
                    <button type="button" className="quiet-button" disabled={mcpBusy === server.id} onClick={() => void window.api.removeMcpServer(server.id).then(() => window.api.listMcpServers()).then(setMcpServers).catch((error) => setMcpError(error instanceof Error ? error.message : 'MCP 删除失败'))}>删除</button>
                  </div>
                </div>
              ))}
              <div className="settings-row settings-directory-row">
                <div className="settings-row-copy"><strong>添加本地 Server</strong><small>参数每行一个，工作目录可留空。</small></div>
                <div className="settings-mcp-form">
                  <input placeholder="ID" value={mcpDraft.id} onChange={(event) => { const value = event.currentTarget.value; setMcpDraft((draft) => ({ ...draft, id: value })) }} />
                  <input placeholder="名称" value={mcpDraft.name} onChange={(event) => { const value = event.currentTarget.value; setMcpDraft((draft) => ({ ...draft, name: value })) }} />
                  <input placeholder="可执行文件" value={mcpDraft.command} onChange={(event) => { const value = event.currentTarget.value; setMcpDraft((draft) => ({ ...draft, command: value })) }} />
                  <textarea placeholder="参数，每行一个" value={mcpDraft.args} onChange={(event) => { const value = event.currentTarget.value; setMcpDraft((draft) => ({ ...draft, args: value })) }} />
                  <input placeholder="工作目录（可选）" value={mcpDraft.cwd} onChange={(event) => { const value = event.currentTarget.value; setMcpDraft((draft) => ({ ...draft, cwd: value })) }} />
                  <label><input type="checkbox" checked={mcpDraft.enabled} onChange={(event) => { const value = event.currentTarget.checked; setMcpDraft((draft) => ({ ...draft, enabled: value })) }} />启用</label>
                  <button type="button" className="quiet-button" disabled={disabled} onClick={() => void saveMcp()}>保存 Server</button>
                </div>
              </div>
            </section>
          </>
        )}
        <div className="settings-feedback" id={statusId}>
          {saving && <p role="status">正在保存设置…</p>}
          {!canChange && <p>任务、保存或关闭确认期间可以查看设置，请结束后再修改。</p>}
          {error && (
            <p className="settings-error" role="alert">
              {error}
            </p>
          )}
          {mcpError && <p className="settings-error" role="alert">{mcpError}</p>}
          {!settings && !loading && !saving && (
            <button type="button" className="quiet-button" onClick={() => void reload()}>
              重新读取
            </button>
          )}
        </div>
      </div>
    </main>
  )
}
