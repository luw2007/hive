import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export type JournalEntryType =
  | 'checkpoint_saved'
  | 'dispatch_received'
  | 'report_sent'
  | 'session_rotated'
  | 'status_sent'
  | 'user_input_received'

export interface JournalEntryInput {
  type: JournalEntryType
  summary: string
  body: string
  dispatch_id?: string
  duration_ms?: number
  artifacts?: string[]
  metadata?: Record<string, string>
}

export interface ManifestEntry {
  seq: number
  ts: string
  type: JournalEntryType
  summary: string
  file: string
  dispatch_id?: string
  duration_ms?: number
  artifacts?: string[]
}

const HIVE_DIR = '.hive'
const JOURNAL_DIR = 'journal'
const MANIFEST_FILE = 'manifest.jsonl'
const ENTRIES_DIR = 'entries'

const SAFE_AGENT_NAME = /^[a-zA-Z0-9_-]+$/

const validateAgentName = (agentName: string) => {
  if (!SAFE_AGENT_NAME.test(agentName)) {
    throw new Error(`Invalid agent name: ${agentName}`)
  }
}

const getJournalDir = (workspacePath: string, agentName: string) =>
  join(workspacePath, HIVE_DIR, JOURNAL_DIR, agentName)

const getManifestPath = (workspacePath: string, agentName: string) =>
  join(getJournalDir(workspacePath, agentName), MANIFEST_FILE)

const getEntriesDir = (workspacePath: string, agentName: string) =>
  join(getJournalDir(workspacePath, agentName), ENTRIES_DIR)


const buildFrontmatter = (entry: JournalEntryInput, ts: string): string => {
  const lines: string[] = ['---']
  lines.push(`ts: "${ts}"`)
  lines.push(`type: ${entry.type}`)
  if (entry.dispatch_id) lines.push(`dispatch_id: "${entry.dispatch_id}"`)
  if (entry.duration_ms !== undefined) lines.push(`duration_ms: ${entry.duration_ms}`)
  if (entry.metadata) {
    for (const [k, v] of Object.entries(entry.metadata)) {
      lines.push(`${k}: "${v}"`)
    }
  }
  lines.push('---')
  return lines.join('\n')
}

async function getNextSeq(workspacePath: string, agentName: string): Promise<number> {
  const manifestPath = getManifestPath(workspacePath, agentName)
  let raw: string
  try {
    raw = await readFile(manifestPath, 'utf8')
  } catch {
    return 1
  }
  const lines = raw.trimEnd().split('\n')
  let maxSeq = 0
  for (const line of lines) {
    if (!line) continue
    try {
      const entry = JSON.parse(line) as ManifestEntry
      if (entry.seq > maxSeq) maxSeq = entry.seq
    } catch {
      // skip corrupted lines
    }
  }
  return maxSeq + 1
}

export async function appendEntry(
  workspacePath: string,
  agentName: string,
  entry: JournalEntryInput
): Promise<ManifestEntry> {
  validateAgentName(agentName)
  const entriesDir = getEntriesDir(workspacePath, agentName)
  await mkdir(entriesDir, { recursive: true })

  const seq = await getNextSeq(workspacePath, agentName)
  const ts = new Date().toISOString()
  const idHash = ts.replace(/\W/g, '').slice(-6)
  const filename = `${String(seq).padStart(4, '0')}-${entry.type}-${idHash}.md`
  const filePath = join(entriesDir, filename)
  const tmpPath = filePath + '.tmp'

  const frontmatter = buildFrontmatter(entry, ts)
  const content = `${frontmatter}\n\n${entry.body}\n`

  await writeFile(tmpPath, content, 'utf8')
  await rename(tmpPath, filePath)

  const summary = entry.summary.slice(0, 200)
  const relativeFile = `${ENTRIES_DIR}/${filename}`

  const manifestEntry: ManifestEntry = {
    seq,
    ts,
    type: entry.type,
    summary,
    file: relativeFile,
    ...(entry.dispatch_id && { dispatch_id: entry.dispatch_id }),
    ...(entry.duration_ms !== undefined && { duration_ms: entry.duration_ms }),
    ...(entry.artifacts && entry.artifacts.length > 0 && { artifacts: entry.artifacts }),
  }

  const manifestPath = getManifestPath(workspacePath, agentName)
  await appendFile(manifestPath, JSON.stringify(manifestEntry) + '\n', 'utf8')

  return manifestEntry
}

export async function getRecentEntries(
  workspacePath: string,
  agentName: string,
  count: number
): Promise<ManifestEntry[]> {
  validateAgentName(agentName)
  const manifestPath = getManifestPath(workspacePath, agentName)

  let raw: string
  try {
    raw = await readFile(manifestPath, 'utf8')
  } catch {
    return []
  }

  const lines = raw.trimEnd().split('\n')
  const recent = lines.slice(-count)
  const entries: ManifestEntry[] = []

  for (const line of recent) {
    if (!line) continue
    try {
      entries.push(JSON.parse(line) as ManifestEntry)
    } catch {
      // skip corrupted lines
    }
  }

  return entries
}
