import { Check } from 'lucide-react'

import type { MarketplaceAgentEntry } from '../api.js'

interface MarketplaceAgentCardProps {
  agent: MarketplaceAgentEntry
  selected: boolean
  imported: boolean
  onSelect: () => void
}

// Card surface uses bg-2 (a step below the drawer's bg-elevated container) so
// cards visually sit on a "table" rather than blending into it. Selected state
// gets an accent-mix wash + accent border so the picked card actually pops
// against its neighbors.
const cardBackground = (selected: boolean): string =>
  selected ? 'color-mix(in oklab, var(--accent) 14%, var(--bg-2))' : 'var(--bg-2)'

const cardBorder = (selected: boolean): string =>
  selected ? 'var(--accent)' : 'var(--border-bright)'

export const MarketplaceAgentCard = ({
  agent,
  selected,
  imported,
  onSelect,
}: MarketplaceAgentCardProps) => {
  const tagline = agent.vibe?.trim() ? agent.vibe : agent.description
  return (
    <button
      type="button"
      onClick={onSelect}
      data-testid="marketplace-agent-card"
      data-agent-path={agent.path}
      data-imported={imported ? 'true' : undefined}
      data-selected={selected ? 'true' : undefined}
      className="flex w-full cursor-pointer flex-col gap-1.5 rounded-md border px-3 py-2.5 text-left transition-colors"
      style={{
        background: cardBackground(selected),
        borderColor: cardBorder(selected),
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {agent.emoji ? <span className="text-base leading-none">{agent.emoji}</span> : null}
          <span className="truncate text-sm font-semibold text-pri">{agent.name}</span>
        </div>
        {imported ? (
          <span
            role="img"
            aria-label="imported"
            data-testid="marketplace-agent-imported"
            className="flex shrink-0 items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide"
            style={{
              background: 'color-mix(in oklab, var(--accent) 18%, transparent)',
              color: 'var(--accent)',
            }}
          >
            <Check size={10} aria-hidden />
          </span>
        ) : null}
      </div>
      <p className="line-clamp-2 text-[11px] leading-snug text-ter">{tagline}</p>
    </button>
  )
}
