import DOMPurify from 'isomorphic-dompurify'
import { marked } from 'marked'
import { useEffect, useMemo, useState } from 'react'

import type { MarketplaceAgentDetail, MarketplaceAgentEntry } from '../api.js'
import { useI18n } from '../i18n.js'

// marked@18 parse() returns string when configured sync; we set async:false
// once at module load so call sites don't need to await.
marked.setOptions({ async: false, breaks: false, gfm: true })

const renderMarkdownToSafeHtml = (body: string): string => {
  const rawHtml = marked.parse(body) as string
  return DOMPurify.sanitize(rawHtml, {
    USE_PROFILES: { html: true },
    ALLOWED_ATTR: ['href', 'name', 'target', 'rel', 'title', 'class', 'id'],
  })
}

interface MarketplaceAgentPreviewProps {
  agent: MarketplaceAgentEntry
  sourceRepo: string
  loadAgent: (path: string) => Promise<MarketplaceAgentDetail>
  onImport: (detail: { name: string; description: string }) => void
}

export const MarketplaceAgentPreview = ({
  agent,
  sourceRepo,
  loadAgent,
  onImport,
}: MarketplaceAgentPreviewProps) => {
  const { t } = useI18n()
  const [state, setState] = useState<{
    status: 'loading' | 'loaded' | 'error'
    detail: MarketplaceAgentDetail | null
    error: string | null
  }>({ status: 'loading', detail: null, error: null })

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading', detail: null, error: null })
    loadAgent(agent.path)
      .then((detail) => {
        if (cancelled) return
        setState({ status: 'loaded', detail, error: null })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setState({
          status: 'error',
          detail: null,
          error: error instanceof Error ? error.message : 'unknown',
        })
      })
    return () => {
      cancelled = true
    }
  }, [agent.path, loadAgent])

  const sourceUrl = `https://github.com/${sourceRepo}/blob/HEAD/${agent.path}`

  const renderedHtml = useMemo(() => {
    if (state.status !== 'loaded' || !state.detail) return null
    return renderMarkdownToSafeHtml(state.detail.body)
  }, [state])

  return (
    <div
      data-testid="marketplace-agent-preview"
      className="flex h-full flex-col gap-3 border-l px-4 py-3"
      style={{ borderColor: 'var(--border)' }}
    >
      <header className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          {agent.emoji ? <span className="text-lg leading-none">{agent.emoji}</span> : null}
          <h3 className="text-base font-semibold text-pri">{agent.name}</h3>
        </div>
        <p className="text-xs text-ter">{agent.description}</p>
      </header>
      <div
        className="min-h-0 flex-1 overflow-y-auto rounded border px-3 py-2 text-xs leading-relaxed"
        style={{ borderColor: 'var(--border)', background: 'var(--bg-2)' }}
      >
        {state.status === 'loading' ? <p className="text-ter">…</p> : null}
        {state.status === 'error' ? (
          <p className="text-ter">
            {t('marketplace.loadFailed')}: {state.error}
          </p>
        ) : null}
        {state.status === 'loaded' && renderedHtml ? (
          <div
            className="marketplace-prose"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: marked output sanitized via DOMPurify with restricted attribute allowlist
            dangerouslySetInnerHTML={{ __html: renderedHtml }}
          />
        ) : null}
      </div>
      <footer className="flex items-center justify-between gap-2">
        <a
          href={sourceUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="text-xs text-ter underline hover:text-sec"
        >
          {t('marketplace.viewSource')}
        </a>
        <button
          type="button"
          disabled={state.status !== 'loaded' || !state.detail}
          onClick={() => {
            if (!state.detail) return
            onImport({ name: agent.name, description: state.detail.body.trim() })
          }}
          data-testid="marketplace-import-button"
          className="cursor-pointer rounded-md px-3 py-1.5 text-sm font-medium text-on-accent transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
          style={{ background: 'var(--accent)' }}
        >
          {t('marketplace.importButton')}
        </button>
      </footer>
    </div>
  )
}
