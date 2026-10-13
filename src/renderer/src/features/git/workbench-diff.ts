/** Plain-text diff presentation. It does not execute patches or interpret HTML. */
export type WorkbenchDiffLine = {
  key: string
  kind: 'context' | 'added' | 'deleted' | 'note'
  text: string
  oldLine: number | null
  newLine: number | null
  index: number
}
export type WorkbenchDiffHunk = {
  key: string
  header: string
  startLine: number
  endLine: number
  sourceHunkIndex: number | null
  lines: WorkbenchDiffLine[]
}
export type ParsedWorkbenchDiff = {
  metadata: string[]
  hunks: WorkbenchDiffHunk[]
  binary: boolean
  renameOnly: boolean
}
export type SplitDiffLine = {
  key: string
  before: WorkbenchDiffLine | null
  after: WorkbenchDiffLine | null
}
export type WordSegment = { text: string; changed: boolean }
export type DiffSearchMatch = { hunkKey: string; lineKey: string; start: number; end: number }

export function parseWorkbenchDiff(text: string): ParsedWorkbenchDiff {
  const metadata: string[] = []
  const hunks: WorkbenchDiffHunk[] = []
  let hunk: WorkbenchDiffHunk | null = null
  let oldLine = 0
  let newLine = 0
  let binary = false
  let renamed = false
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  lines.forEach((raw, index) => {
    // A CR belonging to the line separator is not source content.
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    const heading = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(line)
    if (heading) {
      oldLine = Number(heading[1])
      newLine = Number(heading[3])
      hunk = {
        key: `hunk-${hunks.length}`,
        header: line,
        startLine: index,
        endLine: index,
        sourceHunkIndex: hunks.length,
        lines: []
      }
      hunks.push(hunk)
      return
    }
    if (line.startsWith('diff --git ') || line.startsWith('@@@ ')) hunk = null
    if (!hunk) {
      metadata.push(line)
      binary ||= line.startsWith('Binary files ') || line === 'GIT binary patch'
      renamed ||= line.startsWith('rename from ') || line.startsWith('rename to ')
      return
    }
    const prefix = line[0]
    const kind =
      prefix === '+' ? 'added' : prefix === '-' ? 'deleted' : prefix === ' ' ? 'context' : 'note'
    const row: WorkbenchDiffLine = {
      key: `line-${index}`,
      kind,
      text: kind === 'note' ? line : line.slice(1),
      oldLine: kind === 'context' || kind === 'deleted' ? oldLine++ : null,
      newLine: kind === 'context' || kind === 'added' ? newLine++ : null,
      index
    }
    hunk.lines.push(row)
    hunk.endLine = index
  })
  return { metadata, hunks, binary, renameOnly: renamed && hunks.length === 0 && !binary }
}

/** Fill unchanged context from the two owned file versions; original hunk IDs stay unmoved. */
export function expandWorkbenchDiff(
  diff: ParsedWorkbenchDiff,
  before: string | null,
  after: string | null
): ParsedWorkbenchDiff {
  const sourceLines = (text: string | null): string[] => {
    if (text === null || text === '') return []
    const lines = text.split('\n')
    if (lines.at(-1) === '') lines.pop()
    return lines.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
  }
  const oldLines = sourceLines(before)
  const newLines = sourceLines(after)
  const hunks: WorkbenchDiffHunk[] = []
  let oldCursor = 1
  let newCursor = 1
  const appendContext = (oldEnd: number, newEnd: number): void => {
    const length = Math.max(oldEnd - oldCursor, newEnd - newCursor)
    if (length <= 0) return
    const lines: WorkbenchDiffLine[] = []
    for (let index = 0; index < length; index += 1) {
      const oldLine = oldCursor + index < oldEnd ? oldCursor + index : null
      const newLine = newCursor + index < newEnd ? newCursor + index : null
      lines.push({
        key: `context-${oldLine}:${newLine}`,
        kind: 'context',
        text:
          newLine !== null ? (newLines[newLine - 1] ?? '') : (oldLines[(oldLine ?? 1) - 1] ?? ''),
        oldLine,
        newLine,
        index: -1
      })
    }
    hunks.push({
      key: `context-${hunks.length}`,
      header: '未改动的上下文',
      startLine: -1,
      endLine: -1,
      sourceHunkIndex: null,
      lines
    })
  }
  for (const hunk of diff.hunks) {
    const heading = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(hunk.header)
    if (!heading) {
      hunks.push(hunk)
      continue
    }
    const oldCount = Number(heading[2] ?? 1)
    const newCount = Number(heading[4] ?? 1)
    const oldStart = Number(heading[1]) + (oldCount === 0 ? 1 : 0)
    const newStart = Number(heading[3]) + (newCount === 0 ? 1 : 0)
    appendContext(oldStart, newStart)
    hunks.push(hunk)
    oldCursor = oldStart + oldCount
    newCursor = newStart + newCount
  }
  appendContext(oldLines.length + 1, newLines.length + 1)
  return { ...diff, hunks }
}

/** Align a contiguous replacement block; context and no-newline notes retain their order. */
export function splitHunkRows(hunk: WorkbenchDiffHunk): SplitDiffLine[] {
  const result: SplitDiffLine[] = []
  let index = 0
  while (index < hunk.lines.length) {
    const line = hunk.lines[index]
    if (line.kind === 'context' || line.kind === 'note') {
      result.push({ key: line.key, before: line, after: line })
      index += 1
      continue
    }
    const before: WorkbenchDiffLine[] = []
    const after: WorkbenchDiffLine[] = []
    while (index < hunk.lines.length) {
      const candidate = hunk.lines[index]
      if (candidate.kind === 'context' || candidate.kind === 'note') break
      if (candidate.kind === 'deleted') before.push(candidate)
      else after.push(candidate)
      index += 1
    }
    for (let i = 0; i < Math.max(before.length, after.length); i += 1) {
      result.push({
        key: `${before[i]?.key ?? 'empty'}:${after[i]?.key ?? 'empty'}`,
        before: before[i] ?? null,
        after: after[i] ?? null
      })
    }
  }
  return result
}

function tokens(text: string): string[] {
  return text.match(/[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu) ?? []
}
function segments(values: string[], same: Set<number>): WordSegment[] {
  const result: WordSegment[] = []
  values.forEach((text, index) => {
    const changed = !same.has(index)
    const previous = result.at(-1)
    if (previous?.changed === changed) previous.text += text
    else result.push({ text, changed })
  })
  return result
}

/** Bounded LCS gives useful word changes without quadratic work on an oversized line. */
export function diffWordSegments(
  before: string,
  after: string
): { before: WordSegment[]; after: WordSegment[] } {
  const left = tokens(before)
  const right = tokens(after)
  if (left.length > 256 || right.length > 256) {
    return {
      before: [{ text: before, changed: before !== after }],
      after: [{ text: after, changed: before !== after }]
    }
  }
  const columns = right.length + 1
  const lengths = new Uint16Array((left.length + 1) * columns)
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      lengths[i * columns + j] =
        left[i] === right[j]
          ? 1 + lengths[(i + 1) * columns + j + 1]
          : Math.max(lengths[(i + 1) * columns + j], lengths[i * columns + j + 1])
    }
  }
  const sameLeft = new Set<number>()
  const sameRight = new Set<number>()
  let i = 0
  let j = 0
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      sameLeft.add(i++)
      sameRight.add(j++)
    } else if (lengths[(i + 1) * columns + j] >= lengths[i * columns + j + 1]) i += 1
    else j += 1
  }
  return { before: segments(left, sameLeft), after: segments(right, sameRight) }
}

export function searchDiffRows(
  diff: ParsedWorkbenchDiff,
  query: string,
  maximum = 250
): { matches: DiffSearchMatch[]; total: number; capped: boolean } {
  const needle = query.toLocaleLowerCase()
  if (!needle.trim()) return { matches: [], total: 0, capped: false }
  const matches: DiffSearchMatch[] = []
  let total = 0
  for (const hunk of diff.hunks) {
    for (const line of hunk.lines) {
      const text = line.text.toLocaleLowerCase()
      let from = 0
      while (from <= text.length - needle.length) {
        const start = text.indexOf(needle, from)
        if (start < 0) break
        total += 1
        if (matches.length < maximum)
          matches.push({ hunkKey: hunk.key, lineKey: line.key, start, end: start + needle.length })
        from = start + needle.length
      }
    }
  }
  return { matches, total, capped: total > matches.length }
}
