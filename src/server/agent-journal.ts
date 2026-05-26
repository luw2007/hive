import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export type JournalEntryType =
  | 'checkpoint'
  | 'dispatch_received'
  | 'report_sent'
  | 'session_rotated'
  | 'status_sent'

export interface JournalEntryInput {
  type: JournalEntryType
  summary: string
  body: string
  dispatch_id?: string
  duration_ms?: number
  metadata?: Record<string, string>
}

export interface ManifestEntry {
  ts: string
  type: JournalEntryType
  summary: string
  file: string
  dispatch_id?: string
  duration_ms?: number
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

const formatTimestampForFilename = (ts: string) => ts.replace(/:/g, '-')

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

export async function appendEntry(
  workspacePath: string,
  agentName: string,
  entry: JournalEntryInput
): Promise<ManifestEntry> {
  validateAgentName(agentName)
  const entriesDir = getEntriesDir(workspacePath, agentName)
  await mkdir(entriesDir, { recursive: true })

  const ts = new Date().toISOString()
  const filename = `${formatTimestampForFilename(ts)}_${entry.type}.md`
  const filePath = join(entriesDir, filename)
  const tmpPath = filePath + '.tmp'

  const frontmatter = buildFrontmatter(entry, ts)
  const content = `${frontmatter}\n\n${entry.body}\n`

  await writeFile(tmpPath, content, 'utf8')
  await rename(tmpPath, filePath)

  const summary = entry.summary.slice(0, 120)
  const relativeFile = `${ENTRIES_DIR}/${filename}`

  const manifestEntry: ManifestEntry = {
    ts,
    type: entry.type,
    summary,
    file: relativeFile,
    ...(entry.dispatch_id && { dispatch_id: entry.dispatch_id }),
    ...(entry.duration_ms !== undefined && { duration_ms: entry.duration_ms }),
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
