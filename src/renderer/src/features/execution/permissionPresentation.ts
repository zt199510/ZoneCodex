import type { PermissionMode } from '../../../../shared/execution'

export const permissionModeTitles: Record<PermissionMode, string> = {
  default: '请求批准',
  'auto-approve': '帮我批准',
  'full-access': '完全访问权限'
}

export const permissionModeOptions: Array<{ mode: PermissionMode; description: string }> = [
  { mode: 'default', description: '编辑外部文件和使用互联网时始终询问' },
  { mode: 'auto-approve', description: '仅对检测到的风险操作请求批准' },
  { mode: 'full-access', description: '可不受限制地访问互联网和你电脑上的任何文件' }
]
