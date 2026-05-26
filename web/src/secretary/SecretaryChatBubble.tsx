import { useCallback, useEffect, useRef, useState } from 'react'
import { MessageCircle, Send, X, Trash2, AlertTriangle } from 'lucide-react'
import {
  clearSecretaryMessages,
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

export const SecretaryChatBubble = ({ workspaceId }: SecretaryChatBubbleProps) => {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<SecretaryMessage[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [executingAction, setExecutingAction] = useState<string | null>(null)
  const [hasUnread, setHasUnread] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const prevMessageCountRef = useRef(0)

  const fetchMessages = useCallback(async () => {
    try {
      const msgs = await getSecretaryMessages(workspaceId)
      // 检测新消息（未打开时标记未读）
      if (!open && msgs.length > prevMessageCountRef.current) {
        setHasUnread(true)
      }
      prevMessageCountRef.current = msgs.length
      setMessages(msgs)
    } catch {
      // 静默忽略轮询错误
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

  return (
    <>
      {/* FAB Bubble */}
      <button
        className="secretary-chat-fab"
        onClick={() => setOpen((v) => !v)}
        title={t('secretary.title')}
        type="button"
      >
        {open ? <X size={22} /> : <MessageCircle size={22} />}
        {hasUnread && !open && <span className="secretary-chat-badge" />}
      </button>

      {/* Chat Panel */}
      {open && (
        <div className="secretary-chat-panel">
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
