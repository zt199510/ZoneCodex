import { ipcRenderer } from 'electron'
import type { AppAPI } from '../shared/api'
import { parseGitInvalidatedEvent } from '../shared/git-observation'

export const gitObservationAPI: Pick<AppAPI, 'onGitInvalidated'> = {
  onGitInvalidated: (listener) => {
    if (typeof listener !== 'function') throw new Error('Git 刷新监听无效')
    const receive = (_event: Electron.IpcRendererEvent, value: unknown): void => {
      const checked = parseGitInvalidatedEvent(value)
      if (checked) listener(checked)
    }
    ipcRenderer.on('git:invalidated', receive)
    return () => ipcRenderer.removeListener('git:invalidated', receive)
  }
}
