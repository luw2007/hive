import type { AgentSummary, WorkspaceSummary } from '../shared/types.js'

import { appendEntry, getRecentEntries } from './agent-journal.js'
import type { AgentRuntime } from './agent-runtime-contract.js'
import { getActiveDecisions } from './decision-ledger.js'
import { getHiveTeamRules } from './hive-team-guidance.js'
import type { OrchMessageQueue } from './orch-message-queue.js'

export interface RotationContext {
  compactDetected: boolean
  dispatchReportedAndNoPending: boolean
  hasActiveDispatch: boolean
  messageCount: number
  sessionStartedAt: number
}

export interface OrchestratorRotationContext {
  allWorkersIdle: boolean
  compactDetectedAndIdle: boolean
  messageCount: number
  noPendingDispatches: boolean
  sessionStartedAt: number
  userSilentDurationMs: number
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
const RECOVERY_MAX_CHARS = 12_000
const DECISION_LIMIT = 20

interface RecoverySection {
  key: string
  content: string
  priority: number
}

export const applyBudgetControl = (sections: RecoverySection[], maxChars: number = RECOVERY_MAX_CHARS): string => {
  const measure = (parts: string[]) => {
    const nonEmpty = parts.filter(Boolean)
    if (nonEmpty.length === 0) return 0
    return nonEmpty.reduce((s, p) => s + p.length, 0) + (nonEmpty.length - 1)
  }
  const render = (map: Map<string, string>) =>
    sections.map((s) => map.get(s.key) ?? '').filter(Boolean).join('\n')

  const contents = new Map(sections.map((s) => [s.key, s.content]))
  if (measure([...contents.values()]) <= maxChars) return render(contents)

  const sorted = [...sections].sort((a, b) => a.priority - b.priority)

  for (const s of sorted) {
    if (s.priority >= 6) break
    const othersValues = sections.filter((x) => x.key !== s.key).map((x) => contents.get(x.key) ?? '')
    const othersLen = measure(othersValues)
    const hasOthers = othersValues.some(Boolean)
    const available = maxChars - othersLen - (hasOthers ? 1 : 0)
    const TRUNCATION_SUFFIX = '...(truncated)'
    if (available <= 0 || (contents.get(s.key) ?? '').length > available) {
      if (available >= TRUNCATION_SUFFIX.length + 1) {
        contents.set(s.key, s.content.slice(0, available - TRUNCATION_SUFFIX.length) + TRUNCATION_SUFFIX)
      } else {
        contents.set(s.key, '')
      }
    }
    if (measure([...contents.values()]) <= maxChars) break
  }

  return render(contents)
}

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
  const decisions = await getActiveDecisions(workspacePath)

  const journalLines = entries.map(
    (e, i) => `${i + 1}. [${e.ts}] ${e.type}: ${e.summary}\n   → 详见 .hive/journal/${agent.name}/entries/${e.file.replace('entries/', '')}`
  )

  const completedCount = entries.filter((e) => e.type === 'report_sent').length

  const CODER_CATEGORIES = new Set(['tech', 'constraint'])
  const TESTER_CATEGORIES = new Set(['tech', 'constraint', 'scope'])
  const filteredDecisions = agent.role === 'coder'
    ? decisions.filter((d) => CODER_CATEGORIES.has(d.category))
    : agent.role === 'tester'
    ? decisions.filter((d) => TESTER_CATEGORIES.has(d.category))
    : decisions

  const decisionLines = filteredDecisions.length > 0
    ? filteredDecisions.map((d) => `- [${d.category}] ${d.content} — 理由：${d.reason}`)
    : ['- （无）']

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
    '## Active Decisions（董秘账本）',
    '以下决策你必须遵守：',
    ...decisionLines,
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
  if (
    context.allWorkersIdle &&
    context.noPendingDispatches &&
    context.userSilentDurationMs > 5 * 60_000
  ) return true

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
  const allDecisions = await getActiveDecisions(workspacePath)

  const decisions = allDecisions
    .sort((a, b) => (b.last_referenced ?? 0) - (a.last_referenced ?? 0))
    .slice(0, DECISION_LIMIT)

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

  const header = [
    `你是 ${workspace.name} 的 Orchestrator。`,
    '你刚被 Hive 进行了 session 轮转（上下文刷新），这是正常操作。',
    ...(input.checkpoint ? ['', '## 你上次的 Checkpoint', input.checkpoint] : []),
  ].join('\n')

  const journalContent = ['## 航行日志（最近 8 条）', ...journalLines].join('\n')
  const userInputContent = ['## 最近与 user 的对话', ...(input.recentUserInputs.length > 0 ? input.recentUserInputs.slice(-5) : ['（无）'])].join('\n')
  const decisionsContent = ['## Active Decisions（董秘账本）', '以下是用户在本 workspace 中做出的所有有效决策，你必须遵守：', ...decisionLines].join('\n')
  const workersContent = ['## 当前活跃 worker', ...workerLines, '', '## 当前派单状态', ...dispatchLines].join('\n')
  const tasksContent = ['## tasks.md 当前内容', input.tasksContent.slice(0, TASKS_HEAD_LIMIT) || '(空)'].join('\n')
  const footer = [
    '## 如需恢复更多上下文',
    `cat .hive/journal/${agent.name}/manifest.jsonl`,
    'cat .hive/tasks.md',
    'team list',
  ].join('\n')
  const rulesContent = ['## 你的规则', ...getHiveTeamRules(agent)].join('\n')

  const budgetSections: RecoverySection[] = [
    { key: 'header', content: header, priority: 7 },
    { key: 'journal', content: journalContent, priority: 2 },
    { key: 'user_inputs', content: userInputContent, priority: 4 },
    { key: 'decisions', content: decisionsContent, priority: 3 },
    { key: 'workers', content: workersContent, priority: 5 },
    { key: 'tasks', content: tasksContent, priority: 1 },
    { key: 'footer', content: footer, priority: 7 },
    { key: 'rules', content: rulesContent, priority: 7 },
  ]

  const body = applyBudgetControl(budgetSections)
  return `<hive-system-message type="rotation-recovery">\n${body}\n</hive-system-message>`
}

export const executeOrchestratorRotation = async (
  workspace: WorkspaceSummary,
  agentId: string,
  agent: AgentSummary,
  runtime: AgentRuntime,
  protection: RotationProtection,
  recoveryInput: OrchestratorRecoveryInput,
  hivePort: string,
  queue?: OrchMessageQueue
): Promise<{ protection: RotationProtection; success: boolean }> => {
  await appendEntry(workspace.path, agent.name, {
    type: 'session_rotated',
    summary: 'Orchestrator session rotated',
    body: `Orchestrator rotation triggered.\nAgent: ${agent.name}\nWorkspace: ${workspace.name}`,
  })

  queue?.hold(workspace.id)

  const activeRun = runtime.getActiveRunByAgentId(workspace.id, agentId)
  if (activeRun) {
    runtime.stopAgentRun(activeRun.runId)
  }

  try {
    await runtime.startAgent(workspace, agentId, { hivePort })
    const recovery = await buildOrchestratorRotationRecovery(workspace.path, agent, workspace, recoveryInput)
    runtime.writeAgentStdin(workspace.id, agentId, recovery)
    queue?.resume(workspace.id)

    return {
      protection: {
        consecutiveFailures: 0,
        lastRotationAt: Date.now(),
        suspended: false,
      },
      success: true,
    }
  } catch {
    queue?.resume(workspace.id)
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

