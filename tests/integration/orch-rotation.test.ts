import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import type { AgentSummary, WorkspaceSummary } from '../../src/shared/types.js'
import { appendEntry } from '../../src/server/agent-journal.js'
import { appendDecision } from '../../src/server/decision-ledger.js'
import {
  buildOrchestratorRotationRecovery,
  shouldRotateOrchestrator,
  type OrchestratorRecoveryInput,
  type OrchestratorRotationContext,
  type RotationProtection,
} from '../../src/server/session-rotation.js'

const makeContext = (overrides: Partial<OrchestratorRotationContext> = {}): OrchestratorRotationContext => ({
  allWorkersIdle: false,
  compactDetectedAndIdle: false,
  messageCount: 0,
  noPendingDispatches: true,
  sessionStartedAt: Date.now() - 120_000,
  userSilentDurationMs: 0,
  ...overrides,
})

const makeProtection = (overrides: Partial<RotationProtection> = {}): RotationProtection => ({
  consecutiveFailures: 0,
  lastRotationAt: 0,
  suspended: false,
  ...overrides,
})

const makeAgent = (overrides: Partial<AgentSummary> = {}): AgentSummary => ({
  id: 'ws-1:orchestrator',
  workspaceId: 'ws-1',
  name: 'Orchestrator',
  description: '',
  role: 'orchestrator',
  status: 'idle',
  pendingTaskCount: 0,
  ...overrides,
})

const makeWorker = (name: string): AgentSummary => ({
  id: `ws-1:${name}`,
  workspaceId: 'ws-1',
  name,
  description: '',
  role: 'coder',
  status: 'idle',
  pendingTaskCount: 0,
})

describe('shouldRotateOrchestrator — idle condition', () => {
  test('allWorkersIdle + noPendingDispatches + userSilentDurationMs > 5min → rotate', () => {
    const ctx = makeContext({
      allWorkersIdle: true,
      noPendingDispatches: true,
      userSilentDurationMs: 6 * 60_000,
    })
    expect(shouldRotateOrchestrator(ctx, makeProtection())).toBe(true)
  })

  test('allWorkersIdle + noPendingDispatches but userSilentDurationMs < 5min → no rotate', () => {
    const ctx = makeContext({
      allWorkersIdle: true,
      noPendingDispatches: true,
      userSilentDurationMs: 4 * 60_000,
    })
    expect(shouldRotateOrchestrator(ctx, makeProtection())).toBe(false)
  })

  test('allWorkersIdle + userSilentDurationMs > 5min but pending dispatches → no rotate', () => {
    const ctx = makeContext({
      allWorkersIdle: true,
      noPendingDispatches: false,
      userSilentDurationMs: 10 * 60_000,
    })
    expect(shouldRotateOrchestrator(ctx, makeProtection())).toBe(false)
  })

  test('compactDetectedAndIdle → rotate regardless of other conditions', () => {
    const ctx = makeContext({ compactDetectedAndIdle: true })
    expect(shouldRotateOrchestrator(ctx, makeProtection())).toBe(true)
  })

  test('messageCount >= 40 → rotate', () => {
    expect(shouldRotateOrchestrator(makeContext({ messageCount: 40 }), makeProtection())).toBe(true)
    expect(shouldRotateOrchestrator(makeContext({ messageCount: 39 }), makeProtection())).toBe(false)
  })

  test('session > 2h → rotate', () => {
    const old = makeContext({ sessionStartedAt: Date.now() - 121 * 60_000 })
    expect(shouldRotateOrchestrator(old, makeProtection())).toBe(true)
  })

  test('min runtime < 60s blocks rotation', () => {
    const ctx = makeContext({
      sessionStartedAt: Date.now() - 30_000,
      compactDetectedAndIdle: true,
    })
    expect(shouldRotateOrchestrator(ctx, makeProtection())).toBe(false)
  })

  test('cooldown blocks rotation within 5min of last rotation', () => {
    const ctx = makeContext({ compactDetectedAndIdle: true })
    const recentProt = makeProtection({ lastRotationAt: Date.now() - 4 * 60_000 })
    expect(shouldRotateOrchestrator(ctx, recentProt)).toBe(false)
  })

  test('suspended flag always blocks', () => {
    const ctx = makeContext({ compactDetectedAndIdle: true })
    expect(shouldRotateOrchestrator(ctx, makeProtection({ suspended: true }))).toBe(false)
  })
})

describe('buildOrchestratorRotationRecovery — content', () => {
  let workspacePath: string
  let workspace: WorkspaceSummary
  const agent = makeAgent()

  beforeEach(async () => {
    workspacePath = await mkdtemp(join(tmpdir(), 'hive-orch-rotation-test-'))
    workspace = { id: 'ws-1', name: 'my-project', path: workspacePath }
  })

  afterEach(async () => {
    await rm(workspacePath, { recursive: true, force: true })
  })

  const makeRecoveryInput = (overrides: Partial<OrchestratorRecoveryInput> = {}): OrchestratorRecoveryInput => ({
    checkpoint: null,
    recentUserInputs: [],
    workers: [],
    activeDispatches: [],
    tasksContent: '',
    ...overrides,
  })

  test('includes agent identity section', async () => {
    const recovery = await buildOrchestratorRotationRecovery(
      workspacePath, agent, workspace, makeRecoveryInput()
    )
    expect(recovery).toContain('my-project')
    expect(recovery).toContain('Orchestrator')
  })

  test('includes last 8 journal entries (not older ones)', async () => {
    // Write 12 entries — recovery reads last 8 (entries 5–12)
    for (let i = 0; i < 12; i++) {
      await appendEntry(workspacePath, 'Orchestrator', {
        type: 'user_input_received',
        summary: `UserSaid-${String(i + 1).padStart(2, '0')}`,
        body: `body ${i + 1}`,
      })
    }

    const recovery = await buildOrchestratorRotationRecovery(
      workspacePath, agent, workspace, makeRecoveryInput()
    )
    // Entries 5–12 should appear
    expect(recovery).toContain('UserSaid-05')
    expect(recovery).toContain('UserSaid-12')
    // Entries 1–4 should NOT appear in summaries
    expect(recovery).not.toContain('UserSaid-01')
    expect(recovery).not.toContain('UserSaid-04')
  })

  test('includes worker list section', async () => {
    const workers = [makeWorker('alice'), makeWorker('bob')]
    const recovery = await buildOrchestratorRotationRecovery(
      workspacePath, agent, workspace, makeRecoveryInput({ workers })
    )
    expect(recovery).toContain('alice')
    expect(recovery).toContain('bob')
  })

  test('includes active dispatches section', async () => {
    const activeDispatches = [
      { toWorkerName: 'alice', text: 'Implement auth module', status: 'submitted' },
    ]
    const recovery = await buildOrchestratorRotationRecovery(
      workspacePath, agent, workspace, makeRecoveryInput({ activeDispatches })
    )
    expect(recovery).toContain('alice')
    expect(recovery).toContain('Implement auth module')
  })

  test('includes tasks.md content (truncated)', async () => {
    const tasksContent = '- [x] Task 1\n- [ ] Task 2\n'
    const recovery = await buildOrchestratorRotationRecovery(
      workspacePath, agent, workspace, makeRecoveryInput({ tasksContent })
    )
    expect(recovery).toContain('Task 1')
    expect(recovery).toContain('Task 2')
  })

  test('includes checkpoint when provided', async () => {
    const recovery = await buildOrchestratorRotationRecovery(
      workspacePath, agent, workspace,
      makeRecoveryInput({ checkpoint: 'Progress: auth 80% done' })
    )
    expect(recovery).toContain('Progress: auth 80% done')
  })

  test('includes decisions section when decisions exist', async () => {
    await appendDecision(workspacePath, {
      category: 'tech',
      content: '使用 PostgreSQL 不用 MySQL',
      reason: '团队熟悉度',
    })

    const recovery = await buildOrchestratorRotationRecovery(
      workspacePath, agent, workspace, makeRecoveryInput()
    )
    expect(recovery).toContain('Active Decisions')
    expect(recovery).toContain('PostgreSQL')
    expect(recovery).toContain('团队熟悉度')
  })

  test('includes worker rules section', async () => {
    const recovery = await buildOrchestratorRotationRecovery(
      workspacePath, agent, workspace, makeRecoveryInput()
    )
    expect(recovery).toContain('你的规则')
  })

  test('wrapped in hive-system-message tag', async () => {
    const recovery = await buildOrchestratorRotationRecovery(
      workspacePath, agent, workspace, makeRecoveryInput()
    )
    expect(recovery).toMatch(/^<hive-system-message type="rotation-recovery">/)
    expect(recovery).toMatch(/<\/hive-system-message>$/)
  })

  test('budget control: very large tasks.md truncated so total output stays under 12000 chars', async () => {
    const tasksContent = 'x'.repeat(50_000)
    const recovery = await buildOrchestratorRotationRecovery(
      workspacePath, agent, workspace, makeRecoveryInput({ tasksContent })
    )
    expect(recovery.length).toBeLessThan(12_000)
  })
})
