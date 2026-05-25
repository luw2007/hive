import type { AgentSummary, TeamListItem, WorkspaceSummary } from '../shared/types.js'
import type { AgentManager } from './agent-manager.js'
import type { AgentLaunchConfigInput, PersistedAgentRun } from './agent-run-store.js'
import type { LiveAgentRun } from './agent-runtime-types.js'
import { createDiscussionOperations, type DiscussionOperations } from './discussion-operations.js'
import type { DispatchRecord, ListDispatchesOptions } from './dispatch-ledger-store.js'
import { createHandoffHandler } from './handoff-handler.js'
import type { RecoveryMessage } from './message-log-store.js'
import type { PtyOutputBus } from './pty-output-bus.js'
import { createRuntimeStoreLifecycle, createRuntimeStoreServices } from './runtime-store-helpers.js'
import type { SettingsStore } from './settings-store.js'
import type { createTaskService } from './task-service.js'
import type {
  CancelTaskInput,
  DispatchTaskInput,
  ReportTaskInput,
  ReportTaskResult,
  StatusTaskInput,
} from './team-operations.js'
import type { TerminalRunSummary } from './terminal-input-profile.js'
import type { WorkerInput, WorkspaceRecord } from './workspace-store.js'

interface RuntimeStore {
  close: () => Promise<void>
  createWorkspace: (path: string, name: string) => WorkspaceSummary
  deleteWorkspace: (workspaceId: string) => Promise<void>
  listWorkspaces: () => WorkspaceSummary[]
  reorderWorkspaces: (workspaceIds: string[]) => void
  addWorker: (workspaceId: string, input: WorkerInput) => AgentSummary
  deleteWorker: (workspaceId: string, workerId: string) => void
  renameWorker: (workspaceId: string, workerId: string, name: string) => AgentSummary
  recordUserInput: (workspaceId: string, orchestratorId: string, text: string) => void
  dispatchTask: (
    workspaceId: string,
    workerId: string,
    text: string,
    input?: DispatchTaskInput
  ) => Promise<DispatchRecord>
  dispatchTaskByWorkerName: (
    workspaceId: string,
    workerName: string,
    text: string,
    input?: DispatchTaskInput
  ) => Promise<DispatchRecord>
  reportTask: (workspaceId: string, workerId: string, input?: ReportTaskInput) => ReportTaskResult
  statusTask: (workspaceId: string, workerId: string, input?: StatusTaskInput) => ReportTaskResult
  cancelTask: (workspaceId: string, dispatchId: string, input: CancelTaskInput) => ReportTaskResult
  listDispatches: (workspaceId: string, options?: ListDispatchesOptions) => DispatchRecord[]
  listWorkers: (workspaceId: string) => TeamListItem[]
  markDiscussionJoined: (workspaceId: string, agentId: string) => void
  markDiscussionLeft: (workspaceId: string, agentId: string) => void
  getLastPtyLineForAgent: (workspaceId: string, agentId: string) => string | null
  getWorkspaceSnapshot: (workspaceId: string) => WorkspaceRecord
  getWorker: (workspaceId: string, workerId: string) => AgentSummary
  getAgent: (workspaceId: string, agentId: string) => AgentSummary
  getPtyOutputBus: () => PtyOutputBus
  listTerminalRuns: (workspaceId: string) => TerminalRunSummary[]
  closeWorkspaceShell: (workspaceId: string, runId: string) => boolean
  startWorkspaceShell: (workspaceId: string) => Promise<LiveAgentRun>
  configureAgentLaunch: (
    workspaceId: string,
    agentId: string,
    input: AgentLaunchConfigInput
  ) => void
  peekAgentLaunchConfig: (
    workspaceId: string,
    agentId: string
  ) => AgentLaunchConfigInput | undefined
  startAgent: (
    workspaceId: string,
    agentId: string,
    input: StartAgentOptions
  ) => Promise<LiveAgentRun>
  autostartConfiguredAgents: (input: StartAgentOptions) => Promise<
    Array<{
      agent_id: string
      error: string | null
      ok: boolean
      run_id: string | null
      workspace_id: string
    }>
  >
  autostartOrchestrators: (input: StartAgentOptions) => Promise<
    Array<{
      agent_id: string
      error: string | null
      ok: boolean
      run_id: string | null
      workspace_id: string
    }>
  >
  startWorkspaceWatch: (workspaceId: string) => Promise<void>
  getLiveRun: (runId: string) => LiveAgentRun
  getActiveRunByAgentId: (workspaceId: string, agentId: string) => LiveAgentRun | undefined
  registerTasksListener: (listener: (workspaceId: string, content: string) => void) => () => void
  discussionOps: DiscussionOperations
  listAgentRuns: (agentId: string) => PersistedAgentRun[]
  listMessagesForRecovery: (workspaceId: string, sinceMs: number) => RecoveryMessage[]
  peekAgentToken: (agentId: string) => string | undefined
  pauseTerminalRun: (runId: string) => void
  resizeAgentRun: (runId: string, cols: number, rows: number) => void
  resumeTerminalRun: (runId: string) => void
  settings: SettingsStore
  taskService: ReturnType<typeof createTaskService>
  writeRunInput: (runId: string, input: Buffer | string) => void
  writeAgentStdin: (workspaceId: string, agentId: string, text: string) => void
  getUiToken: () => string
  stopAgentRun: (runId: string) => void
  validateAgentToken: (agentId: string, token: string | undefined) => boolean
  validateUiToken: (token: string | undefined) => boolean
  getDb: () => import('better-sqlite3').Database
  handoffHandler?:
    | {
        activeHandoff: (ctx: {
          agentId: string
          agentName: string
          workspaceId: string
        }) => Promise<void>
        receiveHandover: (
          workspaceId: string,
          agentId: string,
          reportText: string,
          pendingDispatches?: string | null,
          sessionId?: string | null
        ) => boolean
        isPendingHandoff: (workspaceId: string, agentId: string) => boolean
      }
    | undefined
  reattachTmuxSessions: () => number
  registerTeamListener: (workspaceId: string, listener: () => void) => () => void
}

interface RuntimeStoreOptions {
  dataDir?: string
  agentManager?: AgentManager
}

interface StartAgentOptions {
  hivePort: string
}

export type { RuntimeStore }

export const createRuntimeStore = (options: RuntimeStoreOptions = {}): RuntimeStore => {
  const services = createRuntimeStoreServices(options)
  const lifecycle = createRuntimeStoreLifecycle(
    options.agentManager ? { agentManager: options.agentManager, services } : { services }
  )
  const runDataMutation = (mutation: () => void) => {
    if (!services.db) {
      mutation()
      return
    }
    services.db.transaction(mutation)()
  }
  const handoffHandler = services.db
    ? createHandoffHandler({
        db: services.db,
        writeAgentStdin: (workspaceId, agentId, text) =>
          services.agentRuntime.writeAgentStdin(workspaceId, agentId, text),
        deleteWorker: (workspaceId, workerId) => {
          const activeRun = services.agentRuntime.getActiveRunByAgentId(workspaceId, workerId)
          if (activeRun) services.agentRuntime.stopAgentRun(activeRun.runId)
          services.agentRuntime.deleteAgentLaunchConfig(workspaceId, workerId)
          runDataMutation(() => {
            services.dispatchLedgerStore.deleteWorkerDispatches(workspaceId, workerId)
            services.workspaceStore.deleteWorker(workspaceId, workerId)
          })
        },
        getCheckpoint: (agentId) => services.agentRunStore.getCheckpoint(agentId),
      })
    : undefined
  return {
    close: async () => {
      services.teamChangeBus.dispose()
      await lifecycle.close()
    },
    createWorkspace: (path, name) => {
      const workspace = services.workspaceStore.createWorkspace(path, name)
      void lifecycle.startWorkspaceWatch(workspace.id)
      return workspace
    },
    listWorkspaces: () => services.workspaceStore.listWorkspaces(),
    reorderWorkspaces: (workspaceIds) => services.workspaceStore.reorderWorkspaces(workspaceIds),
    deleteWorkspace: async (workspaceId) => {
      const workspace = services.workspaceStore.getWorkspaceSnapshot(workspaceId)
      lifecycle.deleteWorkspaceShell(workspaceId)
      for (const agent of workspace.agents) {
        const activeRun = services.agentRuntime.getActiveRunByAgentId(workspaceId, agent.id)
        if (activeRun) services.agentRuntime.stopAgentRun(activeRun.runId)
        services.agentRuntime.deleteAgentLaunchConfig(workspaceId, agent.id)
      }
      await services.tasksFileWatcher.stop(workspaceId)
      runDataMutation(() => {
        services.dispatchLedgerStore.deleteWorkspaceDispatches(workspaceId)
        services.workspaceStore.deleteWorkspace(workspaceId)
      })
      if (services.settings.getAppState('active_workspace_id')?.value === workspaceId) {
        services.settings.setAppState('active_workspace_id', null)
      }
    },
    addWorker: (workspaceId, input) => {
      const result = services.workspaceStore.addWorker(workspaceId, input)
      services.teamChangeBus.notifyImmediate(workspaceId)
      return result
    },
    renameWorker: (workspaceId, workerId, name) => {
      const result = services.workspaceStore.renameWorker(workspaceId, workerId, name)
      services.teamChangeBus.notifyImmediate(workspaceId)
      return result
    },
    deleteWorker: (workspaceId, workerId) => {
      const activeRun = services.agentRuntime.getActiveRunByAgentId(workspaceId, workerId)
      if (activeRun) services.agentRuntime.stopAgentRun(activeRun.runId)
      services.agentRuntime.deleteAgentLaunchConfig(workspaceId, workerId)
      runDataMutation(() => {
        services.dispatchLedgerStore.deleteWorkerDispatches(workspaceId, workerId)
        services.workspaceStore.deleteWorker(workspaceId, workerId)
      })
      services.teamChangeBus.notifyImmediate(workspaceId)
    },
    recordUserInput: services.teamOps.recordUserInput,
    cancelTask: (workspaceId, dispatchId, input) => {
      const result = services.teamOps.cancelTask(workspaceId, dispatchId, input)
      services.teamChangeBus.notifyImmediate(workspaceId)
      return result
    },
    dispatchTask: async (workspaceId, workerId, text, input) => {
      const result = await services.teamOps.dispatchTask(workspaceId, workerId, text, input)
      services.teamChangeBus.notifyImmediate(workspaceId)
      return result
    },
    dispatchTaskByWorkerName: async (workspaceId, workerName, text, input) => {
      const result = await services.teamOps.dispatchTaskByWorkerName(
        workspaceId,
        workerName,
        text,
        input
      )
      services.teamChangeBus.notifyImmediate(workspaceId)
      return result
    },
    reportTask: (workspaceId, workerId, input) => {
      const result = services.teamOps.reportTask(workspaceId, workerId, input)
      services.teamChangeBus.notifyImmediate(workspaceId)
      return result
    },
    statusTask: (workspaceId, workerId, input) => {
      const result = services.teamOps.statusTask(workspaceId, workerId, input)
      services.teamChangeBus.notifyImmediate(workspaceId)
      return result
    },
    listDispatches: services.dispatchLedgerStore.listWorkspaceDispatches,
    listWorkers: (workspaceId) => services.workspaceStore.listWorkers(workspaceId),
    markDiscussionJoined: (workspaceId, agentId) => {
      services.workspaceStore.markDiscussionJoined(workspaceId, agentId)
      services.teamChangeBus.notifyImmediate(workspaceId)
    },
    markDiscussionLeft: (workspaceId, agentId) => {
      services.workspaceStore.markDiscussionLeft(workspaceId, agentId)
      services.teamChangeBus.notifyImmediate(workspaceId)
    },
    getLastPtyLineForAgent: (workspaceId, agentId) =>
      services.workerOutputTracker?.getLastPtyLine(workspaceId, agentId) ?? null,
    getWorkspaceSnapshot: (workspaceId) =>
      services.workspaceStore.getWorkspaceSnapshot(workspaceId),
    getWorker: (workspaceId, workerId) => services.workspaceStore.getWorker(workspaceId, workerId),
    getAgent: (workspaceId, agentId) => services.workspaceStore.getAgent(workspaceId, agentId),
    getPtyOutputBus: lifecycle.getPtyOutputBus,
    listTerminalRuns: lifecycle.listTerminalRuns,
    closeWorkspaceShell: lifecycle.closeWorkspaceShell,
    configureAgentLaunch: lifecycle.configureAgentLaunch,
    peekAgentLaunchConfig: lifecycle.peekAgentLaunchConfig,
    startAgent: async (workspaceId, agentId, input) => {
      const run = await lifecycle.startAgent(workspaceId, agentId, input)
      services.teamChangeBus.notifyImmediate(workspaceId)
      return run
    },
    autostartConfiguredAgents: async (input) => {
      const results = await lifecycle.autostartConfiguredAgents(input)
      const notified = new Set<string>()
      for (const r of results) {
        if (!notified.has(r.workspace_id)) {
          services.teamChangeBus.notifyImmediate(r.workspace_id)
          notified.add(r.workspace_id)
        }
      }
      return results
    },
    autostartOrchestrators: async (input) => {
      const results = await lifecycle.autostartOrchestrators(input)
      const notified = new Set<string>()
      for (const r of results) {
        if (r.ok && r.run_id && !notified.has(r.workspace_id)) {
          services.teamChangeBus.notifyImmediate(r.workspace_id)
          notified.add(r.workspace_id)
        }
      }
      return results
    },
    startWorkspaceWatch: lifecycle.startWorkspaceWatch,
    startWorkspaceShell: lifecycle.startWorkspaceShell,
    getLiveRun: lifecycle.getLiveRun,
    getActiveRunByAgentId: (workspaceId, agentId) =>
      services.agentRuntime.getActiveRunByAgentId(workspaceId, agentId),
    registerTasksListener: lifecycle.registerTasksListener,
    discussionOps: createDiscussionOperations(services.db),
    listAgentRuns: (agentId) => services.agentRuntime.listAgentRuns(agentId),
    listMessagesForRecovery: (workspaceId, sinceMs) =>
      services.messageLogStore.listMessagesForRecovery(workspaceId, sinceMs),
    peekAgentToken: (agentId) => services.agentRuntime.peekAgentToken(agentId),
    pauseTerminalRun: lifecycle.pauseTerminalRun,
    resizeAgentRun: lifecycle.resizeTerminalRun,
    resumeTerminalRun: lifecycle.resumeTerminalRun,
    settings: services.settings,
    taskService: services.taskService,
    writeRunInput: lifecycle.writeRunInput,
    writeAgentStdin: (workspaceId, agentId, text) =>
      services.agentRuntime.writeAgentStdin(workspaceId, agentId, text),
    getUiToken: () => services.uiAuth.getToken(),
    stopAgentRun: lifecycle.stopTerminalRun,
    validateAgentToken: (agentId, token) =>
      services.agentRuntime.validateAgentToken(agentId, token),
    validateUiToken: (token) => services.uiAuth.validate(token),
    getDb: () => services.db,
    handoffHandler,
    reattachTmuxSessions: lifecycle.reattachTmuxSessions,
    registerTeamListener: (workspaceId, listener) =>
      services.teamChangeBus.subscribe(workspaceId, listener),
  }
}
