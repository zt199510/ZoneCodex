import { join } from 'node:path'
import { parseAppSettings, parseSettingsChange } from '../../shared/settings'
import type { AppSettings, SettingsChange } from '../../shared/settings'
import { createSettingsStore } from './settings-store'
import type { SettingsStore } from './settings-store'
import { resolveTerminalShell } from './terminal-shell'

export type SettingsService = {
  load: () => Promise<void>
  get: () => AppSettings
  update: (change: SettingsChange, beforeSave?: () => void) => Promise<AppSettings>
  setTaskRoot: (root: string, beforeSave?: () => void) => Promise<AppSettings>
}

/** The snapshot becomes visible only after its replacement file is on disk. */
export function createSettingsService(
  store: SettingsStore,
  defaults: AppSettings
): SettingsService {
  let current: AppSettings | null = null
  let loadError = '设置尚未加载，请稍后再试'
  let queue: Promise<unknown> = Promise.resolve()
  const get = (): AppSettings => {
    if (!current) throw new Error(loadError)
    return { ...current }
  }
  const save = (change: Partial<AppSettings>, beforeSave?: () => void): Promise<AppSettings> => {
    const work = async (): Promise<AppSettings> => {
      const next = parseAppSettings({ ...get(), ...change })
      if (!next) throw new Error('设置格式不正确')
      resolveTerminalShell(next.terminalShell)
      beforeSave?.()
      await store.save(next, beforeSave)
      current = next
      return get()
    }
    const next = queue.then(work, work)
    queue = next.catch(() => undefined)
    return next
  }
  return {
    load: async () => {
      try {
        const checked = parseAppSettings((await store.load()) ?? defaults)
        if (!checked) throw new Error('设置格式不正确')
        resolveTerminalShell(checked.terminalShell)
        current = checked
      } catch (error) {
        current = null
        loadError = error instanceof Error ? error.message : '设置读取失败'
      }
    },
    get,
    update: (change, beforeSave) => {
      const checked = parseSettingsChange(change)
      if (!checked) return Promise.reject(new Error('设置修改参数无效'))
      return save(checked, beforeSave)
    },
    setTaskRoot: (root, beforeSave) => save({ taskRoot: root }, beforeSave)
  }
}

let service: SettingsService | null = null

export async function initializeAppSettings(directory: string): Promise<void> {
  service = createSettingsService(createSettingsStore(directory), {
    version: 1,
    taskRoot: join(directory, 'chats'),
    defaultPermissionMode: 'default',
    terminalShell: 'powershell'
  })
  await service.load()
}

export function appSettingsService(): SettingsService {
  if (!service) throw new Error('设置尚未加载，请稍后再试')
  return service
}

export function getAppSettings(): AppSettings {
  return appSettingsService().get()
}
