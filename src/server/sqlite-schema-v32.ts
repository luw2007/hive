import type { Database } from 'better-sqlite3'

export const applySchemaVersion32 = (db: Database) => {
  db.exec(`ALTER TABLE agent_runs ADD COLUMN inject_count INTEGER NOT NULL DEFAULT 0`)
  db.exec(`ALTER TABLE agent_runs ADD COLUMN rotation_reason TEXT`)
}
