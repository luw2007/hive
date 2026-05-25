import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { createHandoffHandler } from '../../src/server/handoff-handler.js'

const makeDb = () => {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE handoff_reports (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      mode TEXT NOT NULL,
      report_text TEXT NOT NULL,
      pending_dispatches TEXT,
      session_id TEXT,
      created_at INTEGER NOT NULL
    )
  `)
  return db
}

describe('handoff-handler', () => {
  let db: ReturnType<typeof makeDb>
  let writeAgentStdin: ReturnType<typeof vi.fn>
  let deleteWorker: ReturnType<typeof vi.fn>
  let getCheckpoint: ReturnType<typeof vi.fn>
  let handler: ReturnType<typeof createHandoffHandler>

  const ctx = { workspaceId: 'ws-1', agentId: 'ws-1:worker-a', agentName: '米芾' }

  beforeEach(() => {
    vi.useFakeTimers()
    db = makeDb()
    writeAgentStdin = vi.fn()
    deleteWorker = vi.fn()
    getCheckpoint = vi.fn().mockReturnValue(null)
    handler = createHandoffHandler({ db, writeAgentStdin, deleteWorker, getCheckpoint })
  })

  afterEach(() => {
    vi.useRealTimers()
    db.close()
  })

  describe('activeHandoff', () => {
    test('sets isPendingHandoff to true and writes stdin prompt', () => {
      handler.activeHandoff(ctx)

      expect(handler.isPendingHandoff(ctx.workspaceId, ctx.agentId)).toBe(true)
      expect(writeAgentStdin).toHaveBeenCalledOnce()
      expect(writeAgentStdin).toHaveBeenCalledWith(ctx.workspaceId, ctx.agentId, expect.stringContaining('交接通知'))
    })

    test('is idempotent — second call does not re-write stdin', () => {
      handler.activeHandoff(ctx)
      handler.activeHandoff(ctx)

      expect(writeAgentStdin).toHaveBeenCalledOnce()
    })

    test('falls back to passiveHandoff if writeAgentStdin throws', () => {
      writeAgentStdin.mockImplementation(() => { throw new Error('PTY closed') })

      handler.activeHandoff(ctx)

      expect(handler.isPendingHandoff(ctx.workspaceId, ctx.agentId)).toBe(false)
      expect(deleteWorker).toHaveBeenCalledWith(ctx.workspaceId, ctx.agentId)
      const rows = db.prepare('SELECT * FROM handoff_reports').all() as { mode: string }[]
      expect(rows).toHaveLength(1)
      expect(rows[0].mode).toBe('passive')
    })
  })

  describe('receiveHandover', () => {
    test('saves active report, clears pending, and deletes worker', () => {
      handler.activeHandoff(ctx)
      const accepted = handler.receiveHandover(ctx.workspaceId, ctx.agentId, '进度50%，剩余TODO列表')

      expect(accepted).toBe(true)
      expect(handler.isPendingHandoff(ctx.workspaceId, ctx.agentId)).toBe(false)
      expect(deleteWorker).toHaveBeenCalledWith(ctx.workspaceId, ctx.agentId)

      const rows = db.prepare('SELECT * FROM handoff_reports').all() as { mode: string; report_text: string }[]
      expect(rows).toHaveLength(1)
      expect(rows[0].mode).toBe('active')
      expect(rows[0].report_text).toBe('进度50%，剩余TODO列表')
    })

    test('returns false if no pending handoff exists', () => {
      const accepted = handler.receiveHandover(ctx.workspaceId, ctx.agentId, 'late report')
      expect(accepted).toBe(false)
    })

    test('notifies orchestrator with report text', () => {
      handler.activeHandoff(ctx)
      writeAgentStdin.mockClear()

      handler.receiveHandover(ctx.workspaceId, ctx.agentId, '交接内容')

      const orchCall = writeAgentStdin.mock.calls.find(
        ([wsId, agentId]: [string, string]) => agentId === `${ctx.workspaceId}:orchestrator`
      )
      expect(orchCall).toBeDefined()
      expect(orchCall![2]).toContain('米芾')
      expect(orchCall![2]).toContain('交接内容')
    })
  })

  describe('passiveHandoff (timeout fallback)', () => {
    test('triggers after timeout with checkpoint text', async () => {
      getCheckpoint.mockReturnValue('checkpoint: 完成了文件A的修改')

      const promise = handler.activeHandoff(ctx)
      vi.advanceTimersByTime(30_000)
      await promise

      expect(handler.isPendingHandoff(ctx.workspaceId, ctx.agentId)).toBe(false)
      expect(deleteWorker).toHaveBeenCalledWith(ctx.workspaceId, ctx.agentId)

      const rows = db.prepare('SELECT * FROM handoff_reports').all() as { mode: string; report_text: string }[]
      expect(rows).toHaveLength(1)
      expect(rows[0].mode).toBe('passive')
      expect(rows[0].report_text).toBe('checkpoint: 完成了文件A的修改')
    })

    test('uses fallback text when no checkpoint available', async () => {
      getCheckpoint.mockReturnValue(null)

      const promise = handler.activeHandoff(ctx)
      vi.advanceTimersByTime(30_000)
      await promise

      const rows = db.prepare('SELECT * FROM handoff_reports').all() as { report_text: string }[]
      expect(rows[0].report_text).toBe('(无主动交接，自动回收)')
    })
  })

  describe('notifyOrchestrator', () => {
    test('notification includes agent name and truncated summary', () => {
      handler.activeHandoff(ctx)
      writeAgentStdin.mockClear()

      const longReport = 'A'.repeat(300)
      handler.receiveHandover(ctx.workspaceId, ctx.agentId, longReport)

      const orchCall = writeAgentStdin.mock.calls.find(
        ([, agentId]: [string, string]) => agentId === `${ctx.workspaceId}:orchestrator`
      )
      expect(orchCall).toBeDefined()
      const notification: string = orchCall![2]
      expect(notification).toContain(`@${ctx.agentName}`)
      expect(notification).toContain('已交接移除')
      expect(notification.length).toBeLessThan(longReport.length + 200)
      expect(notification).toContain('…')
    })

    test('notification includes pending dispatches when provided', () => {
      handler.activeHandoff(ctx)
      writeAgentStdin.mockClear()

      handler.receiveHandover(ctx.workspaceId, ctx.agentId, '报告', '派单A, 派单B')

      const orchCall = writeAgentStdin.mock.calls.find(
        ([, agentId]: [string, string]) => agentId === `${ctx.workspaceId}:orchestrator`
      )
      expect(orchCall![2]).toContain('未完成派单')
      expect(orchCall![2]).toContain('派单A, 派单B')
    })

    test('swallows error if orchestrator is not running', async () => {
      writeAgentStdin.mockImplementationOnce(() => {})
      writeAgentStdin.mockImplementation(() => { throw new Error('orch not running') })

      const promise = handler.activeHandoff(ctx)
      vi.advanceTimersByTime(30_000)
      await promise

      expect(deleteWorker).toHaveBeenCalled()
    })
  })
})
