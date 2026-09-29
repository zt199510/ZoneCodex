import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ProjectInstruction,
  SavedWorkspace,
  Workspace
} from '../../../../shared/project'
import type { OperationControl } from '../conversation/useOperation'

export type WorkspaceInstructionState = 'none' | 'absent' | 'read' | 'error'

export type WorkspaceController = {
  /** Runtime grant and instruction for the currently active conversation. */
  runtime: Workspace | null
  saved: SavedWorkspace | null
  instruction: ProjectInstruction | null
  instructionState: WorkspaceInstructionState
  error: string | null
  selecting: boolean
  canSelect: boolean
  select: () => Promise<boolean>
  clear: () => Promise<boolean>
  readInstruction: () => Promise<boolean>
  release: () => Promise<boolean>
}

type WorkspaceOptions = {
  conversationId: string | null
  saved: SavedWorkspace | null
  operations: OperationControl
  canChange: () => boolean
  onSavedChange: (workspace: SavedWorkspace | null) => void
}

function savedFromRuntime(workspace: Workspace): SavedWorkspace {
  return {
    workspaceId: workspace.workspaceId,
    root: workspace.root,
    label: workspace.label,
    instructionPath: workspace.instruction?.path ?? null,
    instructionFingerprint: workspace.instruction?.fingerprint ?? null
  }
}

function initialInstructionState(): WorkspaceInstructionState {
  // Saved metadata survives a reload, but the main-process directory grant
  // does not. The instruction must be read again after authorization.
  return 'none'
}

/**
 * Keeps the persisted workspace metadata separate from the live directory grant.
 * A reload can restore the label, but the runtime grant must be selected again.
 */
export function useWorkspace({
  conversationId,
  saved,
  operations,
  canChange,
  onSavedChange
}: WorkspaceOptions): WorkspaceController {
  const [runtime, setRuntime] = useState<Workspace | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [instructionState, setInstructionState] = useState<WorkspaceInstructionState>(() =>
    initialInstructionState()
  )
  const runtimeRef = useRef<Workspace | null>(null)
  const conversationRef = useRef<string | null>(conversationId)
  const transitionRef = useRef(0)

  const setRuntimeState = useCallback((next: Workspace | null): void => {
    runtimeRef.current = next
    setRuntime(next)
  }, [])

  const release = useCallback(async (): Promise<boolean> => {
    const id = conversationRef.current
    const current = runtimeRef.current
    if (!id || !current) {
      setRuntimeState(null)
      return true
    }
    try {
      const released = await window.api.clearWorkspace(id)
      if (released) setRuntimeState(null)
      return released
    } catch {
      return false
    }
  }, [setRuntimeState])

  useEffect(() => {
    const previousId = conversationRef.current
    if (previousId === conversationId) return
    const transition = transitionRef.current + 1
    transitionRef.current = transition
    if (previousId && runtimeRef.current) {
      void window.api.clearWorkspace(previousId).catch(() => undefined)
    }
    conversationRef.current = conversationId
    runtimeRef.current = null
    queueMicrotask(() => {
      if (transitionRef.current !== transition) return
      setRuntimeState(null)
      setError(null)
      setInstructionState(initialInstructionState())
    })
  }, [conversationId, setRuntimeState])

  useEffect(() => {
    if (!runtimeRef.current) setInstructionState(initialInstructionState())
  }, [saved?.workspaceId, saved?.instructionPath])

  useEffect(
    () => () => {
      const id = conversationRef.current
      if (id && runtimeRef.current) void window.api.clearWorkspace(id).catch(() => undefined)
    },
    []
  )

  const select = useCallback(async (): Promise<boolean> => {
    if (!conversationId || !canChange() || !operations.begin('selecting')) return false
    setError(null)
    try {
      const result = await window.api.selectWorkspace(conversationId, crypto.randomUUID())
      if (result.status === 'selected') {
        setRuntimeState(result.workspace)
        const nextSaved = savedFromRuntime(result.workspace)
        onSavedChange(nextSaved)
        setInstructionState(result.workspace.instruction ? 'read' : 'absent')
        return true
      }
      if (result.status === 'error') setError(result.error)
      return false
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '工作区选择失败，请重试。')
      return false
    } finally {
      operations.finish('selecting')
    }
  }, [canChange, conversationId, onSavedChange, operations, setRuntimeState])

  const clear = useCallback(async (): Promise<boolean> => {
    if (!conversationId || !canChange() || !operations.begin('selecting')) return false
    setError(null)
    try {
      const cleared = await window.api.clearWorkspace(conversationId)
      if (!cleared) {
        setError('清除工作区失败，请重试。')
        return false
      }
      setRuntimeState(null)
      onSavedChange(null)
      setInstructionState('none')
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '清除工作区失败，请重试。')
      return false
    } finally {
      operations.finish('selecting')
    }
  }, [canChange, conversationId, onSavedChange, operations, setRuntimeState])

  const readInstruction = useCallback(async (): Promise<boolean> => {
    if (!conversationId || !runtimeRef.current || !canChange() || !operations.begin('selecting'))
      return false
    setError(null)
    try {
      const result = await window.api.readWorkspaceInstruction(conversationId)
      if (result.status === 'read') {
        const next = { ...runtimeRef.current, instruction: result.instruction }
        setRuntimeState(next)
        onSavedChange(savedFromRuntime(next))
        setInstructionState('read')
        return true
      }
      if (result.status === 'absent') {
        const next = { ...runtimeRef.current, instruction: null }
        setRuntimeState(next)
        onSavedChange(savedFromRuntime(next))
        setInstructionState('absent')
        return true
      }
      setInstructionState('error')
      setError(result.error)
      return false
    } catch (cause) {
      setInstructionState('error')
      setError(cause instanceof Error ? cause.message : '读取项目指令失败，请重试。')
      return false
    } finally {
      operations.finish('selecting')
    }
  }, [canChange, conversationId, onSavedChange, operations, setRuntimeState])

  return {
    runtime,
    saved,
    instruction: runtime?.instruction ?? null,
    instructionState,
    error,
    selecting: operations.operation === 'selecting',
    canSelect: conversationId !== null,
    select,
    clear,
    readInstruction,
    release
  }
}
