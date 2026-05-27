/**
 * 验证 secretary 服务重启后，POST 消息能自动补挂 PTY 输出订阅。
 *
 * 模拟场景：
 *   - secretary PTY 已在运行（getActiveRunByAgentId 返回 activeRun）
 *   - 但内存中 outputSubscriptions 为空（服务重启后被清空）
 *   - POST 消息后应自动 subscribe PTY 输出
 *   - PTY 产生输出后，应被推入 assistant 消息缓冲
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { secretaryRoutes, pushSecretaryMessage } from '../../src/server/routes-secretary.js'
import type { SecretaryMessage } from '../../src/server/routes-secretary.js'

// 测试用常量
const WORKSPACE_ID = 'ws-test-001'
const SECRETARY_ID = `${WORKSPACE_ID}:secretary`
const ORCH_ID = `${WORKSPACE_ID}:orchestrator`
const RUN_ID = 'run-secretary-abc'

describe('secretary 重启后重新订阅输出流', () => {
  let subscribedListeners: Map<string, (chunk: string) => void>
  let unsubscribeCalled: boolean
  let writtenInputs: Array<{ runId: string; data: string }>
  let sentResponses: Array<{ status: number; body: unknown }>

  const createMockStore = (opts: { hasActiveRun: boolean }) => {
    subscribedListeners = new Map()
    unsubscribeCalled = false
    writtenInputs = []

    return {
      getAgent: (_wId: string, _aId: string) => ({
        id: SECRETARY_ID,
        name: 'Secretary',
        role: 'secretary' as const,
        status: 'working' as const,
      }),
      getActiveRunByAgentId: (_wId: string, _aId: string) =>
        opts.hasActiveRun
          ? { runId: RUN_ID, agentId: SECRETARY_ID, pid: 1234, status: 'running' as const, output: '', startedAt: Date.now() }
          : undefined,
      peekAgentLaunchConfig: (wId: string, aId: string) => {
        if (aId === ORCH_ID) return { command: 'claude', args: ['--model', 'opus'] }
        return undefined
      },
      configureAgentLaunch: vi.fn(),
      listWorkers: (_wId: string) => [] as any[],
      startAgent: vi.fn().mockResolvedValue({
        runId: RUN_ID,
        agentId: SECRETARY_ID,
        pid: 5678,
        status: 'running',
        output: '',
        startedAt: Date.now(),
      }),
      writeRunInput: (runId: string, data: string | Buffer) => {
        writtenInputs.push({ runId, data: String(data) })
      },
      writeAgentStdin: (_wId: string, _aId: string, data: string) => {
        writtenInputs.push({ runId: RUN_ID, data })
      },
      getPtyOutputBus: () => ({
        subscribe: (runId: string, listener: (chunk: string) => void) => {
          subscribedListeners.set(runId, listener)
          return () => { unsubscribeCalled = true }
        },
        publish: (_runId: string, _chunk: string) => {},
        clear: (_runId: string) => {},
      }),
      taskService: {
        listTasks: () => [],
        createTask: vi.fn(),
      },
    }
  }

  const createMockRequest = (): any => {
    const body = JSON.stringify({ content: '帮我整理一下任务' })
    return {
      socket: { localPort: 4321 },
      headers: { 'content-type': 'application/json' },
      [Symbol.asyncIterator]: async function* () {
        yield Buffer.from(body)
      },
    }
  }

  const createMockResponse = (): any => {
    sentResponses = []
    return {
      writeHead: vi.fn(),
      end: vi.fn().mockImplementation(function (this: any, body: string) {
        const statusCode = this.writeHead.mock.calls.at(-1)?.[0] ?? 200
        sentResponses.push({ status: statusCode, body: JSON.parse(body) })
      }),
      setHeader: vi.fn(),
    }
  }

  // 找到 POST messages 路由
  const postMessagesRoute = secretaryRoutes.find(
    (r) => r.method === 'POST' && r.path.includes('/secretary/messages') && !r.path.includes('execute')
  )!

  // 找到 GET messages 路由
  const getMessagesRoute = secretaryRoutes.find(
    (r) => r.method === 'GET' && r.path.includes('/secretary/messages')
  )!

  test('已运行的 secretary 在 POST 时自动补挂输出订阅', async () => {
    const store = createMockStore({ hasActiveRun: true })
    const request = createMockRequest()
    const response = createMockResponse()

    await postMessagesRoute.handler({
      params: { workspaceId: WORKSPACE_ID },
      request,
      response,
      store: store as any,
      tasksFileService: {} as any,
      pickFolderService: (async () => ({})) as any,
      openWorkspaceService: {} as any,
      versionService: {} as any,
    })

    // 验证：PTY 输出 bus 被订阅了
    expect(subscribedListeners.has(RUN_ID)).toBe(true)
    // 验证：消息被写入 stdin
    expect(writtenInputs).toHaveLength(1)
    expect(writtenInputs[0]!.runId).toBe(RUN_ID)
    // 验证：不调用 startAgent（因为已在运行）
    expect(store.startAgent).not.toHaveBeenCalled()
  })

  test('PTY 输出通过订阅被捕获为 assistant 消息', async () => {
    // 用独立 workspaceId 避免模块级 outputSubscriptions 的跨 test 污染
    const wsId = 'ws-output-capture'
    const secId = `${wsId}:secretary`
    const orchId = `${wsId}:orchestrator`
    const runId = 'run-output-test'

    const localListeners = new Map<string, (chunk: string) => void>()
    const store = {
      getAgent: () => ({ id: secId, name: 'Secretary', role: 'secretary' as const, status: 'working' as const }),
      getActiveRunByAgentId: () => ({ runId, agentId: secId, pid: 99, status: 'running' as const, output: '', startedAt: Date.now() }),
      peekAgentLaunchConfig: () => undefined,
      configureAgentLaunch: vi.fn(),
      startAgent: vi.fn(),
      writeRunInput: vi.fn(),
      writeAgentStdin: vi.fn(),
      getPtyOutputBus: () => ({
        subscribe: (rId: string, listener: (chunk: string) => void) => {
          localListeners.set(rId, listener)
          return () => {}
        },
        publish: () => {},
        clear: () => {},
      }),
      taskService: { listTasks: () => [], createTask: vi.fn() },
    }

    // 使用 fake timers 从头开始，确保 startup 阶段 setTimeout 可控
    vi.useFakeTimers()

    await postMessagesRoute.handler({
      params: { workspaceId: wsId },
      request: createMockRequest(),
      response: createMockResponse(),
      store: store as any,
      tasksFileService: {} as any,
      pickFolderService: (async () => ({})) as any,
      openWorkspaceService: {} as any,
      versionService: {} as any,
    })

    // 确认订阅已挂载
    expect(localListeners.has(runId)).toBe(true)

    // 推进过 3s 启动阶段（startupPhase 丢弃所有输出）
    vi.advanceTimersByTime(3100)

    // 模拟 PTY 输出
    const listener = localListeners.get(runId)!
    listener('当前有 3 个待办任务：\n')
    listener('1. 修复登录 bug\n')
    listener('2. 更新文档\n')

    // 推进时间触发防抖 flush（1.5s）
    vi.advanceTimersByTime(1600)

    vi.useRealTimers()

    // 读取消息缓冲验证
    const getResponse = createMockResponse()
    await getMessagesRoute.handler({
      params: { workspaceId: wsId },
      request: {} as any,
      response: getResponse,
      store: store as any,
      tasksFileService: {} as any,
      pickFolderService: (async () => ({})) as any,
      openWorkspaceService: {} as any,
      versionService: {} as any,
    })

    const messages: SecretaryMessage[] = (sentResponses.at(-1)?.body as any)?.messages ?? []
    const assistantMsgs = messages.filter((m) => m.role === 'assistant')
    expect(assistantMsgs).toHaveLength(1)
    expect(assistantMsgs[0]!.content).toContain('当前有 3 个待办任务')
    expect(assistantMsgs[0]!.content).toContain('修复登录 bug')
  })

  test('未运行时自动从 orchestrator 复制配置并启动', async () => {
    const store = createMockStore({ hasActiveRun: false })
    const request = createMockRequest()
    const response = createMockResponse()

    await postMessagesRoute.handler({
      params: { workspaceId: WORKSPACE_ID },
      request,
      response,
      store: store as any,
      tasksFileService: {} as any,
      pickFolderService: (async () => ({})) as any,
      openWorkspaceService: {} as any,
      versionService: {} as any,
    })

    // 验证：配置从 orchestrator 复制
    expect(store.configureAgentLaunch).toHaveBeenCalledWith(
      WORKSPACE_ID,
      SECRETARY_ID,
      expect.objectContaining({ command: 'claude', args: ['--model', 'opus'] })
    )
    // 验证：调用 startAgent
    expect(store.startAgent).toHaveBeenCalledWith(
      WORKSPACE_ID,
      SECRETARY_ID,
      { hivePort: '4321' }
    )
    // 验证：启动后也订阅了输出
    expect(subscribedListeners.has(RUN_ID)).toBe(true)
  })

  test('重复 POST 不会重复订阅（幂等）', async () => {
    const store = createMockStore({ hasActiveRun: true })

    // 第一次 POST
    await postMessagesRoute.handler({
      params: { workspaceId: WORKSPACE_ID },
      request: createMockRequest(),
      response: createMockResponse(),
      store: store as any,
      tasksFileService: {} as any,
      pickFolderService: (async () => ({})) as any,
      openWorkspaceService: {} as any,
      versionService: {} as any,
    })

    const firstListener = subscribedListeners.get(RUN_ID)

    // 第二次 POST — 不应重新订阅
    await postMessagesRoute.handler({
      params: { workspaceId: WORKSPACE_ID },
      request: createMockRequest(),
      response: createMockResponse(),
      store: store as any,
      tasksFileService: {} as any,
      pickFolderService: (async () => ({})) as any,
      openWorkspaceService: {} as any,
      versionService: {} as any,
    })

    // listener 没变（没有被取消重建）
    expect(subscribedListeners.get(RUN_ID)).toBe(firstListener)
    expect(unsubscribeCalled).toBe(false)
  })
})
