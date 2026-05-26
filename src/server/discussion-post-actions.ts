import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import { getTasksFilePath } from './tasks-file.js'

const NEXT_ACTIONS_HEADING = /^##\s+\d+\.\s*Next Actions/i
const LIST_ITEM = /^(?:[-*]\s+|\d+\.\s+)(.+)/

export const parseNextActions = (reportText: string): string[] => {
  const lines = reportText.split('\n')
  let inSection = false
  const actions: string[] = []

  for (const line of lines) {
    if (NEXT_ACTIONS_HEADING.test(line)) {
      inSection = true
      continue
    }
    if (inSection && line.startsWith('## ')) break
    if (inSection) {
      const m = LIST_ITEM.exec(line)
      if (m?.[1]) {
        const text = m[1].trim()
        if (text.length > 0) actions.push(text)
      }
    }
  }

  return actions
}

export interface TaskService {
  createTask(input: {
    workspaceId: string
    title: string
    source: 'discussion'
    sourceRef?: string
  }): { id: string; seq: number }
}

/**
 * 将讨论产出的 action items 创建为 DB tasks。
 * 文件生成由 task-service 的 onChange hook 自动触发，无需手动 append。
 * 返回创建的 task 数量。
 */
export const appendActionsToTasks = (
  workspacePath: string,
  topic: string,
  actions: string[],
  taskService?: TaskService,
  workspaceId?: string,
  groupId?: string
): number => {
  if (actions.length === 0) return 0

  if (taskService && workspaceId) {
    // 新模型：仅创建 DB 记录，md 由 regenerator 自动生成
    for (const action of actions) {
      taskService.createTask({
        workspaceId,
        title: action,
        source: 'discussion',
        ...(groupId ? { sourceRef: groupId } : {}),
      })
    }
  } else {
    // 回退：无 taskService 时仍手动写文件（兼容测试 / 边界场景）
    const tasksPath = getTasksFilePath(workspacePath)
    const dir = dirname(tasksPath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const header = `\n\n## 讨论产出：${topic}\n\n`
    const items = actions.map((a) => `- [ ] ${a}`).join('\n')
    appendFileSync(tasksPath, `${header}${items}\n`, 'utf8')
  }

  return actions.length
}
