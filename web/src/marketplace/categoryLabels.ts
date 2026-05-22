// Localized labels for marketplace categories. Kept separate from the global
// i18n catalog so adding a new upstream category never breaks the page — an
// unknown key falls back to the raw kebab-case name, prettified.

import type { UiLanguage } from '../uiLanguage.js'

interface CategoryLabel {
  en: string
  zh: string
}

const CATEGORY_LABELS: Record<string, CategoryLabel> = {
  academic: { en: 'Academic', zh: '学术' },
  design: { en: 'Design', zh: '设计' },
  engineering: { en: 'Engineering', zh: '工程' },
  finance: { en: 'Finance', zh: '金融' },
  'game-development': { en: 'Game Development', zh: '游戏开发' },
  hr: { en: 'HR', zh: '人力资源' },
  integrations: { en: 'Integrations', zh: '集成' },
  legal: { en: 'Legal', zh: '法务' },
  marketing: { en: 'Marketing', zh: '营销' },
  misc: { en: 'Misc', zh: '其他' },
  'paid-media': { en: 'Paid Media', zh: '付费媒体' },
  product: { en: 'Product', zh: '产品' },
  'project-management': { en: 'Project Management', zh: '项目管理' },
  sales: { en: 'Sales', zh: '销售' },
  'spatial-computing': { en: 'Spatial Computing', zh: '空间计算' },
  specialized: { en: 'Specialized', zh: '专项' },
  'supply-chain': { en: 'Supply Chain', zh: '供应链' },
  support: { en: 'Support', zh: '客户支持' },
  testing: { en: 'Testing', zh: '测试' },
}

const prettifyRaw = (category: string) =>
  category.replace(/-/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase())

export const localizeMarketplaceCategory = (category: string, language: UiLanguage): string => {
  const entry = CATEGORY_LABELS[category]
  if (!entry) return prettifyRaw(category)
  return entry[language]
}
