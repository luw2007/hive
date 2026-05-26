import { useEffect, useRef, useState } from 'react'

import type { TeamListItem, TeamListItemPayload } from '../../src/shared/types.js'
import { apiFetch, initializeUiSession } from './api.js'

const fromPayload = (payload: TeamListItemPayload): TeamListItem => ({
  id: payload.id,
  name: payload.name,
  role: payload.role,
  status: payload.status,
  pendingTaskCount: payload.pending_task_count,
  ...(payload.role_template_name ? { roleTemplateName: payload.role_template_name } : {}),
  ...(payload.last_pty_line ? { lastPtyLine: payload.last_pty_line } : {}),
  ...(payload.command_preset_id ? { commandPresetId: payload.command_preset_id } : {}),
})

const areWorkersEqual = (a: TeamListItem[], b: TeamListItem[]): boolean => {
  if (a.length !== b.length) return false
  return a.every((worker, index) => {
    const other = b[index]
    return (
      other !== undefined &&
      worker.id === other.id &&
      worker.lastPtyLine === other.lastPtyLine &&
      worker.name === other.name &&
      worker.pendingTaskCount === other.pendingTaskCount &&
      worker.role === other.role &&
      worker.status === other.status
    )
  })
}

/** 最大重连延迟 */
const MAX_RECONNECT_MS = 10_000
const getReconnectDelay = (attempt: number) => Math.min(1000 * 2 ** attempt, MAX_RECONNECT_MS)

/** 非活跃 workspace 轮询间隔 */
const POLL_INTERVAL_MS = 5_000

/**
 * 通过 SSE 订阅活跃 workspace 的团队状态变更，其他 workspace 用 fetch 轮询。
 * 这样避免 HTTP/1.1 浏览器 6 连接限制导致请求 pending。
 *
 * activeWorkspaceId: 当前活跃 workspace 使用 SSE 实时推送
 * 其他 workspace: 每 5 秒 fetch 轮询
 */
export const useWorkspaceWorkers = (
  workspaceIds: readonly string[],
  activeWorkspaceId: string | null
) => {
  const workspaceKey = workspaceIds.join('\0')
  const [workersByWorkspaceId, setWorkersByWorkspaceId] = useState<Record<string, TeamListItem[]>>(
    {}
  )
  const refreshingRef = useRef(false)

  // 清理不再存在的 workspace 数据
  useEffect(() => {
    const ids = new Set(workspaceKey ? workspaceKey.split('\0') : [])
    setWorkersByWorkspaceId((current) => {
      const pruned: Record<string, TeamListItem[]> = {}
      let changed = false
      for (const [key, value] of Object.entries(current)) {
        if (ids.has(key)) {
          pruned[key] = value
        } else {
          changed = true
        }
      }
      return changed ? pruned : current
    })
  }, [workspaceKey])

  // SSE 连接：仅活跃 workspace
  useEffect(() => {
    if (!activeWorkspaceId || !workspaceIds.includes(activeWorkspaceId)) return

    let cancelled = false
    const reconnectTimers: number[] = []
    let currentSource: EventSource | null = null

    const connect = (attempt = 0) => {
      if (cancelled) return

      const url = `/api/ui/workspaces/${encodeURIComponent(activeWorkspaceId)}/team/events`
      const es = new EventSource(url)
      currentSource = es

      es.onmessage = (event) => {
        if (cancelled) return
        try {
          const payload = JSON.parse(event.data) as TeamListItemPayload[]
          const workers = payload.map(fromPayload)
          setWorkersByWorkspaceId((current) => {
            const existing = current[activeWorkspaceId] ?? []
            if (areWorkersEqual(existing, workers)) return current
            return { ...current, [activeWorkspaceId]: workers }
          })
        } catch (error) {
          console.error('[hive] SSE parse error', activeWorkspaceId, error)
        }
      }

      es.onerror = () => {
        if (cancelled) return
        es.close()
        currentSource = null

        if (!refreshingRef.current) {
          refreshingRef.current = true
          void initializeUiSession()
            .catch(() => {})
            .finally(() => {
              refreshingRef.current = false
            })
        }

        const delay = getReconnectDelay(attempt)
        const timer = window.setTimeout(
          () => connect(Math.min(attempt + 1, 5)),
          delay
        )
        reconnectTimers.push(timer)
      }
    }

    connect()

    return () => {
      cancelled = true
      currentSource?.close()
      for (const timer of reconnectTimers) window.clearTimeout(timer)
    }
  }, [activeWorkspaceId, workspaceKey])

  // Fetch 轮询：非活跃 workspace（串行避免 HTTP/1.1 连接耗尽）
  useEffect(() => {
    if (!workspaceKey) return

    const ids = workspaceKey.split('\0').filter((id) => id !== activeWorkspaceId)
    if (ids.length === 0) return

    let cancelled = false

    const pollAll = async () => {
      for (const workspaceId of ids) {
        if (cancelled) return
        try {
          const url = `/api/ui/workspaces/${encodeURIComponent(workspaceId)}/team`
          const response = await apiFetch(url)
          if (!response.ok || cancelled) return
          const payload = (await response.json()) as TeamListItemPayload[]
          const workers = payload.map(fromPayload)
          setWorkersByWorkspaceId((current) => {
            const existing = current[workspaceId] ?? []
            if (areWorkersEqual(existing, workers)) return current
            return { ...current, [workspaceId]: workers }
          })
        } catch {
          // 轮询失败静默忽略，下次重试
        }
      }
    }

    void pollAll()
    const timer = window.setInterval(() => void pollAll(), POLL_INTERVAL_MS)

    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [workspaceKey, activeWorkspaceId])

  return [workersByWorkspaceId, setWorkersByWorkspaceId] as const
}
