export type WindowAction = 'minimize' | 'toggle-maximize' | 'close'
export type WindowState = { maximized: boolean }

export function parseWindowState(value: unknown): WindowState | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('maximized' in value) ||
    typeof value.maximized !== 'boolean'
  )
    return null
  return { maximized: value.maximized }
}
