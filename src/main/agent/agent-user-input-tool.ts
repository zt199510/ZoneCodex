/** Pure tool definition; each host supplies its own request-bound question backend. */
export const requestUserInputTool = {
  type: 'function',
  name: 'request_user_input',
  description:
    '计划模式中，在关键目标、范围或偏好无法从现有证据确定时向用户提问。等待用户回答后继续研究并完成方案；答案不代表执行批准。',
  strict: true,
  parameters: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        minItems: 1,
        maxItems: 3,
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', minLength: 1, maxLength: 40, pattern: '^[a-zA-Z0-9_-]+$' },
            header: { type: 'string', minLength: 1, maxLength: 24 },
            question: { type: 'string', minLength: 1, maxLength: 500 },
            options: {
              type: 'array',
              minItems: 2,
              maxItems: 3,
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string', minLength: 1, maxLength: 80 },
                  description: { type: 'string', minLength: 1, maxLength: 200 }
                },
                required: ['label', 'description'],
                additionalProperties: false
              }
            }
          },
          required: ['id', 'header', 'question', 'options'],
          additionalProperties: false
        }
      }
    },
    required: ['questions'],
    additionalProperties: false
  }
} as const
