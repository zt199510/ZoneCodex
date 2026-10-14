// Electron resources share this application-owned owner-navigation signal.
/* eslint-disable @typescript-eslint/no-namespace */
export {}
declare global {
  namespace Electron {
    interface WebContents {
      on(event: 'zonecodex-main-navigation', listener: () => void): this
      once(event: 'zonecodex-main-navigation', listener: () => void): this
      removeListener(event: 'zonecodex-main-navigation', listener: () => void): this
    }
  }
}
