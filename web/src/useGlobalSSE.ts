import { useEffect, useRef, useState } from 'react'

import { initializeUiSession } from './api.js'

/** 最大重连延迟 */
const MAX_RECONNECT_MS = 10_000
const getReconnectDelay = (attempt: number) => Math.min(1000 * 2 ** attempt, MAX_RECONNECT_MS)

export type GlobalSSETeamHandler = (workspaceId: string, workers: unknown[]) => void
export type GlobalSSEDispatchHandler = (workspaceId: string, dispatches: unknown[]) => void

// ─── 全局事件总线 ───
// 让任意组件订阅 dispatches 推送，无需通过 prop drilling

type DispatchListener = (workspaceId: string, dispatches: unknown[]) => void
const dispatchListeners = new Set<DispatchListener>()

/** 在任意组件中订阅 dispatches 推送。返回 unsubscribe 函数。 */
export const subscribeDispatches = (listener: DispatchListener): (() => void) => {
  dispatchListeners.add(listener)
  return () => { dispatchListeners.delete(listener) }
}

/**
 * 全局 SSE 连接管理器。
 * 建立单一 EventSource 到 /api/ui/events，按 event type 分发给订阅者。
 * 浏览器只占用 1 个长连接覆盖所有 workspace。
 */
export const useGlobalSSE = (onTeam: GlobalSSETeamHandler) => {
  const onTeamRef = useRef(onTeam)
  onTeamRef.current = onTeam

  const [connected, setConnected] = useState(false)
  const refreshingRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    let currentSource: EventSource | null = null
    const reconnectTimers: number[] = []

    const connect = (attempt = 0) => {
      if (cancelled) return

      const es = new EventSource('/api/ui/events')
      currentSource = es

      es.addEventListener('team', (event: MessageEvent) => {
        if (cancelled) return
        try {
          const payload = JSON.parse(event.data) as { workspace_id: string; workers: unknown[] }
          onTeamRef.current(payload.workspace_id, payload.workers)
        } catch (error) {
          console.error('[hive] global SSE team parse error', error)
        }
      })

      es.addEventListener('dispatches', (event: MessageEvent) => {
        if (cancelled) return
        try {
          const payload = JSON.parse(event.data) as { workspace_id: string; dispatches: unknown[] }
          for (const listener of dispatchListeners) {
            listener(payload.workspace_id, payload.dispatches)
          }
        } catch (error) {
          console.error('[hive] global SSE dispatches parse error', error)
        }
      })

      es.onopen = () => {
        if (cancelled) return
        setConnected(true)
      }

      es.onerror = () => {
        if (cancelled) return
        es.close()
        currentSource = null
        setConnected(false)

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
  }, [])

  return connected
}
