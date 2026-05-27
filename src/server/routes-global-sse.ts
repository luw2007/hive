import { serializeDispatchRecord } from './dispatch-ledger-serializer.js'
import { route } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'
import { enrichTeamList } from './team-list-enrichment.js'
import { serializeTeamListItem } from './team-list-serializer.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'

/**
 * 全局 SSE 端点：单一连接推送所有 workspace 的 team + dispatches 变更。
 * 避免浏览器 HTTP/1.1 并发连接数限制。
 *
 * 协议：
 *   event: team
 *   data: {"workspace_id":"xxx","workers":[...]}
 *
 *   event: dispatches
 *   data: {"workspace_id":"xxx","dispatches":[...]}
 */
export const globalSseRoutes: RouteDefinition[] = [
  route('GET', '/api/ui/events', ({ request, response, store }) => {
    requireUiTokenFromRequest(request, store.validateUiToken)

    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })

    const sendTeamSnapshot = (workspaceId: string) => {
      if (response.destroyed) return
      const workers = store.listWorkers(workspaceId)
      const data = enrichTeamList(workspaceId, store, workers).map(serializeTeamListItem)
      response.write(`event: team\ndata: ${JSON.stringify({ workspace_id: workspaceId, workers: data })}\n\n`)
    }

    const sendDispatchSnapshot = (workspaceId: string) => {
      if (response.destroyed) return
      const dispatches = store.listDispatches(workspaceId, { limit: 100 }).map(serializeDispatchRecord)
      response.write(`event: dispatches\ndata: ${JSON.stringify({ workspace_id: workspaceId, dispatches })}\n\n`)
    }

    // 初始推送所有 workspace 的当前状态
    const workspaces = store.listWorkspaces()
    for (const ws of workspaces) {
      sendTeamSnapshot(ws.id)
      sendDispatchSnapshot(ws.id)
    }

    // 订阅全局变更
    const unsubscribe = store.registerGlobalTeamListener((workspaceId) => {
      sendTeamSnapshot(workspaceId)
      sendDispatchSnapshot(workspaceId)
    })

    const keepalive = setInterval(() => {
      if (response.destroyed) return
      response.write(': keepalive\n\n')
    }, 15_000)

    let cleaned = false
    const cleanup = () => {
      if (cleaned) return
      cleaned = true
      unsubscribe()
      clearInterval(keepalive)
    }

    request.on('close', cleanup)
    request.on('error', cleanup)
  }),
]
