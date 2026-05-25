import { useCallback, useEffect, useRef, useState } from 'react'

import { initializeUiSession } from '../api.js'

export type DispatchStatus = 'queued' | 'submitted' | 'reported' | 'cancelled'

export interface DispatchItem {
  id: string
  state: DispatchStatus
  task_id: string | null
  text: string
  to_agent_id: string
  from_agent_id: string | null
  created_at: number
  reported_at: number | null
  report_text: string | null
}

export interface TaskDispatchSummary {
  taskId: string | null
  total: number
  reported: number
  cancelled: number
  failed: number
  allDone: boolean
}

const apiFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const response = await fetch(input, init)
  if (!response.ok) throw new Error(`API error: ${response.status}`)
  return response
}

export const fetchDispatches = async (
  workspaceId: string,
  state?: DispatchStatus
): Promise<DispatchItem[]> => {
  const params = new URLSearchParams()
  if (state) params.set('state', state)
  params.set('limit', '100')
  const url = `/api/ui/workspaces/${workspaceId}/dispatches?${params}`
  const response = await apiFetch(url)
  return (await response.json()) as DispatchItem[]
}

export const groupDispatchesByTaskId = (dispatches: DispatchItem[]): Map<string | null, TaskDispatchSummary> => {
  const map = new Map<string | null, TaskDispatchSummary>()
  for (const d of dispatches) {
    const key = d.task_id
    const existing = map.get(key)
    if (existing) {
      existing.total++
      if (d.state === 'reported') existing.reported++
      if (d.state === 'cancelled') existing.cancelled++
      existing.allDone = existing.reported + existing.cancelled === existing.total
    } else {
      const reported = d.state === 'reported' ? 1 : 0
      const cancelled = d.state === 'cancelled' ? 1 : 0
      map.set(key, {
        taskId: key,
        total: 1,
        reported,
        cancelled,
        failed: 0,
        allDone: reported + cancelled === 1,
      })
    }
  }
  return map
}

/** 最大重连延迟 */
const MAX_RECONNECT_MS = 10_000
const getReconnectDelay = (attempt: number) => Math.min(1000 * 2 ** attempt, MAX_RECONNECT_MS)

const areDispatchesEqual = (a: DispatchItem[], b: DispatchItem[]): boolean => {
  if (a.length !== b.length) return false
  return a.every((item, i) => {
    const other = b[i]
    return other !== undefined && item.id === other.id && item.state === other.state
  })
}

export const useDispatchesForWorkspace = (workspaceId: string | null) => {
  const [dispatches, setDispatches] = useState<DispatchItem[]>([])
  const [loading, setLoading] = useState(false)
  const refreshingRef = useRef(false)

  const refresh = useCallback(async () => {
    if (!workspaceId) return
    try {
      const data = await fetchDispatches(workspaceId)
      setDispatches(data)
    } catch (error) {
      console.error('[hive] swallowed:useTasksApi.refresh', error)
    }
  }, [workspaceId])

  useEffect(() => {
    if (!workspaceId) {
      setDispatches([])
      return
    }

    setLoading(true)
    let cancelled = false
    const reconnectTimers: number[] = []
    const sources: EventSource[] = []

    const connect = (attempt = 0) => {
      if (cancelled) return

      const url = `/api/ui/workspaces/${encodeURIComponent(workspaceId)}/dispatches/events`
      const es = new EventSource(url)
      sources.push(es)

      es.onmessage = (event) => {
        if (cancelled) return
        setLoading(false)
        try {
          const payload = JSON.parse(event.data) as DispatchItem[]
          setDispatches((prev) => {
            if (areDispatchesEqual(prev, payload)) return prev
            return payload
          })
        } catch (error) {
          console.error('[hive] dispatch SSE parse error', error)
        }
      }

      es.onerror = () => {
        if (cancelled) return
        es.close()
        const idx = sources.indexOf(es)
        if (idx >= 0) sources.splice(idx, 1)

        // token 可能过期，尝试 refresh session
        if (!refreshingRef.current) {
          refreshingRef.current = true
          void initializeUiSession()
            .catch(() => {})
            .finally(() => { refreshingRef.current = false })
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
      for (const es of sources) es.close()
      for (const timer of reconnectTimers) window.clearTimeout(timer)
      sources.length = 0
      reconnectTimers.length = 0
    }
  }, [workspaceId])

  return { dispatches, loading, refresh }
}

const HISTORY_PAGE_SIZE = 20

export const fetchDispatchHistory = async (
  workspaceId: string,
  limit = HISTORY_PAGE_SIZE,
  offset = 0
): Promise<DispatchItem[]> => {
  const [reported, cancelled] = await Promise.all([
    apiFetch(`/api/ui/workspaces/${workspaceId}/dispatches?state=reported&limit=${limit}&offset=${offset}`),
    apiFetch(`/api/ui/workspaces/${workspaceId}/dispatches?state=cancelled&limit=${limit}&offset=${offset}`),
  ])
  const [r, c] = await Promise.all([
    reported.json() as Promise<DispatchItem[]>,
    cancelled.json() as Promise<DispatchItem[]>,
  ])
  return [...r, ...c].sort((a, b) => (b.reported_at ?? b.created_at) - (a.reported_at ?? a.created_at))
}

export const useDispatchHistory = (workspaceId: string | null) => {
  const [items, setItems] = useState<DispatchItem[]>([])
  const [loading, setLoading] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const offsetRef = useRef(0)

  useEffect(() => {
    setItems([])
    offsetRef.current = 0
    setHasMore(true)
    if (!workspaceId) return
    setLoading(true)
    void fetchDispatchHistory(workspaceId).then((data) => {
      setItems(data)
      setHasMore(data.length >= HISTORY_PAGE_SIZE)
      offsetRef.current = HISTORY_PAGE_SIZE
    }).finally(() => setLoading(false))
  }, [workspaceId])

  const loadMore = useCallback(async () => {
    if (!workspaceId || loading) return
    setLoading(true)
    try {
      const data = await fetchDispatchHistory(workspaceId, HISTORY_PAGE_SIZE, offsetRef.current)
      setItems((prev) => [...prev, ...data])
      setHasMore(data.length >= HISTORY_PAGE_SIZE)
      offsetRef.current += HISTORY_PAGE_SIZE
    } finally {
      setLoading(false)
    }
  }, [workspaceId, loading])

  return { items, loading, hasMore, loadMore }
}
