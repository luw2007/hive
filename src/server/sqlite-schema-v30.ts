import type { Database } from 'better-sqlite3'

export const applySchemaVersion30 = (db: Database) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS handoff_reports (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      mode TEXT NOT NULL CHECK(mode IN ('active', 'passive')),
      report_text TEXT NOT NULL,
      pending_dispatches TEXT,
      session_id TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_handoff_workspace ON handoff_reports(workspace_id, created_at DESC);
  `)
}
