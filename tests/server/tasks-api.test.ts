import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { createApp } from '../../src/server/app.js'
import { createRuntimeStore } from '../../src/server/runtime-store.js'
import { createTasksFileService } from '../../src/server/tasks-file.js'
import { getUiCookie } from '../helpers/ui-session.js'

const tempDirs: string[] = []
const servers: Array<{ close: () => void }> = []

afterEach(() => {
  while (servers.length > 0) {
    servers.pop()?.close()
  }

  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true })
  }
})

const startServer = async () => {
  const dataDir = join(tmpdir(), `hive-tasks-api-${Date.now()}`)
  mkdirSync(dataDir, { recursive: true })
  tempDirs.push(dataDir)

  const workspacePath = join(dataDir, 'workspace')
  mkdirSync(workspacePath, { recursive: true })

  const store = createRuntimeStore({ dataDir })
  const workspace = store.createWorkspace(workspacePath, 'Alpha')
  const app = createApp({ store, tasksFileService: createTasksFileService() })

  await new Promise<void>((resolve) => {
    app.server.listen(0, '127.0.0.1', () => resolve())
  })

  servers.push(app.server)

  const address = app.server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Server did not bind to an inet port')
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    workspace,
  }
}

describe('tasks api', () => {
  test('PUT is read-only: ignores write, returns current DB-generated content', async () => {
    const { baseUrl, workspace } = await startServer()
    const cookie = await getUiCookie(baseUrl)

    // 初始内容为空
    const initialResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/tasks`, {
      headers: { cookie },
    })
    expect(initialResponse.status).toBe(200)
    await expect(initialResponse.json()).resolves.toEqual({ content: '' })

    // PUT 请求被忽略，返回只读标记
    const updateResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/tasks`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ content: '- [ ] implement login\n' }),
    })
    expect(updateResponse.status).toBe(200)
    const putResult = await updateResponse.json() as { content: string; readonly: boolean }
    expect(putResult.readonly).toBe(true)
    expect(putResult.content).toBe('')
  })

  test('task creation via API generates .hive/tasks.md', async () => {
    const { baseUrl, workspace } = await startServer()
    const cookie = await getUiCookie(baseUrl)
    const hiveTasksPath = join(workspace.path, '.hive', 'tasks.md')

    // 通过 task API 创建任务
    const createResponse = await fetch(`${baseUrl}/api/team/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        workspace_id: workspace.id,
        title: 'implement login',
        source: 'user',
      }),
    })
    expect(createResponse.status).toBe(201)

    // 验证 md 文件已自动生成
    expect(existsSync(hiveTasksPath)).toBe(true)
    const content = readFileSync(hiveTasksPath, 'utf8')
    expect(content).toContain('implement login')
    expect(content).toContain('[ ]')
    expect(content).toContain('<!-- tid:')

    // GET 端点返回生成的内容
    const getResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/tasks`, {
      headers: { cookie },
    })
    const getResult = await getResponse.json() as { content: string }
    expect(getResult.content).toContain('implement login')
  })
})
