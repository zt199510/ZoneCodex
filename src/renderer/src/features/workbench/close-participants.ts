const participants = new Set<(conversationId?: string, committed?: boolean) => Promise<boolean>>()
export function registerPanelCloseParticipant(
  participant: (conversationId?: string, committed?: boolean) => Promise<boolean>
): () => void {
  participants.add(participant)
  return () => {
    participants.delete(participant)
  }
}
export async function preparePanelWindowClose(): Promise<boolean> {
  for (const participant of participants) if (!(await participant())) return false
  return true
}

export async function preparePanelConversationDelete(conversationId: string): Promise<boolean> {
  for (const participant of participants) if (!(await participant(conversationId))) return false
  return true
}
export async function completePanelConversationDelete(conversationId: string): Promise<void> {
  for (const participant of participants) await participant(conversationId, true)
}
