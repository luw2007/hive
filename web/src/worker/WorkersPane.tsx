import * as Accordion from '@radix-ui/react-accordion'
import { ChevronDown, Trash2, UserPlus } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'

import type { TeamListItem } from '../../../src/shared/types.js'
import type { TerminalRunSummary } from '../api.js'
import { useI18n } from '../i18n.js'
import { Confirm } from '../ui/Confirm.js'
import { DeleteWorkerDialog } from './DeleteWorkerDialog.js'
import { StopWorkerDialog } from './StopWorkerDialog.js'
import { EmptyState } from '../ui/EmptyState.js'
import { RenameWorkerDialog } from './RenameWorkerDialog.js'
import { WorkerCard, type WorkerCardActionKind } from './WorkerCard.js'
import { presentWorkerStatus, type WorkerStatusKind } from './worker-status.js'

type WorkersPaneProps = {
  onAddWorkerClick: () => void
  onDeleteWorker: (worker: TeamListItem) => void
  onOpenWorker: (worker: TeamListItem) => void
  onRenameWorker: (worker: TeamListItem, newName: string) => Promise<{ error: string | null }>
  onStartWorker: (worker: TeamListItem) => void
  onStopWorkerRun: (runId: string) => void
  startingWorkerId: string | null
  terminalRuns: TerminalRunSummary[]
  workers: TeamListItem[]
  workspaceId: string
}

const SECTION_ORDER: WorkerStatusKind[] = ['working', 'idle', 'stopped']
const statusKey = (status: WorkerStatusKind) => {
  if (status === 'working') return 'common.running'
  if (status === 'idle') return 'common.idle'
  return 'common.stopped'
}

const summarizeWorkers = (workers: TeamListItem[]) => {
  const buckets: Record<WorkerStatusKind, TeamListItem[]> = {
    idle: [],
    working: [],
    stopped: [],
  }
  for (const worker of workers) buckets[presentWorkerStatus(worker).kind].push(worker)
  return {
    sections: SECTION_ORDER.filter((kind) => buckets[kind].length > 0).map((kind) => ({
      kind,
      workers: buckets[kind],
    })),
    summary: {
      idle: buckets.idle.length,
      stopped: buckets.stopped.length,
      working: buckets.working.length,
    },
  }
}

export const WorkersPane = ({
  onAddWorkerClick,
  onDeleteWorker,
  onOpenWorker,
  onRenameWorker,
  onStartWorker,
  onStopWorkerRun,
  startingWorkerId,
  terminalRuns,
  workers,
  workspaceId,
}: WorkersPaneProps) => {
  const { t } = useI18n()
  const { sections, summary } = useMemo(() => summarizeWorkers(workers), [workers])
  const runIdsByAgentId = useMemo(
    () => new Map(terminalRuns.map((run) => [run.agent_id, run.run_id] as const)),
    [terminalRuns]
  )
  const [pendingDelete, setPendingDelete] = useState<TeamListItem | null>(null)
  const [pendingStop, setPendingStop] = useState<{ worker: TeamListItem; runId: string } | null>(null)
  const [renameTarget, setRenameTarget] = useState<TeamListItem | null>(null)
  const [renameBusy, setRenameBusy] = useState(false)
  const [confirmClearStopped, setConfirmClearStopped] = useState(false)

  const handleAccordionChange = useCallback(() => {
    setTimeout(() => window.dispatchEvent(new Event('resize')), 300)
  }, [])

  const stoppedWorkers = useMemo(
    () => sections.find((s) => s.kind === 'stopped')?.workers ?? [],
    [sections]
  )

  const handleClearAllStopped = () => {
    for (const worker of stoppedWorkers) onDeleteWorker(worker)
    setConfirmClearStopped(false)
  }

  const handleAction = (kind: WorkerCardActionKind, worker: TeamListItem) => {
    if (kind === 'start') {
      onStartWorker(worker)
      return
    }
    if (kind === 'stop') {
      const runId = runIdsByAgentId.get(worker.id)
      if (runId) setPendingStop({ worker, runId })
      return
    }
    if (kind === 'rename') {
      setRenameTarget(worker)
      return
    }
    if (kind === 'delete') {
      setPendingDelete(worker)
    }
  }

  const confirmDelete = () => {
    if (!pendingDelete) return
    onDeleteWorker(pendingDelete)
    setPendingDelete(null)
  }

  const submitRename = (worker: TeamListItem, newName: string) => {
    setRenameBusy(true)
    void onRenameWorker(worker, newName).finally(() => {
      setRenameBusy(false)
      setRenameTarget(null)
    })
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col" style={{ background: 'var(--bg-2)' }}>
      <div className="workers-pane-body scroll-y flex-1 px-2 py-2">
        {workers.length === 0 ? (
          <EmptyState
            icon={<UserPlus size={28} />}
            title={t('worker.emptyTitle')}
            description={t('worker.emptyDesc')}
            action={
              <button
                type="button"
                onClick={onAddWorkerClick}
                className="icon-btn icon-btn--primary"
                data-testid="add-worker-empty"
              >
                <UserPlus size={14} aria-hidden /> {t('worker.emptyAdd')}
              </button>
            }
          />
        ) : (
          <Accordion.Root
            type="multiple"
            defaultValue={['working', 'idle', 'stopped']}
            data-testid="worker-grid"
            onValueChange={handleAccordionChange}
          >
            {sections.map((section) => (
              <Accordion.Item key={section.kind} value={section.kind} className="accordion-section mb-1 last:mb-0">
                <Accordion.Header asChild>
                  <div className="accordion-trigger-wrap">
                    <Accordion.Trigger className="accordion-trigger" data-testid={`accordion-trigger-${section.kind}`}>
                      <span className="inline-flex items-center gap-1.5">
                        <span className={`status-dot status-dot--${section.kind}`} aria-hidden />
                        <span className="text-xs font-medium uppercase tracking-wider text-ter">
                          {t(statusKey(section.kind))}
                        </span>
                        <span className="mono text-xs text-ter">{section.workers.length}</span>
                      </span>
                      <ChevronDown size={12} className="accordion-chevron" aria-hidden />
                    </Accordion.Trigger>
                    {section.kind === 'stopped' && section.workers.length > 0 ? (
                      <button
                        type="button"
                        className="ml-auto mr-1 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-ter hover:bg-3 hover:text-danger"
                        data-testid="clear-all-stopped"
                        onClick={(e) => { e.stopPropagation(); setConfirmClearStopped(true) }}
                      >
                        <Trash2 size={10} aria-hidden />
                        {t('worker.clearAllStopped')}
                      </button>
                    ) : null}
                  </div>
                </Accordion.Header>
                <Accordion.Content className="accordion-content">
                  <ul
                    aria-label={`${t(statusKey(section.kind))} team members`}
                    className="worker-card-grid"
                  >
                    {section.workers.map((worker) => (
                      <li key={worker.id}>
                        <WorkerCard
                          hasRun={runIdsByAgentId.has(worker.id)}
                          isPending={startingWorkerId === worker.id}
                          onAction={handleAction}
                          onClick={onOpenWorker}
                          worker={worker}
                        />
                      </li>
                    ))}
                  </ul>
                </Accordion.Content>
              </Accordion.Item>
            ))}
          </Accordion.Root>
        )}
      </div>

      <StopWorkerDialog
        open={pendingStop !== null}
        onOpenChange={(open) => { if (!open) setPendingStop(null) }}
        workerName={pendingStop?.worker.name ?? ''}
        onConfirm={() => {
          if (pendingStop) onStopWorkerRun(pendingStop.runId)
          setPendingStop(null)
        }}
      />
      <DeleteWorkerDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null)
        }}
        workerName={pendingDelete?.name ?? ''}
        workerStatus={pendingDelete?.status ?? 'stopped'}
        onHandoff={async () => {
          if (!pendingDelete) return
          const res = await fetch(`/api/workspaces/${workspaceId}/workers/${pendingDelete.id}?handover=true`, { method: 'DELETE' })
          if (!res.ok) {
            const body = await res.text().catch(() => 'Handoff failed')
            throw new Error(body)
          }
          onDeleteWorker(pendingDelete)
        }}
        onForceDelete={confirmDelete}
      />
      <RenameWorkerDialog
        worker={renameTarget}
        busy={renameBusy}
        onClose={() => setRenameTarget(null)}
        onSubmit={submitRename}
      />
      <Confirm
        open={confirmClearStopped}
        onOpenChange={setConfirmClearStopped}
        title={t('worker.clearAllStoppedConfirmTitle')}
        description={t('worker.clearAllStoppedConfirmDesc', { count: stoppedWorkers.length })}
        confirmLabel={t('common.delete')}
        confirmKind="danger"
        onConfirm={handleClearAllStopped}
      />
    </div>
  )
}
