/** Make terminal and direction controls visible; repository text remains plain React text. */
export function visibleGitText(value: string): string {
  let output = ''
  for (const character of value) {
    const code = character.charCodeAt(0)
    const control =
      code < 9 ||
      code === 11 ||
      code === 12 ||
      (code >= 14 && code <= 31) ||
      (code >= 127 && code <= 159) ||
      (code >= 0x200b && code <= 0x200f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2060 && code <= 0x206f)
    output += control ? `⟨U+${code.toString(16).toUpperCase().padStart(4, '0')}⟩` : character
  }
  return output
}

export type GitDisplayRow = { kind: 'context' | 'add' | 'remove' | 'meta'; text: string }
/** Color native unified-diff lines; do not reconstruct HEAD/index/worktree comparisons. */
export function gitDisplayRows(text: string, format: 'diff' | 'content'): GitDisplayRow[] {
  return text.split(/\r\n|\n|\r/).map((line): GitDisplayRow => ({
    kind:
      format === 'content'
        ? 'context'
        : line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')
          ? 'meta'
          : line.startsWith('+')
            ? 'add'
            : line.startsWith('-')
              ? 'remove'
              : 'context',
    text: visibleGitText(line)
  }))
}
