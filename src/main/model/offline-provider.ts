import type { ModelProvider } from './model-contract'

export const offlineModelNotice = '当前为离线模式，未调用推理模型，也未执行本轮任务。'
export const offlineProvider: ModelProvider = Object.freeze({
  id: 'offline',
  label: '离线模式（无模型推理）',
  capabilities: Object.freeze({ tools: false, images: false, summary: false, title: false,
    riskReview: false, gitGeneration: false, resume: false }),
  createSender: () => async (_input, signal, options = {}) => {
    signal.throwIfAborted()
    options.onTextDelta?.(offlineModelNotice)
    signal.throwIfAborted()
    options.onMessageEvent?.({ attempt: 0, outputIndex: 0, phase: 'final_answer', text: offlineModelNotice })
    signal.throwIfAborted()
    return { status: 'completed', output: [{ type: 'message', role: 'assistant',
      phase: 'final_answer', content: [{ type: 'output_text', text: offlineModelNotice }] }] }
  }
})
