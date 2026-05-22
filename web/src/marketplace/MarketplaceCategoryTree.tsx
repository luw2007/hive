import { useI18n } from '../i18n.js'
import { localizeMarketplaceCategory } from './categoryLabels.js'

interface CategoryTreeProps {
  categories: readonly string[]
  selected: string | null
  onSelect: (category: string | null) => void
  counts?: Record<string, number>
  showAll: boolean
  onToggleShowAll: () => void
  hiddenCount: number
}

export const MarketplaceCategoryTree = ({
  categories,
  selected,
  onSelect,
  counts,
  showAll,
  onToggleShowAll,
  hiddenCount,
}: CategoryTreeProps) => {
  const { t, language } = useI18n()
  const totalCount = counts
    ? Object.values(counts).reduce((sum, value) => sum + value, 0)
    : undefined

  const buttonClass = (active: boolean) =>
    `flex w-full cursor-pointer items-center justify-between gap-2 rounded px-2 py-1 text-left text-sm transition-colors ${
      active ? 'bg-3 text-pri' : 'text-sec hover:bg-3 hover:text-pri'
    }`

  return (
    <nav className="flex flex-col gap-0.5" data-testid="marketplace-category-tree">
      <button
        type="button"
        className={buttonClass(selected === null)}
        onClick={() => onSelect(null)}
      >
        <span>{t('marketplace.allCategories')}</span>
        {totalCount !== undefined ? (
          <span className="tabular-nums text-xs text-ter">{totalCount}</span>
        ) : null}
      </button>
      {categories.map((category) => (
        <button
          key={category}
          type="button"
          className={buttonClass(selected === category)}
          onClick={() => onSelect(category)}
        >
          <span>{localizeMarketplaceCategory(category, language)}</span>
          {counts?.[category] !== undefined ? (
            <span className="tabular-nums text-xs text-ter">{counts[category]}</span>
          ) : null}
        </button>
      ))}
      {hiddenCount > 0 || showAll ? (
        <button
          type="button"
          onClick={onToggleShowAll}
          data-testid="marketplace-toggle-show-all"
          className="mt-2 cursor-pointer rounded px-2 py-1 text-left text-xs text-ter transition-colors hover:bg-3 hover:text-sec"
        >
          {showAll
            ? t('marketplace.showCoreOnly')
            : t('marketplace.showAllCategories', { count: hiddenCount })}
        </button>
      ) : null}
    </nav>
  )
}
