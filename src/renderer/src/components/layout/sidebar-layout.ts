export const sidebarDefaultWidth = 340
export const sidebarMinWidth = 290
export const sidebarMaxWidth = 520
export const sidebarBreakpoint = 768

export function clampSidebarWidth(width: number, viewportWidth = window.innerWidth): number {
  return Math.max(
    sidebarMinWidth,
    Math.min(
      Number.isFinite(width) ? width : sidebarDefaultWidth,
      sidebarMaxWidth,
      viewportWidth - 240
    )
  )
}
