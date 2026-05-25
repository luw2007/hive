import type { ReactNode } from 'react'

type CollapsiblePanelProps = {
  id: string
  children: ReactNode
  collapsed: boolean
  onToggle: () => void
  headerContent: ReactNode
}

export const CollapsiblePanel = ({
  id,
  children,
  collapsed,
  onToggle,
  headerContent,
}: CollapsiblePanelProps) => {
  return (
    <section className="collapsible-panel" data-panel-id={id} data-collapsed={collapsed || undefined}>
      <header
        className="collapsible-panel__header"
        onClick={onToggle}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle() } }}
        aria-expanded={!collapsed}
        aria-controls={`panel-content-${id}`}
      >
        {headerContent}
      </header>
      <div
        id={`panel-content-${id}`}
        className="collapsible-panel__content"
        aria-hidden={collapsed}
      >
        {children}
      </div>
    </section>
  )
}
