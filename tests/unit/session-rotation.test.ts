import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import type { AgentSummary, WorkspaceSummary } from '../../src/shared/types.js'
import { appendEntry } from '../../src/server/agent-journal.js'
import {
  buildWorkerRotationRecovery,
  shouldRotateWorker,
  type RotationContext,
  type RotationProtection,
} from '../../src/server/session-rotation.js'

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

describe('shouldRotateWorker', () => {
  test('returns true when dispatch reported and no pending', () => {
    const ctx = makeContext({ dispatchReportedAndNoPending: true })
    expect(shouldRotateWorker(ctx, makeProtection())).toBe(true)
  })

  test('returns false when a dispatch is actively in progress', () => {
    const ctx = makeContext({
      hasActiveDispatch: true,
      dispatchReportedAndNoPending: true,
    })
    expect(shouldRotateWorker(ctx, makeProtection())).toBe(false)
  })

  test('returns true when message count >= 20', () => {
    const ctx = makeContext({ messageCount: 20 })
    expect(shouldRotateWorker(ctx, makeProtection())).toBe(true)
  })

  test('returns false within 60s minimum runtime', () => {
    const ctx = makeContext({
      sessionStartedAt: Date.now() - 30_000,
      dispatchReportedAndNoPending: true,
    })
    expect(shouldRotateWorker(ctx, makeProtection())).toBe(false)
  })

  test('respects 5min cooldown between rotations', () => {
    const ctx = makeContext({ dispatchReportedAndNoPending: true })
    const protection = makeProtection({ lastRotationAt: Date.now() - 60_000 })
    expect(shouldRotateWorker(ctx, protection)).toBe(false)
  })

  test('suspends after 3 consecutive start failures', () => {
    const ctx = makeContext({ dispatchReportedAndNoPending: true })
    const protection = makeProtection({ suspended: true, consecutiveFailures: 3 })
    expect(shouldRotateWorker(ctx, protection)).toBe(false)
  })

  test('returns true on compact detected + idle', () => {
    const ctx = makeContext({ compactDetected: true })
    expect(shouldRotateWorker(ctx, makeProtection())).toBe(true)
  })

  test('returns true when session > 90min', () => {
    const ctx = makeContext({ sessionStartedAt: Date.now() - 91 * 60_000 })
    expect(shouldRotateWorker(ctx, makeProtection())).toBe(true)
  })
})

describe('buildWorkerRotationRecovery', () => {
  let workspacePath: string
  const agent: AgentSummary = {
    id: 'ws-1:worker-a',
    workspaceId: 'ws-1',
    name: 'Alice',
    description: 'Coder worker',
    role: 'coder',
    status: 'working',
    pendingTaskCount: 0,
  }
  const workspace: WorkspaceSummary = { id: 'ws-1', name: 'my-project', path: '' }

  beforeEach(async () => {
    workspacePath = await mkdtemp(join(tmpdir(), 'hive-rotation-test-'))
    workspace.path = workspacePath
  })

  afterEach(async () => {
    await rm(workspacePath, { recursive: true, force: true })
  })

  test('includes last 5 journal entries from manifest', async () => {
    for (let i = 0; i < 7; i++) {
      await appendEntry(workspacePath, 'Alice', {
        type: 'dispatch_received',
        summary: `Task ${i + 1}`,
        body: `body ${i + 1}`,
      })
    }

    const recovery = await buildWorkerRotationRecovery(
      workspacePath,
      agent,
      workspace,
      null
    )

    expect(recovery).toContain('Task 3')
    expect(recovery).toContain('Task 7')
    expect(recovery).not.toContain('Task 1')
    expect(recovery).not.toContain('Task 2')
    expect(recovery).toContain('航行日志（最近 5 条）')
  })

  test('includes pending dispatch text if one exists', async () => {
    await appendEntry(workspacePath, 'Alice', {
      type: 'dispatch_received',
      summary: 'Some task',
      body: 'body',
    })

    const recovery = await buildWorkerRotationRecovery(
      workspacePath,
      agent,
      workspace,
      '实现用户登录接口'
    )

    expect(recovery).toContain('待处理派单：实现用户登录接口')
  })

  test('shows no pending dispatch when null', async () => {
    const recovery = await buildWorkerRotationRecovery(
      workspacePath,
      agent,
      workspace,
      null
    )

    expect(recovery).toContain('待处理派单：无，等待新派单')
  })

  test('includes worker rules section', async () => {
    const recovery = await buildWorkerRotationRecovery(
      workspacePath,
      agent,
      workspace,
      null
    )

    expect(recovery).toContain('## 你的规则')
    expect(recovery).toContain('team report')
  })

  test('wraps output in hive-system-message tag', async () => {
    const recovery = await buildWorkerRotationRecovery(
      workspacePath,
      agent,
      workspace,
      null
    )

    expect(recovery).toMatch(/^<hive-system-message type="rotation-recovery">/)
    expect(recovery).toMatch(/<\/hive-system-message>$/)
  })
})
