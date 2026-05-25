import { useEffect, useRef, useState } from 'react'

import type { TeamListItem, TeamListItemPayload } from '../../src/shared/types.js'
import { initializeUiSession } from './api.js'

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

/**
 * 通过 SSE 订阅所有 workspace 的团队状态变更。
 * 每个 workspaceId 建立一条 EventSource 连接。
 */
export const useWorkspaceWorkers = (workspaceIds: readonly string[]) => {
  const workspaceKey = workspaceIds.join('\0')
  const [workersByWorkspaceId, setWorkersByWorkspaceId] = useState<Record<string, TeamListItem[]>>(
    {}
  )
  // 用 ref 追踪 session refresh 是否正在进行，避免多条 SSE 同时触发
  const refreshingRef = useRef(false)

  useEffect(() => {
    if (!workspaceKey) {
      setWorkersByWorkspaceId({})
      return
    }

    const ids = workspaceKey.split('\0')
    const sources: EventSource[] = []
    const reconnectTimers: number[] = []
    let cancelled = false

    const connectWorkspace = (workspaceId: string, attempt = 0) => {
      if (cancelled) return

      const url = `/api/ui/workspaces/${encodeURIComponent(workspaceId)}/team/events`
      const es = new EventSource(url)
      sources.push(es)

      es.onmessage = (event) => {
        if (cancelled) return
        try {
          const payload = JSON.parse(event.data) as TeamListItemPayload[]
          const workers = payload.map(fromPayload)
          setWorkersByWorkspaceId((current) => {
            const existing = current[workspaceId] ?? []
            if (areWorkersEqual(existing, workers)) return current
            return { ...current, [workspaceId]: workers }
          })
        } catch (error) {
          console.error('[hive] SSE parse error', workspaceId, error)
        }
      }

      es.onerror = () => {
        if (cancelled) return
        es.close()
        // 从 sources 中移除已关闭的
        const idx = sources.indexOf(es)
        if (idx >= 0) sources.splice(idx, 1)

        // 可能是 token 过期导致 403，尝试 refresh session 再重连
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
          () => connectWorkspace(workspaceId, Math.min(attempt + 1, 5)),
          delay
        )
        reconnectTimers.push(timer)
      }
    }

    for (const id of ids) connectWorkspace(id)

    return () => {
      cancelled = true
      for (const es of sources) es.close()
      for (const timer of reconnectTimers) window.clearTimeout(timer)
      sources.length = 0
      reconnectTimers.length = 0
    }
  }, [workspaceKey])

  return [workersByWorkspaceId, setWorkersByWorkspaceId] as const
}
