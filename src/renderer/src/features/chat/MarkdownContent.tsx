import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Components } from 'react-markdown'

// 不传 base URL：相对路径、锚点和 //example.com 都不作为外链接受。
function displayUrl(value: string): string {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return ''
    if (url.username || url.password) return ''
    return url.href
  } catch {
    return ''
  }
}

const components: Components = {
  // 本课只显示可选择复制的地址，不创建 a 标签，不打开网页。
  a: ({ href, children }) => (
    <span className="markdown-link">
      {children}
      {href ? <span className="markdown-url">（{href}）</span> : '（链接不可用）'}
    </span>
  ),
  // 不输出 img 标签，所以不会请求模型文本里的图片地址。
  img: ({ alt }) => (
    <span className="markdown-image-placeholder">[图片未加载：{alt || '无说明'}]</span>
  ),
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
