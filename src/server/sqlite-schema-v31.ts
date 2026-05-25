import type { Database } from 'better-sqlite3'

import { HR_ROLE_DESCRIPTION } from './role-templates.js'

export const applySchemaVersion31 = (db: Database) => {
  const now = Date.now()
  db.prepare(
    `INSERT INTO role_templates (
       id, name, role_type, description, default_command, default_args, default_env,
       is_builtin, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT(id) DO NOTHING`
  ).run('hr', 'HR', 'hr', HR_ROLE_DESCRIPTION, 'claude', '[]', '{}', now, now)
}
