import type { PermissionMode } from '../../../../shared/execution'

export const permissionModeTitles: Record<PermissionMode, string> = {
  default: '请求批准',
  'auto-approve': '帮我批准',
  'full-access': '完全访问权限'
}

export const permissionModeOptions: Array<{ mode: PermissionMode; description: string }> = [
  { mode: 'default', description: '允许读取和当前可写范围内写入；范围外写入及需批准的命令先询问' },
  { mode: 'auto-approve', description: '需批准的操作先审核，必要时由你确认；审核失败仍需确认' },
  { mode: 'full-access', description: '跳过权限审批；文件、命令和运行环境的校验仍然生效' }
]
