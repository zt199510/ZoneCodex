import { useId, useLayoutEffect, useRef } from 'react'
import type { TerminalShell } from '../../../../shared/settings'
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
