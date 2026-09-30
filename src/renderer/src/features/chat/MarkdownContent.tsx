import { Children, isValidElement, useEffect, useRef, useState } from 'react'
import type { MouseEvent, ReactNode } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Components } from 'react-markdown'
import { Icon } from '../../components/ui/Icon'

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
      <pre>{codeElement ?? children}</pre>
    </div>
  )
}

function ExternalLink({
  href,
  children
}: {
  href?: string
  children?: ReactNode
}): React.JSX.Element {
  const safeHref = href ? displayUrl(href) : ''
  if (!safeHref) {
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
  a: ({ href, children }) => <ExternalLink href={href}>{children}</ExternalLink>,
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

export function MarkdownContent({ content }: { content: string }): React.JSX.Element {
  return (
    <div className="markdown-body">
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={displayUrl}
        components={components}
      >
        {content}
      </Markdown>
    </div>
  )
}
