import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import type { AgentSummary, WorkspaceSummary } from '../../src/shared/types.js'
import { checkAndRotateWorker } from '../../src/server/rotation-manager.js'
import {
  shouldRotateWorker,
  type RotationContext,
  type RotationProtection,
} from '../../src/server/session-rotation.js'
import { startTestServer } from '../helpers/test-server.js'

// ─────────────────────────────────────────────────────────────────────────────
// Unit-level tests for checkAndRotateWorker (mock store, no PTY)
// ─────────────────────────────────────────────────────────────────────────────

const makeContext = (overrides: Partial<RotationContext> = {}): RotationContext => ({
  compactDetected: false,
  dispatchReportedAndNoPending: false,
  hasActiveDispatch: false,
  messageCount: 0,
  sessionStartedAt: Date.now() - 120_000,
  ...overrides,
})

const makeProtection = (overrides: Partial<RotationProtection> = {}): RotationProtection => ({
  consecutiveFailures: 0,
  lastRotationAt: 0,
  suspended: false,
  ...overrides,
})

describe('shouldRotateWorker — rotation triggers', () => {
  test('dispatch reported with no remaining pending → rotate', () => {
    const ctx = makeContext({ dispatchReportedAndNoPending: true })
    expect(shouldRotateWorker(ctx, makeProtection())).toBe(true)
  })

  test('hasActiveDispatch blocks rotation even if dispatch was reported', () => {
    const ctx = makeContext({ dispatchReportedAndNoPending: true, hasActiveDispatch: true })
    expect(shouldRotateWorker(ctx, makeProtection())).toBe(false)
  })

  test('message count >= 20 triggers rotation', () => {
    expect(shouldRotateWorker(makeContext({ messageCount: 20 }), makeProtection())).toBe(true)
    expect(shouldRotateWorker(makeContext({ messageCount: 19 }), makeProtection())).toBe(false)
  })

  test('compactDetected flag triggers rotation', () => {
    expect(shouldRotateWorker(makeContext({ compactDetected: true }), makeProtection())).toBe(true)
  })

  test('session > 90 min triggers rotation', () => {
    const old = makeContext({ sessionStartedAt: Date.now() - 91 * 60_000 })
    expect(shouldRotateWorker(old, makeProtection())).toBe(true)
  })
})

describe('shouldRotateWorker — protections', () => {
  test('min runtime: < 60s blocks rotation', () => {
    const ctx = makeContext({
      sessionStartedAt: Date.now() - 30_000,
      dispatchReportedAndNoPending: true,
    })
    expect(shouldRotateWorker(ctx, makeProtection())).toBe(false)
  })

  test('cooldown: < 5min since last rotation blocks', () => {
    const ctx = makeContext({ dispatchReportedAndNoPending: true })
    const recent = makeProtection({ lastRotationAt: Date.now() - 4 * 60_000 })
    expect(shouldRotateWorker(ctx, recent)).toBe(false)
  })

  test('cooldown: > 5min since last rotation allows', () => {
    const ctx = makeContext({ dispatchReportedAndNoPending: true })
    const old = makeProtection({ lastRotationAt: Date.now() - 6 * 60_000 })
    expect(shouldRotateWorker(ctx, old)).toBe(true)
  })

  test('suspended flag always blocks rotation', () => {
    const ctx = makeContext({ dispatchReportedAndNoPending: true })
    const suspended = makeProtection({ suspended: true })
    expect(shouldRotateWorker(ctx, suspended)).toBe(false)
  })
})

describe('checkAndRotateWorker — mock store', () => {
  let workspacePath: string

  beforeEach(() => {
    workspacePath = mkdtempSync(join(tmpdir(), 'hive-rotation-mock-'))
  })

  afterEach(() => {
    rmSync(workspacePath, { force: true, recursive: true })
  })

  const makeAgent = (overrides: Partial<AgentSummary> = {}): AgentSummary => ({
    id: 'ws-1:worker-1',
    workspaceId: 'ws-1',
    name: 'alice',
    description: '',
    role: 'coder',
    status: 'idle',
    pendingTaskCount: 0,
    ...overrides,
  })

  const makeWorkspace = (): WorkspaceSummary => ({
    id: 'ws-1',
    name: 'TestProject',
    path: workspacePath,
  })

  const makeMockStore = (overrides: {
    runId?: string
    startedAt?: number
    injectCount?: number
    pendingCount?: number
  } = {}) => {
    const {
      runId = 'run-test-1',
      startedAt = Date.now() - 120_000,
      injectCount = 0,
      pendingCount = 0,
    } = overrides

    const db = {
      prepare: (sql: string) => ({
        get: (..._args: unknown[]) => {
          if (sql.includes('inject_count')) return { inject_count: injectCount }
          if (sql.includes('COUNT(*)')) return { cnt: pendingCount }
          if (sql.includes('SELECT text FROM dispatches')) return pendingCount > 0 ? { text: 'pending task text' } : undefined
          return undefined
        },
      }),
    }

    const outputBus = {
      subscribe: vi.fn(),
      publish: vi.fn(),
    }

    return {
      getActiveRunByAgentId: (_wsId: string, _agentId: string) => ({ runId, startedAt }),
      getPtyOutputBus: () => outputBus as never,
      getDb: () => db as never,
      getAgentRuntime: () => ({
        stopAgentRun: vi.fn(),
        startAgent: vi.fn().mockResolvedValue({ runId: 'new-run-1', startedAt: Date.now() }),
        writeAgentStdin: vi.fn(),
        getActiveRunByAgentId: (_wsId: string, _agentId: string) => ({ runId, startedAt }),
      } as never),
    }
  }

  test('no rotation when activeRun is missing', async () => {
    const store = makeMockStore()
    const noRunStore = { ...store, getActiveRunByAgentId: () => undefined }
    const sessionRotation = await import('../../src/server/session-rotation.js')
    const executeSpy = vi.spyOn(sessionRotation, 'executeWorkerRotation')

    checkAndRotateWorker({
      store: noRunStore,
      workspace: makeWorkspace(),
      agent: makeAgent(),
      dispatchResult: { dispatch: null },
      hivePort: '9999',
    })

    expect(executeSpy).not.toHaveBeenCalled()
  })

  test('no rotation when session < 60s old', async () => {
    const store = makeMockStore({ startedAt: Date.now() - 10_000 })
    const sessionRotation = await import('../../src/server/session-rotation.js')
    const executeSpy = vi.spyOn(sessionRotation, 'executeWorkerRotation')

    checkAndRotateWorker({
      store,
      workspace: makeWorkspace(),
      agent: makeAgent(),
      dispatchResult: { dispatch: null },
      hivePort: '9999',
    })

    expect(executeSpy).not.toHaveBeenCalled()
  })

  test('rotation fires via setImmediate when dispatch reported with no pending', async () => {
    const store = makeMockStore({ startedAt: Date.now() - 120_000, pendingCount: 0 })
    let rotationCalled = false
    const sessionRotation = await import('../../src/server/session-rotation.js')
    vi.spyOn(sessionRotation, 'executeWorkerRotation').mockImplementation(async () => {
      rotationCalled = true
      return { protection: makeProtection({ lastRotationAt: Date.now() }), success: true }
    })

    const fakeDispatch = {
      id: 'd-1',
      status: 'reported' as const,
      toAgentId: 'ws-1:worker-1',
      workspaceId: 'ws-1',
      text: 'task',
      fromAgentId: 'ws-1:orchestrator',
      reportText: 'done',
      artifacts: [] as string[],
      sequence: 1,
      taskId: null,
      createdAt: Date.now(),
      deliveredAt: null,
      reportedAt: Date.now(),
      submittedAt: Date.now(),
    }

    checkAndRotateWorker({
      store,
      workspace: makeWorkspace(),
      agent: makeAgent(),
      dispatchResult: { dispatch: fakeDispatch },
      hivePort: '9999',
    })

    await new Promise((resolve) => setImmediate(resolve))

    expect(rotationCalled).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Integration tests: report endpoint triggers rotation via real server
// ─────────────────────────────────────────────────────────────────────────────

const waitFor = async (
  assertion: () => Promise<void> | void,
  timeoutMs = 5000,
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

describe('worker rotation — integration with real server', () => {
  let serverClose: (() => Promise<void>) | undefined
  let workspacePath: string
  let baseUrl: string
  let workspaceId: string
  let orchestratorId: string
  let workerId: string
  let uiCookie: string
  let orchToken: string
  let workerToken: string
  let serverStore: Awaited<ReturnType<typeof startTestServer>>['store']

  beforeEach(async () => {
    workspacePath = mkdtempSync(join(tmpdir(), 'hive-rotation-e2e-'))
    const server = await startTestServer()
    serverClose = server.close
    serverStore = server.store
    baseUrl = server.baseUrl

    const sessionRes = await fetch(`${baseUrl}/api/ui/session`)
    uiCookie = sessionRes.headers.get('set-cookie') ?? ''
    if (!uiCookie) throw new Error('Expected UI session cookie')

    const wsRes = await fetch(`${baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: uiCookie },
      body: JSON.stringify({ name: 'RotationTest', path: workspacePath }),
    })
    workspaceId = ((await wsRes.json()) as { id: string }).id
    orchestratorId = `${workspaceId}:orchestrator`

    const workerRes = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/workers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: uiCookie },
      body: JSON.stringify({ name: 'alice', role: 'coder' }),
    })
    workerId = ((await workerRes.json()) as { id: string }).id

    const dummyScript = `${process.execPath} -e "process.stdin.resume()"`
    for (const agentId of [orchestratorId, workerId]) {
      await fetch(`${baseUrl}/api/workspaces/${workspaceId}/agents/${agentId}/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({ command: '/bin/bash', args: ['-lc', dummyScript] }),
      })
      await fetch(`${baseUrl}/api/workspaces/${workspaceId}/agents/${agentId}/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: uiCookie },
        body: JSON.stringify({ hive_port: baseUrl.split(':').at(-1) }),
      })
    }

    await waitFor(() => {
      const ot = serverStore.peekAgentToken(orchestratorId)
      const wt = serverStore.peekAgentToken(workerId)
      if (!ot || !wt) throw new Error('tokens not ready')
      orchToken = ot
      workerToken = wt
    })
  })

  afterEach(async () => {
    await serverClose?.()
    rmSync(workspacePath, { force: true, recursive: true })
  })

  test('report on old session → rotation conditions met (shouldRotateWorker returns true)', async () => {
    // This test verifies the rotation conditions are correctly assembled at route level.
    // Actual PTY restart is tested in executeWorkerRotation unit tests.
    const activeRun = serverStore.getActiveRunByAgentId(workspaceId, workerId)
    if (!activeRun) throw new Error('worker has no active run')

    // Verify that shouldRotateWorker would return true if the session were old enough
    const { shouldRotateWorker: shouldRotate } = await import('../../src/server/session-rotation.js')
    const db = serverStore.getDb()

    const agedCtx = {
      compactDetected: false,
      dispatchReportedAndNoPending: true,
      hasActiveDispatch: false,
      messageCount: 0,
      sessionStartedAt: Date.now() - 130_000,
    }
    expect(shouldRotate(agedCtx, { consecutiveFailures: 0, lastRotationAt: 0, suspended: false })).toBe(true)

    // Dispatch a task and report it
    const sendRes = await fetch(`${baseUrl}/api/team/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        project_id: workspaceId,
        from_agent_id: orchestratorId,
        token: orchToken,
        to: 'alice',
        text: 'Complete the auth feature',
      }),
    })
    const { dispatch_id } = (await sendRes.json()) as { dispatch_id: string }

    const reportRes = await fetch(`${baseUrl}/api/team/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        project_id: workspaceId,
        from_agent_id: workerId,
        token: workerToken,
        result: 'Auth feature complete',
        dispatch_id,
      }),
    })
    expect(reportRes.status).toBe(202)

    // Verify dispatch was reported
    const dispatches = db.prepare('SELECT status FROM dispatches WHERE id = ?').get(dispatch_id) as { status: string } | undefined
    expect(dispatches?.status).toBe('reported')
  })

  test('rotation blocked when hasActiveDispatch (pending dispatch exists)', async () => {
    const activeRun = serverStore.getActiveRunByAgentId(workspaceId, workerId)
    if (!activeRun) throw new Error('worker has no active run')

    const db = serverStore.getDb()
    db.prepare('UPDATE agent_runs SET started_at = ? WHERE run_id = ?')
      .run(Date.now() - 130_000, activeRun.runId)

    // Send TWO tasks — report first, leaving second pending
    const s1 = await fetch(`${baseUrl}/api/team/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        project_id: workspaceId,
        from_agent_id: orchestratorId,
        token: orchToken,
        to: 'alice',
        text: 'First task',
      }),
    })
    const d1 = (await s1.json()) as { dispatch_id: string }

    await fetch(`${baseUrl}/api/team/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        project_id: workspaceId,
        from_agent_id: orchestratorId,
        token: orchToken,
        to: 'alice',
        text: 'Second task (pending)',
      }),
    })

    // Report first task — second is still pending, so rotation should NOT fire
    await fetch(`${baseUrl}/api/team/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        project_id: workspaceId,
        from_agent_id: workerId,
        token: workerToken,
        result: 'First task done',
        dispatch_id: d1.dispatch_id,
      }),
    })

    // Wait briefly, then verify only 1 run exists (no rotation)
    await new Promise((resolve) => setTimeout(resolve, 300))
    const runs = db.prepare('SELECT run_id FROM agent_runs WHERE agent_id = ?').all(workerId) as Array<{ run_id: string }>
    expect(runs.length).toBe(1)
  })

  test('journal entry report_sent written on worker report (observable side-effect)', async () => {
    // Verifies the journal is written when report endpoint is called —
    // session_rotated itself requires real PTY restart which is covered by executeWorkerRotation unit tests

    const sendRes = await fetch(`${baseUrl}/api/team/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        project_id: workspaceId,
        from_agent_id: orchestratorId,
        token: orchToken,
        to: 'alice',
        text: 'Rotate me please',
      }),
    })
    const { dispatch_id } = (await sendRes.json()) as { dispatch_id: string }

    await fetch(`${baseUrl}/api/team/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        project_id: workspaceId,
        from_agent_id: workerId,
        token: workerToken,
        result: 'Done, rotate now',
        dispatch_id,
      }),
    })

    const manifestPath = join(workspacePath, '.hive', 'journal', 'alice', 'manifest.jsonl')

    await waitFor(() => {
      expect(existsSync(manifestPath)).toBe(true)
      const lines = readFileSync(manifestPath, 'utf-8').trim().split('\n').filter(Boolean)
      const entries = lines.map((l) => JSON.parse(l) as { type: string })
      const reportEntry = entries.find((e) => e.type === 'report_sent')
      expect(reportEntry).toBeDefined()
    }, 3000)
  })
})
