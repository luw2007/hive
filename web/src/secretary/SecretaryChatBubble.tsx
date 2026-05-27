import { useCallback, useEffect, useRef, useState } from 'react'
import { MessageCircle, Send, X, Trash2, AlertTriangle, Plus } from 'lucide-react'
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
}

const POLL_INTERVAL_MS = 3000

function positionKey(workspaceId: string) {
  return `secretary_position_${workspaceId}`
}

export const SecretaryChatBubble = ({ workspaceId }: SecretaryChatBubbleProps) => {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<SecretaryMessage[]>([])
  const [input, setInput] = useState('')
  const [taskInput, setTaskInput] = useState('')
  const [taskSubmitting, setTaskSubmitting] = useState(false)
  const [sending, setSending] = useState(false)
  const [executingAction, setExecutingAction] = useState<string | null>(null)
  const [hasUnread, setHasUnread] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const prevMessageCountRef = useRef(0)

  // Draggable position state (persisted server-side per workspace)
  const [pos, setPos] = useState<{ x: number; y: number }>({ x: -1, y: -1 })
  const draggingRef = useRef(false)
  const dragStartRef = useRef({ mx: 0, my: 0, ox: 0, oy: 0 })
  const fabRef = useRef<HTMLButtonElement>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Load position from server
  useEffect(() => {
    const key = positionKey(workspaceId)
    void fetch(`/api/settings/app-state/${key}`).then(async (res) => {
      if (!res.ok) return
      const payload = (await res.json()) as { key: string; value: { x: number; y: number } | null }
      if (payload.value && typeof payload.value.x === 'number' && typeof payload.value.y === 'number') {
        setPos(payload.value)
      }
    }).catch(() => {})
  }, [workspaceId])

  const persistPosition = useCallback((p: { x: number; y: number }) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      const key = positionKey(workspaceId)
      void fetch(`/api/settings/app-state/${key}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value: p }),
      }).catch(() => {})
    }, 300)
  }, [workspaceId])

  // Drag handlers
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

  const onPointerUp = useCallback((e: React.PointerEvent) => {
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
  }, [pos, persistPosition])

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
      await createTask({ workspace_id: workspaceId, title: text, source: 'user' })
      setTaskInput('')
    } catch { /* silent */ }
    finally { setTaskSubmitting(false) }
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

  // Compute FAB style: use saved position or default (right:24, bottom:96)
  const fabStyle: React.CSSProperties = pos.x >= 0
    ? { position: 'fixed', left: pos.x, top: pos.y, right: 'auto', bottom: 'auto' }
    : {}

  // Panel position follows FAB
  const panelStyle: React.CSSProperties = pos.x >= 0
    ? { position: 'fixed', left: pos.x - 272, top: pos.y - 432, right: 'auto', bottom: 'auto' }
    : {}

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
        <div className="secretary-chat-panel" style={panelStyle}>
          {/* Header */}
          <div className="secretary-chat-header">
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
              className="secretary-task-input"
              disabled={taskSubmitting}
              onKeyDown={handleTaskKeyDown}
              onChange={(e) => setTaskInput(e.target.value)}
              placeholder={t('secretary.taskPlaceholder')}
              type="text"
              value={taskInput}
            />
          </div>

          {/* Messages */}
          <div className="secretary-chat-messages">
            {messages.length === 0 && (
              <div className="secretary-chat-empty">{t('secretary.empty')}</div>
            )}
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`secretary-chat-msg secretary-chat-msg-${msg.role}`}
              >
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
