import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseAppSettings } from '../../shared/settings'
import type { AppSettings } from '../../shared/settings'

export type SettingsStore = {
  load: () => Promise<AppSettings | null>
  save: (settings: AppSettings, beforeReplace?: () => void) => Promise<void>
}

/** Never replace a damaged or unsupported existing settings file. */
export function createSettingsStore(directory: string): SettingsStore {
  const file = join(directory, 'settings.json')
  let queue: Promise<unknown> = Promise.resolve()

  function serial<T>(work: () => Promise<T>): Promise<T> {
    const next = queue.then(work, work)
    queue = next.catch(() => undefined)
    return next
  }

  async function readExisting(): Promise<AppSettings | null> {
    let bytes: Buffer
    try {
      bytes = await readFile(file)
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
        return null
      throw new Error('无法读取设置文件，请检查文件权限。原文件未被覆盖。')
    }
    try {
      if (bytes.length > 32_768) throw new Error('文件过大')
      const settings = parseAppSettings(JSON.parse(bytes.toString('utf8')))
      if (!settings) throw new Error('格式不支持')
      return settings
    } catch {
      throw new Error('设置文件损坏或格式不支持。原文件未被覆盖，请修正后重开应用。')
    }
  }

  return {
    load: () => serial(readExisting),
    save: (value, beforeReplace) =>
      serial(async () => {
        const settings = parseAppSettings(value)
        if (!settings) throw new Error('设置格式不正确')
        await readExisting()
        const temporary = join(directory, `settings-${randomUUID()}.tmp`)
        try {
          await mkdir(directory, { recursive: true })
          await writeFile(temporary, JSON.stringify(settings, null, 2), {
            encoding: 'utf8',
            flag: 'wx'
          })
          beforeReplace?.()
          await rename(temporary, file)
        } catch {
          throw new Error('设置保存失败，请检查文件权限或磁盘空间。此前设置未改变。')
        } finally {
          await rm(temporary, { force: true }).catch(() => undefined)
        }
      })
  }
}
