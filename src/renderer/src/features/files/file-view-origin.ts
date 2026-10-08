import type { FileReference } from '../../../../shared/file-view'
import type { ToolScope } from '../../../../shared/project'

export type FileViewOrigin = {
  messageId: string
  scope?: ToolScope
  source: { kind: 'local' } | { kind: 'snapshot'; snapshotId: string }
}

export type OpenFileView = (
  reference: FileReference,
  origin: FileViewOrigin,
  trigger: HTMLElement
) => void

export type OpenFileReference = (reference: FileReference, trigger: HTMLElement) => void
