export function restoreCollapsedDetailsFocus(details: HTMLDetailsElement | null): void {
  const summary = details?.querySelector<HTMLElement>(':scope > summary')
  const active = details?.ownerDocument.activeElement
  if (
    details &&
    summary &&
    active &&
    active !== details &&
    details.contains(active) &&
    !summary.contains(active)
  )
    summary.focus({ preventScroll: true })
}
