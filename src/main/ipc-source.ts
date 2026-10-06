import { BrowserWindow } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'

type SourceChecks = { windowMustBeLive?: boolean; senderMustBeLive?: boolean }

/** Reuse caller identity checks without changing each interface's teardown policy. */
export function getIpcWindow(
  event: IpcMainInvokeEvent,
  message: string,
  checks: SourceChecks = {}
): BrowserWindow {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (
    !window ||
    (checks.windowMustBeLive && window.isDestroyed()) ||
    (checks.senderMustBeLive && event.sender.isDestroyed()) ||
    event.senderFrame !== event.sender.mainFrame
  ) {
    throw new Error(message)
  }
  return window
}
