// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { useWorkspaceWorkers } from '../../web/src/useWorkspaceWorkers.js'

beforeEach(() => {
  // mock fetch 返回空 workers，避免初始 fetch 影响测试
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: async () => [],
  }))
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useWorkspaceWorkers', () => {
  test('returns empty map initially and exposes handleTeamUpdate', () => {
    const { result } = renderHook(() => useWorkspaceWorkers(['a', 'b']))

    expect(result.current.workersByWorkspaceId).toEqual({})
    expect(typeof result.current.handleTeamUpdate).toBe('function')
  })

  test('handleTeamUpdate populates workers for a workspace', () => {
    const { result } = renderHook(() => useWorkspaceWorkers(['a']))

    act(() => {
      result.current.handleTeamUpdate('a', [
        { id: 'wa', name: 'Alice', role: 'coder', status: 'working', pending_task_count: 1 },
      ])
    })

    expect(result.current.workersByWorkspaceId).toEqual({
      a: [{ id: 'wa', name: 'Alice', role: 'coder', status: 'working', pendingTaskCount: 1 }],
    })
  })

  test('prunes worker data when a workspace is removed from the id list', () => {
    const { rerender, result } = renderHook(
      ({ ids }: { ids: string[] }) => useWorkspaceWorkers(ids),
      { initialProps: { ids: ['a', 'b'] } }
    )

    act(() => {
      result.current.handleTeamUpdate('a', [
        { id: 'wa', name: 'Alice', role: 'coder', status: 'idle', pending_task_count: 0 },
      ])
      result.current.handleTeamUpdate('b', [
        { id: 'wb', name: 'Bob', role: 'tester', status: 'idle', pending_task_count: 0 },
      ])
    })

    expect(result.current.workersByWorkspaceId).toHaveProperty('a')
    expect(result.current.workersByWorkspaceId).toHaveProperty('b')

    rerender({ ids: ['b'] })

    expect(result.current.workersByWorkspaceId).toEqual({
      b: [{ id: 'wb', name: 'Bob', role: 'tester', status: 'idle', pendingTaskCount: 0 }],
    })
  })

  test('keeps same reference when updated workers are identical', () => {
    const { result } = renderHook(() => useWorkspaceWorkers(['a']))

    act(() => {
      result.current.handleTeamUpdate('a', [
        { id: 'wa', name: 'Alice', role: 'coder', status: 'idle', pending_task_count: 0 },
      ])
    })

    const firstMap = result.current.workersByWorkspaceId

    act(() => {
      result.current.handleTeamUpdate('a', [
        { id: 'wa', name: 'Alice', role: 'coder', status: 'idle', pending_task_count: 0 },
      ])
    })

    expect(result.current.workersByWorkspaceId).toBe(firstMap)
  })
})
