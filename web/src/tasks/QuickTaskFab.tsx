import { Plus, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import type { TeamListItem } from '../../../src/shared/types.js'
import { createTask } from '../api.js'
import { useI18n } from '../i18n.js'
import { useToast } from '../ui/useToast.js'

interface QuickTaskFabProps {
  workspaceId: string
  workers: TeamListItem[]
}

export const QuickTaskFab = ({ workspaceId, workers }: QuickTaskFabProps) => {
  const { t } = useI18n()
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [assignee, setAssignee] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // 快捷键 Ctrl+Shift+T
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key === 'T') {
        e.preventDefault()
        setOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // 打开时聚焦输入框
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [open])

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = title.trim()
    if (!trimmed) return

    setSubmitting(true)
    try {
      await createTask({
        workspace_id: workspaceId,
        title: trimmed,
        source: 'user',
        ...(assignee ? { worker_name: assignee } : {}),
      })
      toast.show({ kind: 'success', message: t('quickTask.created') })
      setTitle('')
      setAssignee('')
      setOpen(false)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      toast.show({ kind: 'error', message })
    } finally {
      setSubmitting(false)
    }
  }, [title, assignee, workspaceId, toast, t])

  const runnableWorkers = workers.filter((w) => w.status !== 'stopped')

  return (
    <>
      {/* FAB 按钮 */}
      <button
        type="button"
        className="quick-task-fab"
        onClick={() => setOpen((v) => !v)}
        aria-label={t('quickTask.title')}
        data-testid="quick-task-fab"
      >
        {open ? <X size={24} /> : <Plus size={24} />}
      </button>

      {/* Popover 表单 */}
      {open ? (
        <div className="quick-task-popover" data-testid="quick-task-popover">
          <div className="quick-task-popover__header">
            <span>{t('quickTask.title')}</span>
          </div>
          <form onSubmit={(e) => void handleSubmit(e)} className="quick-task-popover__form">
            <input
              ref={inputRef}
              type="text"
              className="quick-task-popover__input"
              placeholder={t('quickTask.placeholder')}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={submitting}
              data-testid="quick-task-title-input"
            />
            {runnableWorkers.length > 0 ? (
              <select
                className="quick-task-popover__select"
                value={assignee}
                onChange={(e) => setAssignee(e.target.value)}
                disabled={submitting}
                data-testid="quick-task-assignee"
              >
                <option value="">{t('quickTask.noAssignee')}</option>
                {runnableWorkers.map((w) => (
                  <option key={w.id} value={w.name}>{w.name}</option>
                ))}
              </select>
            ) : null}
            <div className="quick-task-popover__actions">
              <button
                type="submit"
                className="quick-task-popover__btn quick-task-popover__btn--primary"
                disabled={submitting || !title.trim()}
                data-testid="quick-task-submit"
              >
                {t('quickTask.create')}
              </button>
              <button
                type="button"
                className="quick-task-popover__btn"
                onClick={() => setOpen(false)}
                disabled={submitting}
              >
                {t('quickTask.cancel')}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </>
  )
}
