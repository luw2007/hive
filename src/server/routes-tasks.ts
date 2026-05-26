import { getRequiredParam, readJsonBody, route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'
import { requireUiTokenFromRequest } from './ui-auth-helpers.js'

export const taskRoutes: RouteDefinition[] = [
  route(
    'GET',
    '/api/workspaces/:workspaceId/tasks',
    ({ params, request, response, store, tasksFileService }) => {
      const workspaceId = getRequiredParam(
        response,
        params,
        'workspaceId',
        'Workspace id is required'
      )
      if (!workspaceId) {
        return
      }

      requireUiTokenFromRequest(request, store.validateUiToken)

      const workspace = store.getWorkspaceSnapshot(workspaceId)
      sendJson(response, 200, { content: tasksFileService.readTasks(workspace.summary.path) })
    }
  ),
  route(
    'PUT',
    '/api/workspaces/:workspaceId/tasks',
    async ({ params, request, response, store, tasksFileService }) => {
      const workspaceId = getRequiredParam(
        response,
        params,
        'workspaceId',
        'Workspace id is required'
      )
      if (!workspaceId) {
        return
      }

      requireUiTokenFromRequest(request, store.validateUiToken)

      // 新模型：md 为 DB 只读投影，忽略写入请求，返回当前 DB 生成内容
      await readJsonBody<{ content: string }>(request)
      const workspace = store.getWorkspaceSnapshot(workspaceId)
      const content = tasksFileService.readTasks(workspace.summary.path)
      sendJson(response, 200, { content, readonly: true })
    }
  ),
]
