import { describe, it, expect, vi, beforeEach } from 'vitest'

import {
  broadcastToMembers,
  clearWriteQueue,
  formatDiscussionInvite,
  formatInitialBundle,
  formatDiscussMessage,
  formatConcludeInvite,
  injectToAgent,
  type BroadcastResult,
} from '../../src/server/discussion-message-router.js'
import type { DiscussionMember } from '../../src/server/discussion-operations.js'

const makeMember = (agentId: string, status = 'joined'): DiscussionMember => ({
  agent_id: agentId,
  agent_name: agentId,
  group_id: 'g-1',
  role: 'worker',
  member_status: status as DiscussionMember['member_status'],
  initial_position: null,
  final_position: null,
  rounds_participated: 0,
  last_message_at: null,
})

describe('discussion-message-router', () => {
  beforeEach(() => {
    clearWriteQueue('ws-1', 'agent-a')
    clearWriteQueue('ws-1', 'agent-b')
    clearWriteQueue('ws-1', 'agent-c')
  })

  describe('broadcastToMembers', () => {
    it('delivers to all active members except the excluded one', async () => {
      const writeFn = vi.fn()
      const members = [makeMember('agent-a'), makeMember('agent-b'), makeMember('agent-c')]

      const result = await broadcastToMembers('ws-1', members, 'agent-a', 'hello', writeFn)

      expect(result.delivered).toEqual(['agent-b', 'agent-c'])
      expect(result.failed).toEqual([])
      expect(writeFn).toHaveBeenCalledTimes(2)
      expect(writeFn).toHaveBeenCalledWith('ws-1', 'agent-b', 'hello')
      expect(writeFn).toHaveBeenCalledWith('ws-1', 'agent-c', 'hello')
    })

    it('skips members with skipped or failed status', async () => {
      const writeFn = vi.fn()
      const members = [
        makeMember('agent-a'),
        makeMember('agent-b', 'skipped'),
        makeMember('agent-c', 'failed'),
      ]

      const result = await broadcastToMembers('ws-1', members, 'agent-x', 'msg', writeFn)

      expect(result.delivered).toEqual(['agent-a'])
      expect(writeFn).toHaveBeenCalledTimes(1)
    })

    it('records failed agents when writeFn throws', async () => {
      const writeFn = vi.fn().mockImplementation((_ws, agentId) => {
        if (agentId === 'agent-b') throw new Error('write failed')
      })
      const members = [makeMember('agent-a'), makeMember('agent-b'), makeMember('agent-c')]

      const result = await broadcastToMembers('ws-1', members, 'agent-x', 'msg', writeFn)

      expect(result.delivered).toContain('agent-a')
      expect(result.delivered).toContain('agent-c')
      expect(result.failed).toEqual(['agent-b'])
    })
  })

  describe('formatDiscussionInvite', () => {
    it('includes topic, members, and round count', () => {
      const result = formatDiscussionInvite('API design', ['Alice', 'Bob'], 3)
      expect(result).toContain('API design')
      expect(result).toContain('Alice, Bob')
      expect(result).toContain('3')
      expect(result).toContain('team discuss')
    })
  })

  describe('formatInitialBundle', () => {
    it('includes all positions and round info', () => {
      const positions = [
        { name: 'Alice', text: 'Use REST' },
        { name: 'Bob', text: 'Use GraphQL' },
      ]
      const result = formatInitialBundle(positions, 1, 3)
      expect(result).toContain('@Alice')
      expect(result).toContain('Use REST')
      expect(result).toContain('@Bob')
      expect(result).toContain('Use GraphQL')
      expect(result).toContain('第 1 轮/共 3 轮')
    })
  })

  describe('formatDiscussMessage', () => {
    it('formats sender name and round info', () => {
      const result = formatDiscussMessage('Alice', 2, 3, 'I disagree because...')
      expect(result).toContain('@Alice')
      expect(result).toContain('第 2 轮/共 3 轮')
      expect(result).toContain('I disagree because...')
    })
  })

  describe('formatConcludeInvite', () => {
    it('asks for final conclusion', () => {
      const result = formatConcludeInvite()
      expect(result).toContain('team discuss --final')
      expect(result).toContain('最终结论')
    })
  })

  describe('injectToAgent', () => {
    it('calls writeFn with correct arguments', async () => {
      const writeFn = vi.fn()
      injectToAgent('ws-1', 'agent-a', 'injected text', writeFn)
      await new Promise((r) => setTimeout(r, 10))
      expect(writeFn).toHaveBeenCalledWith('ws-1', 'agent-a', 'injected text')
    })
  })

  describe('clearWriteQueue', () => {
    it('does not throw when clearing non-existent queue', () => {
      expect(() => clearWriteQueue('ws-x', 'agent-x')).not.toThrow()
    })
  })
})
