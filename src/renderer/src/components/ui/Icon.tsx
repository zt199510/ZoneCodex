import type { CSSProperties } from 'react'

const paths = {
  panel: 'M9 3v18M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z',
  folder: 'M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z',
  chat: 'M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2v-10a9.5 9.5 0 0 1 19-.5Z',
  arrow: 'M12 19V5m-6 6 6-6 6 6',
  plus: 'M12 5v14M5 12h14',
  check: 'm5 12 4 4L19 6',
  close: 'm6 6 12 12M6 18 18 6',
  code: 'm8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 16',
  spark: 'm12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z',
  book: 'M4 4h6a2 2 0 0 1 2 2v15a3 3 0 0 0-3-2H4V4Zm16 0h-6a2 2 0 0 0-2 2v15a3 3 0 0 1 3-2h5V4Z',
  trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7',
  stop: 'M6 6h12v12H6Z',
  chevron: 'm9 5 7 7-7 7'
} as const

export type IconName = keyof typeof paths

export function Icon({
  name,
  size = 18,
  style
}: {
  name: IconName
  size?: number
  style?: CSSProperties
}): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={style}
    >
      <path d={paths[name]} />
    </svg>
  )
}
