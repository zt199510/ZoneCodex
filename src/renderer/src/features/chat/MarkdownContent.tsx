import {
  Children,
  createContext,
  isValidElement,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from 'react'
import type { MouseEvent, ReactNode } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Components } from 'react-markdown'
import type { Element, Nodes, Root, Text } from 'hast'
import { Icon } from '../../components/ui/Icon'
import { parseFileReferenceLink } from '../../../../shared/file-view'
import type { OpenFileReference } from '../files/file-view-origin'
import { highlightedCode } from '../files/source-highlight'
import { MessageIcon } from './MessageIcon'
import { codeLanguageLabel } from './message-code-language'

// 不传 base URL：相对路径、锚点和 //example.com 都不作为外链接受。
function displayUrl(value: string): string {
  try {
    const url = new URL(value)
    if (
      (url.protocol !== 'https:' && url.protocol !== 'http:') ||
      !url.hostname ||
      url.username ||
      url.password
    )
      return ''
    return url.href
  } catch {
    return ''
  }
}

function messageUrl(value: string): string {
  return displayUrl(value) || (parseFileReferenceLink(value) ? value : '')
}

const FileReferenceContext = createContext<OpenFileReference | undefined>(undefined)
const MarkdownSourceContext = createContext<string | null>(null)

let codeWrapped = false
try {
  codeWrapped = localStorage.getItem('zonecodex.messages.code-wrap') === 'true'
} catch {
  // Wrapping still works when browser storage is unavailable.
}
const wrapListeners = new Set<() => void>()
function subscribeCodeWrap(listener: () => void): () => void {
  wrapListeners.add(listener)
  return () => {
    wrapListeners.delete(listener)
  }
}
function getCodeWrap(): boolean {
  return codeWrapped
}
function toggleCodeWrap(): void {
  codeWrapped = !codeWrapped
  try {
    localStorage.setItem('zonecodex.messages.code-wrap', String(codeWrapped))
  } catch {
    // This preference can remain in memory for the current session.
  }
  wrapListeners.forEach((listener) => listener())
}

function isClosedCodeBlock(
  source: string | null,
  node: Element | undefined,
  code: string
): boolean {
  const start = node?.position?.start.offset
  const end = node?.position?.end.offset
  if (source === null || start === undefined || end === undefined) return true
  const lines = source.slice(start, end).split(/\r\n|\n|\r/)
  const opening = /^ {0,3}(`{3,}|~{3,})/.exec(lines[0])
  if (!opening) return true // Indented blocks do not need a closing fence.
  if (lines.length < 2) return false
  // HAST positions retain blockquote prefixes and list indentation on later lines.
  const closing = /^(?:[\t ]*>[\t ]*)*[\t ]*(`{3,}|~{3,})[\t ]*$/.exec(lines.at(-1) ?? '')
  if (!closing || closing[1][0] !== opening[1][0] || closing[1].length < opening[1].length)
    return false
  // The Markdown parser removes a valid closing fence from the rendered code.
  // Invalid indentation or container prefixes leave that final line in the code.
  if (code === '') return true
  // HAST adds an LF to non-empty code. Remove that LF separately so a source
  // ending in a lone CR is not accidentally combined into a CRLF line break.
  const codeValue = code.endsWith('\n') ? code.slice(0, -1) : code
  return codeValue.split(/\r\n|\n|\r/).length === lines.length - 2
}

function textContent(value: ReactNode): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (Array.isArray(value)) return value.map(textContent).join('')
  if (isValidElement<{ children?: ReactNode }>(value)) return textContent(value.props.children)
  return ''
}

type CodeElementProps = {
  className?: string
  children?: ReactNode
}

function CodeBlock({
  children,
  node
}: {
  children?: ReactNode
  node?: Element
}): React.JSX.Element {
  const source = useContext(MarkdownSourceContext)
  const wrapped = useSyncExternalStore(subscribeCodeWrap, getCodeWrap)
  const codeElement = Children.toArray(children).find((child) =>
    isValidElement<CodeElementProps>(child)
  )
  const codeProps = isValidElement<CodeElementProps>(codeElement) ? codeElement.props : undefined
  const code = textContent(codeProps?.children ?? children)
  const className = codeProps?.className ?? ''
  const languageMatch = /(?:^|\s)language-(\S+)/.exec(className)
  const language = languageMatch?.[1] ?? ''
  const closed = isClosedCodeBlock(source, node, code)
  const highlighted = useMemo(() => highlightedCode(code, language), [code, language])
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const [copying, setCopying] = useState(false)
  const copyPending = useRef(false)
  const resetTimer = useRef<number | null>(null)
  const mounted = useRef(true)
  const copyRequest = useRef(0)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      copyRequest.current += 1
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current)
    }
  }, [])

  function showCopyState(state: 'copied' | 'failed'): void {
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current)
    setCopyState(state)
    resetTimer.current = window.setTimeout(() => {
      resetTimer.current = null
      setCopyState('idle')
    }, 2000)
  }

  function copyCode(event: MouseEvent<HTMLButtonElement>): void {
    event.preventDefault()
    event.stopPropagation()
    if (copyPending.current || copyState === 'copied') return
    const request = ++copyRequest.current
    if (!navigator.clipboard) {
      showCopyState('failed')
      return
    }
    copyPending.current = true
    setCopying(true)
    void Promise.resolve()
      .then(() => navigator.clipboard.writeText(code))
      .then(
        () => {
          if (mounted.current && request === copyRequest.current) showCopyState('copied')
        },
        () => {
          if (mounted.current && request === copyRequest.current) showCopyState('failed')
        }
      )
      .finally(() => {
        copyPending.current = false
        if (mounted.current && request === copyRequest.current) setCopying(false)
      })
  }

  return (
    <div className="markdown-code-block" data-wrap={wrapped}>
      <div className="markdown-code-toolbar">
        <span className="markdown-code-title">
          {language && (
            <>
              <MessageIcon name="code" size={20} />
              <span className="markdown-code-language">{codeLanguageLabel(language)}</span>
            </>
          )}
        </span>
        <div className="markdown-code-actions">
          <button
            type="button"
            className="markdown-code-wrap"
            onClick={toggleCodeWrap}
            aria-pressed={wrapped}
            aria-label={wrapped ? '关闭代码换行' : '开启代码换行'}
            title={wrapped ? '关闭代码换行' : '开启代码换行'}
          >
            <MessageIcon name={wrapped ? 'wrap' : 'overflow'} size={16} />
          </button>
          {closed && (
            <button
              type="button"
              className="markdown-code-copy"
              onClick={copyState === 'copied' || copying ? undefined : copyCode}
              aria-busy={copying}
              aria-disabled={copying || copyState === 'copied'}
              aria-label={
                copyState === 'copied'
                  ? '代码已复制'
                  : copyState === 'failed'
                    ? '复制失败'
                    : '复制代码'
              }
              title={
                copyState === 'copied'
                  ? '代码已复制'
                  : copyState === 'failed'
                    ? '复制失败'
                    : '复制代码'
              }
            >
              {copyState === 'failed' ? (
                <Icon name="close" size={16} />
              ) : (
                <MessageIcon name={copyState === 'copied' ? 'codeCopied' : 'codeCopy'} size={16} />
              )}
            </button>
          )}
        </div>
      </div>
      <pre tabIndex={0}>
        <code className={className}>{highlighted}</code>
      </pre>
    </div>
  )
}

function MessageLink({
  href,
  children
}: {
  href?: string
  children?: ReactNode
}): React.JSX.Element {
  const onOpenFile = useContext(FileReferenceContext)
  const assistantLink = useContext(MarkdownSourceContext) !== null
  const safeHref = href ? displayUrl(href) : ''
  if (!safeHref) {
    const reference = href ? parseFileReferenceLink(href) : null
    if (reference && onOpenFile) {
      return (
        <button
          type="button"
          className="markdown-link markdown-file-reference"
          title={`${reference.path}${
            reference.startLine
              ? `:${reference.startLine}${reference.endLine ? `-${reference.endLine}` : ''}`
              : ''
          }`}
          aria-label={`查看文件 ${textContent(children) || reference.path}`}
          onClick={(event) => onOpenFile(reference, event.currentTarget)}
        >
          <Icon name="file" size={13} />
          <span>{children}</span>
        </button>
      )
    }
    return (
      <span className="markdown-link markdown-link-invalid">
        {children}
        <span className="markdown-url">（链接不可用）</span>
      </span>
    )
  }

  function open(event: MouseEvent<HTMLAnchorElement>): void {
    event.preventDefault()
    void window.api.openExternal(safeHref).catch(() => undefined)
  }

  return (
    <a
      className={`markdown-link${assistantLink ? ' markdown-external-reference' : ''}`}
      href={safeHref}
      target="_blank"
      rel="noreferrer"
      onClick={open}
    >
      {assistantLink && (
        <span className="markdown-link-icon">
          <MessageIcon name="globe" size={16} />
        </span>
      )}
      {children}
    </a>
  )
}

const components: Components = {
  p: ({ children }) => (
    <p data-markdown-han-text={/\p{Script=Han}/u.test(textContent(children)) ? 'true' : undefined}>
      {children}
    </p>
  ),
  a: ({ href, children }) => <MessageLink href={href}>{children}</MessageLink>,
  // 不输出 img 标签，所以不会请求模型文本里的图片地址。
  img: ({ alt }) => (
    <span className="markdown-image-placeholder">[图片未加载：{alt || '无说明'}]</span>
  ),
  input: ({ type, checked }) => <input type={type} checked={checked} disabled readOnly />,
  li: ({ className, children }) => {
    if (!className?.split(' ').includes('task-list-item'))
      return <li className={className}>{children}</li>
    const parts = Children.toArray(children)
    const firstIndex = parts.findIndex((part) => typeof part !== 'string' || part.trim() !== '')
    const first = parts[firstIndex]
    const isCheckbox = (child: ReactNode): boolean =>
      isValidElement<{ type?: string }>(child) && child.props.type === 'checkbox'
    if (isCheckbox(first)) {
      return (
        <li className={className}>
          {first}
          <div data-markdown-list-item-content>{parts.slice(firstIndex + 1)}</div>
        </li>
      )
    }
    if (isValidElement<{ children?: ReactNode }>(first)) {
      const paragraph = Children.toArray(first.props.children)
      const checkboxIndex = paragraph.findIndex(isCheckbox)
      if (checkboxIndex >= 0) {
        const text = paragraph.slice(checkboxIndex + 1)
        return (
          <li className={className}>
            {paragraph[checkboxIndex]}
            <div data-markdown-list-item-content>
              <p
                data-markdown-han-text={
                  /\p{Script=Han}/u.test(textContent(text)) ? 'true' : undefined
                }
              >
                {text}
              </p>
              {parts.slice(firstIndex + 1)}
            </div>
          </li>
        )
      }
    }
    return <li className={className}>{children}</li>
  },
  pre: ({ children, node }) => <CodeBlock node={node}>{children}</CodeBlock>,
  table: ({ children }) => (
    <div className="markdown-table-scroll" role="region" aria-label="消息表格" tabIndex={0}>
      <table>{children}</table>
    </div>
  )
}

const userComponents: Components = {
  a: components.a
}

export function UserMessageContent({
  content,
  onOpenFile
}: {
  content: string
  onOpenFile?: OpenFileReference
}): React.JSX.Element {
  const linksOnly = useMemo(
    () => () => (tree: Root) => {
      const links: { node: Element; start: number; end: number }[] = []
      function collect(node: Nodes): void {
        if (node.type === 'element' && node.tagName === 'a') {
          const start = node.position?.start.offset
          let end = node.position?.end.offset
          if (
            typeof start === 'number' &&
            typeof end === 'number' &&
            start >= 0 &&
            end <= content.length &&
            end > start
          ) {
            const source = content.slice(start, end)
            if (/^(?:https?:\/\/|www\.)/i.test(source)) {
              const target = source.replace(/[，。；：！？、）】》」』]+$/u, '')
              if (target !== source) {
                node.properties.href = displayUrl(
                  /^www\./i.test(target) ? `http://${target}` : target
                )
                node.children = [{ type: 'text', value: target }]
                end = start + target.length
              }
            }
            if (
              typeof node.properties.href === 'string' &&
              (displayUrl(node.properties.href) ||
                (onOpenFile &&
                  source.startsWith('[') &&
                  parseFileReferenceLink(node.properties.href)))
            )
              links.push({ node, start, end })
          }
          return
        }
        if ('children' in node) node.children.forEach(collect)
      }
      collect(tree)
      // Restore user text after Markdown's whitespace normalization. Only
      // parsed links render as elements; other source text stays exact.
      const children: (Text | Element)[] = []
      let cursor = 0
      for (const link of links) {
        if (link.start < cursor) continue
        if (link.start > cursor)
          children.push({ type: 'text', value: content.slice(cursor, link.start) })
        children.push(link.node)
        cursor = link.end
      }
      if (cursor < content.length) children.push({ type: 'text', value: content.slice(cursor) })
      tree.children = children
    },
    [content, onOpenFile]
  )
  return (
    <FileReferenceContext.Provider value={onOpenFile}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[linksOnly]}
        skipHtml
        urlTransform={messageUrl}
        components={userComponents}
      >
        {content}
      </Markdown>
    </FileReferenceContext.Provider>
  )
}

export function MarkdownContent({
  content,
  onOpenFile
}: {
  content: string
  onOpenFile?: OpenFileReference
}): React.JSX.Element {
  return (
    <div className="markdown-body">
      <MarkdownSourceContext.Provider value={content}>
        <FileReferenceContext.Provider value={onOpenFile}>
          <Markdown
            remarkPlugins={[remarkGfm]}
            skipHtml
            urlTransform={messageUrl}
            components={components}
          >
            {content}
          </Markdown>
        </FileReferenceContext.Provider>
      </MarkdownSourceContext.Provider>
    </div>
  )
}
