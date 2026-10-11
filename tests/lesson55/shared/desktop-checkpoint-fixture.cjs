/** Synthetic persistence adapter for existing desktop lifecycle/material suites.
 * They retain real tool filesystem work and all original protection assertions.
 * Actual checkpoint schema, disk and new-PID resume are independently checked
 * by lesson57; these legacy suites do not claim checkpoint persistence coverage.
 */
function desktopCheckpointFixture(saveOverride) {
  const store = {
    save: async (checkpoint, history) =>
      saveOverride
        ? saveOverride(structuredClone(checkpoint), structuredClone(history))
        : {
            ok: true,
            file: 'synthetic-desktop-checkpoint',
            checkpoint: structuredClone(checkpoint)
          },
    findByConversation: async () => null,
    load: async () => {
      throw new Error('Legacy desktop protection suite must not resume a task')
    }
  }
  return {
    desktopCheckpointStore: () => store,
    getResumableAgentTask: async () => null
  }
}
module.exports = { desktopCheckpointFixture }
