import type { AgentSummary, WorkspaceSummary } from '../shared/types.js'

import type { AgentRuntime } from './agent-runtime-contract.js'
import { createCompactDetector, type CompactDetector } from './compact-detector.js'
import type { DispatchRecord } from './dispatch-ledger-store.js'
import { createOrchMessageQueue, type OrchMessageQueue } from './orch-message-queue.js'
import type { PtyOutputBus } from './pty-output-bus.js'
import {
  executeOrchestratorRotation,
  executeWorkerRotation,
  shouldRotateOrchestrator,
  shouldRotateWorker,
  type OrchestratorRecoveryInput,
  type RotationProtection,
} from './session-rotation.js'

export interface RotationManagerStore {
  getActiveRunByAgentId: (workspaceId: string, agentId: string) => { runId: string; startedAt: number } | undefined
  getPtyOutputBus: () => PtyOutputBus
  getDb: () => import('better-sqlite3').Database
  getAgentRuntime: () => AgentRuntime
}

export interface OrchRotationStore extends RotationManagerStore {
  getOrchMessageQueue?: () => OrchMessageQueue
  getOrchRecoveryInput: (workspaceId: string, orchAgentId: string) => Promise<OrchestratorRecoveryInput>
  getLastUserInputTime: (workspaceId: string) => number
}

const protectionMap = new Map<string, RotationProtection>()
const unsubscribeMap = new Map<string, () => void>()

const noopQueue: OrchMessageQueue = createOrchMessageQueue(() => {})

let detector: CompactDetector | undefined

const getDetector = (bus: PtyOutputBus): CompactDetector => {
  if (!detector) detector = createCompactDetector(bus)
  return detector
}

const workerKey = (workspaceId: string, agentId: string) => `${workspaceId}:${agentId}`

const getProtection = (workspaceId: string, agentId: string): RotationProtection => {
  const key = workerKey(workspaceId, agentId)
  let p = protectionMap.get(key)
  if (!p) {
    p = { consecutiveFailures: 0, lastRotationAt: 0, suspended: false }
    protectionMap.set(key, p)
  }
  return p
}

export const attachCompactDetector = (
  bus: PtyOutputBus,
  runId: string,
  workspaceId: string,
  agentId: string
): void => {
  const key = workerKey(workspaceId, agentId)
  const existing = unsubscribeMap.get(key)
  if (existing) existing()

  const unsubscribe = getDetector(bus).attach(runId)
  unsubscribeMap.set(key, unsubscribe)
}

export const detachCompactDetector = (workspaceId: string, agentId: string): void => {
  const key = workerKey(workspaceId, agentId)
  const unsub = unsubscribeMap.get(key)
  if (unsub) {
    unsub()
    unsubscribeMap.delete(key)
  }
}

interface CheckRotationInput {
  store: RotationManagerStore
  workspace: WorkspaceSummary
  agent: AgentSummary
  dispatchResult: { dispatch: DispatchRecord | null }
  hivePort: string
}

export const checkAndRotateWorker = (input: CheckRotationInput): void => {
  const { store, workspace, agent, dispatchResult, hivePort } = input
  const { id: workspaceId } = workspace
  const agentId = agent.id

  const activeRun = store.getActiveRunByAgentId(workspaceId, agentId)
  if (!activeRun) return

  const db = store.getDb()
  const runRow = db
    .prepare('SELECT inject_count FROM agent_runs WHERE run_id = ?')
    .get(activeRun.runId) as { inject_count: number } | undefined
  const injectCount = runRow?.inject_count ?? 0

  const compactDetected = getDetector(store.getPtyOutputBus()).isCompactDetected(activeRun.runId)

  const pendingRow = db
    .prepare(
      `SELECT COUNT(*) as cnt FROM dispatches WHERE workspace_id = ? AND to_agent_id = ? AND status IN ('queued', 'submitted')`
    )
    .get(workspaceId, agentId) as { cnt: number }
  const hasPendingDispatch = pendingRow.cnt > 0

  const dispatchWasReported =
    dispatchResult.dispatch !== null && dispatchResult.dispatch.status === 'reported'

  const context = {
    compactDetected,
    dispatchReportedAndNoPending: dispatchWasReported && !hasPendingDispatch,
    hasActiveDispatch: hasPendingDispatch,
    messageCount: injectCount,
    sessionStartedAt: activeRun.startedAt,
  }
  const protection = getProtection(workspaceId, agentId)

  if (!shouldRotateWorker(context, protection)) return

  const pendingDispatchText = hasPendingDispatch
    ? ((db
        .prepare(
          `SELECT text FROM dispatches WHERE workspace_id = ? AND to_agent_id = ? AND status IN ('queued', 'submitted') ORDER BY sequence ASC LIMIT 1`
        )
        .get(workspaceId, agentId) as { text: string } | undefined)?.text ?? null)
    : null

  const key = workerKey(workspaceId, agentId)
  const runtime = store.getAgentRuntime()
  setImmediate(() => {
    void executeWorkerRotation(workspace, agentId, agent, runtime, protection, pendingDispatchText, hivePort)
      .then((result) => {
        protectionMap.set(key, result.protection)
      })
      .catch((err: unknown) => {
        console.error(`[rotation-manager] rotation failed for ${agent.name}:`, err)
      })
  })
}

interface CheckOrchRotationInput {
  store: OrchRotationStore
  workspace: WorkspaceSummary
  agent: AgentSummary
  hivePort: string
}

export const checkAndRotateOrchestrator = (input: CheckOrchRotationInput): void => {
  const { store, workspace, agent, hivePort } = input
  const { id: workspaceId } = workspace
  const agentId = agent.id

  const activeRun = store.getActiveRunByAgentId(workspaceId, agentId)
  if (!activeRun) return

  const db = store.getDb()
  const runRow = db
    .prepare('SELECT inject_count FROM agent_runs WHERE run_id = ?')
    .get(activeRun.runId) as { inject_count: number } | undefined
  const injectCount = runRow?.inject_count ?? 0

  const compactDetectedAndIdle = getDetector(store.getPtyOutputBus()).isCompactDetected(activeRun.runId)

  const pendingRow = db
    .prepare(
      `SELECT COUNT(*) as cnt FROM dispatches WHERE workspace_id = ? AND status IN ('queued', 'submitted')`
    )
    .get(workspaceId) as { cnt: number }
  const noPendingDispatches = pendingRow.cnt === 0

  const workerStatusRow = db
    .prepare(
      `SELECT COUNT(*) as cnt FROM workers WHERE workspace_id = ? AND status NOT IN ('idle', 'stopped')`
    )
    .get(workspaceId) as { cnt: number } | undefined
  const allWorkersIdle = (workerStatusRow?.cnt ?? 0) === 0

  const lastUserInputTime = store.getLastUserInputTime(workspaceId)
  const userSilentDurationMs = Date.now() - lastUserInputTime

  const context = {
    allWorkersIdle,
    compactDetectedAndIdle,
    messageCount: injectCount,
    noPendingDispatches,
    sessionStartedAt: activeRun.startedAt,
    userSilentDurationMs,
  }
  const protection = getProtection(workspaceId, agentId)

  if (!shouldRotateOrchestrator(context, protection)) return

  const orchQueue = store.getOrchMessageQueue?.()
  const key = workerKey(workspaceId, agentId)
  const runtime = store.getAgentRuntime()

  void store.getOrchRecoveryInput(workspaceId, agentId).then((recoveryInput) =>
    setImmediate(() => {
      void executeOrchestratorRotation(workspace, agentId, agent, runtime, protection, recoveryInput, hivePort, orchQueue)
        .then((result) => {
          protectionMap.set(key, result.protection)
        })
        .catch((err: unknown) => {
          console.error(`[rotation-manager] orch rotation failed for ${agent.name}:`, err)
        })
    })
  ).catch((err: unknown) => {
    console.error(`[rotation-manager] failed to build orch recovery for ${agent.name}:`, err)
  })
}
