import { ElectronAPI } from '@electron-toolkit/preload'
import type { AppAPI } from '../shared/api'
declare global {
  interface Window {
    electron: ElectronAPI
    api: AppAPI
  }
}
