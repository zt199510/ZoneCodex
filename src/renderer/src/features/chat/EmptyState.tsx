import { Icon } from '../../components/ui/Icon'
import type { IconName } from '../../components/ui/Icon'

const suggestions: { icon: IconName; title: string; description: string; prompt: string }[] = [
  {
    icon: 'code',
    title: '理解一段代码',
    description: '把复杂逻辑，拆成清楚的步骤',
    prompt: '请帮我理解下面这段代码，先说明整体作用，再逐步解释关键逻辑：\n\n'
  },
  {
    icon: 'spark',
    title: '梳理一个想法',
    description: '从初步想法，到可行的方案',
    prompt: '我有一个想法，想请你帮我梳理目标、需要解决的问题和实现步骤：\n\n'
  },
  {
    icon: 'book',
    title: '巩固一个概念',
    description: '用熟悉的例子，理解新知识',
    prompt: '请用一个简单的例子解释 React 的 state、ref 和闭包分别有什么作用。'
  }
]

export function EmptyState({
  disabled,
  onSuggestion
}: {
  disabled: boolean
  onSuggestion: (prompt: string) => void
}): React.JSX.Element {
  return (
    <div className="empty-state">
      <div className="welcome-mark">
        <Icon name="code" size={32} />
      </div>
      <p className="welcome-eyebrow">ZONECODEX · 个人工作空间</p>
      <h2>从一个想法开始。</h2>
      <p className="welcome-description">讨论问题、梳理思路，把下一步想清楚。</p>
      <div className="suggestion-grid">
        {suggestions.map((suggestion) => (
          <button
            key={suggestion.title}
            className="suggestion-card"
            disabled={disabled}
            onClick={() => onSuggestion(suggestion.prompt)}
          >
            <Icon name={suggestion.icon} size={21} />
            <strong>{suggestion.title}</strong>
            <span>{suggestion.description}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
