import type { AgentSummary, WorkspaceSummary } from '../shared/types.js'

import { appendEntry, getRecentEntries } from './agent-journal.js'
import type { AgentRuntime } from './agent-runtime-contract.js'
import { getActiveDecisions } from './decision-ledger.js'
import { getHiveTeamRules } from './hive-team-guidance.js'

export interface RotationContext {
  compactDetected: boolean
  dispatchReportedAndNoPending: boolean
  hasActiveDispatch: boolean
  messageCount: number
  sessionStartedAt: number
}

export interface OrchestratorRotationContext {
  compactDetectedAndIdle: boolean
  messageCount: number
  sessionStartedAt: number
}

export interface RotationProtection {
  consecutiveFailures: number
  lastRotationAt: number
  suspended: boolean
}

const MIN_RUNTIME_MS = 60_000
const COOLDOWN_MS = 5 * 60_000
const MAX_FAILURES = 3
const MESSAGE_THRESHOLD = 20
const ORCH_MESSAGE_THRESHOLD = 40
const DURATION_THRESHOLD_MS = 90 * 60_000
const ORCH_DURATION_THRESHOLD_MS = 2 * 60 * 60_000
const TASKS_HEAD_LIMIT = 1536

export const shouldRotateWorker = (
  context: RotationContext,
  protection: RotationProtection
): boolean => {
  if (protection.suspended) return false
  const elapsed = Date.now() - context.sessionStartedAt
  if (elapsed < MIN_RUNTIME_MS) return false
  if (context.hasActiveDispatch) return false
  if (Date.now() - protection.lastRotationAt < COOLDOWN_MS) return false

  if (context.dispatchReportedAndNoPending) return true
  if (context.messageCount >= MESSAGE_THRESHOLD) return true
  if (context.compactDetected) return true
  if (elapsed >= DURATION_THRESHOLD_MS) return true

  return false
}

export const executeWorkerRotation = async (
  workspace: WorkspaceSummary,
  agentId: string,
  agent: AgentSummary,
  runtime: AgentRuntime,
  protection: RotationProtection,
  pendingDispatchText: string | null,
  hivePort: string
): Promise<{ protection: RotationProtection; success: boolean }> => {
  const workspacePath = workspace.path

  await appendEntry(workspacePath, agent.name, {
    type: 'session_rotated',
    summary: `Session rotated (msgs: ${protection.lastRotationAt ? 'scheduled' : 'trigger'})`,
    body: `Worker rotation triggered.\nAgent: ${agent.name}\nWorkspace: ${workspace.name}`,
  })

  const activeRun = runtime.getActiveRunByAgentId(workspace.id, agentId)
  if (activeRun) {
    runtime.stopAgentRun(activeRun.runId)
  }

  try {
    const newRun = await runtime.startAgent(workspace, agentId, { hivePort })
    const recovery = await buildWorkerRotationRecovery(
      workspacePath,
      agent,
      workspace,
      pendingDispatchText
    )
    runtime.writeAgentStdin(workspace.id, agentId, recovery)

    return {
      protection: {
        consecutiveFailures: 0,
        lastRotationAt: Date.now(),
        suspended: false,
      },
      success: true,
    }
  } catch {
    const failures = protection.consecutiveFailures + 1
    return {
      protection: {
        consecutiveFailures: failures,
        lastRotationAt: Date.now(),
        suspended: failures >= MAX_FAILURES,
      },
      success: false,
    }
  }
}

export const buildWorkerRotationRecovery = async (
  workspacePath: string,
  agent: AgentSummary,
  workspace: WorkspaceSummary,
  pendingDispatchText: string | null
): Promise<string> => {
  const entries = await getRecentEntries(workspacePath, agent.name, 5)

  const journalLines = entries.map(
    (e, i) => `${i + 1}. [${e.ts}] ${e.type}: ${e.summary}\n   → 详见 .hive/journal/${agent.name}/entries/${e.file.replace('entries/', '')}`
  )

  const completedCount = entries.filter((e) => e.type === 'report_sent').length

  const sections: string[] = [
    `你是 ${workspace.name} 的 ${agent.name}（${agent.role}）。`,
    '你刚被 Hive 进行了 session 轮转（上下文刷新），这是正常操作。',
    '',
    '## 你的航行日志（最近 5 条）',
    ...journalLines,
    '',
    '## 当前状态',
    `- 待处理派单：${pendingDispatchText ?? '无，等待新派单'}`,
    `- 已完成 dispatch 数：${completedCount}`,
    '',
    '## 如需恢复完整上下文',
    `cat .hive/journal/${agent.name}/manifest.jsonl`,
    `cat .hive/journal/${agent.name}/entries/<文件名>`,
    '',
    '## 你的规则',
    ...getHiveTeamRules(agent),
  ]

  return `<hive-system-message type="rotation-recovery">\n${sections.join('\n')}\n</hive-system-message>`
}

export const shouldRotateOrchestrator = (
  context: OrchestratorRotationContext,
  protection: RotationProtection
): boolean => {
  if (protection.suspended) return false
  const elapsed = Date.now() - context.sessionStartedAt
  if (elapsed < MIN_RUNTIME_MS) return false
  if (Date.now() - protection.lastRotationAt < COOLDOWN_MS) return false

  if (context.compactDetectedAndIdle) return true
  if (context.messageCount >= ORCH_MESSAGE_THRESHOLD) return true
  if (elapsed >= ORCH_DURATION_THRESHOLD_MS) return true

  return false
}

export interface OrchestratorRecoveryInput {
  checkpoint: string | null
  recentUserInputs: string[]
  workers: AgentSummary[]
  activeDispatches: Array<{ toWorkerName: string; text: string; status: string }>
  tasksContent: string
}

export const buildOrchestratorRotationRecovery = async (
  workspacePath: string,
  agent: AgentSummary,
  workspace: WorkspaceSummary,
  input: OrchestratorRecoveryInput
): Promise<string> => {
  const entries = await getRecentEntries(workspacePath, agent.name, 8)
  const decisions = await getActiveDecisions(workspacePath)

  const journalLines = entries.map(
    (e, i) => `${i + 1}. [${e.ts}] ${e.type}: ${e.summary}\n   → 详见 .hive/journal/${agent.name}/entries/${e.file.replace('entries/', '')}`
  )

  const workerLines = input.workers.map(
    (w) => `- @${w.name} (${w.role}) — status: ${w.status}, pending: ${w.pendingTaskCount}`
  )

  const dispatchLines = input.activeDispatches.length > 0
    ? input.activeDispatches.map((d) => `- → @${d.toWorkerName}: ${d.text.slice(0, 80)} [${d.status}]`)
    : ['- （无活跃派单）']

  const decisionLines = decisions.length > 0
    ? decisions.map((d) => `- [${d.category}] ${d.content} — 理由：${d.reason}`)
    : ['- （无）']

  const sections: string[] = [
    `你是 ${workspace.name} 的 Orchestrator。`,
    '你刚被 Hive 进行了 session 轮转（上下文刷新），这是正常操作。',
  ]

  if (input.checkpoint) {
    sections.push('', '## 你上次的 Checkpoint', input.checkpoint)
  }

  sections.push(
    '',
    '## 航行日志（最近 8 条）',
    ...journalLines,
    '',
    '## 最近与 user 的对话',
    ...(input.recentUserInputs.length > 0 ? input.recentUserInputs.slice(-5) : ['（无）']),
    '',
    '## Active Decisions（董秘账本）',
    '以下是用户在本 workspace 中做出的所有有效决策，你必须遵守：',
    ...decisionLines,
    '',
    '## 当前活跃 worker',
    ...workerLines,
    '',
    '## 当前派单状态',
    ...dispatchLines,
    '',
    '## tasks.md 当前内容',
    input.tasksContent.slice(0, TASKS_HEAD_LIMIT) || '(空)',
    '',
    '## 如需恢复更多上下文',
    `cat .hive/journal/${agent.name}/manifest.jsonl`,
    'cat .hive/tasks.md',
    'team list',
    '',
    '## 你的规则',
    ...getHiveTeamRules(agent),
  )

  return `<hive-system-message type="rotation-recovery">\n${sections.join('\n')}\n</hive-system-message>`
}

