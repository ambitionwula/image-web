import React, { useEffect, useState } from 'react'

const accountUsernamePattern = /^[A-Za-z0-9]{10,40}$/
const accountUsernameHint = '账号只能使用英文和数字，长度必须大于 9 位'

function normalizeAccountUsername(value) {
  return value.replace(/[^A-Za-z0-9]/g, '').slice(0, 40)
}

async function apiRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: options.body ? { 'Content-Type': 'application/json', ...(options.headers || {}) } : options.headers,
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data?.error?.message || `请求失败（${response.status}）`)
  return data
}

export function AuthScreen({ needsSetup, onAuthenticated }) {
  const [authMode, setAuthMode] = useState('login')
  const [username, setUsername] = useState(needsSetup ? 'admin2026001' : '')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const isRegister = !needsSetup && authMode === 'register'

  async function submit(event) {
    event.preventDefault()
    if ((needsSetup || isRegister) && !accountUsernamePattern.test(username)) return setError(accountUsernameHint)
    if ((needsSetup || isRegister) && password !== confirmPassword) return setError('两次输入的密码不一致')
    setSubmitting(true)
    setError('')
    try {
      const data = await apiRequest(needsSetup ? '/api/auth/setup' : isRegister ? '/api/auth/register' : '/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password, displayName }),
      })
      onAuthenticated(data.user)
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setSubmitting(false)
    }
  }

  function switchMode(nextMode) {
    setAuthMode(nextMode)
    setUsername(nextMode === 'login' ? '' : '')
    setDisplayName('')
    setPassword('')
    setConfirmPassword('')
    setError('')
  }

  return <div className="auth-page">
    <div className="auth-brand"><div className="brand-mark">造</div><div><b>造像所</b><small>AI IMAGE LAB</small></div></div>
    <main className="auth-layout">
      <section className="auth-intro">
        <span>PRIVATE CREATIVE WORKSPACE</span>
        <h1>让每一次创作，<br/>都有清晰的权限。</h1>
        <p>管理员统一维护模型接口与用户账户，普通用户可自行注册后专注完成图片生成、编辑和电商创作。</p>
        <div className="auth-role-notes"><span><i>01</i>管理员配置接口</span><span><i>02</i>用户独立登录</span><span><i>03</i>普通用户自助注册</span></div>
      </section>

      <section className="auth-form-panel">
        <span>{needsSetup ? 'INITIAL ADMIN' : isRegister ? 'CREATE ACCOUNT' : 'WELCOME BACK'}</span>
        <h2>{needsSetup ? '创建首位管理员' : isRegister ? '注册账号' : '登录工作台'}</h2>
        <p>{needsSetup ? '这是首次运行。请先创建管理员账号。' : isRegister ? '注册普通用户账号后可立即进入工作台，管理员仍负责接口配置与用户管理。' : '管理员与普通用户使用同一个入口，登录后显示对应功能。'}</p>
        <form onSubmit={submit}>
          <label><span>用户名</span><input autoFocus={!needsSetup} autoComplete="username" value={username} onChange={event => setUsername(needsSetup || isRegister ? normalizeAccountUsername(event.target.value) : event.target.value)} placeholder={needsSetup || isRegister ? '例如：user2026001' : '请输入用户名'} /></label>
          {(needsSetup || isRegister) && <small className="auth-field-tip">{accountUsernameHint}</small>}
          {(needsSetup || isRegister) && <label><span>显示名称（可选）</span><input value={displayName} onChange={event => setDisplayName(event.target.value)} placeholder={needsSetup ? '例如：工作室管理员' : '例如：设计师小林'} /></label>}
          <label><span>密码</span><input type="password" autoComplete={needsSetup || isRegister ? 'new-password' : 'current-password'} value={password} onChange={event => setPassword(event.target.value)} placeholder="至少 8 位" /></label>
          {(needsSetup || isRegister) && <label><span>确认密码</span><input type="password" autoComplete="new-password" value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} placeholder="再次输入密码" /></label>}
          {error && <div className="auth-error">{error}</div>}
          <button className="auth-submit" disabled={submitting}>{submitting ? '正在处理…' : needsSetup ? '创建管理员并进入' : isRegister ? '注册并进入' : '登录'}</button>
        </form>
        {!needsSetup && <p className="auth-switch">
          {isRegister ? '已有账号？' : '还没有账号？'}
          <button type="button" onClick={() => switchMode(isRegister ? 'login' : 'register')}>{isRegister ? '返回登录' : '注册账号'}</button>
        </p>}
      </section>
    </main>
  </div>
}

export function AccountModal({ user, onClose, onLogout }) {
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState(null)

  async function changePassword(event) {
    event.preventDefault()
    if (newPassword !== confirmPassword) return setMessage({ ok: false, text: '两次输入的新密码不一致' })
    setSaving(true)
    setMessage(null)
    try {
      await apiRequest('/api/auth/password', {
        method: 'PUT',
        body: JSON.stringify({ currentPassword, newPassword }),
      })
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      setMessage({ ok: true, text: '密码已更新' })
    } catch (error) {
      setMessage({ ok: false, text: error.message })
    } finally {
      setSaving(false)
    }
  }

  async function logout() {
    try { await apiRequest('/api/auth/logout', { method: 'POST' }) } finally { onLogout() }
  }

  return <div className="modal-backdrop" onMouseDown={event => event.target === event.currentTarget && onClose()}>
    <div className="modal account-modal" role="dialog" aria-modal="true" aria-labelledby="account-title">
      <div className="modal-head"><div><span>ACCOUNT</span><h2 id="account-title">账户设置</h2></div><button aria-label="关闭账户设置" onClick={onClose}>×</button></div>
      <div className="account-identity"><div>{user.displayName.slice(0, 1).toUpperCase()}</div><span><b>{user.displayName}</b><small>@{user.username} · {user.role === 'admin' ? '管理员' : '普通用户'}</small></span></div>
      <form className="account-password" onSubmit={changePassword}>
        <h3>修改密码</h3>
        <label><span>当前密码</span><input type="password" autoComplete="current-password" value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} /></label>
        <label><span>新密码</span><input type="password" autoComplete="new-password" value={newPassword} onChange={event => setNewPassword(event.target.value)} placeholder="8 到 128 位" /></label>
        <label><span>确认新密码</span><input type="password" autoComplete="new-password" value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} /></label>
        {message && <div className={`account-message${message.ok ? ' success' : ''}`}>{message.text}</div>}
        <button className="save" disabled={saving}>{saving ? '保存中…' : '更新密码'}</button>
      </form>
      <button className="logout-button" onClick={logout}>退出登录</button>
    </div>
  </div>
}

export function UserManagementModal({ onClose }) {
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [form, setForm] = useState({ username: '', displayName: '', password: '', membershipLevel: 'normal', remark: '' })
  const [userSearch, setUserSearch] = useState('')
  const [userFilter, setUserFilter] = useState('all')
  const [creating, setCreating] = useState(false)
  const [resetUserId, setResetUserId] = useState('')
  const [resetPassword, setResetPassword] = useState('')
  const [editingUserId, setEditingUserId] = useState('')
  const [editForm, setEditForm] = useState({ membershipLevel: 'normal', remark: '', pointsDelta: '' })

  function membershipLabel(level) {
    if (level === 'svip') return 'SVIP'
    if (level === 'vip') return 'VIP'
    return '普通'
  }

  function formatPoints(value) {
    const points = Number(value) || 0
    return Number.isInteger(points) ? String(points) : points.toFixed(2).replace(/\.?0+$/, '')
  }

  const userStats = users.reduce((stats, user) => {
    const level = ['vip', 'svip'].includes(user.membershipLevel) ? user.membershipLevel : 'normal'
    stats[level] += 1
    return stats
  }, { normal: 0, vip: 0, svip: 0 })

  const filteredUsers = users.filter(user => {
    const level = ['vip', 'svip'].includes(user.membershipLevel) ? user.membershipLevel : 'normal'
    const matchesFilter = userFilter === 'all'
      || userFilter === level
      || (userFilter === 'enabled' && user.enabled)
      || (userFilter === 'disabled' && !user.enabled)
    const keyword = userSearch.trim().toLowerCase()
    const matchesSearch = !keyword || [user.username, user.displayName, user.remark].some(value => (value || '').toString().toLowerCase().includes(keyword))
    return matchesFilter && matchesSearch
  })

  async function loadUsers() {
    setLoading(true)
    setError('')
    try {
      const data = await apiRequest('/api/admin/users')
      setUsers(data.users || [])
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadUsers() }, [])

  async function createUser(event) {
    event.preventDefault()
    if (!accountUsernamePattern.test(form.username)) return setError(accountUsernameHint)
    setCreating(true)
    setError('')
    try {
      const data = await apiRequest('/api/admin/users', { method: 'POST', body: JSON.stringify(form) })
      setUsers(current => [...current, data.user])
      setForm({ username: '', displayName: '', password: '', membershipLevel: 'normal', remark: '' })
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setCreating(false)
    }
  }

  async function updateUser(user, patch) {
    setError('')
    try {
      const data = await apiRequest(`/api/admin/users/${user.id}`, { method: 'PATCH', body: JSON.stringify(patch) })
      setUsers(current => current.map(item => item.id === user.id ? data.user : item))
      setResetUserId('')
      setResetPassword('')
      setEditingUserId('')
    } catch (requestError) {
      setError(requestError.message)
    }
  }

  function startEdit(user) {
    setEditingUserId(user.id)
    setEditForm({ membershipLevel: user.membershipLevel || 'normal', remark: user.remark || '', pointsDelta: '' })
  }

  function saveUserEdit(user) {
    const deltaText = (editForm.pointsDelta || '').toString().trim()
    const delta = deltaText ? Number(deltaText) : 0
    if (deltaText && !Number.isFinite(delta)) return setError('积分调整必须填写数字，例如 100 或 -50')
    const nextBalance = Math.max(0, (Number(user.pointsBalance) || 0) + delta)
    updateUser(user, {
      membershipLevel: editForm.membershipLevel,
      remark: editForm.remark,
      ...(deltaText ? { pointsBalance: nextBalance } : {}),
    })
  }

  return <div className="modal-backdrop" onMouseDown={event => event.target === event.currentTarget && onClose()}>
    <div className="modal users-modal" role="dialog" aria-modal="true" aria-labelledby="users-title">
      <div className="modal-head"><div><span>USER ADMINISTRATION</span><h2 id="users-title">用户管理</h2></div><button aria-label="关闭用户管理" onClick={onClose}>×</button></div>
      <div className="users-overview">
        <div><span>{userStats.normal}</span><small>普通用户</small></div>
        <div><span>{userStats.vip}</span><small>VIP 用户</small></div>
        <div><span>{userStats.svip}</span><small>SVIP 用户</small></div>
      </div>

      <form className="create-user-form" onSubmit={createUser}>
        <div><b>添加普通用户</b><small>账号只能使用英文和数字，长度必须大于 9 位。</small></div>
        <label><span>用户名</span><input value={form.username} onChange={event => setForm(old => ({ ...old, username: normalizeAccountUsername(event.target.value) }))} placeholder="user2026001" /></label>
        <label><span>显示名称</span><input value={form.displayName} onChange={event => setForm(old => ({ ...old, displayName: event.target.value }))} placeholder="可选" /></label>
        <label><span>初始密码</span><input type="password" autoComplete="new-password" value={form.password} onChange={event => setForm(old => ({ ...old, password: event.target.value }))} placeholder="至少 8 位" /></label>
        <label><span>会员权限</span><select value={form.membershipLevel} onChange={event => setForm(old => ({ ...old, membershipLevel: event.target.value }))}><option value="normal">普通用户</option><option value="vip">VIP</option><option value="svip">SVIP</option></select></label>
        <label className="create-user-remark"><span>用户备注（仅管理员可见）</span><input value={form.remark} onChange={event => setForm(old => ({ ...old, remark: event.target.value }))} placeholder="例如：测试账号 / 客户来源 / 合作备注" /></label>
        <button className="save" disabled={creating}>{creating ? '创建中…' : '创建用户'}</button>
      </form>

      {error && <div className="users-error">{error}</div>}
      <div className="users-list-head"><b>普通用户</b><span>{filteredUsers.length} / {users.length} 个账户</span></div>
      <div className="users-toolbar">
        <input value={userSearch} onChange={event => setUserSearch(event.target.value)} placeholder="搜索用户名、显示名称或备注" />
        <select value={userFilter} onChange={event => setUserFilter(event.target.value)}>
          <option value="all">全部用户</option>
          <option value="normal">普通用户</option>
          <option value="vip">VIP 用户</option>
          <option value="svip">SVIP 用户</option>
          <option value="enabled">已启用</option>
          <option value="disabled">已停用</option>
        </select>
      </div>
      <div className="users-list">
        {loading ? <div className="users-empty">正在加载用户…</div> : users.length === 0 ? <div className="users-empty">还没有普通用户</div> : filteredUsers.length === 0 ? <div className="users-empty">没有匹配的用户</div> : filteredUsers.map(user => <div className={`user-row${user.enabled ? '' : ' disabled'}`} key={user.id}>
          <div className="user-avatar">{user.displayName.slice(0, 1).toUpperCase()}</div>
          <div className="user-info"><b>{user.displayName}</b><small>@{user.username} · 创建于 {new Date(user.createdAt).toLocaleDateString('zh-CN')}</small>{user.remark && <em>备注：{user.remark}</em>}</div>
          <span className="user-points"><b>{formatPoints(user.pointsBalance)}</b><small>积分</small></span>
          <span className={`user-membership ${user.membershipLevel || 'normal'}`}>{membershipLabel(user.membershipLevel)}</span>
          <span className={`user-status${user.enabled ? '' : ' off'}`}>{user.enabled ? '已启用' : '已停用'}</span>
          <button className="user-action" onClick={() => startEdit(user)}>权限/备注</button>
          <button className="user-action" onClick={() => { setResetUserId(user.id); setResetPassword('') }}>重置密码</button>
          <button className={`user-toggle${user.enabled ? '' : ' enable'}`} onClick={() => updateUser(user, { enabled: !user.enabled })}>{user.enabled ? '停用' : '启用'}</button>
          {editingUserId === user.id && <div className="user-edit-panel">
            <label><span>会员权限</span><select value={editForm.membershipLevel} onChange={event => setEditForm(old => ({ ...old, membershipLevel: event.target.value }))}><option value="normal">普通用户</option><option value="vip">VIP</option><option value="svip">SVIP</option></select></label>
            <label><span>当前积分</span><input disabled value={`${formatPoints(user.pointsBalance)} 分`} /></label>
            <label><span>加减积分</span><input type="number" step="0.01" value={editForm.pointsDelta} onChange={event => setEditForm(old => ({ ...old, pointsDelta: event.target.value }))} placeholder="例如：100 或 -50" /></label>
            <label className="user-edit-remark"><span>用户备注（仅管理员可见）</span><textarea value={editForm.remark} onChange={event => setEditForm(old => ({ ...old, remark: event.target.value }))} placeholder="普通用户端不会看到这条备注" /></label>
            <div className="user-edit-actions"><button className="save" onClick={() => saveUserEdit(user)}>保存</button><button onClick={() => setEditingUserId('')}>取消</button></div>
          </div>}
          {resetUserId === user.id && <div className="user-reset"><input autoFocus type="password" autoComplete="new-password" value={resetPassword} onChange={event => setResetPassword(event.target.value)} placeholder="输入新密码（至少 8 位）" /><button className="save" disabled={resetPassword.length < 8} onClick={() => updateUser(user, { password: resetPassword })}>确认重置</button><button onClick={() => setResetUserId('')}>取消</button></div>}
        </div>)}
      </div>
    </div>
  </div>
}

export function OrderManagementModal({ onClose }) {
  const [rechargeOrders, setRechargeOrders] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [orderConfirm, setOrderConfirm] = useState({})
  const [orderProcessing, setOrderProcessing] = useState('')

  function formatPoints(value) {
    const points = Number(value) || 0
    return Number.isInteger(points) ? String(points) : points.toFixed(2).replace(/\.?0+$/, '')
  }

  async function loadRechargeOrders() {
    setLoading(true)
    setError('')
    try {
      const data = await apiRequest('/api/admin/recharge-orders')
      setRechargeOrders(data.orders || [])
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadRechargeOrders() }, [])

  function orderStatusLabel(status) {
    if (status === 'success') return '已到账'
    if (status === 'pending') return '待支付/待回调'
    if (status === 'canceled') return '已取消'
    if (status === 'failed') return '失败'
    return status || '未知'
  }

  function orderTitle(order) {
    if (order.kind === 'membership') return `${order.membershipFromLevel === 'vip' && order.membershipLevel === 'svip' ? 'VIP 升级 ' : ''}${order.membershipLevel === 'svip' ? 'SVIP' : 'VIP'} 会员开通`
    return `${formatPoints(order.points)} 积分充值`
  }

  async function completeRechargeOrder(order) {
    const confirmTradeNo = (orderConfirm[order.id] || '').trim()
    const isMembership = order.kind === 'membership'
    if (confirmTradeNo !== order.tradeNo) return setError(`请先完整填写该订单号，确认用户已付款后再手动${isMembership ? '升级会员' : '入账'}`)
    const actionText = isMembership ? `升级为 ${order.membershipLevel === 'svip' ? 'SVIP' : 'VIP'} 会员` : `入账 ${formatPoints(order.points)} 积分`
    if (!window.confirm(`请确认你已经在支付后台核对该订单确实付款成功。\n\n用户：${order.user?.displayName || order.user?.username || '未知用户'}\n订单号：${order.tradeNo}\n金额：${Number(order.amount || 0).toFixed(2)} 元\n操作：${actionText}\n\n确认后将立即生效，是否继续？`)) return
    setOrderProcessing(order.id)
    setError('')
    try {
      const data = await apiRequest(`/api/admin/recharge-orders/${order.id}/complete`, {
        method: 'POST',
        body: JSON.stringify({ confirmTradeNo }),
      })
      setRechargeOrders(current => current.map(item => item.id === order.id ? data.order : item))
      setOrderConfirm(current => ({ ...current, [order.id]: '' }))
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setOrderProcessing('')
    }
  }

  const pendingRechargeCount = rechargeOrders.filter(order => order.status === 'pending').length
  const successRechargeAmount = rechargeOrders.filter(order => order.status === 'success').reduce((sum, order) => sum + (Number(order.amount) || 0), 0)

  return <div className="modal-backdrop" onMouseDown={event => event.target === event.currentTarget && onClose()}>
    <div className="modal orders-modal" role="dialog" aria-modal="true" aria-labelledby="orders-title">
      <div className="modal-head"><div><span>ORDER ADMINISTRATION</span><h2 id="orders-title">订单管理</h2></div><button aria-label="关闭订单管理" onClick={onClose}>×</button></div>
      <div className="orders-overview">
        <div><span>{rechargeOrders.length}</span><small>全部订单</small></div>
        <div><span>{pendingRechargeCount}</span><small>待支付/待回调</small></div>
        <div><span>{successRechargeAmount.toFixed(2)}</span><small>已到账金额（元）</small></div>
      </div>
      <div className="admin-recharge-panel standalone">
        <div className="admin-recharge-head"><div><b>充值与会员订单</b><small>没有公网回调时，可由管理员核对支付后台后手动确认。</small></div><button type="button" onClick={loadRechargeOrders} disabled={loading}>{loading ? '刷新中…' : '刷新订单'}</button></div>
        <p className="admin-recharge-warning">如果支付平台无法回调，请先在支付后台确认用户已经付款成功，再输入本系统订单号手动确认。充值订单会补积分，会员订单会立即升级；请勿只凭用户截图操作。</p>
        {error && <div className="users-error">{error}</div>}
        <div className="admin-recharge-list standalone">
          {loading ? <div className="admin-recharge-empty">正在加载订单…</div> : rechargeOrders.length === 0 ? <div className="admin-recharge-empty">暂无订单</div> : rechargeOrders.map(order => <div className={`admin-recharge-row ${order.status}`} key={order.id}>
            <div className="admin-recharge-main"><b>{order.user?.displayName || order.user?.username || '未知用户'} <small>@{order.user?.username || '-'}</small></b><span>{order.tradeNo}</span><em>{new Date(order.createdAt).toLocaleString('zh-CN')}</em></div>
            <div className="admin-recharge-money"><b>{orderTitle(order)}</b><span>{Number(order.amount || 0).toFixed(2)} 元</span></div>
            <div className="admin-recharge-status"><span>{orderStatusLabel(order.status)}</span>{order.providerTradeNo && <small>{order.providerTradeNo}</small>}</div>
            {order.status === 'pending' && <div className="admin-recharge-confirm">
              <input value={orderConfirm[order.id] || ''} onChange={event => setOrderConfirm(current => ({ ...current, [order.id]: event.target.value }))} placeholder="输入订单号确认" />
              <button type="button" className="save" disabled={orderProcessing === order.id || (orderConfirm[order.id] || '').trim() !== order.tradeNo} onClick={() => completeRechargeOrder(order)}>{orderProcessing === order.id ? '确认中…' : order.kind === 'membership' ? '手动升级' : '手动入账'}</button>
            </div>}
          </div>)}
        </div>
      </div>
    </div>
  </div>
}
