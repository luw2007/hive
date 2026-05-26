import { writeFileSync } from 'node:fs'

import type { Database } from 'better-sqlite3'

import type { TaskStatus } from './task-service.js'
import { getTasksFilePath } from './tasks-file.js'

interface TaskRow {
  id: string
  workspace_id: string
  title: string
  status: TaskStatus
  seq: number
  created_at: number
}

const STATUS_CHECKBOX: Record<string, string> = {
  done: '[x]',
  cancelled: '[x]',
}

const STATUS_SUFFIX: Record<string, string> = {
  blocked: '(blocked)',
  cancelled: '(cancelled)',
  in_progress: '(in progress)',
}

/**
 * 从 SQLite tasks 表生成 .hive/tasks.md 内容。
 * 排序：open/in_progress/proposed 在上，done/cancelled 在下，每组按 seq 升序。
 */
export const generateTasksMarkdown = (db: Database, workspaceId: string): string => {
  const rows = db
    .prepare(
      `SELECT id, workspace_id, title, status, seq, created_at
       FROM tasks WHERE workspace_id = ?
       ORDER BY
         CASE WHEN status IN ('done','cancelled') THEN 1 ELSE 0 END,
         seq ASC`
    )
    .all(workspaceId) as TaskRow[]

  if (rows.length === 0) return ''

  const lines: string[] = []
  for (const row of rows) {
    const checkbox = STATUS_CHECKBOX[row.status] ?? '[ ]'
    const suffix = STATUS_SUFFIX[row.status] ?? ''
    const seqPrefix = `#${row.seq}`
    const line = `- ${checkbox} ${seqPrefix} ${row.title}${suffix ? ` ${suffix}` : ''} <!-- tid:${row.id} -->`
    lines.push(line)
  }
  return lines.join('\n') + '\n'
}

export interface TasksMarkdownRegenerator {
  regenerate: (workspaceId: string) => string
}

/**
 * 创建 regenerator 实例，绑定 DB 和 workspace 路径查找函数。
 * regenerate() 写入文件并返回生成的内容（供 WS 推送使用）。
 */
export const createTasksMarkdownRegenerator = (
  db: Database,
  getWorkspacePath: (workspaceId: string) => string
): TasksMarkdownRegenerator => {
  return {
    regenerate(workspaceId: string): string {
      const content = generateTasksMarkdown(db, workspaceId)
      const filePath = getTasksFilePath(getWorkspacePath(workspaceId))
      writeFileSync(filePath, content, 'utf8')
      return content
    },
  }
}
