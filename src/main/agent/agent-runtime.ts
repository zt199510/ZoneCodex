import { buildAgentRequest } from './agent-instructions'
import { createAgentToolExecutor } from './agent-tools'
import { createProjectExecutor } from '../tools/project-file-tools'
import { createChangeProposalExecutor } from '../tools/change-proposal'
import type { ModelConfiguration } from '../model/model-configuration'
import type { ModelSession } from '../model/model-contract'
import { createModelSession, assertModelInput } from '../model/model-session'
import { createContextSummaryResponse } from '../model/context-summary'
import type { AgentCoreDependencies, AgentCoreObserver } from './agent-core-contract'
import type { ExecuteTool } from './tool-loop'
import { validateSkillSnapshotHash } from '../skills/skill-reader'

type RuntimeInput = {
  capabilities: Parameters<typeof buildAgentRequest>[0]
  configuration?: ModelConfiguration
  session?: ModelSession
  imageCount?: number
  imageBytes?: number
}

/** Shared request assembly; importing it never captures host state or starts I/O. */
export function createAgentRuntime({
  capabilities,
  configuration,
  session,
  imageCount = 0,
  imageBytes = 0
}: RuntimeInput): Pick<AgentCoreDependencies, 'send' | 'summarize' | 'networkOverhead' | 'mcpToolNames'> {
  if (capabilities.skill && !validateSkillSnapshotHash(capabilities.skill))
    throw new Error('技能快照指纹不一致')
  const request = buildAgentRequest(capabilities)
  const fixedSession = session ?? createModelSession(configuration)
  assertModelInput(fixedSession, imageCount > 0 || Boolean(capabilities.imagePresent), Boolean(capabilities.resuming))
  return {
    mcpToolNames: Object.freeze(capabilities.mode === 'execute' && fixedSession.capabilities.tools
      ? (capabilities.mcpTools ?? []).map((tool) => (tool as { qualifiedName: string }).qualifiedName) : []),
    send: fixedSession.createSend({ purpose: 'agent', tools: request.tools, instructions: request.instructions }),
    summarize: fixedSession.capabilities.summary ? createContextSummaryResponse(fixedSession) : undefined,
    networkOverhead: {
      instructionsCharacters: request.instructions.length,
      toolSchemaCharacters: JSON.stringify(request.tools).length,
      imageCount,
      imageBytes
    }
  }
}

type ToolOptions = Parameters<typeof createAgentToolExecutor>[0]
type HostToolBridges = Omit<
  ToolOptions,
  'projectExecutor' | 'appendTrace' | 'onProgress' | 'onEffect'
> & { conversationId: string }

/** A fresh executor/evidence set per invocation; hosts supply approval and input bridges. */
export function createAgentRuntimeTools(
  { conversationId, ...bridges }: HostToolBridges,
  observer: AgentCoreObserver
): ExecuteTool {
  const snapshot = bridges.projectSnapshot
  const projectExecutor = snapshot
    ? bridges.mode === 'plan'
      ? createProjectExecutor(snapshot)
      : createChangeProposalExecutor(snapshot, conversationId)
    : undefined
  return createAgentToolExecutor({
    ...bridges,
    projectExecutor,
    appendTrace: observer.appendTrace,
    onProgress: observer.progress,
    onEffect: observer.effectStarted
  })
}
