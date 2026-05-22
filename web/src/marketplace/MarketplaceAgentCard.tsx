import { Check } from 'lucide-react'

import type { MarketplaceAgentEntry } from '../api.js'

interface MarketplaceAgentCardProps {
  agent: MarketplaceAgentEntry
  selected: boolean
  imported: boolean
  onSelect: () => void
}

// Upstream colors come in two shapes: CSS named colors ('purple') and hex
// ('#D97706'). Both are valid CSS color values; we just pass through. Falls
// back to the theme border when missing.
const sidebarColor = (raw: string | null): string =>
  raw && raw.trim().length > 0 ? raw : 'var(--border-bright)'

export const MarketplaceAgentCard = ({
  agent,
  selected,
  imported,
  onSelect,
}: MarketplaceAgentCardProps) => (
  <button
    type="button"
    onClick={onSelect}
    data-testid="marketplace-agent-card"
    data-agent-path={agent.path}
    data-imported={imported ? 'true' : undefined}
    className="relative flex w-full cursor-pointer flex-col gap-1.5 overflow-hidden rounded-md border pl-3.5 pr-3 py-2.5 text-left transition-colors hover:bg-3"
    style={{
      background: selected ? 'var(--bg-3)' : 'var(--bg-elevated)',
      borderColor: selected ? 'var(--border-bright)' : 'var(--border)',
    }}
  >
    <span
      aria-hidden
      className="absolute inset-y-0 left-0 w-1"
      style={{ background: sidebarColor(agent.color) }}
    />
    <div className="flex items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-2">
        {agent.emoji ? <span className="text-lg leading-none">{agent.emoji}</span> : null}
        <span className="truncate text-sm font-semibold text-pri">{agent.name}</span>
      </div>
      {imported ? (
        <span
          role="img"
          aria-label="imported"
          data-testid="marketplace-agent-imported"
          className="flex shrink-0 items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide"
          style={{ background: 'var(--bg-2)', color: 'var(--accent)' }}
        >
          <Check size={10} aria-hidden />
        </span>
      ) : null}
    </div>
    <p className="line-clamp-2 text-[11px] leading-snug text-ter">{agent.description}</p>
  </button>
)
