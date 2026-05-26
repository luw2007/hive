import { ChevronDown, ChevronRight, FileCode, Plus, Terminal, UserPlus } from 'lucide-react'
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'

import type { TeamListItem, WorkspaceSummary } from '../../src/shared/types.js'
import {
  isWorkspaceShellRun,
  type OrchestratorStartResult,
  renameWorker,
  stopAgentRun,
  type TerminalRunSummary,
} from './api.js'
import { useI18n } from './i18n.js'
import { CollapsiblePanel } from './layout/CollapsiblePanel.js'
import { usePanelLayout } from './layout/usePanelLayout.js'
import { logSwallowed } from './lib/log-swallowed.js'
import { WorkspaceNotifications } from './notifications/WorkspaceNotifications.js'
import { QuickTaskFab } from './tasks/QuickTaskFab.js'
import { SecretaryChatBubble } from './secretary/SecretaryChatBubble.js'
import { TaskGraphDrawer } from './tasks/TaskGraphDrawer.js'
import type { useTasksFile } from './tasks/useTasksFile.js'
import { TerminalBottomPanel } from './terminal/TerminalBottomPanel.js'
import { useTerminalPanelTabs } from './terminal/useTerminalPanelTabs.js'
import { findRunByAgentId } from './terminal/useTerminalRuns.js'
import { useWorkspaceShellLauncher } from './terminal/useWorkspaceShellLauncher.js'
import { useToast } from './ui/useToast.js'
import { usePaneSplit } from './usePaneSplit.js'
import { OrchestratorPane } from './worker/OrchestratorPane.js'
import { useOrchestratorPaneState } from './worker/useOrchestratorPaneState.js'
import type { WorkerActions } from './worker/useWorkerActions.js'
import { useWorkerComposer } from './worker/useWorkerComposer.js'
import { WelcomePane } from './worker/WelcomePane.js'
import { WorkersPane } from './worker/WorkersPane.js'

const AddWorkerDialog = lazy(() =>
  import('./worker/AddWorkerDialog.js').then((module) => ({ default: module.AddWorkerDialog }))
)
const WorkerModal = lazy(() =>
  import('./worker/WorkerModal.js').then((module) => ({ default: module.WorkerModal }))
)

type TasksFileApi = ReturnType<typeof useTasksFile>

type WorkspaceDetailProps = {
  onCreateWorker: WorkerActions['createWorker']
  onDeleteWorker: (workerId: string) => Promise<void>
  onDeleteWorkspace: (workspace: WorkspaceSummary) => Promise<void>
  onStartWorker: (workerId: string) => Promise<{ error: string | null; runId: string | null }>
  onOrchestratorResult: (workspaceId: string, result: OrchestratorStartResult) => void
  onRequestAddWorkspace: () => void
  onShellRunClosed?: ((workspaceId: string, runId: string) => void) | undefined
  onShellRunStarted?: ((workspaceId: string, run: TerminalRunSummary) => void) | undefined
  onTryDemo?: (() => void) | undefined
  welcomeDisabledReason?: string | undefined
  orchestratorAutostartError: string | null
  orchestratorAutostartRunId: string | null
  tasksFile: TasksFileApi
  terminalRuns: TerminalRunSummary[]
  workers: TeamListItem[]
  workspace: WorkspaceSummary | undefined
}

export const WorkspaceDetail = ({
  onCreateWorker,
  onDeleteWorker,
  onDeleteWorkspace,
  onStartWorker,
  onOrchestratorResult,
  onRequestAddWorkspace,
  onShellRunClosed,
  onShellRunStarted,
  onTryDemo,
  welcomeDisabledReason,
  orchestratorAutostartError,
  orchestratorAutostartRunId,
  tasksFile,
  terminalRuns,
  workers,
  workspace,
}: WorkspaceDetailProps) => {
  const { t } = useI18n()
  const [activeWorkerId, setActiveWorkerId] = useState<string | null>(null)
  const [composerOpen, setComposerOpen] = useState(false)
  const [addTaskCounter, setAddTaskCounter] = useState(0)
  const [taskRawMode, setTaskRawMode] = useState(false)
  const [deleteWorkerError, setDeleteWorkerError] = useState<string | null>(null)
  const [startWorkerError, setStartWorkerError] = useState<string | null>(null)
  const [startingWorkerId, setStartingWorkerId] = useState<string | null>(null)
  const { layout, toggleCollapsed } = usePanelLayout()
  const toast = useToast()
  const composer = useWorkerComposer({
    createWorker: onCreateWorker,
    open: composerOpen,
    workers,
  })
  const orchestrator = useOrchestratorPaneState({
    workspaceId: workspace?.id ?? '',
    terminalRuns,
    autostartError: orchestratorAutostartError,
    suppressAutostartRunId: orchestratorAutostartRunId,
    onClearAutostartError: () => {
      if (workspace) onOrchestratorResult(workspace.id, { ok: true, error: null, run_id: null })
    },
    onAfterStart: (result) => {
      if (workspace) onOrchestratorResult(workspace.id, result)
    },
  })
  const split = usePaneSplit()
  const activeWorker: TeamListItem | null =
    workers.find((worker) => worker.id === activeWorkerId) ?? null
  useEffect(() => {
    if (activeWorkerId && !activeWorker) setActiveWorkerId(null)
  }, [activeWorkerId, activeWorker])
  const panelTabs = useTerminalPanelTabs({
    workspaceId: workspace?.id ?? '',
    workers,
    terminalRuns,
  })
  const shellPanelTabs = panelTabs.tabs.filter((tab) => tab.kind === 'shell')
  const shellRuns = workspace
    ? terminalRuns.filter((run) => isWorkspaceShellRun(run, workspace.id))
    : []
  const { closeShellTab, shellError, shellStarting, startNewShell } =
    useWorkspaceShellLauncher({
      onCloseFailed: (message) =>
        toast.show({ kind: 'error', message: t('shellTerminal.closeFailed', { message }) }),
      onShellRunClosed,
      onShellRunStarted,
      panelTabs,
      shellRuns,
      workspaceId: workspace?.id ?? null,
    })

  // Surface composer / delete errors as toasts instead of inline alert bands.
  useEffect(() => {
    if (composer.createWorkerError)
      toast.show({ kind: 'error', message: composer.createWorkerError })
  }, [composer.createWorkerError, toast])

  useEffect(() => {
    if (deleteWorkerError) toast.show({ kind: 'error', message: deleteWorkerError })
  }, [deleteWorkerError, toast])

  // Start failures no longer have a modal banner to display them — surface
  // via toast to keep parity with delete-error feedback.
  useEffect(() => {
    if (startWorkerError) toast.show({ kind: 'error', message: startWorkerError })
  }, [startWorkerError, toast])

  // Shell-start failures no longer have a dialog banner — surface via toast.
  useEffect(() => {
    if (shellError) toast.show({ kind: 'error', message: shellError })
  }, [shellError, toast])

  // B2: when the user switches workspace, clear local error state so we don't
  // surface a stale error from the previous workspace as a fresh toast.
  // biome-ignore lint/correctness/useExhaustiveDependencies: effect intentionally fires only on workspace switch
  useEffect(() => {
    setActiveWorkerId(null)
    setDeleteWorkerError(null)
    setStartWorkerError(null)
    setStartingWorkerId(null)
  }, [workspace?.id])

  const knownWorkerNames = useMemo(
    () => (workers.length ? workers.map((w) => w.name) : undefined),
    [workers]
  )

  // 计算 tasks 进度（必须在 early return 之前，因为下面的 useEffect 依赖 taskTotal）
  const taskLines = tasksFile.content.split('\n')
  const taskTotal = taskLines.filter((l) => /^\s*-\s+\[[ xX]\]/.test(l)).length
  const taskDone = taskLines.filter((l) => /^\s*-\s+\[[xX]\]/.test(l)).length
  const taskPct = taskTotal > 0 ? Math.round((taskDone / taskTotal) * 100) : 0

  // 计算 workers 状态
  const workersWorking = workers.filter((w) => w.status === 'working').length
  const workersStopped = workers.filter((w) => w.status === 'stopped').length
  const workersIdle = workers.length - workersWorking - workersStopped

  // 空面板默认折叠
  const autoCollapsedRef = useRef(false)
  useEffect(() => {
    if (autoCollapsedRef.current) return
    autoCollapsedRef.current = true
    if (taskTotal === 0) toggleCollapsed('tasks', true)
    if (workers.length === 0) toggleCollapsed('workers', true)
    if (shellPanelTabs.length === 0) toggleCollapsed('terminal', true)
  }, [taskTotal, workers.length, shellPanelTabs.length, toggleCollapsed])

  if (!workspace) {
    const welcomeProps: {
      onAddWorkspace: () => void
      onTryDemo?: () => void
      disabledReason?: string
    } = { onAddWorkspace: onRequestAddWorkspace }
    if (onTryDemo) welcomeProps.onTryDemo = onTryDemo
    if (welcomeDisabledReason) welcomeProps.disabledReason = welcomeDisabledReason
    return <WelcomePane {...welcomeProps} />
  }

  const activeWorkerRun = activeWorker ? findRunByAgentId(terminalRuns, activeWorker.id) : undefined

  const handleDeleteWorker = (worker: TeamListItem) => {
    setDeleteWorkerError(null)
    void onDeleteWorker(worker.id)
      .then(() => setActiveWorkerId(null))
      .catch((error) => {
        setDeleteWorkerError(error instanceof Error ? error.message : String(error))
      })
  }

  const handleStartWorker = (worker: TeamListItem) => {
    setStartWorkerError(null)
    setStartingWorkerId(worker.id)
    void onStartWorker(worker.id)
      .then(({ error }) => {
        if (error) setStartWorkerError(error)
      })
      .catch((error) => {
        setStartWorkerError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => setStartingWorkerId(null))
  }

  const handleRenameWorker = async (
    worker: TeamListItem,
    newName: string
  ): Promise<{ error: string | null }> => {
    try {
      await renameWorker(workspace.id, worker.id, newName)
      toast.show({
        kind: 'success',
        message: t('worker.renameSuccess', { name: newName }),
      })
      return { error: null }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      toast.show({ kind: 'error', message: t('worker.renameFailed', { message }) })
      return { error: message }
    }
  }

  const orchWidth = `${(split.orchPct * 100).toFixed(2)}%`
  const startNewShellFromPanel = () => {
    startNewShell()
  }

  const togglePanel = (id: 'tasks' | 'workers' | 'terminal') => {
    toggleCollapsed(id)
    if (layout.collapsed[id]) {
      setTimeout(() => window.dispatchEvent(new Event('resize')), 300)
    }
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" style={{ background: 'var(--bg-2)' }}>
      <WorkspaceNotifications terminalRuns={terminalRuns} workers={workers} workspace={workspace} />
      <div ref={split.containerRef} className="relative flex min-h-0 flex-1">
        <div
          className="flex min-w-[480px] shrink-0 flex-col"
          style={{ width: orchWidth }}
          data-testid="orchestrator-pane-shell"
        >
          <OrchestratorPane
            state={orchestrator.state}
            onStop={orchestrator.stop}
            onRemoveWorkspace={() => {
              void onDeleteWorkspace(workspace).catch((error: unknown) => {
                const message = error instanceof Error ? error.message : String(error)
                toast.show({ kind: 'error', message: `Delete failed: ${message}` })
              })
            }}
            onStart={orchestrator.start}
            onRestart={orchestrator.restart}
            onResetContext={orchestrator.resetContext}
          />
        </div>
        {/* biome-ignore lint/a11y/useSemanticElements: <hr> can't host pointer/keyboard handlers and the visible accent line; aria role="separator" is the canonical resize-handle role */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t('workerPane.resize')}
          aria-valuenow={Math.round(split.orchPct * 100)}
          aria-valuemin={30}
          aria-valuemax={78}
          tabIndex={0}
          className="pane-splitter"
          style={{ left: `calc(${orchWidth} - 4px)` }}
          data-dragging={split.dragging || undefined}
          data-testid="pane-splitter"
          onPointerDown={split.beginDrag}
          onKeyDown={split.onKeyDown}
        />
        <div className="relative flex min-w-0 flex-1 flex-col overflow-y-auto">
          {/* Tasks 面板 */}
          <CollapsiblePanel
            id="tasks"
            collapsed={layout.collapsed.tasks}
            onToggle={() => togglePanel('tasks')}
            headerContent={
              <div className="module-header">
                <div className="module-header__row1">
                  <span className="module-header__chevron" aria-hidden>
                    {layout.collapsed.tasks ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
                  </span>
                  <span className="module-header__title">{t('workspace.panel.tasks')}</span>
                  {taskTotal > 0 ? (
                    <span className="module-header__badge">{taskDone}/{taskTotal} · {taskPct}%</span>
                  ) : null}
                  <div className="module-header__spacer" />
                  <button
                    type="button"
                    className="icon-btn icon-btn--sm"
                    onClick={(e) => { e.stopPropagation(); toggleCollapsed('tasks', false); setAddTaskCounter((c) => c + 1) }}
                    data-testid="panel-add-task"
                  >
                    <Plus size={14} aria-hidden />
                  </button>
                  <button
                    type="button"
                    className="icon-btn icon-btn--sm"
                    onClick={(e) => { e.stopPropagation(); setTaskRawMode((v) => !v) }}
                    data-testid="panel-task-raw-toggle"
                    aria-label={taskRawMode ? t('tasks.action.backToList') : t('tasks.action.viewSource')}
                  >
                    <FileCode size={14} aria-hidden />
                  </button>
                </div>
                {taskTotal > 0 ? (
                  <div className="module-header__row2">
                    <span className="panel-progress-bar" style={{ '--progress': `${taskPct}%` } as React.CSSProperties} />
                  </div>
                ) : null}
              </div>
            }
          >
            <div className="relative min-h-0 flex-1 overflow-hidden" data-inline-task-panel>
              <TaskGraphDrawer
                content={tasksFile.content}
                hasConflict={tasksFile.hasConflict}
                onClose={() => toggleCollapsed('tasks')}
                onContentChange={tasksFile.onChange}
                onKeepLocal={tasksFile.onKeepLocal}
                onReload={tasksFile.onReload}
                onSave={tasksFile.onSave}
                onToggleTaskLine={(line) => {
                  void tasksFile.toggleTaskAtLine(line).catch(logSwallowed('tasks.toggleTaskAtLine'))
                }}
                onAppendTask={(text) => {
                  void tasksFile.appendTask(text).catch(logSwallowed('tasks.appendTask'))
                }}
                onAppendSubtask={(parentLine, text) => {
                  void tasksFile.appendSubtask(parentLine, text).catch(logSwallowed('tasks.appendSubtask'))
                }}
                onUpdateTaskText={(line, nextText) => {
                  void tasksFile.updateTaskText(line, nextText).catch(logSwallowed('tasks.updateTaskText'))
                }}
                onDeleteTask={(line) => {
                  void tasksFile.deleteTask(line).catch(logSwallowed('tasks.deleteTask'))
                }}
                open={true}
                workspaceId={workspace.id}
                workspacePath={workspace.path}
                knownWorkerNames={knownWorkerNames}
                requestAddTask={addTaskCounter}
                rawMode={taskRawMode}
                onRawModeChange={setTaskRawMode}
              />
            </div>
          </CollapsiblePanel>

          {/* Workers 面板 */}
          <CollapsiblePanel
            id="workers"
            collapsed={layout.collapsed.workers}
            onToggle={() => togglePanel('workers')}
            headerContent={
              <div className="module-header">
                <div className="module-header__row1">
                  <span className="module-header__chevron" aria-hidden>
                    {layout.collapsed.workers ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
                  </span>
                  <span className="module-header__title">{t('worker.teamMembers')}</span>
                  <span className="module-header__badge">{workers.length}</span>
                  <div className="module-header__spacer" />
                  <button
                    type="button"
                    className="icon-btn icon-btn--sm"
                    onClick={(e) => { e.stopPropagation(); toggleCollapsed('workers', false); setComposerOpen(true) }}
                    data-testid="panel-add-worker"
                  >
                    <UserPlus size={14} aria-hidden /> {t('addWorker.create')}
                  </button>
                </div>
                {workers.length > 0 ? (
                  <div className="module-header__row2">
                    <span className="inline-flex items-center gap-1.5">
                      <span className="status-dot status-dot--working" aria-hidden />
                      <span className="text-sec">{workersWorking}</span> {t('common.running')}
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <span className="status-dot status-dot--idle" aria-hidden />
                      <span className="text-sec">{workersIdle}</span> {t('common.idle')}
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <span className="status-dot status-dot--stopped" aria-hidden />
                      <span className="text-sec">{workersStopped}</span> {t('common.stopped')}
                    </span>
                  </div>
                ) : null}
              </div>
            }
          >
            <WorkersPane
              onAddWorkerClick={() => setComposerOpen(true)}
              onDeleteWorker={handleDeleteWorker}
              onOpenWorker={(worker) => setActiveWorkerId(worker.id)}
              onRenameWorker={handleRenameWorker}
              onStartWorker={handleStartWorker}
              onStopWorkerRun={(runId) => void stopAgentRun(runId)}
              startingWorkerId={startingWorkerId}
              terminalRuns={terminalRuns}
              workers={workers}
              workspaceId={workspace.id}
            />
          </CollapsiblePanel>

          {/* Terminal 面板 */}
          <CollapsiblePanel
            id="terminal"
            collapsed={layout.collapsed.terminal}
            onToggle={() => togglePanel('terminal')}
            headerContent={
              <div className="module-header">
                <div className="module-header__row1">
                  <span className="module-header__chevron" aria-hidden>
                    {layout.collapsed.terminal ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
                  </span>
                  <span className="module-header__title">{t('workspace.panel.terminal')}</span>
                  {shellPanelTabs.length > 0 ? (
                    <span className="module-header__badge">{shellPanelTabs.length}</span>
                  ) : null}
                  <div className="module-header__spacer" />
                  <button
                    type="button"
                    className="icon-btn icon-btn--sm"
                    onClick={(e) => { e.stopPropagation(); toggleCollapsed('terminal', false); startNewShellFromPanel() }}
                    data-testid="panel-new-shell"
                  >
                    <Terminal size={14} aria-hidden /> {t('workspace.panel.terminal')}
                  </button>
                </div>
              </div>
            }
          >
            <div className="min-h-0 flex-1">
              <TerminalBottomPanel
                tabs={shellPanelTabs}
                activeId={panelTabs.activeId}
                scopeKey={workspace.id}
                onSelect={panelTabs.setActive}
                onClose={(tabId) => {
                  if (tabId.startsWith('shell:')) {
                    closeShellTab(tabId.slice('shell:'.length))
                  }
                  panelTabs.closeTab(tabId)
                }}
                onClosePanel={() => toggleCollapsed('terminal')}
                onNewShell={startNewShellFromPanel}
                newShellPending={shellStarting}
                onStartWorker={(workerId) => {
                  const worker = workers.find((w) => w.id === workerId)
                  if (worker) handleStartWorker(worker)
                }}
                startingWorkerId={startingWorkerId}
              />
            </div>
          </CollapsiblePanel>
        </div>
      </div>
      {activeWorker ? (
        <Suspense fallback={null}>
          <WorkerModal
            onClose={() => setActiveWorkerId(null)}
            onStart={handleStartWorker}
            runId={activeWorkerRun?.run_id ?? null}
            startError={startWorkerError}
            starting={startingWorkerId === activeWorker.id}
            worker={activeWorker}
          />
        </Suspense>
      ) : null}
      {composerOpen ? (
        <Suspense fallback={null}>
          <AddWorkerDialog
            commandPresets={composer.commandPresets}
            commandPresetId={composer.commandPresetId}
            creating={composer.creating}
            customRoleName={composer.customRoleName}
            customTemplates={composer.customTemplates}
            onApplyMarketplaceImport={composer.applyMarketplaceImport}
            onClose={() => setComposerOpen(false)}
            onCustomRoleNameChange={composer.setCustomRoleName}
            onDeleteTemplate={composer.deleteTemplate}
            onNameChange={composer.setWorkerName}
            onNameFieldFocus={composer.onNameFieldFocus}
            onPresetChange={composer.setCommandPresetId}
            onRandomName={composer.randomizeWorkerName}
            onRoleDescriptionChange={composer.setRoleDescription}
            onRoleDescriptionReset={composer.resetRoleDescription}
            onRoleChange={composer.setWorkerRole}
            onSaveAsTemplate={composer.saveAsTemplate}
            onSubmit={(event) => composer.submit(event, () => setComposerOpen(false))}
            onStartupCommandChange={composer.setStartupCommand}
            onTemplateChange={composer.selectTemplate}
            roleDescription={composer.roleDescription}
            roleDescriptionDefault={composer.roleDescriptionDefault}
            selectedTemplateId={composer.selectedTemplateId}
            startupCommand={composer.startupCommand}
            templateBusy={composer.templateBusy}
            usedTemplateNames={composer.usedTemplateNames}
            workerName={composer.workerName}
            workerRole={composer.workerRole}
          />
        </Suspense>
      ) : null}
      {workspace ? <QuickTaskFab workspaceId={workspace.id} workers={workers} /> : null}
      {workspace ? <SecretaryChatBubble workspaceId={workspace.id} /> : null}
    </div>
  )
}
