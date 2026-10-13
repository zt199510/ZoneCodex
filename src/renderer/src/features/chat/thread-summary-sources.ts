import type { ChatMessage } from '../../../../shared/conversation'
import type { ToolRun } from '../../../../shared/agent-history'
import {
  parseFileReference,
  parseFileReferenceLink,
  type FileReference
} from '../../../../shared/file-view'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import type { Nodes } from 'mdast'
import type { FileViewOrigin } from '../files/file-view-origin'
import { activityBlocks, readObject, toolState } from './message-activity-model'

export type ThreadSummarySource = {
  key: string
  reference: FileReference
  origin: FileViewOrigin
}

const markdownParser = unified().use(remarkParse).use(remarkGfm)
const referenceCache = new WeakMap<ChatMessage, { content: string; references: FileReference[] }>()

function messageFileReferences(message: ChatMessage): FileReference[] {
  const previous = referenceCache.get(message)
  if (previous?.content === message.content) return previous.references
  const tree = markdownParser.parse(message.content)
  const definitions = new Map<string, string>()
  const references: FileReference[] = []
  const visit = (node: Nodes, callback: (node: Nodes) => void): void => {
    callback(node)
    if ('children' in node) node.children.forEach((child) => visit(child, callback))
  }
  visit(tree, (node) => {
    if (node.type === 'definition' && !definitions.has(node.identifier))
      definitions.set(node.identifier, node.url)
  })
  visit(tree, (node) => {
    const url =
      node.type === 'link'
        ? node.url
        : node.type === 'linkReference'
          ? definitions.get(node.identifier)
          : undefined
    const reference = url ? parseFileReferenceLink(url) : null
    if (reference) references.push(reference)
  })
  referenceCache.set(message, { content: message.content, references })
  return references
}

// Reuse the same local/snapshot boundaries as the message's file links. A
// Sources row represents an actual attachment, citation, or successfully read file.
export function threadSummarySources(
  messages: readonly ChatMessage[],
  toolRuns: readonly ToolRun[]
): ThreadSummarySource[] {
  const sources = new Map<string, ThreadSummarySource>()
  const add = (reference: FileReference, origin: FileViewOrigin): void => {
    const location =
      origin.source.kind === 'snapshot'
        ? `snapshot:${origin.source.snapshotId}`
        : `local:${origin.scope?.workspaceId ?? ''}:${origin.scope?.executionId ?? ''}`
    const key = `${location}:${reference.path}`
    sources.set(key, { key, reference, origin })
  }
  for (const message of messages) {
    const run = toolRuns.find(
      (item) => item.userId === message.id || item.assistantId === message.id
    )
    for (const attachment of message.attachments ?? []) {
      const reference = parseFileReference({ path: attachment.path })
      if (!reference) continue
      add(reference, {
        messageId: message.id,
        scope: run?.scope,
        source:
          run?.scope.kind === 'project'
            ? { kind: 'snapshot', snapshotId: run.scope.snapshotId }
            : { kind: 'local' }
      })
    }
    if (message.role === 'system') continue
    const attachments = run
      ? messages.find((item) => item.id === run.userId)?.attachments
      : message.attachments
    for (const reference of messageFileReferences(message)) {
      const snapshotAlias =
        run?.scope.kind === 'project' &&
        attachments?.some((attachment) => attachment.path === reference.path)
      add(reference, {
        messageId: message.id,
        scope: run?.scope,
        source:
          snapshotAlias && run?.scope.kind === 'project'
            ? { kind: 'snapshot', snapshotId: run.scope.snapshotId }
            : { kind: 'local' }
      })
    }
  }
  for (const run of toolRuns) {
    const message = messages.find((item) => item.id === run.assistantId)
    if (!message) continue
    for (const block of activityBlocks(run.items)) {
      if (block.kind !== 'tools') continue
      for (const call of block.calls) {
        if (
          !['read_project_file', 'read_workspace_file'].includes(call.name) ||
          toolState(call, message.status) !== 'completed'
        )
          continue
        const args = readObject(call.arguments)
        const result = readObject(call.output)
        const reference = parseFileReference({ path: result?.path ?? args?.path })
        if (!reference) continue
        if (call.name === 'read_project_file' && run.scope.kind !== 'project') continue
        add(reference, {
          messageId: message.id,
          scope: run.scope,
          source:
            call.name === 'read_project_file' && run.scope.kind === 'project'
              ? { kind: 'snapshot', snapshotId: run.scope.snapshotId }
              : { kind: 'local' }
        })
      }
    }
  }
  return [...sources.values()]
}
