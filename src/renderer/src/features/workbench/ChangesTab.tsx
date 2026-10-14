import { useEffect } from 'react'
import { useGitView } from '../git/useGitView'
import { GitWorkbenchPanel } from '../git/GitWorkbenchPanel'
export function ChangesTab({
  active,
  onClose
}: {
  active: boolean
  onClose: () => void
}): React.JSX.Element {
  const controller = useGitView(true, false, false)
  // The tab owns its Git view; global Git modal shortcuts are disabled.
  const open = controller.open
  useEffect(() => {
    const frame = requestAnimationFrame(() => open(document.body))
    return () => cancelAnimationFrame(frame)
  }, [open])
  return (
    <GitWorkbenchPanel
      state={{ ...controller.state, open: true }}
      cleanupError={controller.cleanupError}
      directoryDisabled={false}
      onSelectDirectory={controller.selectDirectory}
      onAdoptView={controller.adoptView}
      onClose={onClose}
      onRefresh={controller.refresh}
      onReadItem={controller.readItem}
      active={active}
    />
  )
}
