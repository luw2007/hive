import { readFileSync, existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { appendEntry, getRecentEntries } from '../../src/server/agent-journal.js'

describe('agent-journal', () => {
  let workspacePath: string

  beforeEach(async () => {
    workspacePath = await mkdtemp(join(tmpdir(), 'hive-journal-test-'))
  })

  afterEach(async () => {
    await rm(workspacePath, { recursive: true, force: true })
  })

  test('appendEntry creates .hive/journal/<name>/ directory structure on first write', async () => {
    await appendEntry(workspacePath, 'alice', {
      type: 'dispatch_received',
      summary: 'Implement login endpoint',
      body: '## Task\nBuild POST /login',
      dispatch_id: 'd-abc123',
    })

    const journalDir = join(workspacePath, '.hive', 'journal', 'alice')
    expect(existsSync(journalDir)).toBe(true)
    expect(existsSync(join(journalDir, 'manifest.jsonl'))).toBe(true)
    expect(existsSync(join(journalDir, 'entries'))).toBe(true)
  })

  test('appendEntry writes manifest.jsonl line with correct schema fields including seq', async () => {
    await appendEntry(workspacePath, 'bob', {
      type: 'report_sent',
      summary: 'Completed auth module',
      body: '## Report\nDone',
      dispatch_id: 'd-xyz789',
      duration_ms: 1500,
    })

    const manifestPath = join(workspacePath, '.hive', 'journal', 'bob', 'manifest.jsonl')
    const line = readFileSync(manifestPath, 'utf-8').trim()
    const entry = JSON.parse(line)

    expect(entry.seq).toBe(1)
    expect(entry.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
    expect(entry.type).toBe('report_sent')
    expect(entry.summary).toBe('Completed auth module')
    expect(entry.file).toMatch(/^entries\//)
    expect(entry.dispatch_id).toBe('d-xyz789')
    expect(entry.duration_ms).toBe(1500)
  })

  test('appendEntry creates entry file with YAML frontmatter + body content', async () => {
    await appendEntry(workspacePath, 'carol', {
      type: 'dispatch_received',
      summary: 'Fix bug in parser',
      body: '## 派单内容\nFix the CSV parser edge case',
      dispatch_id: 'd-fix001',
    })

    const journalDir = join(workspacePath, '.hive', 'journal', 'carol')
    const manifest = readFileSync(join(journalDir, 'manifest.jsonl'), 'utf-8').trim()
    const { file } = JSON.parse(manifest)
    const entryContent = readFileSync(join(journalDir, file), 'utf-8')

    expect(entryContent).toContain('---')
    expect(entryContent).toContain('type: dispatch_received')
    expect(entryContent).toContain('dispatch_id: "d-fix001"')
    expect(entryContent).toContain('## 派单内容')
    expect(entryContent).toContain('Fix the CSV parser edge case')
  })

  test('getRecentEntries returns last N entries in chronological order', async () => {
    await appendEntry(workspacePath, 'dave', {
      type: 'dispatch_received',
      summary: 'First task',
      body: 'body1',
    })
    await appendEntry(workspacePath, 'dave', {
      type: 'report_sent',
      summary: 'First done',
      body: 'body2',
    })
    await appendEntry(workspacePath, 'dave', {
      type: 'dispatch_received',
      summary: 'Second task',
      body: 'body3',
    })

    const recent = await getRecentEntries(workspacePath, 'dave', 2)

    expect(recent).toHaveLength(2)
    expect(recent[0]!.summary).toBe('First done')
    expect(recent[1]!.summary).toBe('Second task')
  })

  test('getRecentEntries returns empty array for non-existent agent journal', async () => {
    const result = await getRecentEntries(workspacePath, 'ghost', 5)
    expect(result).toEqual([])
  })

  test('multiple appendEntry calls produce ordered manifest lines with incrementing seq', async () => {
    await appendEntry(workspacePath, 'eve', {
      type: 'dispatch_received',
      summary: 'Task A',
      body: 'do A',
    })
    await appendEntry(workspacePath, 'eve', {
      type: 'status_sent',
      summary: 'Working on A',
      body: 'progress update',
    })
    await appendEntry(workspacePath, 'eve', {
      type: 'report_sent',
      summary: 'A completed',
      body: 'done',
    })

    const manifestPath = join(workspacePath, '.hive', 'journal', 'eve', 'manifest.jsonl')
    const lines = readFileSync(manifestPath, 'utf-8').trim().split('\n')

    expect(lines).toHaveLength(3)
    const entries = lines.map((l) => JSON.parse(l))
    expect(entries[0]!.seq).toBe(1)
    expect(entries[1]!.seq).toBe(2)
    expect(entries[2]!.seq).toBe(3)
    expect(entries[0]!.type).toBe('dispatch_received')
    expect(entries[1]!.type).toBe('status_sent')
    expect(entries[2]!.type).toBe('report_sent')
  })

  test('entry filenames use seq-prefixed pattern: {seq padded 4}-{type}-{hash}.md', async () => {
    await appendEntry(workspacePath, 'frank', {
      type: 'session_rotated',
      summary: 'Rotation triggered',
      body: 'context refresh',
    })

    const manifestPath = join(workspacePath, '.hive', 'journal', 'frank', 'manifest.jsonl')
    const { file } = JSON.parse(readFileSync(manifestPath, 'utf-8').trim())

    expect(file).toMatch(/^entries\/0001-session_rotated-[a-zA-Z0-9]+\.md$/)
  })

  test('appendEntry summary is truncated to 200 chars if longer', async () => {
    const longSummary = 'x'.repeat(300)

    await appendEntry(workspacePath, 'grace', {
      type: 'checkpoint_saved',
      summary: longSummary,
      body: 'checkpoint data',
    })

    const manifestPath = join(workspacePath, '.hive', 'journal', 'grace', 'manifest.jsonl')
    const entry = JSON.parse(readFileSync(manifestPath, 'utf-8').trim())

    expect(entry.summary.length).toBeLessThanOrEqual(200)
    expect(entry.summary.length).toBe(200)
  })

  test('appendEntry stores artifacts when provided', async () => {
    await appendEntry(workspacePath, 'hal', {
      type: 'report_sent',
      summary: 'Done with auth',
      body: 'completed',
      artifacts: ['src/auth.ts', 'src/auth.test.ts'],
    })

    const manifestPath = join(workspacePath, '.hive', 'journal', 'hal', 'manifest.jsonl')
    const entry = JSON.parse(readFileSync(manifestPath, 'utf-8').trim())

    expect(entry.artifacts).toEqual(['src/auth.ts', 'src/auth.test.ts'])
  })

  test('appendEntry omits artifacts field when not provided', async () => {
    await appendEntry(workspacePath, 'iris', {
      type: 'dispatch_received',
      summary: 'Task without artifacts',
      body: 'body',
    })

    const manifestPath = join(workspacePath, '.hive', 'journal', 'iris', 'manifest.jsonl')
    const entry = JSON.parse(readFileSync(manifestPath, 'utf-8').trim())

    expect(entry.artifacts).toBeUndefined()
  })

  test('checkpoint_saved and user_input_received are valid entry types', async () => {
    await appendEntry(workspacePath, 'jake', {
      type: 'checkpoint_saved',
      summary: 'Progress checkpoint',
      body: 'saving state',
    })
    await appendEntry(workspacePath, 'jake', {
      type: 'user_input_received',
      summary: 'User said hello',
      body: 'hello world',
    })

    const manifestPath = join(workspacePath, '.hive', 'journal', 'jake', 'manifest.jsonl')
    const lines = readFileSync(manifestPath, 'utf-8').trim().split('\n')
    const entries = lines.map((l) => JSON.parse(l))

    expect(entries[0]!.type).toBe('checkpoint_saved')
    expect(entries[1]!.type).toBe('user_input_received')
    expect(entries[0]!.seq).toBe(1)
    expect(entries[1]!.seq).toBe(2)
  })
})
