import type { ReactNode } from 'react'
import { createLowlight } from 'lowlight'
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import json from 'highlight.js/lib/languages/json'
import xml from 'highlight.js/lib/languages/xml'
import css from 'highlight.js/lib/languages/css'
import python from 'highlight.js/lib/languages/python'
import bash from 'highlight.js/lib/languages/bash'
import powershell from 'highlight.js/lib/languages/powershell'
import sql from 'highlight.js/lib/languages/sql'
import yaml from 'highlight.js/lib/languages/yaml'
import diff from 'highlight.js/lib/languages/diff'
import { splitFileViewLines } from '../../../../shared/file-view'

const lowlight = createLowlight({
  javascript,
  typescript,
  json,
  xml,
  css,
  python,
  bash,
  powershell,
  sql,
  yaml,
  diff
})
lowlight.registerAlias({ typescript: ['tsx'], bash: ['shell'] })
type HighlightNode = ReturnType<typeof lowlight.highlight>['children'][number]
type HighlightText = { value: string; className: string }

function highlightText(code: string, language: string): HighlightText[] | null {
  const name = language.toLowerCase()
  if (
    !lowlight.registered(name) ||
    code.length > 12000 ||
    splitFileViewLines(code).some((line) => line.length > 2000)
  )
    return null
  try {
    let remaining = 10000
    const result: HighlightText[] = []
    function collect(nodes: readonly HighlightNode[], depth: number, classes: string[]): void {
      if (depth > 32) throw new Error('Token tree is too deep')
      for (const node of nodes) {
        if (--remaining < 0) throw new Error('Token tree is too large')
        if (node.type === 'text') {
          result.push({ value: node.value, className: classes.join(' ') })
          continue
        }
        if (node.type !== 'element' || node.tagName !== 'span')
          throw new Error('Unexpected token node')
        const ownClasses = Array.isArray(node.properties.className)
          ? node.properties.className.filter(
              (value): value is string =>
                typeof value === 'string' &&
                /^(?:hljs-[a-z][a-z0-9_-]*|[a-z][a-z0-9_-]*_)$/.test(value)
            )
          : []
        collect(node.children, depth + 1, [...classes, ...ownClasses])
      }
    }
    collect(lowlight.highlight(name, code).children, 0, [])
    // The display layer must never repair or substitute the original source.
    return result.map((token) => token.value).join('') === code ? result : null
  } catch {
    return null
  }
}

function tokenNode(token: HighlightText, key: number): ReactNode {
  return token.className ? (
    <span key={key} className={token.className}>
      {token.value}
    </span>
  ) : (
    token.value
  )
}

export function highlightedCode(code: string, language: string): ReactNode {
  const tokens = highlightText(code, language)
  return tokens ? tokens.map(tokenNode) : code
}

export function highlightSourceLines(code: string, language: string): ReactNode[] {
  const plain = splitFileViewLines(code)
  const tokens = highlightText(code, language)
  if (!tokens) return plain
  const lines: ReactNode[][] = [[]]
  let key = 0
  // Split only after validating the entire token tree and its exact text.
  for (const token of tokens) {
    const parts = token.value.split(/(\r\n|\r|\n)/)
    for (const part of parts) {
      if (/^(?:\r\n|\r|\n)$/.test(part)) lines.push([])
      else if (part) lines[lines.length - 1].push(tokenNode({ ...token, value: part }, key++))
    }
  }
  // A token boundary may split CRLF. In that case keep the reliable plain lines.
  return lines.length === plain.length ? lines : plain
}
