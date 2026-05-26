import type { RuntimeStore } from './runtime-store.js'
import { buildRecoverySummary, type ActiveDiscussionInfo } from './recovery-summary.js'
import { getActiveDecisions } from './decision-ledger.js'
import { hasInteractivePromptReady, isInteractiveAgentCommand } from './post-start-input-writer.js'
import type { TasksFileService } from './tasks-file.js'

const RECOVERY_WINDOW_MS = 60 * 60 * 1000
const CLEAR_SETTLE_MS = 1500
const PROMPT_POLL_MS = 100
const PROMPT_TIMEOUT_MS = 10_000

/**
 * 重置 agent 上下文：向 PTY 发送 /clear，等待 prompt 就绪后注入 recovery summary。
 * 用于 UI "Reset Context" 按钮，解决用户在 CLI 中执行 /clear 或 /new 后丢失 Hive 上下文的问题。
 */
export const resetAgentContext = async (
  store: RuntimeStore,
  tasksFileService: TasksFileService,
  workspaceId: string,
  agentId: string
): Promise<void> => {
  const run = store.getActiveRunByAgentId(workspaceId, agentId)
  if (!run) throw new Error('No active run for agent')

  const config = store.peekAgentLaunchConfig(workspaceId, agentId)
  if (!config) throw new Error('No launch config for agent')

  const command = config.interactiveCommand ?? config.command
  if (!isInteractiveAgentCommand(command)) {
    throw new Error('Reset context only supported for interactive agents')
  }

  // 步骤 1: 发送 /clear 命令
  store.writeRunInput(run.runId, '/clear\n')

  // 步骤 2: 等待 CLI 处理 /clear 并重新出现 prompt
  await waitForPromptReady(store, run.runId, command)

  // 步骤 3: 注入 recovery summary
  const snapshot = store.getWorkspaceSnapshot(workspaceId)
  const agent = snapshot.agents.find((a) => a.id === agentId)
  if (!agent) throw new Error('Agent not found in workspace snapshot')

  const workers = snapshot.agents.filter(
    (a) => a.role !== 'orchestrator' && a.id !== agentId
  )
  const messages = store.listMessagesForRecovery(workspaceId, Date.now() - RECOVERY_WINDOW_MS)
  const allTaskMessages = store.listMessagesForRecovery(workspaceId, 0)

  const dispatches = store.listDispatches(workspaceId, { status: 'submitted' })
  const queued = store.listDispatches(workspaceId, { status: 'queued' })
  const nameMap = new Map(snapshot.agents.map((a) => [a.id, a.name]))
  const activeDispatches = [...dispatches, ...queued].slice(0, 10).map((d) => ({
    status: d.status,
    text: d.text,
    toWorkerName: nameMap.get(d.toAgentId) ?? d.toAgentId,
  }))

  const activeDiscussions: ActiveDiscussionInfo[] = store.discussionOps
    .getActiveGroupsForWorkspace(workspaceId)
    .map((g) => ({
      currentRound: g.current_round,
      maxRounds: g.max_rounds,
      status: g.status,
      topic: g.topic,
    }))

  // 读 tasks.md
  let tasksContent = ''
  try {
    tasksContent = tasksFileService.readTasks(snapshot.summary.path)
  } catch {
    tasksContent = '(无法读取)'
  }

  const recoveryText = buildRecoverySummary({
    activeDispatches,
    activeDiscussions,
    agent,
    allTaskMessages,
    messages,
    decisions: await getActiveDecisions(snapshot.summary.path).catch(() => []),
    tasksContent,
    workers,
    workspace: snapshot.summary,
  })

  // 注入 recovery — 通过 writeAgentStdin 走 interactive paste 协议
  store.writeAgentStdin(workspaceId, agentId, recoveryText)
}

const waitForPromptReady = (
  store: RuntimeStore,
  runId: string,
  command: string
): Promise<void> =>
  new Promise((resolve, reject) => {
    const startedAt = Date.now()
    const checkPrompt = () => {
      const elapsed = Date.now() - startedAt
      if (elapsed >= PROMPT_TIMEOUT_MS) {
        // 超时也继续注入，比完全不注入好
        resolve()
        return
      }
      try {
        const run = store.getLiveRun(runId)
        if (run.status !== 'running' && run.status !== 'starting') {
          reject(new Error('Agent exited during context reset'))
          return
        }
        if (elapsed >= CLEAR_SETTLE_MS && run.output && hasInteractivePromptReady(run.output, command)) {
          resolve()
          return
        }
      } catch {
        reject(new Error('Agent run unavailable during context reset'))
        return
      }
      setTimeout(checkPrompt, PROMPT_POLL_MS)
    }
    setTimeout(checkPrompt, CLEAR_SETTLE_MS)
  })
