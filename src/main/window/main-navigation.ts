import type { WebContents } from 'electron'

/** Embedded webviews create subframes and emit did-start-loading on their owner.
 * Only a real owner-document navigation invalidates application resources. */
export function attachMainNavigationSignal(contents: WebContents): void {
  contents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
    if (mainFrame && !inPlace) contents.emit('zonecodex-main-navigation')
  })
}
