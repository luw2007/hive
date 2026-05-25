/**
 * 团队状态变更通知总线。
 *
 * 支持两种通知模式：
 * - 即时（structural）：worker 增删、状态切换等结构性变更立刻推送
 * - 防抖（pty output）：PTY 输出引起的 lastPtyLine 变更，按 workspace 去重后延迟推送
 *
 * 订阅者按 workspaceId 注册，收到通知后自行拉取最新快照。
 */

type TeamChangeListener = () => void

interface SubscriptionEntry {
  workspaceId: string
  listener: TeamChangeListener
}

export interface TeamChangeBus {
  /** 订阅某 workspace 的团队变更，返回 unsubscribe 函数 */
  subscribe: (workspaceId: string, listener: TeamChangeListener) => () => void
  /** 结构性变更（status/pendingTaskCount/add/delete/rename），立即通知 */
  notifyImmediate: (workspaceId: string) => void
  /** PTY output 引起的 lastPtyLine 变更，防抖通知（同一 workspace 500ms 内合并） */
  notifyPtyOutput: (workspaceId: string) => void
  /** 清理所有定时器 */
  dispose: () => void
}

const PTY_DEBOUNCE_MS = 500

export const createTeamChangeBus = (): TeamChangeBus => {
  const subscriptions = new Set<SubscriptionEntry>()
  const ptyTimers = new Map<string, ReturnType<typeof setTimeout>>()

  const fireListeners = (workspaceId: string) => {
    for (const entry of subscriptions) {
      if (entry.workspaceId === workspaceId) {
        entry.listener()
      }
    }
  }

  return {
    subscribe(workspaceId, listener) {
      const entry: SubscriptionEntry = { workspaceId, listener }
      subscriptions.add(entry)
      return () => {
        subscriptions.delete(entry)
      }
    },

    notifyImmediate(workspaceId) {
      // 结构性变更时，如果有 pending 的 pty 定时器也一并清除（下次推送会包含最新状态）
      const timer = ptyTimers.get(workspaceId)
      if (timer !== undefined) {
        clearTimeout(timer)
        ptyTimers.delete(workspaceId)
      }
      fireListeners(workspaceId)
    },

    notifyPtyOutput(workspaceId) {
      if (ptyTimers.has(workspaceId)) return // 已有定时器排队中
      ptyTimers.set(
        workspaceId,
        setTimeout(() => {
          ptyTimers.delete(workspaceId)
          fireListeners(workspaceId)
        }, PTY_DEBOUNCE_MS)
      )
    },

    dispose() {
      for (const timer of ptyTimers.values()) clearTimeout(timer)
      ptyTimers.clear()
      subscriptions.clear()
    },
  }
}
