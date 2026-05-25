import { randomUUID } from 'node:crypto'

import type { Database } from 'better-sqlite3'

export interface HandoffReport {
  id: string
  workspaceId: string
  agentId: string
  agentName: string
  mode: 'active' | 'passive'
  reportText: string
  pendingDispatches: string | null
  sessionId: string | null
  createdAt: number
}

interface HandoffRow {
  id: string
  workspace_id: string
  agent_id: string
  agent_name: string
  mode: 'active' | 'passive'
  report_text: string
  pending_dispatches: string | null
  session_id: string | null
  created_at: number
}

const toRecord = (row: HandoffRow): HandoffReport => ({
  id: row.id,
  workspaceId: row.workspace_id,
  agentId: row.agent_id,
  agentName: row.agent_name,
  mode: row.mode,
  reportText: row.report_text,
  pendingDispatches: row.pending_dispatches,
  sessionId: row.session_id,
  createdAt: row.created_at,
})

export const createHandoffStore = (db: Database) => {
  const insertReport = (input: {
    workspaceId: string
    agentId: string
    agentName: string
    mode: 'active' | 'passive'
    reportText: string
    pendingDispatches?: string | null
    sessionId?: string | null
  }): HandoffReport => {
    const id = randomUUID()
    const now = Date.now()
    db.prepare(
      `INSERT INTO handoff_reports (id, workspace_id, agent_id, agent_name, mode, report_text, pending_dispatches, session_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      input.workspaceId,
      input.agentId,
      input.agentName,
      input.mode,
      input.reportText,
      input.pendingDispatches ?? null,
      input.sessionId ?? null,
      now
    )
    return {
      id,
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      agentName: input.agentName,
      mode: input.mode,
      reportText: input.reportText,
      pendingDispatches: input.pendingDispatches ?? null,
      sessionId: input.sessionId ?? null,
      createdAt: now,
    }
  }

  const getReport = (id: string): HandoffReport | null => {
    const row = db.prepare('SELECT * FROM handoff_reports WHERE id = ?').get(id) as HandoffRow | undefined
    return row ? toRecord(row) : null
  }

  const listByWorkspace = (workspaceId: string): HandoffReport[] => {
    const rows = db
      .prepare('SELECT * FROM handoff_reports WHERE workspace_id = ? ORDER BY created_at DESC')
      .all(workspaceId) as HandoffRow[]
    return rows.map(toRecord)
  }

  return { insertReport, getReport, listByWorkspace }
}
