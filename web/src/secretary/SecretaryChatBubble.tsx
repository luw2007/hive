import { useCallback, useEffect, useRef, useState } from 'react'
import { MessageCircle, Send, X, Trash2, AlertTriangle, Plus } from 'lucide-react'
import type { TeamListItem } from '../../../src/shared/types.js'
import {
  clearSecretaryMessages,
  createTask,
  executeSecretaryAction,
  getSecretaryMessages,
  sendSecretaryMessage,
  type SecretaryAction,
  type SecretaryMessage,
} from '../api.js'
import { useI18n } from '../i18n.js'

interface SecretaryChatBubbleProps {
  workspaceId: string
  workers: TeamListItem[]
}

const POLL_INTERVAL_MS = 3000
const PANEL_BOUNDS_KEY = (workspaceId: string) => `secretary-panel-bounds-${workspaceId}`
const PANEL_MIN_W = 280
const PANEL_MIN_H = 300
const PANEL_MAX_W = 600
const PANEL_MAX_H = 800
const PANEL_DEFAULT_W = 320
const PANEL_DEFAULT_H = 480

interface PanelBounds {
  x: number
  y: number
  w: number
  h: number
}

function loadPanelBounds(workspaceId: string): PanelBounds | null {
  try {
    const raw = localStorage.getItem(PANEL_BOUNDS_KEY(workspaceId))
    if (raw) {
      const v = JSON.parse(raw) as PanelBounds
      if (
        typeof v.x === 'number' &&
        typeof v.y === 'number' &&
        typeof v.w === 'number' &&
        typeof v.h === 'number'
      )
        return v
    }
    // Lazy migration: read old shared key and migrate to per-workspace
    const legacy = localStorage.getItem('secretary-panel-bounds')
    if (legacy) {
      const v = JSON.parse(legacy) as PanelBounds
      if (
        typeof v.x === 'number' &&
        typeof v.y === 'number' &&
        typeof v.w === 'number' &&
        typeof v.h === 'number'
      ) {
        localStorage.setItem(PANEL_BOUNDS_KEY(workspaceId), legacy)
        localStorage.removeItem('secretary-panel-bounds')
        return v
      }
    }
  } catch {
    /* ignore */
  }
  return null
}

function savePanelBounds(workspaceId: string, b: PanelBounds) {
  try {
    localStorage.setItem(PANEL_BOUNDS_KEY(workspaceId), JSON.stringify(b))
  } catch {
    /* ignore */
  }
}

function clampBounds(b: PanelBounds): PanelBounds {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const w = Math.max(PANEL_MIN_W, Math.min(PANEL_MAX_W, b.w))
  const h = Math.max(PANEL_MIN_H, Math.min(PANEL_MAX_H, b.h))
  const x = Math.max(0, Math.min(b.x, vw - w))
  const y = Math.max(0, Math.min(b.y, vh - h))
  return { x, y, w, h }
}

function defaultBounds(): PanelBounds {
  const vw = window.innerWidth
  const vh = window.innerHeight
  return {
    x: vw - PANEL_DEFAULT_W - 24,
    y: vh - PANEL_DEFAULT_H - 80,
    w: PANEL_DEFAULT_W,
    h: PANEL_DEFAULT_H,
  }
}

function positionKey(workspaceId: string) {
  return `secretary_position_${workspaceId}`
}

type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se'

export const SecretaryChatBubble = ({ workspaceId, workers }: SecretaryChatBubbleProps) => {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<SecretaryMessage[]>([])
  const [input, setInput] = useState('')
  const [taskInput, setTaskInput] = useState('')
  const [taskAssignee, setTaskAssignee] = useState('')
  const [taskSubmitting, setTaskSubmitting] = useState(false)
  const [sending, setSending] = useState(false)
  const [executingAction, setExecutingAction] = useState<string | null>(null)
  const [hasUnread, setHasUnread] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const taskInputRef = useRef<HTMLInputElement>(null)
  const prevMessageCountRef = useRef(0)

  // Draggable FAB position state (persisted server-side per workspace)
  const [pos, setPos] = useState<{ x: number; y: number }>({ x: -1, y: -1 })
  const draggingRef = useRef(false)
  const dragStartRef = useRef({ mx: 0, my: 0, ox: 0, oy: 0 })
  const fabRef = useRef<HTMLButtonElement>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Panel bounds (independent from FAB)
  const [panelBounds, setPanelBounds] = useState<PanelBounds>(
    () => loadPanelBounds(workspaceId) ?? { x: -1, y: -1, w: PANEL_DEFAULT_W, h: PANEL_DEFAULT_H }
  )
  const panelRef = useRef<HTMLDivElement>(null)
  const panelDragRef = useRef<{ active: boolean; mx: number; my: number; ox: number; oy: number }>({
    active: false,
    mx: 0,
    my: 0,
    ox: 0,
    oy: 0,
  })
  const resizeRef = useRef<{
    active: boolean
    edge: ResizeEdge
    mx: number
    my: number
    ox: number
    oy: number
    ow: number
    oh: number
  } | null>(null)

  // Initialize panel position on first open if not persisted
  useEffect(() => {
    if (open && panelBounds.x < 0) {
      setPanelBounds(defaultBounds())
    }
  }, [open, panelBounds.x])

  // Load position from server
  useEffect(() => {
    const key = positionKey(workspaceId)
    void fetch(`/api/settings/app-state/${key}`)
      .then(async (res) => {
        if (!res.ok) return
        const payload = (await res.json()) as {
          key: string
          value: { x: number; y: number } | null
        }
        if (
          payload.value &&
          typeof payload.value.x === 'number' &&
          typeof payload.value.y === 'number'
        ) {
          setPos(payload.value)
        }
      })
      .catch(() => {})
  }, [workspaceId])

  const persistPosition = useCallback(
    (p: { x: number; y: number }) => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      saveTimerRef.current = setTimeout(() => {
        const key = positionKey(workspaceId)
        void fetch(`/api/settings/app-state/${key}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ value: p }),
        }).catch(() => {})
      }, 300)
    },
    [workspaceId]
  )

  // FAB drag handlers
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    draggingRef.current = false
    const fab = fabRef.current
    if (!fab) return
    const rect = fab.getBoundingClientRect()
    dragStartRef.current = { mx: e.clientX, my: e.clientY, ox: rect.left, oy: rect.top }
    fab.setPointerCapture(e.pointerId)
  }, [])

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const fab = fabRef.current
    if (!fab || !fab.hasPointerCapture(e.pointerId)) return
    const dx = e.clientX - dragStartRef.current.mx
    const dy = e.clientY - dragStartRef.current.my
    if (!draggingRef.current && Math.abs(dx) + Math.abs(dy) > 5) {
      draggingRef.current = true
    }
    if (draggingRef.current) {
      const nx = dragStartRef.current.ox + dx
      const ny = dragStartRef.current.oy + dy
      setPos({ x: nx, y: ny })
    }
  }, [])

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      const fab = fabRef.current
      if (!fab) return
      fab.releasePointerCapture(e.pointerId)
      if (draggingRef.current) {
        draggingRef.current = false
        const vw = window.innerWidth
        const vh = window.innerHeight
        const clampedX = Math.max(0, Math.min(pos.x, vw - 48))
        const clampedY = Math.max(0, Math.min(pos.y, vh - 48))
        const finalPos = { x: clampedX, y: clampedY }
        setPos(finalPos)
        persistPosition(finalPos)
      } else {
        setOpen((v) => !v)
      }
    },
    [pos, persistPosition]
  )

  // Panel header drag handlers
  const onPanelHeaderPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault()
      const panel = panelRef.current
      if (!panel) return
      panelDragRef.current = {
        active: true,
        mx: e.clientX,
        my: e.clientY,
        ox: panelBounds.x,
        oy: panelBounds.y,
      }
      panel.setPointerCapture(e.pointerId)
    },
    [panelBounds.x, panelBounds.y]
  )

  const onPanelPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const panel = panelRef.current
    if (!panel || !panel.hasPointerCapture(e.pointerId)) return

    if (resizeRef.current?.active) {
      const r = resizeRef.current
      const dx = e.clientX - r.mx
      const dy = e.clientY - r.my
      let { ox: x, oy: y, ow: w, oh: h } = r
      const edge = r.edge
      if (edge.includes('e')) w = r.ow + dx
      if (edge.includes('s')) h = r.oh + dy
      if (edge.includes('w')) {
        w = r.ow - dx
        x = r.ox + dx
      }
      if (edge.includes('n')) {
        h = r.oh - dy
        y = r.oy + dy
      }
      setPanelBounds(clampBounds({ x, y, w, h }))
      return
    }

    if (panelDragRef.current.active) {
      const dx = e.clientX - panelDragRef.current.mx
      const dy = e.clientY - panelDragRef.current.my
      const nx = panelDragRef.current.ox + dx
      const ny = panelDragRef.current.oy + dy
      setPanelBounds((prev) => clampBounds({ ...prev, x: nx, y: ny }))
    }
  }, [])

  const onPanelPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const panel = panelRef.current
    if (!panel) return
    panel.releasePointerCapture(e.pointerId)
    if (resizeRef.current?.active || panelDragRef.current.active) {
      panelDragRef.current.active = false
      if (resizeRef.current) resizeRef.current.active = false
      setPanelBounds((prev) => {
        const clamped = clampBounds(prev)
        savePanelBounds(workspaceId, clamped)
        return clamped
      })
    }
  }, [])

  const onResizeHandlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, edge: ResizeEdge) => {
      e.preventDefault()
      e.stopPropagation()
      const panel = panelRef.current
      if (!panel) return
      resizeRef.current = {
        active: true,
        edge,
        mx: e.clientX,
        my: e.clientY,
        ox: panelBounds.x,
        oy: panelBounds.y,
        ow: panelBounds.w,
        oh: panelBounds.h,
      }
      panel.setPointerCapture(e.pointerId)
    },
    [panelBounds]
  )

  // Ctrl+Shift+T shortcut: open panel and focus task input
  useEffect(() => {
    let tid: ReturnType<typeof setTimeout> | null = null
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key === 'T') {
        e.preventDefault()
        setOpen(true)
        tid = setTimeout(() => taskInputRef.current?.focus(), 100)
      }
    }
    window.addEventListener('keydown', handler)
    return () => {
      window.removeEventListener('keydown', handler)
      if (tid !== null) clearTimeout(tid)
    }
  }, [])

  const fetchMessages = useCallback(async () => {
    try {
      const msgs = await getSecretaryMessages(workspaceId)
      if (!open && msgs.length > prevMessageCountRef.current) {
        setHasUnread(true)
      }
      prevMessageCountRef.current = msgs.length
      setMessages(msgs)
    } catch {
      // silent
    }
  }, [workspaceId, open])

  // 始终轮询（即使面板关闭——需要检测积压通知）
  useEffect(() => {
    fetchMessages()
    const interval = setInterval(fetchMessages, POLL_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [fetchMessages])

  // 打开时清除未读
  useEffect(() => {
    if (open) {
      setHasUnread(false)
      setTimeout(() => inputRef.current?.focus(), 100)
    }
  }, [open])

  // 自动滚到底
  useEffect(() => {
    if (open) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages, open])

  const handleSend = async () => {
    const text = input.trim()
    if (!text || sending) return

    setSending(true)
    setInput('')
    try {
      const { message } = await sendSecretaryMessage(workspaceId, text)
      setMessages((prev) => [...prev, message])
    } catch {
      setInput(text)
    } finally {
      setSending(false)
    }
  }

  const handleCreateTask = async () => {
    const text = taskInput.trim()
    if (!text || taskSubmitting) return
    setTaskSubmitting(true)
    try {
      await createTask({
        workspace_id: workspaceId,
        title: text,
        source: 'user',
        ...(taskAssignee ? { worker_name: taskAssignee } : {}),
      })
      setTaskInput('')
      setTaskAssignee('')
    } catch {
      /* silent */
    } finally {
      setTaskSubmitting(false)
    }
  }

  const handleTaskKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void handleCreateTask()
    }
  }

  const handleClear = async () => {
    try {
      await clearSecretaryMessages(workspaceId)
      setMessages([])
    } catch {
      // 静默
    }
  }

  const handleExecuteAction = async (action: SecretaryAction) => {
    if (executingAction) return
    setExecutingAction(action.id)
    try {
      await executeSecretaryAction(workspaceId, action.id)
      // 重新加载消息以显示执行结果
      await fetchMessages()
    } catch {
      // 静默
    } finally {
      setExecutingAction(null)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  // Compute FAB style: use saved position or default (right:24, bottom:24)
  const fabStyle: React.CSSProperties =
    pos.x >= 0 ? { position: 'fixed', left: pos.x, top: pos.y, right: 'auto', bottom: 'auto' } : {}

  // Panel uses its own bounds (independent of FAB)
  const panelStyle: React.CSSProperties =
    panelBounds.x >= 0
      ? {
          position: 'fixed',
          left: panelBounds.x,
          top: panelBounds.y,
          width: panelBounds.w,
          height: panelBounds.h,
          right: 'auto',
          bottom: 'auto',
        }
      : { width: panelBounds.w, height: panelBounds.h }

  const activeWorkers = workers.filter((w) => w.status !== 'stopped')

  return (
    <>
      {/* FAB Bubble — draggable */}
      <button
        ref={fabRef}
        className="secretary-chat-fab"
        style={fabStyle}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        title={t('secretary.title')}
        type="button"
      >
        {open ? <X size={22} /> : <MessageCircle size={22} />}
        {hasUnread && !open && <span className="secretary-chat-badge" />}
      </button>

      {/* Chat Panel */}
      {open && (
        <div
          ref={panelRef}
          className="secretary-chat-panel"
          style={panelStyle}
          onPointerMove={onPanelPointerMove}
          onPointerUp={onPanelPointerUp}
        >
          {/* Resize handles */}
          {(['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se'] as ResizeEdge[]).map((edge) => (
            <div
              key={edge}
              className={`secretary-resize-handle secretary-resize-${edge}`}
              onPointerDown={(e) => onResizeHandlePointerDown(e, edge)}
            />
          ))}

          {/* Header — drag to move */}
          <div
            className="secretary-chat-header secretary-chat-header-draggable"
            onPointerDown={onPanelHeaderPointerDown}
          >
            <span className="secretary-chat-title">{t('secretary.title')}</span>
            <button
              className="secretary-chat-clear"
              onClick={handleClear}
              title={t('secretary.clear')}
              type="button"
            >
              <Trash2 size={14} />
            </button>
          </div>

          {/* Quick task creation input */}
          <div className="secretary-task-input-area">
            <Plus size={14} className="secretary-task-icon" />
            <input
              ref={taskInputRef}
              className="secretary-task-input"
              disabled={taskSubmitting}
              onKeyDown={handleTaskKeyDown}
              onChange={(e) => setTaskInput(e.target.value)}
              placeholder={t('secretary.taskPlaceholder')}
              type="text"
              value={taskInput}
            />
            {activeWorkers.length > 0 && (
              <select
                className="secretary-task-assignee"
                value={taskAssignee}
                onChange={(e) => setTaskAssignee(e.target.value)}
                disabled={taskSubmitting}
              >
                <option value="">{t('quickTask.noAssignee')}</option>
                {activeWorkers.map((w) => (
                  <option key={w.id} value={w.name}>
                    {w.name}
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* Messages */}
          <div className="secretary-chat-messages">
            {messages.length === 0 && (
              <div className="secretary-chat-empty">
                {t('secretary.empty')
                  .split('\n')
                  .map((line, i) => (
                    <span key={i}>
                      {line}
                      {i === 0 && <br />}
                    </span>
                  ))}
              </div>
            )}
            {messages.map((msg) => (
              <div key={msg.id} className={`secretary-chat-msg secretary-chat-msg-${msg.role}`}>
                {msg.role === 'system' && (
                  <AlertTriangle size={14} className="secretary-chat-msg-icon" />
                )}
                <div className="secretary-chat-msg-content">{msg.content}</div>
                {msg.actions && msg.actions.length > 0 && (
                  <div className="secretary-chat-actions">
                    {msg.actions.map((action) => (
                      <button
                        key={action.id}
                        className="secretary-chat-action-btn"
                        disabled={executingAction === action.id}
                        onClick={() => handleExecuteAction(action)}
                        type="button"
                      >
                        {executingAction === action.id ? '...' : action.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div className="secretary-chat-input-area">
            <input
              ref={inputRef}
              className="secretary-chat-input"
              disabled={sending}
              onKeyDown={handleKeyDown}
              onChange={(e) => setInput(e.target.value)}
              placeholder={t('secretary.placeholder')}
              type="text"
              value={input}
            />
            <button
              className="secretary-chat-send"
              disabled={!input.trim() || sending}
              onClick={handleSend}
              type="button"
            >
              <Send size={16} />
            </button>
          </div>
        </div>
      )}
    </>
  )
}
