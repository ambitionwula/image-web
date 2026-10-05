import React, { useEffect, useMemo, useState } from 'react'

async function request(url, options = {}) {
  const response = await fetch(url, { ...options, headers: options.body ? { 'Content-Type': 'application/json', ...(options.headers || {}) } : options.headers })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data?.error?.message || `请求失败（${response.status}）`)
  return data
}

export function AnnouncementBanner() {
  const [items, setItems] = useState([])
  const [open, setOpen] = useState(false)
  useEffect(() => { request('/api/announcements').then(data => setItems(data.announcements || [])).catch(() => {}) }, [])
  const latest = items[0]
  if (!latest) return null
  return <>
    <button className="announcement-banner" type="button" onClick={() => setOpen(true)}><span>📣</span><b>公告</b><strong>{latest.title}</strong><small>{new Date(latest.createdAt).toLocaleDateString('zh-CN')}</small><i>查看全部 →</i></button>
    {open && <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && setOpen(false)}><div className="modal announcements-modal"><div className="modal-head"><div><span>ANNOUNCEMENTS</span><h2>站内公告</h2></div><button onClick={() => setOpen(false)}>×</button></div><div className="announcement-list">{items.map(item => <article key={item.id}><div><b>{item.title}</b><small>{new Date(item.createdAt).toLocaleString('zh-CN')}</small></div><p>{item.content}</p></article>)}</div></div></div>}
  </>
}

export default function SupportCenter({ isAdmin, onClose }) {
  const [tickets, setTickets] = useState([])
  const [selectedId, setSelectedId] = useState('')
  const [subject, setSubject] = useState('')
  const [message, setMessage] = useState('')
  const [reply, setReply] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  async function load() {
    setLoading(true); setError('')
    try { const data = await request(isAdmin ? '/api/admin/support/tickets' : '/api/support/tickets'); setTickets(data.tickets || []) }
    catch (e) { setError(e.message) } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [isAdmin])
  const selected = useMemo(() => tickets.find(item => item.id === selectedId) || tickets[0], [tickets, selectedId])

  async function createTicket(e) {
    e.preventDefault(); setError('')
    try { const data = await request('/api/support/tickets', { method: 'POST', body: JSON.stringify({ subject, message }) }); setTickets(current => [data.ticket, ...current]); setSelectedId(data.ticket.id); setSubject(''); setMessage('') }
    catch (e) { setError(e.message) }
  }
  async function sendMessage(e) {
    e.preventDefault(); if (!selected || !reply.trim()) return
    try { const url = isAdmin ? `/api/admin/support/tickets/${selected.id}/messages` : `/api/support/tickets/${selected.id}/messages`; const data = await request(url, { method: 'POST', body: JSON.stringify({ message: reply }) }); setTickets(current => current.map(item => item.id === selected.id ? data.ticket : item)); setReply('') }
    catch (e) { setError(e.message) }
  }
  async function setStatus(status) {
    try { const data = await request(`/api/admin/support/tickets/${selected.id}`, { method: 'PATCH', body: JSON.stringify({ status }) }); setTickets(current => current.map(item => item.id === selected.id ? data.ticket : item)) }
    catch (e) { setError(e.message) }
  }

  return <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && onClose()}><div className="modal support-modal">
    <div className="modal-head"><div><span>{isAdmin ? 'SUPPORT ADMIN' : 'CUSTOMER SERVICE'}</span><h2>{isAdmin ? '客服工单' : '联系客服'}</h2></div><button onClick={onClose}>×</button></div>
    {error && <div className="support-error">{error}</div>}
    {!isAdmin && <form className="support-new" onSubmit={createTicket}><b>提交新问题</b><input value={subject} onChange={e => setSubject(e.target.value)} placeholder="问题标题" /><textarea value={message} onChange={e => setMessage(e.target.value)} placeholder="请描述你遇到的问题、订单号或需要协助的内容" /><button className="save">提交工单</button></form>}
    <div className="support-layout"><div className="support-ticket-list">{loading ? <div className="support-empty">正在加载…</div> : tickets.length === 0 ? <div className="support-empty">暂无工单</div> : tickets.map(ticket => <button type="button" className={selected?.id === ticket.id ? 'active' : ''} key={ticket.id} onClick={() => setSelectedId(ticket.id)}><b>{ticket.subject}</b><small>{isAdmin && ticket.user ? `${ticket.user.displayName} · ` : ''}{ticket.status === 'closed' ? '已关闭' : ticket.status === 'replied' ? '客服已回复' : '处理中'}</small></button>)}</div>
      <div className="support-thread">{selected ? <><div className="support-thread-head"><b>{selected.subject}</b>{isAdmin && <select value={selected.status} onChange={e => setStatus(e.target.value)}><option value="open">处理中</option><option value="replied">已回复</option><option value="closed">已关闭</option></select>}</div><div className="support-messages">{(selected.messages || []).map(item => <div className={`support-message ${item.from}`} key={item.id}><span>{item.from === 'admin' ? '客服' : '我'}</span><p>{item.content}</p><small>{new Date(item.createdAt).toLocaleString('zh-CN')}</small></div>)}</div><form className="support-reply" onSubmit={sendMessage}><textarea value={reply} onChange={e => setReply(e.target.value)} placeholder={isAdmin ? '回复用户…' : '继续补充问题…'} /><button className="save">发送</button></form></> : <div className="support-empty">选择一个工单开始沟通</div>}</div>
    </div>
  </div></div>
}

export function AnnouncementManagement({ onClose }) {
  const [items, setItems] = useState([])
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [editingId, setEditingId] = useState('')
  const [error, setError] = useState('')
  useEffect(() => { request('/api/admin/announcements').then(data => setItems(data.announcements || [])).catch(e => setError(e.message)) }, [])
  async function save(e) {
    e.preventDefault(); setError('')
    try {
      const data = await request(editingId ? `/api/admin/announcements/${editingId}` : '/api/admin/announcements', { method: editingId ? 'PATCH' : 'POST', body: JSON.stringify({ title, content }) })
      setItems(old => editingId ? old.map(item => item.id === editingId ? data.announcement : item) : [data.announcement, ...old])
      setTitle(''); setContent(''); setEditingId('')
    } catch (e) { setError(e.message) }
  }
  async function toggle(item) {
    try { const data = await request(`/api/admin/announcements/${item.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: item.enabled === false }) }); setItems(old => old.map(entry => entry.id === item.id ? data.announcement : entry)) }
    catch (e) { setError(e.message) }
  }
  async function remove(item) {
    if (!window.confirm(`删除公告“${item.title}”？`)) return
    try { await request(`/api/admin/announcements/${item.id}`, { method: 'DELETE' }); setItems(old => old.filter(entry => entry.id !== item.id)) }
    catch (e) { setError(e.message) }
  }
  return <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && onClose()}><div className="modal announcements-modal"><div className="modal-head"><div><span>ANNOUNCEMENT ADMIN</span><h2>公告管理</h2></div><button onClick={onClose}>×</button></div>
    {error && <div className="support-error">{error}</div>}
    <form className="announcement-form" onSubmit={save}><input value={title} onChange={e => setTitle(e.target.value)} placeholder="公告标题" /><textarea value={content} onChange={e => setContent(e.target.value)} placeholder="公告内容" /><div><button className="save">{editingId ? '保存修改' : '发布公告'}</button>{editingId && <button type="button" onClick={() => { setEditingId(''); setTitle(''); setContent('') }}>取消编辑</button>}</div></form>
    <div className="announcement-admin-list">{items.length === 0 ? <p>暂无公告</p> : items.map(item => <article key={item.id}><div><b>{item.title}</b><small>{new Date(item.createdAt).toLocaleString('zh-CN')} · {item.enabled === false ? '已隐藏' : '展示中'}</small></div><p>{item.content}</p><footer><button onClick={() => { setEditingId(item.id); setTitle(item.title); setContent(item.content) }}>编辑</button><button onClick={() => toggle(item)}>{item.enabled === false ? '显示' : '隐藏'}</button><button onClick={() => remove(item)}>删除</button></footer></article>)}</div>
  </div></div>
}
