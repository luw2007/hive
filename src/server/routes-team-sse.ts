import { getRequiredParam, route } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'
import { enrichTeamList } from './team-list-enrichment.js'
import { serializeTeamListItem } from './team-list-serializer.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'

export const teamSseRoutes: RouteDefinition[] = [
  route(
    'GET',
    '/api/ui/workspaces/:workspaceId/team/events',
    ({ params, request, response, store }) => {
      const workspaceId = getRequiredParam(
        response,
        params,
        'workspaceId',
        'Workspace id is required'
      )
      if (!workspaceId) return

      requireUiTokenFromRequest(request, store.validateUiToken)

      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })

      const sendSnapshot = () => {
        const data = enrichTeamList(workspaceId, store, store.listWorkers(workspaceId)).map(
          serializeTeamListItem
        )
        response.write(`data: ${JSON.stringify(data)}\n\n`)
      }

      sendSnapshot()

      const unsubscribe = store.registerTeamListener(workspaceId, () => {
        if (response.destroyed) return
        sendSnapshot()
      })

      const keepalive = setInterval(() => {
        if (response.destroyed) return
        response.write(': keepalive\n\n')
      }, 15_000)

      const cleanup = () => {
        unsubscribe()
        clearInterval(keepalive)
      }

      request.on('close', cleanup)
      request.on('error', cleanup)
    }
  ),
]
