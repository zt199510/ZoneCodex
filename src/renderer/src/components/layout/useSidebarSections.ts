import { useEffect, useState } from 'react'

const storageKey = 'zonecodex.sidebar.collapsed-sections'

function savedSections(): Record<string, boolean> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '{}')
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {}
    return Object.fromEntries(
      Object.entries(saved).filter(([, value]) => typeof value === 'boolean')
    )
  } catch {
    return {}
  }
}

export function useSidebarSections(): {
  isCollapsed: (key: string) => boolean
  toggleSection: (key: string) => void
} {
  const [sections, setSections] = useState(savedSections)

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(sections))
    } catch {
      // Section folding still works when storage is unavailable.
    }
  }, [sections])

  return {
    isCollapsed: (key) => sections[key] === true,
    toggleSection: (key) => setSections((previous) => ({ ...previous, [key]: !previous[key] }))
  }
}
