export type DiffRow = {
  kind: 'same' | 'remove' | 'add'
  text: string
  oldLine: number | null
  newLine: number | null
}

const splitLines = (text: string): string[] => (text === '' ? [] : text.split('\n'))

export function buildDiff(before: string, after: string): DiffRow[] {
  const oldLines = splitLines(before)
  const newLines = splitLines(after)
  let start = 0

  while (
    start < oldLines.length &&
    start < newLines.length &&
    oldLines[start] === newLines[start]
  ) {
    start += 1
  }

  let oldEnd = oldLines.length
  let newEnd = newLines.length
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd -= 1
    newEnd -= 1
  }

  const rows: DiffRow[] = []
  for (let index = 0; index < start; index += 1) {
    rows.push({
      kind: 'same',
      text: oldLines[index],
      oldLine: index + 1,
      newLine: index + 1
    })
  }
  for (let index = start; index < oldEnd; index += 1) {
    rows.push({ kind: 'remove', text: oldLines[index], oldLine: index + 1, newLine: null })
  }
  for (let index = start; index < newEnd; index += 1) {
    rows.push({ kind: 'add', text: newLines[index], oldLine: null, newLine: index + 1 })
  }
  for (let oldIndex = oldEnd, newIndex = newEnd; oldIndex < oldLines.length; oldIndex += 1) {
    rows.push({
      kind: 'same',
      text: oldLines[oldIndex],
      oldLine: oldIndex + 1,
      newLine: newIndex + 1
    })
    newIndex += 1
  }
  return rows
}
