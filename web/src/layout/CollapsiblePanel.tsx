import { ChevronDown, ChevronRight, GripVertical } from 'lucide-react'
import type { ReactNode } from 'react'

type DragHandleProps = {
  onPointerDown?: ((e: React.PointerEvent) => void) | undefined
  'data-drag-handle'?: boolean | undefined
}

type CollapsiblePanelProps = {
  id: string
  children: ReactNode
  collapsed: boolean
  onToggle: () => void
  dragHandleProps?: DragHandleProps | undefined
  title?: string | undefined
  icon?: ReactNode | undefined
  rightSlot?: ReactNode | undefined
  subtitle?: ReactNode | undefined
  headerContent?: ReactNode | undefined
  showChevron?: boolean | undefined
}

export const CollapsiblePanel = ({
  id,
  children,
  collapsed,
  onToggle,
  dragHandleProps,
  title,
  icon,
  rightSlot,
  subtitle,
  headerContent,
  showChevron = true,
}: CollapsiblePanelProps) => {
  const defaultHeader = (
    <>
      <div className="collapsible-panel__row1">
        <span
          className="collapsible-panel__drag"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          {...dragHandleProps}
        >
          <GripVertical size={12} aria-hidden />
        </span>
        {icon ? <span className="collapsible-panel__icon">{icon}</span> : null}
        {title ? <span className="collapsible-panel__title">{title}</span> : null}
        {rightSlot ? <span className="collapsible-panel__summary">{rightSlot}</span> : null}
        {showChevron ? (
          <span className="collapsible-panel__toggle" aria-hidden>
            {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          </span>
        ) : null}
      </div>
      {subtitle ? (
        <div className="collapsible-panel__row2">
          {subtitle}
        </div>
      ) : null}
    </>
  )

  return (
    <section className="collapsible-panel" data-panel-id={id} data-collapsed={collapsed || undefined}>
      <header
        className={`collapsible-panel__header${subtitle ? ' collapsible-panel__header--two-line' : ''}`}
        onClick={onToggle}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle() } }}
        aria-expanded={!collapsed}
        aria-controls={`panel-content-${id}`}
      >
        {headerContent ?? defaultHeader}
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
