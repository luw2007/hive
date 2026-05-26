import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { startTestServer } from '../helpers/test-server.js'

const waitFor = async (
  assertion: () => void | Promise<void>,
  timeoutMs = 3000,
  intervalMs = 50
) => {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() <= deadline) {
    try {
      await assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  }
  throw lastError
}

describe('decision ledger API', () => {
  let baseUrl: string
  let workspaceId: string
  let workspacePath: string
  let orchestratorId: string
  let orchToken: string
  let uiCookie: string
  let closeServer: (() => Promise<void>) | undefined
  let serverStore: Awaited<ReturnType<typeof startTestServer>>['store']

  beforeEach(async () => {
    workspacePath = mkdtempSync(join(tmpdir(), 'hive-decision-api-'))
    const server = await startTestServer()
    closeServer = server.close
    serverStore = server.store
    baseUrl = server.baseUrl

    const sessionRes = await fetch(`${baseUrl}/api/ui/session`)
    uiCookie = sessionRes.headers.get('set-cookie') ?? ''
    if (!uiCookie) throw new Error('Expected UI session cookie')

    const wsRes = await fetch(`${baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: uiCookie },
      body: JSON.stringify({ name: 'DecideTest', path: workspacePath }),
    })
    workspaceId = ((await wsRes.json()) as { id: string }).id
    orchestratorId = `${workspaceId}:orchestrator`

    // Start orch agent to get a token
    await fetch(`${baseUrl}/api/workspaces/${workspaceId}/agents/${orchestratorId}/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: uiCookie },
      body: JSON.stringify({
        command: '/bin/bash',
        args: ['-lc', `${process.execPath} -e "process.stdin.resume()"`],
      }),
    })
    await fetch(`${baseUrl}/api/workspaces/${workspaceId}/agents/${orchestratorId}/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: uiCookie },
      body: JSON.stringify({ hive_port: baseUrl.split(':').at(-1) }),
    })

    await waitFor(() => {
      const token = serverStore.peekAgentToken(orchestratorId)
      if (!token) throw new Error('orch token not ready')
      orchToken = token
    })
  })

  afterEach(async () => {
    await closeServer?.()
    rmSync(workspacePath, { force: true, recursive: true })
  })

  test('POST /api/team/decide creates decision and returns id', async () => {
    const res = await fetch(`${baseUrl}/api/team/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        project_id: workspaceId,
        from_agent_id: orchestratorId,
        token: orchToken,
        content: '使用 PostgreSQL 不用 MySQL',
        category: 'tech',
        reason: '团队熟悉度',
      }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { ok: boolean; decision: { id: string; content: string; category: string } }
    expect(body.ok).toBe(true)
    expect(body.decision.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(body.decision.content).toBe('使用 PostgreSQL 不用 MySQL')
    expect(body.decision.category).toBe('tech')

    // Verify written to filesystem
    await waitFor(() => {
      const { existsSync } = require('node:fs')
      expect(existsSync(join(workspacePath, '.hive', 'decisions.jsonl'))).toBe(true)
    })
  })

  test('GET /api/team/decisions returns only active decisions', async () => {
    // Create 3 decisions
    const ids: string[] = []
    for (const content of ['Decision A', 'Decision B', 'Decision C']) {
      const res = await fetch(`${baseUrl}/api/team/decide`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: workspaceId,
          from_agent_id: orchestratorId,
          token: orchToken,
          content,
          category: 'tech',
          reason: 'test reason',
        }),
      })
      const body = (await res.json()) as { decision: { id: string } }
      ids.push(body.decision.id)
    }

    // Supersede the first one
    await fetch(`${baseUrl}/api/team/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        project_id: workspaceId,
        from_agent_id: orchestratorId,
        token: orchToken,
        content: 'Decision A (updated)',
        category: 'tech',
        reason: 'updated reason',
        supersede_id: ids[0],
      }),
    })

    const qs = new URLSearchParams({
      project_id: workspaceId,
      from_agent_id: orchestratorId,
      token: orchToken,
    })
    const getRes = await fetch(`${baseUrl}/api/team/decisions?${qs.toString()}`)
    expect(getRes.status).toBe(200)
    const getBody = (await getRes.json()) as { ok: boolean; decisions: Array<{ content: string; active: boolean }> }
    expect(getBody.ok).toBe(true)

    const activeContents = getBody.decisions.map((d) => d.content)
    expect(activeContents).not.toContain('Decision A')
    expect(activeContents).toContain('Decision A (updated)')
    expect(activeContents).toContain('Decision B')
    expect(activeContents).toContain('Decision C')
    expect(getBody.decisions).toHaveLength(3)
  })

  test('GET /api/team/decisions?category=tech returns only tech decisions', async () => {
    // Create tech and scope decisions
    await fetch(`${baseUrl}/api/team/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        project_id: workspaceId,
        from_agent_id: orchestratorId,
        token: orchToken,
        content: 'Use TypeScript everywhere',
        category: 'tech',
        reason: 'type safety',
      }),
    })
    await fetch(`${baseUrl}/api/team/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        project_id: workspaceId,
        from_agent_id: orchestratorId,
        token: orchToken,
        content: 'MVP excludes email notifications',
        category: 'scope',
        reason: 'timeline constraint',
      }),
    })
    await fetch(`${baseUrl}/api/team/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        project_id: workspaceId,
        from_agent_id: orchestratorId,
        token: orchToken,
        content: 'Another tech decision',
        category: 'tech',
        reason: 'performance',
      }),
    })

    const qs = new URLSearchParams({
      project_id: workspaceId,
      from_agent_id: orchestratorId,
      token: orchToken,
      category: 'tech',
    })
    const res = await fetch(`${baseUrl}/api/team/decisions?${qs.toString()}`)
    const body = (await res.json()) as { decisions: Array<{ category: string; content: string }> }

    expect(body.decisions.every((d) => d.category === 'tech')).toBe(true)
    expect(body.decisions).toHaveLength(2)
    expect(body.decisions.map((d) => d.content)).toContain('Use TypeScript everywhere')
    expect(body.decisions.map((d) => d.content)).not.toContain('MVP excludes email notifications')
  })

  test('POST /api/team/decide with source=user stores user source', async () => {
    const res = await fetch(`${baseUrl}/api/team/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        project_id: workspaceId,
        from_agent_id: orchestratorId,
        token: orchToken,
        content: 'Always use dark mode',
        category: 'preference',
        reason: 'user preference',
        source: 'user',
      }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { decision: { source: string } }
    expect(body.decision.source).toBe('user')
  })
})
