import { useEffect, useRef, useState } from 'react'
import type {
  AgentUserInputRequest,
  AgentUserInputResponse
} from '../../../../shared/agent-user-input'

export function PlanQuestionCard({
  request,
  onRespond,
  onCancel,
  disabled = false
}: {
  request: AgentUserInputRequest
  onRespond: (response: AgentUserInputResponse) => Promise<boolean>
  onCancel: () => Promise<void>
  disabled?: boolean
}): React.JSX.Element {
  const form = useRef<HTMLFormElement>(null)
  const submittingRef = useRef(false)
  const [choices, setChoices] = useState(new Map<string, string>())
  const [customAnswers, setCustomAnswers] = useState(new Map<string, string>())
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const answers = request.questions.map((question) => ({
    id: question.id,
    answer:
      choices.get(question.id) === 'custom'
        ? (customAnswers.get(question.id) ?? '').trim()
        : (question.options[Number(choices.get(question.id))]?.label ?? '')
  }))
  const complete = answers.every((answer) => answer.answer.length > 0)

  useEffect(() => {
    if (document.querySelector('dialog[open], [popover]:popover-open')) return
    form.current?.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true })
  }, [])

  async function submit(): Promise<void> {
    if (!complete || disabled || submittingRef.current) return
    submittingRef.current = true
    setSubmitting(true)
    setError(null)
    try {
      const accepted = await onRespond({
        requestId: request.requestId,
        inputId: request.inputId,
        answers
      })
      if (!accepted) setError('问题已失效或回答未被接受，请核对当前请求。')
    } catch {
      setError('回答发送失败，请重试。')
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  return (
    <form
      className="plan-question-card"
      ref={form}
      aria-label="计划问题"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <p className="plan-question-title">请补充以下信息</p>
      {request.questions.map((question, questionIndex) => (
        <fieldset key={question.id} disabled={disabled || submitting}>
          <legend>
            <span className="plan-question-header">{question.header}</span>
            {question.question}
          </legend>
          {question.options.map((option, index) => (
            <label className="plan-question-option" key={option.label}>
              <input
                type="radio"
                name={`${request.inputId}-${question.id}`}
                value={index}
                checked={choices.get(question.id) === String(index)}
                onChange={() =>
                  setChoices((previous) => new Map(previous).set(question.id, String(index)))
                }
              />
              <span>
                <strong>{option.label}</strong>
                <span className="plan-question-description">{option.description}</span>
              </span>
            </label>
          ))}
          <label className="plan-question-option">
            <input
              type="radio"
              name={`${request.inputId}-${question.id}`}
              value="custom"
              checked={choices.get(question.id) === 'custom'}
              onChange={() =>
                setChoices((previous) => new Map(previous).set(question.id, 'custom'))
              }
            />
            <span>自定义回答</span>
          </label>
          {choices.get(question.id) === 'custom' && (
            <textarea
              className="plan-question-custom"
              aria-label={`问题${questionIndex + 1}的自定义回答`}
              placeholder="填写你的想法"
              maxLength={1000}
              rows={3}
              value={customAnswers.get(question.id) ?? ''}
              onChange={(event) =>
                setCustomAnswers((previous) =>
                  new Map(previous).set(question.id, event.target.value)
                )
              }
            />
          )}
        </fieldset>
      ))}
      {error && (
        <p className="plan-question-error" role="alert">
          {error}
        </p>
      )}
      <div className="plan-question-actions">
        <button type="button" disabled={disabled} onClick={() => void onCancel()}>
          取消本轮
        </button>
        <button type="submit" disabled={!complete || disabled || submitting}>
          {submitting ? '正在提交…' : '提交回答'}
        </button>
      </div>
    </form>
  )
}
