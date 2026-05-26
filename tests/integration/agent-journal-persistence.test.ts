import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { getRecentEntries } from '../../src/server/agent-journal.js'
import { startTestServer } from '../helpers/test-server.js'

const waitFor = async (
  assertion: () => Promise<void> | void,
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

const readManifestLines = (workspacePath: string, agentName: string): string[] => {
  const manifestPath = join(workspacePath, '.hive', 'journal', agentName, 'manifest.jsonl')
  if (!existsSync(manifestPath)) return []
  return readFileSync(manifestPath, 'utf-8').trim().split('\n').filter(Boolean)
}

const parseManifest = (workspacePath: string, agentName: string) =>
  readManifestLines(workspacePath, agentName).map((l) => JSON.parse(l))

interface TestCtx {
  baseUrl: string
  close: () => Promise<void>
  workspaceId: string
  workspacePath: string
  orchestratorId: string
  workerId: string
  orchToken: () => string
  workerToken: () => string
  uiCookie: string
  store: Awaited<ReturnType<typeof startTestServer>>['store']
}

const setupCtx = async (): Promise<TestCtx> => {
  const workspacePath = mkdtempSync(join(tmpdir(), 'hive-journal-e2e-'))
  const server = await startTestServer()
  const { baseUrl, store } = server

  const sessionResponse = await fetch(`${baseUrl}/api/ui/session`)
  const uiCookie = sessionResponse.headers.get('set-cookie')
  if (!uiCookie) throw new Error('Expected UI session cookie')

  const workspaceResponse = await fetch(`${baseUrl}/api/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: uiCookie },
    body: JSON.stringify({ name: 'JournalTest', path: workspacePath }),
  })
  expect(workspaceResponse.status).toBe(201)
  const workspace = (await workspaceResponse.json()) as { id: string }
  const workspaceId = workspace.id
  const orchestratorId = `${workspaceId}:orchestrator`

  const workerResponse = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/workers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: uiCookie },
    body: JSON.stringify({ name: 'alice', role: 'coder' }),
  })
  expect(workerResponse.status).toBe(201)
  const worker = (await workerResponse.json()) as { id: string }
  const workerId = worker.id

  const dummyScript = `${process.execPath} -e "process.stdin.resume()"`
  for (const agentId of [orchestratorId, workerId]) {
    const configRes = await fetch(
      `${baseUrl}/api/workspaces/${workspaceId}/agents/${agentId}/config`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({ command: '/bin/bash', args: ['-lc', dummyScript] }),
      }
    )
    expect(configRes.status).toBe(204)
    const startRes = await fetch(
      `${baseUrl}/api/workspaces/${workspaceId}/agents/${agentId}/start`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({ hive_port: baseUrl.split(':').at(-1) }),
      }
    )
    expect([201, 200]).toContain(startRes.status)
  }

  await waitFor(() => {
    if (!store.peekAgentToken(orchestratorId)) throw new Error('orch token not ready')
    if (!store.peekAgentToken(workerId)) throw new Error('worker token not ready')
  })

  return {
    baseUrl,
    close: async () => {
      await server.close()
      rmSync(workspacePath, { force: true, recursive: true })
    },
    orchestratorId,
    orchToken: () => store.peekAgentToken(orchestratorId)!,
    store,
    uiCookie,
    workerId,
    workspacePath,
    workspaceId,
    workerToken: () => store.peekAgentToken(workerId)!,
  }
}

describe('agent journal persistence', () => {
  let ctx: TestCtx

  beforeEach(async () => {
    ctx = await setupCtx()
  })

  afterEach(async () => {
    await ctx.close()
  })

  test('dispatch writes dispatch_received entry to worker journal', async () => {
    const { baseUrl, orchestratorId, orchToken, workspaceId, workspacePath } = ctx

    const sendRes = await fetch(`${baseUrl}/api/team/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        project_id: workspaceId,
        from_agent_id: orchestratorId,
        token: orchToken(),
        to: 'alice',
        text: 'Implement login endpoint',
      }),
    })
    expect(sendRes.status).toBe(202)

    await waitFor(() => {
      const entries = parseManifest(workspacePath, 'alice')
      expect(entries.length).toBeGreaterThan(0)
      const last = entries.at(-1)
      expect(last.type).toBe('dispatch_received')
      expect(last.summary).toContain('login endpoint')
      expect(last.seq).toBe(1)
      const entryFile = join(workspacePath, '.hive', 'journal', 'alice', last.file)
      expect(existsSync(entryFile)).toBe(true)
      const content = readFileSync(entryFile, 'utf-8')
      expect(content).toContain('type: dispatch_received')
    })
  })

  test('report writes report_sent entry to worker journal', async () => {
    const { baseUrl, orchestratorId, orchToken, workerId, workerToken, workspaceId, workspacePath } = ctx

    const sendRes = await fetch(`${baseUrl}/api/team/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        project_id: workspaceId,
        from_agent_id: orchestratorId,
        token: orchToken(),
        to: 'alice',
        text: 'Build auth module',
      }),
    })
    const sendBody = (await sendRes.json()) as { dispatch_id: string }

    await fetch(`${baseUrl}/api/team/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        project_id: workspaceId,
        from_agent_id: workerId,
        token: workerToken(),
        result: 'Auth module complete',
        dispatch_id: sendBody.dispatch_id,
      }),
    })

    await waitFor(() => {
      const entries = parseManifest(workspacePath, 'alice')
      const reportEntry = entries.find((e: { type: string }) => e.type === 'report_sent')
      expect(reportEntry).toBeDefined()
      expect(reportEntry.summary).toContain('Auth module complete')
    })
  })

  test('status writes status_sent entry to worker journal', async () => {
    const { baseUrl, orchestratorId, orchToken, workerId, workerToken, workspaceId, workspacePath } = ctx

    await fetch(`${baseUrl}/api/team/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        project_id: workspaceId,
        from_agent_id: orchestratorId,
        token: orchToken(),
        to: 'alice',
        text: 'Ongoing task',
      }),
    })

    await fetch(`${baseUrl}/api/team/status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        project_id: workspaceId,
        from_agent_id: workerId,
        token: workerToken(),
        result: 'Working on it now',
      }),
    })

    await waitFor(() => {
      const entries = parseManifest(workspacePath, 'alice')
      const statusEntry = entries.find((e: { type: string }) => e.type === 'status_sent')
      expect(statusEntry).toBeDefined()
      expect(statusEntry.summary).toContain('Working on it now')
    })
  })

  test('checkpoint writes checkpoint_saved entry and stores in agent_runs', async () => {
    const { baseUrl, workerId, workerToken, workspaceId, workspacePath, store } = ctx

    await fetch(`${baseUrl}/api/team/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        project_id: workspaceId,
        from_agent_id: ctx.orchestratorId,
        token: ctx.orchToken(),
        to: 'alice',
        text: 'Long running task',
      }),
    })

    const cpRes = await fetch(`${baseUrl}/api/team/checkpoint`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        project_id: workspaceId,
        from_agent_id: workerId,
        token: workerToken(),
        text: 'Progress: 50% done, working on auth',
        artifacts: ['src/auth.ts'],
      }),
    })
    expect(cpRes.status).toBe(201)
    const cpBody = (await cpRes.json()) as { ok: boolean }
    expect(cpBody.ok).toBe(true)

    await waitFor(() => {
      const entries = parseManifest(workspacePath, 'alice')
      const cpEntry = entries.find((e: { type: string }) => e.type === 'checkpoint_saved')
      expect(cpEntry).toBeDefined()
      expect(cpEntry.summary).toContain('50%')
      expect(cpEntry.artifacts).toEqual(['src/auth.ts'])
    })

    const activeRun = store.getActiveRunByAgentId(workspaceId, workerId)
    if (activeRun) {
      const db = store.getDb()
      const row = db.prepare('SELECT checkpoint_json FROM agent_runs WHERE run_id = ?').get(activeRun.runId) as { checkpoint_json: string | null } | undefined
      expect(row?.checkpoint_json).toContain('50% done')
    }
  })

  test('seq counter increments monotonically across multiple entries', async () => {
    const { baseUrl, orchestratorId, orchToken, workerId, workerToken, workspaceId, workspacePath } = ctx

    for (let i = 0; i < 3; i++) {
      const sendRes = await fetch(`${baseUrl}/api/team/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: workspaceId,
          from_agent_id: orchestratorId,
          token: orchToken(),
          to: 'alice',
          text: `Task ${i + 1}`,
        }),
      })
      const sendBody = (await sendRes.json()) as { dispatch_id: string }

      // Wait for dispatch_received entry before next operation to avoid concurrent seq reads
      const expectedDispatchCount = i + 1
      await waitFor(() => {
        const entries = parseManifest(workspacePath, 'alice')
        const dispatchEntries = entries.filter((e: { type: string }) => e.type === 'dispatch_received')
        expect(dispatchEntries.length).toBe(expectedDispatchCount)
      })

      await fetch(`${baseUrl}/api/team/report`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: workspaceId,
          from_agent_id: workerId,
          token: workerToken(),
          result: `Done task ${i + 1}`,
          dispatch_id: sendBody.dispatch_id,
        }),
      })

      // Wait for report entry before next send
      const expectedReportCount = i + 1
      await waitFor(() => {
        const entries = parseManifest(workspacePath, 'alice')
        const reportEntries = entries.filter((e: { type: string }) => e.type === 'report_sent')
        expect(reportEntries.length).toBe(expectedReportCount)
      })
    }

    const entries = parseManifest(workspacePath, 'alice')
    const seqs = entries.map((e: { seq: number }) => e.seq)
    // All seqs must be unique and increasing
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!)
    }
    expect(seqs[0]).toBe(1)

    const files = entries.map((e: { file: string }) => e.file)
    expect(files[0]).toMatch(/^entries\/0001-/)
    expect(files[1]).toMatch(/^entries\/0002-/)
    expect(files[2]).toMatch(/^entries\/0003-/)
  })

  test('getRecentEntries(count=5) returns last 5 of 10 entries', async () => {
    const { baseUrl, orchestratorId, orchToken, workerId, workerToken, workspaceId, workspacePath } = ctx

    for (let i = 0; i < 5; i++) {
      const sendRes = await fetch(`${baseUrl}/api/team/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: workspaceId,
          from_agent_id: orchestratorId,
          token: orchToken(),
          to: 'alice',
          text: `Bulk task ${i + 1}`,
        }),
      })
      const sendBody = (await sendRes.json()) as { dispatch_id: string }

      const expectedDispatch = i + 1
      await waitFor(() => {
        const entries = parseManifest(workspacePath, 'alice')
        expect(entries.filter((e: { type: string }) => e.type === 'dispatch_received').length).toBe(expectedDispatch)
      })

      await fetch(`${baseUrl}/api/team/report`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_id: workspaceId,
          from_agent_id: workerId,
          token: workerToken(),
          result: `Bulk done ${i + 1}`,
          dispatch_id: sendBody.dispatch_id,
        }),
      })

      const expectedReport = i + 1
      await waitFor(() => {
        const entries = parseManifest(workspacePath, 'alice')
        expect(entries.filter((e: { type: string }) => e.type === 'report_sent').length).toBe(expectedReport)
      })
    }

    const allEntries = parseManifest(workspacePath, 'alice')
    expect(allEntries.length).toBe(10)

    const recent = await getRecentEntries(workspacePath, 'alice', 5)
    expect(recent).toHaveLength(5)
    const lastFive = allEntries.slice(-5) as Array<{ seq: number }>
    expect(recent.map((e) => e.seq)).toEqual(lastFive.map((e) => e.seq))
  })
})
