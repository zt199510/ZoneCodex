import {
  Children,
  createContext,
  isValidElement,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
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

function CodeBlock({ children }: { children?: ReactNode }): React.JSX.Element {
  const codeElement = Children.toArray(children).find((child) =>
    isValidElement<CodeElementProps>(child)
  )
  const codeProps = isValidElement<CodeElementProps>(codeElement) ? codeElement.props : undefined
  const code = textContent(codeProps?.children ?? children)
  const className = codeProps?.className ?? ''
  const languageMatch = /(?:^|\s)language-([a-zA-Z0-9_+#.-]+)/.exec(className)
  const language = languageMatch?.[1] ?? 'text'
  const highlighted = useMemo(() => highlightedCode(code, language), [code, language])
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const resetTimer = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current)
    },
    []
  )

  function showCopyState(state: 'copied' | 'failed'): void {
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current)
    setCopyState(state)
    resetTimer.current = window.setTimeout(() => {
      resetTimer.current = null
      setCopyState('idle')
    }, 1400)
  }

  function copyCode(event: MouseEvent<HTMLButtonElement>): void {
    event.preventDefault()
    event.stopPropagation()
    if (!navigator.clipboard) {
      showCopyState('failed')
      return
    }
    void navigator.clipboard.writeText(code).then(
      () => showCopyState('copied'),
      () => showCopyState('failed')
    )
  }

  return (
    <div className="markdown-code-block">
      <div className="markdown-code-toolbar">
        <span className="markdown-code-language">{language}</span>
        <button
          type="button"
          className="markdown-code-copy"
          onClick={copyCode}
          aria-label={
            copyState === 'copied' ? '代码已复制' : copyState === 'failed' ? '复制失败' : '复制代码'
          }
          title={
            copyState === 'copied' ? '代码已复制' : copyState === 'failed' ? '复制失败' : '复制代码'
          }
        >
          <Icon
            name={copyState === 'copied' ? 'check' : copyState === 'failed' ? 'close' : 'copy'}
            size={14}
          />
        </button>
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
    <a className="markdown-link" href={safeHref} target="_blank" rel="noreferrer" onClick={open}>
      {children}
    </a>
  )
}

const components: Components = {
  a: ({ href, children }) => <MessageLink href={href}>{children}</MessageLink>,
  // 不输出 img 标签，所以不会请求模型文本里的图片地址。
  img: ({ alt }) => (
    <span className="markdown-image-placeholder">[图片未加载：{alt || '无说明'}]</span>
  ),
  input: (props) => <input {...props} disabled readOnly />,
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
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
    </div>
  )
}
