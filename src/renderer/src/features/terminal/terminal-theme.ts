import type { ITheme } from '@xterm/xterm'

/** Keep xterm's rendered cells in the same palette as the surrounding shell. */
export function terminalThemeFor(element: HTMLElement): ITheme {
  const styles = getComputedStyle(element)
  const color = (name: string, fallback: string): string =>
    styles.getPropertyValue(name).trim() || fallback
  const surface = color('--surface', '#ffffff')
  const text = color('--text', '#292b28')
  const accent = color('--accent', '#47705b')
  const muted = color('--muted', '#777a73')
  const danger = color('--danger', '#a43d35')
  const selection = getComputedStyle(element, '::selection').backgroundColor

  return {
    background: surface,
    foreground: text,
    cursor: accent,
    cursorAccent: surface,
    selectionBackground: selection || '#dce9df',
    selectionForeground: text,
    selectionInactiveBackground: color('--sidebar', '#f5f5f3'),
    black: text,
    red: danger,
    green: accent,
    yellow: '#85621b',
    blue: '#315a83',
    magenta: '#78558a',
    cyan: '#2e7274',
    white: '#60655d',
    brightBlack: muted,
    brightRed: '#b74236',
    brightGreen: '#3d7354',
    brightYellow: '#8c651b',
    brightBlue: '#35699c',
    brightMagenta: '#875491',
    brightCyan: '#26797c',
    brightWhite: text
  }
}
