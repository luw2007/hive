import type { IncomingMessage } from 'node:http'

import type { RuntimeStore } from './runtime-store.js'
import { BadRequestError } from './http-errors.js'
import { readJsonBody, route, sendJson } from './route-helpers.js'
import type { RouteDefinition } from './route-types.js'
import { getSecretaryId } from './workspace-store-support.js'

/** 可执行动作定义 */
export interface SecretaryAction {
  id: string
  label: string
  /** 动作类型：create_task / dispatch / cancel_task / start_discussion */
  type: 'create_task' | 'dispatch' | 'cancel_task' | 'start_discussion'
  /** 动作参数，按 type 不同含义不同 */
  payload: Record<string, unknown>
}

export interface SecretaryMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: number
  /** 可选：附带可执行动作按钮 */
  actions?: SecretaryAction[]
}

/** 每 workspace 的消息缓冲（内存，最多 200 条） */
const messageBuffers = new Map<string, SecretaryMessage[]>()

/** 每 workspace 上次发送的用户输入（用于检测 PTY 输入回显） */
const lastUserInputs = new Map<string, string>()

/** 检测 cleaned output 是否为用户输入的回显 */
const isInputEcho = (workspaceId: string, cleaned: string): boolean => {
  const lastInput = lastUserInputs.get(workspaceId)
  if (!lastInput) return false
  // 去空格 + 小写后比较（PTY 回显可能丢失空格/大小写不变但格式不同）
  const normalize = (s: string) => s.replace(/\s+/g, '').toLowerCase()
  return normalize(cleaned) === normalize(lastInput)
}

/** 每 workspace 上次积压提醒时间（防抖用） */
const lastBacklogAlertTime = new Map<string, number>()

/** 每 workspace 的 PTY 输出订阅取消函数 */
const outputSubscriptions = new Map<string, () => void>()

const MAX_MESSAGES = 200
const BACKLOG_THRESHOLD = 5
const BACKLOG_COOLDOWN_MS = 5 * 60 * 1000 // 5 分钟冷却
const OUTPUT_DEBOUNCE_MS = 1500 // PTY 输出防抖
const ANSI_ESCAPE_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\)?)/g

/**
 * 从 Claude Code TUI 原始 PTY 输出中提取纯回复文本。
 *
 * Claude Code 用 ⏺ (U+23FA) 标记实际响应行。策略：
 * 1. 先去 ANSI + 控制字符，NBSP→空格
 * 2. 用 ⏺/● 标记定位响应段落，提取到下一个噪音边界
 * 3. 如果没找到 ⏺ 行，fallback 到正则清洗
 */
const extractClaudeResponse = (raw: string): string => {
  // Phase 1: strip ANSI + control chars, normalize NBSP to space
  const stripped = raw
    .replace(ANSI_ESCAPE_RE, '')
    .replace(/[\x00-\x09\x0B-\x1F\x7F]/g, '')
    .replace(/\u00A0/g, ' ')  // TUI 用 NBSP 做空格，必须保留为空格

  // Phase 2: 找 ⏺/● 标记的响应段落（可能不在行首）
  // 噪音边界：\w+… (动画词如 Spinning…/Quantumizing…/Boondoggling…)、status bar 等
  const NOISE_BOUNDARY = /\w+…|∴\s*Thinking|running.?stop.?hooks|\[OMC[^\]]*\]|Worked for \d|max\/effort|❯|∴/
  const markerRe = /[⏺●]\s*/g
  const responseBlocks: string[] = []
  let match: RegExpExecArray | null

  while ((match = markerRe.exec(stripped)) !== null) {
    const afterMarker = stripped.slice(match.index + match[0].length)
    // 取到下一个噪音边界或末尾
    const boundaryMatch = NOISE_BOUNDARY.exec(afterMarker)
    const content = (boundaryMatch ? afterMarker.slice(0, boundaryMatch.index) : afterMarker)
      .replace(/[\u2500-\u259F\u23F5\u25C8\u276F]/g, '')  // 残留 TUI chrome
      .replace(/[\u2800-\u28FF✽✻✶✢]+/g, '')               // spinners
      .replace(/\n{3,}/g, '\n\n')
      .trim()
    if (content.length > 0) {
      responseBlocks.push(content)
    }
  }

  if (responseBlocks.length > 0) {
    return responseBlocks.join('\n\n').trim()
  }

  // Fallback: 无 ⏺ 标记时的正则清洗
  return stripped
    .replace(/[\u2500-\u259F\u23F5\u25C8\u276F\u2733]/g, '')  // TUI chrome (不含 NBSP!)
    .replace(/[\u2800-\u28FF✽✻✶✢·]+/g, '')                    // spinners
    .replace(/0;\s*[^\n]{0,50}(?:Claude Code|Hive[^\n]*)\s*/g, '')
    .replace(/(?:Claude\s*Code\s*v[\d.]+|Opus[\d.·\s]*|bypass\s*permissions?\s*on|shift\+tab\s*to\s*cycle|\d+\s*tokens?|max\s*[·/]\s*effort|\[OMC[^\]]*\][^\n]*|Boondoggling[^\n]*|Hive secretary[^\n]*|Spinning[^\n]*|∴\s*Thinking[^\n]*|Worked for[^\n]*|running stop hooks[^\n]*)/gi, '')
    .replace(/\d+;\d+[Hf]/g, '')
    .replace(/\[Hive[^\]]*\][^\n]*/g, '')
    .replace(/\d+s\)/g, '')
    .replace(/\(\s*\)/g, '')
    .replace(/^\d+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const getMessages = (workspaceId: string): SecretaryMessage[] => {
  if (!messageBuffers.has(workspaceId)) {
    messageBuffers.set(workspaceId, [])
  }
  return messageBuffers.get(workspaceId)!
}

export const pushSecretaryMessage = (
  workspaceId: string,
  role: 'user' | 'assistant' | 'system',
  content: string,
  actions?: SecretaryAction[]
): SecretaryMessage => {
  const messages = getMessages(workspaceId)
  const msg: SecretaryMessage = {
    id: crypto.randomUUID(),
    role,
    content,
    timestamp: Date.now(),
    ...(actions?.length ? { actions } : {}),
  }
  messages.push(msg)
  if (messages.length > MAX_MESSAGES) {
    messages.splice(0, messages.length - MAX_MESSAGES)
  }
  return msg
}

/**
 * 积压检测入口——由 task-service onChange 调用。
 * 当 open + proposed 任务数 >= 阈值且冷却期已过，自动推送系统消息。
 */
export const checkTaskBacklog = (
  workspaceId: string,
  openCount: number,
  proposedCount: number,
  workers: Array<{ name: string; status: string }>
) => {
  const total = openCount + proposedCount
  if (total < BACKLOG_THRESHOLD) return

  const now = Date.now()
  const lastAlert = lastBacklogAlertTime.get(workspaceId) ?? 0
  if (now - lastAlert < BACKLOG_COOLDOWN_MS) return

  lastBacklogAlertTime.set(workspaceId, now)

  const idleWorkers = workers.filter((w) => w.status === 'idle' || w.status === 'stopped')
  const actions: SecretaryAction[] = []

  if (idleWorkers.length > 0) {
    const firstIdle = idleWorkers[0]!
    actions.push({
      id: crypto.randomUUID(),
      label: `派单给 ${firstIdle.name}`,
      type: 'dispatch',
      payload: { worker_name: firstIdle.name },
    })
  }

  actions.push({
    id: crypto.randomUUID(),
    label: '查看任务列表',
    type: 'create_task',
    payload: { action: 'view_tasks' },
  })

  pushSecretaryMessage(
    workspaceId,
    'system',
    `⚠️ 任务积压提醒：当前有 ${openCount} 个待办 + ${proposedCount} 个待审议任务（共 ${total} 个）。` +
      (idleWorkers.length > 0
        ? `有 ${idleWorkers.length} 个空闲 worker 可用。`
        : '所有 worker 都在忙碌中。'),
    actions
  )
}

// ─── PTY 输出订阅 ────────────────────────────────────────────────────────

/**
 * 订阅 secretary PTY 输出，防抖后推入消息缓冲。
 * 幂等：对同一 workspace 重复调用会先取消旧订阅。
 *
 * 注意：Claude Code 的 PTY 输出包含 TUI 渲染噪音（banner、box drawing、
 * 注入的启动说明等）。这里做尽力过滤，但无法完美提取纯回复文本。
 * 长期方案应改用 session JSONL 解析。
 */
const subscribeSecretaryOutput = (workspaceId: string, runId: string, store: RuntimeStore) => {
  // 已有订阅先清理
  outputSubscriptions.get(workspaceId)?.()

  const chunks: string[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  let startupPhase = true // 跳过启动阶段输出（banner + 注入说明）
  let startupTimer: ReturnType<typeof setTimeout> | null = null

  // 启动阶段：前 3 秒的输出全部丢弃（仅 banner，因 secretary 已跳过启动注入）
  startupTimer = setTimeout(() => {
    startupPhase = false
    startupTimer = null
    // 丢弃启动阶段积累的 chunks
    chunks.splice(0)
  }, 3000)

  const flush = () => {
    timer = null
    if (chunks.length === 0) return
    if (startupPhase) {
      chunks.splice(0) // 启动阶段全部丢弃
      return
    }
    const raw = chunks.splice(0).join('')
    const clean = extractClaudeResponse(raw)
    if (clean.length > 0 && !isInputEcho(workspaceId, clean)) {
      pushSecretaryMessage(workspaceId, 'assistant', clean)
    }
  }

  const unsubscribe = store.getPtyOutputBus().subscribe(runId, (chunk: string) => {
    chunks.push(chunk)
    if (timer) clearTimeout(timer)
    timer = setTimeout(flush, OUTPUT_DEBOUNCE_MS)
  })

  outputSubscriptions.set(workspaceId, () => {
    unsubscribe()
    if (startupTimer) { clearTimeout(startupTimer); startupTimer = null }
    if (timer) { clearTimeout(timer); timer = null }
    startupPhase = false
    flush()
  })
}

// ─── 自动启动 + 订阅保证 ──────────────────────────────────────────────────

const getRuntimePort = (request: IncomingMessage) => String(request.socket.localPort ?? '')

/**
 * 确保 secretary 正在运行并已订阅输出。
 * 1. 如果已运行且已订阅 → 直接返回
 * 2. 如果已运行但未订阅（服务重启场景） → 补挂订阅
 * 3. 如果未运行 → seed launch config + start + 订阅
 */
const ensureSecretaryRunning = async (
  workspaceId: string,
  request: IncomingMessage,
  store: RuntimeStore
) => {
  const secretaryId = getSecretaryId(workspaceId)
  const activeRun = store.getActiveRunByAgentId(workspaceId, secretaryId)

  if (activeRun) {
    // 已运行但无订阅 → 补挂（服务重启后 outputSubscriptions map 被清空）
    if (!outputSubscriptions.has(workspaceId)) {
      subscribeSecretaryOutput(workspaceId, activeRun.runId, store)
    }
    return activeRun
  }

  // 确保有 launch config——优先从第一个 worker 复制（worker 才是 AI agent），
  // fallback 到 orchestrator 的 interactiveCommand
  if (!store.peekAgentLaunchConfig(workspaceId, secretaryId)) {
    const workers = store.listWorkers(workspaceId)
    let sourceConfig: ReturnType<typeof store.peekAgentLaunchConfig> | undefined
    for (const worker of workers) {
      sourceConfig = store.peekAgentLaunchConfig(workspaceId, worker.id)
      if (sourceConfig) break
    }
    if (!sourceConfig) {
      const orchId = `${workspaceId}:orchestrator`
      const orchConfig = store.peekAgentLaunchConfig(workspaceId, orchId)
      if (!orchConfig) return undefined
      // orchestrator 可能是 shell（/bin/zsh），实际 AI 命令在 interactiveCommand
      sourceConfig = {
        ...orchConfig,
        command: orchConfig.interactiveCommand ?? orchConfig.command,
      }
    }
    store.configureAgentLaunch(workspaceId, secretaryId, {
      command: sourceConfig.command,
      args: sourceConfig.args ?? [],
      commandPresetId: sourceConfig.commandPresetId ?? null,
    })
  }

  try {
    const run = await store.startAgent(workspaceId, secretaryId, { hivePort: getRuntimePort(request) })
    subscribeSecretaryOutput(workspaceId, run.runId, store)
    return run
  } catch (error) {
    pushSecretaryMessage(
      workspaceId,
      'system',
      `⚠️ 董秘启动失败：${error instanceof Error ? error.message : String(error)}`
    )
    return undefined
  }
}

interface SendMessageBody {
  content: string
}

interface ExecuteActionBody {
  action_id: string
  /** 额外参数覆盖（如用户补充的 task title） */
  overrides?: Record<string, unknown>
}

export const secretaryRoutes: RouteDefinition[] = [
  route('GET', '/api/workspaces/:workspaceId/secretary/messages', async ({ params, response, store }) => {
    const workspaceId = params.workspaceId!
    store.getAgent(workspaceId, getSecretaryId(workspaceId))
    const messages = getMessages(workspaceId)
    sendJson(response, 200, { messages })
  }),

  route('POST', '/api/workspaces/:workspaceId/secretary/messages', async ({ params, request, response, store }) => {
    const workspaceId = params.workspaceId!
    const body = await readJsonBody<SendMessageBody>(request)

    if (!body.content || typeof body.content !== 'string') {
      throw new BadRequestError('Missing content')
    }

    const secretaryId = getSecretaryId(workspaceId)
    store.getAgent(workspaceId, secretaryId)

    const trimmedContent = body.content.trim()
    lastUserInputs.set(workspaceId, trimmedContent)
    const userMsg = pushSecretaryMessage(workspaceId, 'user', trimmedContent)

    // 自动启动 secretary（如果尚未运行）+ 确保输出已订阅
    const activeRun = await ensureSecretaryRunning(workspaceId, request, store)
    if (activeRun) {
      // 必须用 writeAgentStdin 走 postStartInputWriter：
      // 等待交互式 prompt ready → bracketed paste → submit
      // 直接 writeRunInput 会在 Claude Code TUI 未就绪时丢失输入
      store.writeAgentStdin(workspaceId, secretaryId, trimmedContent)
    }

    sendJson(response, 201, { message: userMsg, secretary_running: !!activeRun })
  }),

  route('POST', '/api/workspaces/:workspaceId/secretary/execute', async ({ params, request, response, store }) => {
    const workspaceId = params.workspaceId!
    const body = await readJsonBody<ExecuteActionBody>(request)

    if (!body.action_id || typeof body.action_id !== 'string') {
      throw new BadRequestError('Missing action_id')
    }

    // 在消息缓冲中找到对应 action
    const messages = getMessages(workspaceId)
    let foundAction: SecretaryAction | undefined
    for (const msg of messages) {
      if (!msg.actions) continue
      foundAction = msg.actions.find((a) => a.id === body.action_id)
      if (foundAction) break
    }

    if (!foundAction) {
      throw new BadRequestError('Action not found or expired')
    }

    // 根据 action type 执行
    let result: { ok: boolean; detail: string }

    switch (foundAction.type) {
      case 'create_task': {
        const title = (body.overrides?.title as string) || (foundAction.payload.title as string)
        if (title) {
          const task = store.taskService.createTask({
            workspaceId,
            title,
            source: 'secretary',
          })
          result = { ok: true, detail: `任务 #${task.seq} "${task.title}" 已创建` }
        } else {
          result = { ok: true, detail: '查看任务列表' }
        }
        break
      }
      case 'dispatch': {
        // dispatch 需要有 pending task 才能执行
        const tasks = store.taskService.listTasks(workspaceId, { status: 'open' })
        if (tasks.length === 0) {
          result = { ok: false, detail: '没有待办任务可派发' }
        } else {
          const firstTask = tasks[0]!
          result = {
            ok: true,
            detail: `建议将任务 #${firstTask.seq} "${firstTask.title}" 派给 ${foundAction.payload.worker_name}。请在 Orchestrator 中执行 team send。`,
          }
        }
        break
      }
      case 'start_discussion': {
        result = { ok: true, detail: '请在 Orchestrator 中发起讨论' }
        break
      }
      default: {
        result = { ok: false, detail: '未知动作类型' }
      }
    }

    // 记录执行结果为 system 消息
    pushSecretaryMessage(workspaceId, 'system', `✅ ${result.detail}`)

    sendJson(response, 200, result)
  }),

  route('DELETE', '/api/workspaces/:workspaceId/secretary/messages', async ({ params, response, store }) => {
    const workspaceId = params.workspaceId!
    store.getAgent(workspaceId, getSecretaryId(workspaceId))
    // 取消输出订阅
    outputSubscriptions.get(workspaceId)?.()
    outputSubscriptions.delete(workspaceId)
    messageBuffers.delete(workspaceId)
    sendJson(response, 200, { cleared: true })
  }),

  route('GET', '/api/workspaces/:workspaceId/secretary/status', async ({ params, response, store }) => {
    const workspaceId = params.workspaceId!
    const secretaryId = getSecretaryId(workspaceId)
    const agent = store.getAgent(workspaceId, secretaryId)
    const activeRun = store.getActiveRunByAgentId(workspaceId, secretaryId)
    sendJson(response, 200, {
      status: agent.status,
      running: !!activeRun,
      run_id: activeRun?.runId ?? null,
    })
  }),
]
