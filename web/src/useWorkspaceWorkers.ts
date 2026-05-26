import { useCallback, useEffect, useState } from 'react'

import type { TeamListItem, TeamListItemPayload } from '../../src/shared/types.js'
import { apiFetch } from './api.js'

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

/**
 * 维护 workers 状态。
 * 主通道：全局 SSE 推送 team 数据（通过 handleTeamUpdate）。
 * 保底：初始化时做一次 fetch 获取初始数据（SSE 可能还没连上或测试环境下 mock 不发数据）。
 */
export const useWorkspaceWorkers = (workspaceIds: readonly string[]) => {
  const workspaceKey = workspaceIds.join('\0')
  const [workersByWorkspaceId, setWorkersByWorkspaceId] = useState<Record<string, TeamListItem[]>>(
    {}
  )

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

  // 初始 fetch：确保 SSE 还没推送前有数据
  useEffect(() => {
    if (!workspaceKey) return
    let cancelled = false
    const ids = workspaceKey.split('\0')

    const fetchAll = async () => {
      for (const workspaceId of ids) {
        if (cancelled) return
        try {
          const url = `/api/ui/workspaces/${encodeURIComponent(workspaceId)}/team`
          const response = await apiFetch(url)
          if (!response.ok || cancelled) continue
          const payload = (await response.json()) as TeamListItemPayload[]
          const workers = payload.map(fromPayload)
          setWorkersByWorkspaceId((current) => {
            const existing = current[workspaceId] ?? []
            if (areWorkersEqual(existing, workers)) return current
            return { ...current, [workspaceId]: workers }
          })
        } catch {
          // 初始 fetch 失败静默忽略，等 SSE 推送
        }
      }
    }

    void fetchAll()
    return () => { cancelled = true }
  }, [workspaceKey])

  /** 接收全局 SSE 推送的 team 数据 */
  const handleTeamUpdate = useCallback((workspaceId: string, rawWorkers: unknown[]) => {
    const workers = (rawWorkers as TeamListItemPayload[]).map(fromPayload)
    setWorkersByWorkspaceId((current) => {
      const existing = current[workspaceId] ?? []
      if (areWorkersEqual(existing, workers)) return current
      return { ...current, [workspaceId]: workers }
    })
  }, [])

  return { workersByWorkspaceId, setWorkersByWorkspaceId, handleTeamUpdate }
}
