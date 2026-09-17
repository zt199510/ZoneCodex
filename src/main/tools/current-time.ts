export const timeTool = {
  type: 'function',
  name: 'get_current_time',
  description: '读取本机当前时间，仅支持 UTC 或 Asia/Hong_Kong。询问当前时间时使用。',
  strict: true,
  parameters: {
    type: 'object',
    properties: { timeZone: { type: 'string', enum: ['UTC', 'Asia/Hong_Kong'] } },
    required: ['timeZone'],
    additionalProperties: false
  }
}

export function executeTimeTool(name: string, rawArguments: string): string {
  if (name !== 'get_current_time') {
    return JSON.stringify({ ok: false, error: 'UNKNOWN_TOOL' })
  }
  let args: unknown
  try {
    args = JSON.parse(rawArguments)
  } catch {
    return JSON.stringify({ ok: false, error: 'INVALID_JSON' })
  }
  if (
    typeof args !== 'object' ||
    args === null ||
    Array.isArray(args) ||
    Object.keys(args).length !== 1 ||
    !('timeZone' in args) ||
    (args.timeZone !== 'UTC' && args.timeZone !== 'Asia/Hong_Kong')
  ) {
    return JSON.stringify({ ok: false, error: 'INVALID_TIME_ZONE' })
  }
  const now = new Date()
  return JSON.stringify({
    ok: true,
    timeZone: args.timeZone,
    utc: now.toISOString(),
    localTime: new Intl.DateTimeFormat('zh-CN', {
      timeZone: args.timeZone,
      dateStyle: 'full',
      timeStyle: 'long'
    }).format(now)
  })
}
