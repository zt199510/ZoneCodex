import { isAgentId } from './agent'

export type AgentUserInputQuestion = {
  id: string
  header: string
  question: string
  options: Array<{ label: string; description: string }>
}

export type AgentUserInputArguments = { questions: AgentUserInputQuestion[] }
export type AgentUserInputAnswer = { id: string; answer: string }
export type AgentUserInputResult = { answers: AgentUserInputAnswer[] }

/** Runtime request identity never grants execution or survives a restart. */
export type AgentUserInputRequest = AgentUserInputArguments & {
  requestId: string
  conversationId: string
  inputId: string
  callId: string
}
export type AgentUserInputResponse = AgentUserInputResult & {
  requestId: string
  inputId: string
}

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const actual = Reflect.ownKeys(descriptors)
  return (
    actual.length === keys.length &&
    actual.every(
      (key) =>
        typeof key === 'string' &&
        keys.includes(key) &&
        descriptors[key].enumerable &&
        'value' in descriptors[key]
    )
  )
}

function boundedArray(value: unknown, minimum: number, maximum: number): value is unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) return false
  if (Object.getPrototypeOf(value) !== Array.prototype) return false
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const keys = Reflect.ownKeys(descriptors)
  return (
    keys.length === value.length + 1 &&
    keys.every(
      (key) =>
        key === 'length' ||
        (typeof key === 'string' &&
          /^(0|[1-9]\d*)$/.test(key) &&
          descriptors[key].enumerable &&
          'value' in descriptors[key])
    )
  )
}

function text(value: unknown, maximum: number, multiline = false): value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) return false
  return !Array.from(value).some((character) => {
    const code = character.charCodeAt(0)
    return code === 127 || (code < 32 && (!multiline || (code !== 9 && code !== 10 && code !== 13)))
  })
}

function questionId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,40}$/.test(value)
}

/** Same schema is used for model arguments, IPC cards and stored tool calls. */
export function parseAgentUserInputArguments(value: unknown): AgentUserInputArguments | null {
  try {
    if (!exact(value, ['questions']) || !boundedArray(value.questions, 1, 3)) return null
    const questions: AgentUserInputQuestion[] = []
    const ids = new Set<string>()
    for (const item of value.questions) {
      if (
        !exact(item, ['id', 'header', 'question', 'options']) ||
        !questionId(item.id) ||
        ids.has(item.id) ||
        !text(item.header, 24) ||
        !text(item.question, 500, true) ||
        !boundedArray(item.options, 2, 3)
      )
        return null
      const options: AgentUserInputQuestion['options'] = []
      const labels = new Set<string>()
      for (const option of item.options) {
        if (
          !exact(option, ['label', 'description']) ||
          !text(option.label, 80) ||
          !text(option.description, 200, true) ||
          labels.has(option.label.trim())
        )
          return null
        labels.add(option.label.trim())
        options.push({ label: option.label.trim(), description: option.description.trim() })
      }
      ids.add(item.id)
      questions.push({
        id: item.id,
        header: item.header.trim(),
        question: item.question.trim(),
        options
      })
    }
    const result = { questions }
    return JSON.stringify(value).length <= 4096 && JSON.stringify(result).length <= 4096
      ? result
      : null
  } catch {
    return null
  }
}

export function parseAgentUserInputRequest(value: unknown): AgentUserInputRequest | null {
  try {
    if (
      !exact(value, ['requestId', 'conversationId', 'inputId', 'callId', 'questions']) ||
      !isAgentId(value.requestId) ||
      !isAgentId(value.conversationId) ||
      !isAgentId(value.inputId) ||
      !text(value.callId, 200)
    )
      return null
    const args = parseAgentUserInputArguments({ questions: value.questions })
    return args
      ? {
          requestId: value.requestId,
          conversationId: value.conversationId,
          inputId: value.inputId,
          callId: value.callId,
          ...args
        }
      : null
  } catch {
    return null
  }
}

/** Answers must cover the displayed questions exactly once, in canonical question order. */
export function parseAgentUserInputAnswers(
  value: unknown,
  questions?: readonly AgentUserInputQuestion[]
): AgentUserInputAnswer[] | null {
  try {
    if (!boundedArray(value, 1, 3)) return null
    const answers: AgentUserInputAnswer[] = []
    const ids = new Set<string>()
    for (const item of value) {
      if (
        !exact(item, ['id', 'answer']) ||
        !questionId(item.id) ||
        ids.has(item.id) ||
        !text(item.answer, 1000, true)
      )
        return null
      ids.add(item.id)
      answers.push({ id: item.id, answer: item.answer.trim() })
    }
    if (!questions) return answers
    const args = parseAgentUserInputArguments({ questions })
    if (!args || args.questions.length !== answers.length) return null
    const byId = new Map(answers.map((answer) => [answer.id, answer]))
    const ordered: AgentUserInputAnswer[] = []
    for (const question of args.questions) {
      const answer = byId.get(question.id)
      if (!answer) return null
      ordered.push(answer)
    }
    return ordered
  } catch {
    return null
  }
}

export function parseAgentUserInputResult(
  value: unknown,
  questions: readonly AgentUserInputQuestion[]
): AgentUserInputResult | null {
  try {
    if (!exact(value, ['answers'])) return null
    const answers = parseAgentUserInputAnswers(value.answers, questions)
    if (!answers) return null
    const result = { answers }
    return JSON.stringify(result).length <= 12000 ? result : null
  } catch {
    return null
  }
}

export function parseAgentUserInputResponse(
  value: unknown,
  request?: AgentUserInputRequest
): AgentUserInputResponse | null {
  try {
    if (
      !exact(value, ['requestId', 'inputId', 'answers']) ||
      !isAgentId(value.requestId) ||
      !isAgentId(value.inputId) ||
      (request && (request.requestId !== value.requestId || request.inputId !== value.inputId))
    )
      return null
    const answers = parseAgentUserInputAnswers(value.answers, request?.questions)
    return answers ? { requestId: value.requestId, inputId: value.inputId, answers } : null
  } catch {
    return null
  }
}
