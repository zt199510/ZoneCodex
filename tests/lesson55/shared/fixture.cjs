const questions = {
  questions: [
    {
      id: 'direction',
      header: '实施方向',
      question: '页面应该优先支持哪种布局？',
      options: [
        { label: '列表（推荐）', description: '先完成便于浏览的列表布局。' },
        { label: '卡片', description: '用卡片展示更多预览信息。' }
      ]
    }
  ]
}
const finalMessage = (text) => ({
  type: 'message',
  role: 'assistant',
  phase: 'final_answer',
  content: [{ type: 'output_text', text }]
})
const call = (name, args = questions, id = 'call-question-1') => ({
  type: 'function_call',
  call_id: id,
  name,
  arguments: JSON.stringify(args)
})
const response = (...output) => ({ status: 'completed', output })
const clone = structuredClone

function accessorObject(source, key, value) {
  const object = clone(source)
  let read = false
  Object.defineProperty(object, key, {
    enumerable: true,
    get() {
      read = true
      return value
    }
  })
  return { object, wasRead: () => read }
}

function hostileObjects(source) {
  const symbolObject = clone(source)
  symbolObject[Symbol('unexpected')] = 'unexpected'
  const inherited = Object.assign(Object.create({ inherited: true }), clone(source))
  const extra = { ...clone(source), unexpected: true }
  return { symbolObject, inherited, extra }
}

module.exports = { questions, finalMessage, call, response, clone, accessorObject, hostileObjects }
