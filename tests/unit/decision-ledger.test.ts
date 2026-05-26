import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import {
  appendDecision,
  getAllDecisions,
  getActiveDecisions,
  supersede,
} from '../../src/server/decision-ledger.js'

describe('decision-ledger', () => {
  let workspacePath: string

  beforeEach(async () => {
    workspacePath = await mkdtemp(join(tmpdir(), 'hive-ledger-test-'))
  })

  afterEach(async () => {
    await rm(workspacePath, { recursive: true, force: true })
  })

  test('appendDecision creates decisions.jsonl and writes correct schema', async () => {
    const decision = await appendDecision(workspacePath, {
      category: 'tech',
      content: 'Use PostgreSQL for persistence',
      reason: 'Team familiarity and JSONB support',
    })

    const filePath = join(workspacePath, '.hive', 'decisions.jsonl')
    const line = readFileSync(filePath, 'utf-8').trim()
    const parsed = JSON.parse(line)

    expect(parsed.id).toBe(decision.id)
    expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
    expect(parsed.category).toBe('tech')
    expect(parsed.content).toBe('Use PostgreSQL for persistence')
    expect(parsed.reason).toBe('Team familiarity and JSONB support')
    expect(parsed.source).toBe('orch')
    expect(parsed.confirmed_by).toBeNull()
    expect(parsed.last_referenced).toBeNull()
    expect(parsed.active).toBe(true)
  })

  test('getActiveDecisions returns only active=true entries', async () => {
    await appendDecision(workspacePath, {
      category: 'tech',
      content: 'Decision A',
      reason: 'reason A',
    })
    const b = await appendDecision(workspacePath, {
      category: 'process',
      content: 'Decision B',
      reason: 'reason B',
    })

    await supersede(workspacePath, b.id, {
      category: 'process',
      content: 'Decision B revised',
      reason: 'better approach',
    })

    const active = await getActiveDecisions(workspacePath)
    expect(active).toHaveLength(2)
    expect(active.find((d) => d.content === 'Decision A')).toBeDefined()
    expect(active.find((d) => d.content === 'Decision B revised')).toBeDefined()
    expect(active.find((d) => d.content === 'Decision B')).toBeUndefined()
  })

  test('getActiveDecisions with category filter', async () => {
    await appendDecision(workspacePath, {
      category: 'tech',
      content: 'Use React',
      reason: 'ecosystem',
    })
    await appendDecision(workspacePath, {
      category: 'scope',
      content: 'MVP only auth flow',
      reason: 'time constraint',
    })
    await appendDecision(workspacePath, {
      category: 'tech',
      content: 'Use Vite',
      reason: 'speed',
    })

    const techOnly = await getActiveDecisions(workspacePath, 'tech')
    expect(techOnly).toHaveLength(2)
    expect(techOnly.every((d) => d.category === 'tech')).toBe(true)

    const scopeOnly = await getActiveDecisions(workspacePath, 'scope')
    expect(scopeOnly).toHaveLength(1)
    expect(scopeOnly[0]!.content).toBe('MVP only auth flow')
  })

  test('supersede marks old decision inactive and appends new one', async () => {
    const original = await appendDecision(workspacePath, {
      category: 'constraint',
      content: 'Max 3 workers per workspace',
      reason: 'resource limit',
    })

    const replacement = await supersede(workspacePath, original.id, {
      category: 'constraint',
      content: 'Max 5 workers per workspace',
      reason: 'user feedback — 3 too few',
    })

    const all = await getAllDecisions(workspacePath)
    const old = all.find((d) => d.id === original.id)!
    const newer = all.find((d) => d.id === replacement.id)!

    expect(old.active).toBe(false)
    expect(old.superseded_by).toBe(replacement.id)
    expect(newer.active).toBe(true)
    expect(newer.content).toBe('Max 5 workers per workspace')
  })

  test('supersede rewrites file atomically — content is consistent after write', async () => {
    await appendDecision(workspacePath, {
      category: 'tech',
      content: 'First decision',
      reason: 'initial',
    })
    const second = await appendDecision(workspacePath, {
      category: 'tech',
      content: 'Second decision',
      reason: 'follow-up',
    })

    await supersede(workspacePath, second.id, {
      category: 'tech',
      content: 'Second revised',
      reason: 'correction',
    })

    const filePath = join(workspacePath, '.hive', 'decisions.jsonl')
    const raw = readFileSync(filePath, 'utf-8')
    const lines = raw.trimEnd().split('\n')

    expect(lines).toHaveLength(3)
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow()
    }

    const parsed = lines.map((l) => JSON.parse(l))
    const activeCount = parsed.filter((d: { active: boolean }) => d.active).length
    expect(activeCount).toBe(2)
  })

  test('getAllDecisions returns all including inactive', async () => {
    const a = await appendDecision(workspacePath, {
      category: 'preference',
      content: 'Tabs over spaces',
      reason: 'team vote',
    })

    await supersede(workspacePath, a.id, {
      category: 'preference',
      content: 'Spaces over tabs',
      reason: 'changed team vote',
    })

    const all = await getAllDecisions(workspacePath)
    expect(all).toHaveLength(2)
    expect(all.filter((d) => d.active)).toHaveLength(1)
    expect(all.filter((d) => !d.active)).toHaveLength(1)
  })

  test('getActiveDecisions returns empty array when no file exists', async () => {
    const result = await getActiveDecisions(workspacePath)
    expect(result).toEqual([])
  })

  test('supersede throws for non-existent or inactive decision', async () => {
    await expect(
      supersede(workspacePath, 'non-existent-id', {
        category: 'tech',
        content: 'whatever',
        reason: 'test',
      })
    ).rejects.toThrow(/not found or already inactive/)
  })

  test('appendDecision accepts source and confirmed_by fields', async () => {
    const decision = await appendDecision(workspacePath, {
      category: 'priority',
      content: 'Focus on auth flow first',
      reason: 'User explicitly requested',
      source: 'user',
      confirmed_by: 'user',
    })

    expect(decision.source).toBe('user')
    expect(decision.confirmed_by).toBe('user')
    expect(decision.last_referenced).toBeNull()
    expect(decision.category).toBe('priority')
  })

  test('appendDecision defaults source to orch when not provided', async () => {
    const decision = await appendDecision(workspacePath, {
      category: 'tech',
      content: 'Use Bun runtime',
      reason: 'Faster startup',
    })

    expect(decision.source).toBe('orch')
    expect(decision.confirmed_by).toBeNull()
  })

  test('supersede preserves source/confirmed_by on new decision', async () => {
    const original = await appendDecision(workspacePath, {
      category: 'constraint',
      content: 'Limit to 3 agents',
      reason: 'resource constraint',
      source: 'orch',
    })

    const replacement = await supersede(workspacePath, original.id, {
      category: 'constraint',
      content: 'Limit to 5 agents',
      reason: 'user override',
      source: 'user',
      confirmed_by: 'user',
    })

    expect(replacement.source).toBe('user')
    expect(replacement.confirmed_by).toBe('user')
    expect(replacement.last_referenced).toBeNull()
  })

  test('priority category is accepted', async () => {
    const decision = await appendDecision(workspacePath, {
      category: 'priority',
      content: 'Auth before dashboard',
      reason: 'Blocking other work',
    })

    expect(decision.category).toBe('priority')
    const active = await getActiveDecisions(workspacePath, 'priority')
    expect(active).toHaveLength(1)
    expect(active[0]!.content).toBe('Auth before dashboard')
  })
})
