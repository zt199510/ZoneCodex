import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProjectSelection } from '../../../../shared/project'

import type { OperationControl } from '../conversation/useOperation'

type ProjectSelectionOptions = {
  conversationId: string | null
  operations: OperationControl
  canChange: () => boolean
}

type ProjectSelectionController = {
  projectSelection: ProjectSelection | null
  projectError: string | null
  clearError: () => void
  selectProjectFiles: () => Promise<boolean>
  revokeProjectFiles: () => Promise<boolean>
  removeFile: (path: string) => Promise<boolean>
  revokeSelectionForChange: () => Promise<boolean>
}

// 只管理临时文件选择；添加即授权当前会话使用附件；会话库和操作互斥仍由会话控制器协调。
export function useProjectSelection({
  conversationId,
  operations,
  canChange
}: ProjectSelectionOptions): ProjectSelectionController {
  const [projectError, setProjectError] = useState<string | null>(null)
  const [projectSelection, setProjectSelectionState] = useState<ProjectSelection | null>(null)
  const projectSelectionRef = useRef<ProjectSelection | null>(null)
  const setProjectSelection = useCallback((selection: ProjectSelection | null): void => {
    projectSelectionRef.current = selection
    setProjectSelectionState(selection)
  }, [])

  useEffect(() => {
    return () => {
      const selection = projectSelectionRef.current
      if (selection) void window.api.revokeProjectFiles(selection.snapshotId).catch(() => undefined)
    }
  }, [])

  async function revokeSelectionRaw(): Promise<boolean> {
    const selection = projectSelectionRef.current
    if (!selection) {
      return true
    }
    try {
      const revoked = await window.api.revokeProjectFiles(selection.snapshotId)
      if (!revoked) throw new Error('项目授权已失效，请重新选择文件。')
      setProjectSelection(null)
      return true
    } catch (error) {
      setProjectError(error instanceof Error ? error.message : '撤销项目授权失败，请重试。')
      return false
    }
  }

  async function revokeSelectionForChange(): Promise<boolean> {
    if (!projectSelectionRef.current) return true
    if (!operations.begin('selecting')) return false
    try {
      return await revokeSelectionRaw()
    } finally {
      operations.finish('selecting')
    }
  }

  async function selectProjectFiles(): Promise<boolean> {
    if (!conversationId || !canChange()) return false
    if (!operations.begin('selecting')) return false
    setProjectError(null)
    try {
      const result = await window.api.selectProjectFiles(conversationId)
      if (result.status === 'selected') {
        setProjectSelection(result.selection)
        return true
      }
      if (result.status === 'error') setProjectError(result.error)
      return false
    } catch {
      setProjectError('项目文件选择失败，请重试。')
      return false
    } finally {
      operations.finish('selecting')
    }
  }

  async function revokeProjectFiles(): Promise<boolean> {
    if (!canChange()) return false
    if (!projectSelectionRef.current) {
      return true
    }
    if (!operations.begin('selecting')) return false
    try {
      return await revokeSelectionRaw()
    } finally {
      operations.finish('selecting')
    }
  }

  async function removeFile(path: string): Promise<boolean> {
    const selection = projectSelectionRef.current
    if (!conversationId || !selection || !canChange() || !operations.begin('selecting'))
      return false
    setProjectError(null)
    try {
      const result = await window.api.removeProjectFile(conversationId, selection.snapshotId, path)
      if (result.status === 'selected' || result.status === 'cleared') {
        setProjectSelection(result.status === 'selected' ? result.selection : null)
        return true
      }
      if (result.status === 'error') setProjectError(result.error)
      return false
    } catch {
      setProjectError('附件移除失败，请重试。')
      return false
    } finally {
      operations.finish('selecting')
    }
  }

  return {
    projectSelection,
    projectError,
    clearError: () => setProjectError(null),
    selectProjectFiles,
    revokeProjectFiles,
    revokeSelectionForChange,
    removeFile
  }
}
