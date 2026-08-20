import React, { useEffect, useRef, useState } from 'react'

const welcome = { role: 'assistant', content: '你好，我是你的 AI 创作助手。你可以和我讨论创意、文案、商品策划，或者任何想了解的问题。' }

export default function ChatPanel({ headers, model, configured, onOpenSettings }) {
  const [messages, setMessages] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('image-studio-chat') || 'null')
      return Array.isArray(saved) && saved.every(item => item && typeof item.content === 'string') ? saved : [welcome]
    }
    catch { return [welcome] }
  })
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const bottomRef = useRef(null)

  useEffect(() => {
    try { localStorage.setItem('image-studio-chat', JSON.stringify(messages)) } catch {}
  }, [messages])
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, sending])

  async function send() {
    const content = input.trim()
    if (!content || sending) return
    if (!configured) {
      setError(onOpenSettings ? '请先完成接口设置' : '管理员尚未完成接口设置，请联系管理员')
      onOpenSettings?.()
      return
    }
    const userMessage = { role: 'user', content }
    const context = [...messages.filter(item => item !== welcome), userMessage].slice(-30)
    setMessages(old => [...old, userMessage])
    setInput(''); setSending(true); setError('')
    try {
      const response = await fetch('/api/chat', {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages: context }),
      })
      const text = await response.text()
      let data
      try { data = JSON.parse(text) } catch { throw new Error(`接口返回格式异常（HTTP ${response.status}）`) }
      if (!response.ok) throw new Error(data?.error?.message || 'AI 回复失败')
      setMessages(old => [...old, { role: 'assistant', content: data.content, model: data.model }])
    } catch (e) {
      setError(e.message)
    } finally {
      setSending(false)
    }
  }

  function clearChat() {
    if (window.confirm('确定清空当前对话吗？')) { setMessages([welcome]); setError('') }
  }

  return <div className="chat-panel">
    <div className="chat-head">
      <div><span>AI CONVERSATION</span><h2>和 AI 聊一聊</h2><p>支持连续对话，AI 会结合当前会话的上下文进行回复。</p></div>
      <div className="chat-head-actions"><button onClick={clearChat}>清空对话</button></div>
    </div>
    <div className="chat-messages">
      {messages.map((message, index) => <div className={`chat-message ${message.role}`} key={index}>
        <div className="chat-avatar">{message.role === 'assistant' ? 'AI' : '你'}</div>
        <div className="chat-bubble"><div>{message.content}</div>{message.role === 'assistant' && <button onClick={() => navigator.clipboard?.writeText(message.content)}>复制</button>}</div>
      </div>)}
      {sending && <div className="chat-message assistant"><div className="chat-avatar">AI</div><div className="chat-bubble chat-typing"><i/><i/><i/></div></div>}
      <div ref={bottomRef} />
    </div>
    {error && <div className="chat-error">{error}</div>}
    <div className="chat-composer">
      <textarea value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }} placeholder="输入消息，按 Enter 发送，Shift + Enter 换行…" />
      <div><small>AI 生成的内容可能存在误差，请核对重要信息。</small><button disabled={sending || !input.trim()} onClick={send}>{sending ? '回复中…' : '发送 ↑'}</button></div>
    </div>
  </div>
}
