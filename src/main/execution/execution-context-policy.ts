import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { ExecutionInfo } from '../../shared/execution'
import { decideLocalPermission, type LocalPermissionDecision } from '../../shared/permission-policy'

export type ExecutionContext = {
  info: ExecutionInfo
  writableRoots: readonly string[]
}

export function pathWithin(root: string, candidate: string): boolean {
  const offset = relative(resolve(root), resolve(candidate))
  return offset === '' || (!isAbsolute(offset) && offset !== '..' && !offset.startsWith(`..${sep}`))
}

export function localPermission(
  execution: ExecutionContext,
  operation: 'read' | 'write' | 'command',
  target: string
): LocalPermissionDecision {
  return decideLocalPermission({
    operation,
    mode: execution.info.mode,
    withinWritableRoots: execution.writableRoots.some((root) => pathWithin(root, target)),
    sandboxAvailable: false
  })
}
