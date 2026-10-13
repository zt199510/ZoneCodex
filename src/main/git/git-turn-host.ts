type TurnStatus = 'completed' | 'interrupted' | 'failed'
type FinishTurn = (status: TurnStatus) => Promise<void>
let begin: ((windowId: number) => Promise<FinishTurn | undefined>) | undefined

/** Desktop-only lifecycle observation. No Agent request, output or authority crosses this seam. */
export function configureGitTurnHost(
  callback: (windowId: number) => Promise<FinishTurn | undefined>
): void {
  begin = callback
}
export async function beginSelectedGitTurn(windowId: number): Promise<FinishTurn | undefined> {
  try {
    const finish = await begin?.(windowId)
    if (!finish) return undefined
    let finished = false
    return async (status) => {
      if (finished) return
      finished = true
      try {
        await finish(status)
      } catch {
        // Git capture failure is displayed by Git; it does not change the Agent result.
      }
    }
  } catch {
    return undefined
  }
}
