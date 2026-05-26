import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export type DecisionCategory = 'constraint' | 'preference' | 'priority' | 'process' | 'scope' | 'tech'

export interface Decision {
  id: string
  ts: string
  category: DecisionCategory
  content: string
  reason: string
  source: 'user' | 'orch'
  confirmed_by: 'user' | null
  last_referenced: number | null
  active: boolean
  superseded_by?: string
}

export interface DecisionInput {
  category: DecisionCategory
  content: string
  reason: string
  source?: 'user' | 'orch'
  confirmed_by?: 'user' | null
}

const HIVE_DIR = '.hive'
const DECISIONS_FILE = 'decisions.jsonl'

const getDecisionsPath = (workspacePath: string) =>
  join(workspacePath, HIVE_DIR, DECISIONS_FILE)

export async function appendDecision(
  workspacePath: string,
  input: DecisionInput
): Promise<Decision> {
  const dir = join(workspacePath, HIVE_DIR)
  await mkdir(dir, { recursive: true })

  const decision: Decision = {
    id: randomUUID(),
    ts: new Date().toISOString(),
    category: input.category,
    content: input.content,
    reason: input.reason,
    source: input.source ?? 'orch',
    confirmed_by: input.confirmed_by ?? null,
    last_referenced: null,
    active: true,
  }

  const filePath = getDecisionsPath(workspacePath)
  await appendFile(filePath, JSON.stringify(decision) + '\n', 'utf8')
  return decision
}

export async function getActiveDecisions(
  workspacePath: string,
  category?: DecisionCategory
): Promise<Decision[]> {
  const filePath = getDecisionsPath(workspacePath)

  let raw: string
  try {
    raw = await readFile(filePath, 'utf8')
  } catch {
    return []
  }

  const decisions: Decision[] = []
  for (const line of raw.trimEnd().split('\n')) {
    if (!line) continue
    try {
      const d = JSON.parse(line) as Decision
      if (d.active && (!category || d.category === category)) {
        decisions.push(d)
      }
    } catch {
      // skip corrupted lines
    }
  }
  return decisions
}

export async function getAllDecisions(workspacePath: string): Promise<Decision[]> {
  const filePath = getDecisionsPath(workspacePath)

  let raw: string
  try {
    raw = await readFile(filePath, 'utf8')
  } catch {
    return []
  }

  const decisions: Decision[] = []
  for (const line of raw.trimEnd().split('\n')) {
    if (!line) continue
    try {
      decisions.push(JSON.parse(line) as Decision)
    } catch {
      // skip corrupted lines
    }
  }
  return decisions
}

export async function supersede(
  workspacePath: string,
  oldId: string,
  newInput: DecisionInput
): Promise<Decision> {
  const all = await getAllDecisions(workspacePath)
  const oldDecision = all.find((d) => d.id === oldId && d.active)
  if (!oldDecision) {
    throw new Error(`Decision ${oldId} not found or already inactive`)
  }

  const newDecision: Decision = {
    id: randomUUID(),
    ts: new Date().toISOString(),
    category: newInput.category,
    content: newInput.content,
    reason: newInput.reason,
    source: newInput.source ?? 'orch',
    confirmed_by: newInput.confirmed_by ?? null,
    last_referenced: null,
    active: true,
  }

  oldDecision.active = false
  oldDecision.superseded_by = newDecision.id

  const filePath = getDecisionsPath(workspacePath)
  const lines = all.map((d) => JSON.stringify(d)).join('\n') + '\n' + JSON.stringify(newDecision) + '\n'

  const dir = join(workspacePath, HIVE_DIR)
  await mkdir(dir, { recursive: true })
  const tmpPath = filePath + '.tmp'
  await writeFile(tmpPath, lines, 'utf8')
  await rename(tmpPath, filePath)

  return newDecision
}
