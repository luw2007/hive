import type { Database } from 'better-sqlite3'

import { createHandoffStore } from './handoff-store.js'

const HANDOFF_TIMEOUT_MS = 30_000

const HANDOFF_PROMPT = [
  '[Hive 系统消息：交接通知]',
  '你即将被移除。请在 30 秒内用以下命令提交工作交接摘要：',
  '  team report --handover "你的交接摘要：当前进度、未完成事项、关键上下文"',
  '如果超时未提交，系统将自动回收你的公开状态信息。',
].join('\n')

const buildHandoffNotification = (
  agentName: string,
  reportText: string,
  pendingDispatches: string | null | undefined
): string => {
  const summary = reportText.length > 200 ? `${reportText.slice(0, 200)}…` : reportText
  const pending = pendingDispatches ? `\n未完成派单：${pendingDispatches}` : ''
  return `[Hive 系统消息：@${agentName} 已交接移除]\n摘要：${summary}${pending}\n`
}

export interface HandoffContext {
  agentId: string
  agentName: string
  workspaceId: string
}

type PendingHandoff = {
  context: HandoffContext
  timer: ReturnType<typeof setTimeout>
  resolve: () => void
}

export const createHandoffHandler = ({
  db,
  writeAgentStdin,
  deleteWorker,
  getCheckpoint,
}: {
  db: Database
  writeAgentStdin: (workspaceId: string, agentId: string, text: string) => void
  deleteWorker: (workspaceId: string, workerId: string) => void
  getCheckpoint: (agentId: string) => string | null
}) => {
  const handoffStore = createHandoffStore(db)
  const pending = new Map<string, PendingHandoff>()

  const notifyOrchestrator = (workspaceId: string, agentName: string, reportText: string, pendingDispatches?: string | null) => {
    const orchId = `${workspaceId}:orchestrator`
    try {
      writeAgentStdin(workspaceId, orchId, buildHandoffNotification(agentName, reportText, pendingDispatches))
    } catch {
      // Orchestrator may not be running — swallow
    }
  }

  const passiveHandoff = (ctx: HandoffContext) => {
    const checkpoint = getCheckpoint(ctx.agentId)
    const reportText = checkpoint ?? '(无主动交接，自动回收)'
    handoffStore.insertReport({
      workspaceId: ctx.workspaceId,
      agentId: ctx.agentId,
      agentName: ctx.agentName,
      mode: 'passive',
      reportText,
      pendingDispatches: null,
      sessionId: null,
    })
    deleteWorker(ctx.workspaceId, ctx.agentId)
    notifyOrchestrator(ctx.workspaceId, ctx.agentName, reportText)
  }

  const activeHandoff = (ctx: HandoffContext): Promise<void> => {
    const key = `${ctx.workspaceId}:${ctx.agentId}`
    if (pending.has(key)) return Promise.resolve()

    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(key)
        passiveHandoff(ctx)
        resolve()
      }, HANDOFF_TIMEOUT_MS)

      pending.set(key, { context: ctx, timer, resolve })

      try {
        writeAgentStdin(ctx.workspaceId, ctx.agentId, HANDOFF_PROMPT + '\n')
      } catch {
        clearTimeout(timer)
        pending.delete(key)
        passiveHandoff(ctx)
        resolve()
      }
    })
  }

  const receiveHandover = (
    workspaceId: string,
    agentId: string,
    reportText: string,
    pendingDispatches?: string | null,
    sessionId?: string | null
  ): boolean => {
    const key = `${workspaceId}:${agentId}`
    const entry = pending.get(key)
    if (!entry) return false

    clearTimeout(entry.timer)
    pending.delete(key)

    handoffStore.insertReport({
      workspaceId,
      agentId,
      agentName: entry.context.agentName,
      mode: 'active',
      reportText,
      ...(pendingDispatches != null ? { pendingDispatches } : {}),
      ...(sessionId != null ? { sessionId } : {}),
    })

    deleteWorker(workspaceId, agentId)
    notifyOrchestrator(workspaceId, entry.context.agentName, reportText, pendingDispatches)
    entry.resolve()
    return true
  }

  const isPendingHandoff = (workspaceId: string, agentId: string): boolean =>
    pending.has(`${workspaceId}:${agentId}`)

  return { activeHandoff, receiveHandover, isPendingHandoff, handoffStore }
}
