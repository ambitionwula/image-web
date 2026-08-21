import express from 'express'
import multer from 'multer'
import { jsonrepair } from 'jsonrepair'
import path from 'node:path'
import fs from 'node:fs/promises'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { execFile, spawn } from 'node:child_process'
import { createHash, createHmac, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const isProduction = process.env.NODE_ENV === 'production'
const isElectron = Boolean(process.versions?.electron)
const app = express()
const configuredTrustProxy = process.env.TRUST_PROXY
if ((isProduction && !isElectron) || configuredTrustProxy) {
  const numericTrustProxy = Number(configuredTrustProxy)
  app.set('trust proxy', configuredTrustProxy && Number.isNaN(numericTrustProxy) ? configuredTrustProxy : (configuredTrustProxy ? numericTrustProxy : 1))
}
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 49_000_000 } })
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const defaultBaseUrl = 'https://newapi.smartlifemarketing.com/v1'
const localRequestTimeoutMs = 10 * 60 * 1000
const chatCommandTimeoutMs = 30 * 1000
const maxChatCommandOutputChars = 18000
const updateCommandTimeoutMs = 5 * 60 * 1000
const sessionCookieName = 'image_studio_session'
const sessionMaxAgeSeconds = 30 * 24 * 60 * 60
const checkInTimezone = process.env.CHECK_IN_TIMEZONE || 'Asia/Shanghai'
const defaultCheckInRewardPoints = 10
const defaultCheckInWindowDays = 30
const scryptAsync = promisify(scrypt)
const dataDirectory = process.env.IMAGE_STUDIO_DATA_DIR
  ? path.resolve(process.env.IMAGE_STUDIO_DATA_DIR)
  : path.join(__dirname, '.runtime')
const dataFile = path.join(dataDirectory, 'app-data.json')
const secureSessionCookies = envFlag('SESSION_COOKIE_SECURE', isProduction && !isElectron)
const chatWorkspaceCommandsEnabled = envFlag('ENABLE_CHAT_WORKSPACE_COMMANDS', !isProduction || isElectron)
const webUpdateEnabled = envFlag('ENABLE_WEB_UPDATE', !isProduction)
const webUpdateRestartEnabled = envFlag('ENABLE_WEB_UPDATE_RESTART', isProduction && !isElectron)
const webUpdateRestartService = (process.env.WEB_UPDATE_RESTART_SERVICE || 'image-web').toString().trim()
const allowArbitrarySavePaths = envFlag('ALLOW_ARBITRARY_SAVE_PATHS', !isProduction || isElectron)
const imageSaveBaseDirectory = process.env.IMAGE_SAVE_BASE_DIR
  ? path.resolve(process.env.IMAGE_SAVE_BASE_DIR)
  : path.join(dataDirectory, 'saved-images')
const maxSavedImageBytes = Math.max(1_000_000, Number(process.env.IMAGE_SAVE_MAX_BYTES || 25_000_000))
const defaultServerSettings = {
  baseUrl: process.env.NEWAPI_BASE_URL || defaultBaseUrl,
  apiKey: process.env.NEWAPI_API_KEY || '',
  model: process.env.NEWAPI_IMAGE_MODEL || 'gpt-image-2',
  copyModel: 'gpt-5.6-sol',
  chatModel: 'gpt-5.5',
  format: 'url',
  autoSave: false,
  saveDirectory: '',
  imagePointCost: 3,
  copyPointCost: 1,
  rechargeRate: 10,
  normalImagePrice: 0.3,
  normalCopyPrice: 0.1,
  vipImagePrice: 0.2,
  vipCopyPrice: 0.08,
  vipDescription: '适合稳定创作用户，图片与文案生成享受更低单价。',
  svipImagePrice: 0.1,
  svipCopyPrice: 0.05,
  svipDescription: '适合高频创作团队，享受最低图片和文案生成单价。',
  vipOpenPrice: 29,
  svipOpenPrice: 99,
  paymentEnabled: false,
  paymentGatewayUrl: '',
  paymentCallbackBaseUrl: '',
  paymentReturnUrl: '',
  paymentMerchantId: '',
  paymentMerchantKey: '',
  paymentMinAmount: 1,
  checkInRewardPoints: defaultCheckInRewardPoints,
  checkInWindowDays: defaultCheckInWindowDays,
}

let runtimeStore
let persistQueue = Promise.resolve()
let updateInProgress = false

app.use(express.json({ limit: '50mb' }))
app.use(express.urlencoded({ extended: false }))

function envFlag(name, fallback = false) {
  const value = process.env[name]
  if (value === undefined || value === '') return fallback
  return /^(1|true|yes|on)$/i.test(value)
}

function clientIp(req) {
  return (req.ip || req.socket?.remoteAddress || 'unknown').toString()
}

function rateLimit({ windowMs, max, keyPrefix }) {
  const hits = new Map()
  return (req, res, next) => {
    const now = Date.now()
    const key = `${keyPrefix}:${clientIp(req)}`
    const current = hits.get(key)
    if (!current || current.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + windowMs })
      return next()
    }
    current.count += 1
    if (current.count > max) {
      res.setHeader('Retry-After', Math.ceil((current.resetAt - now) / 1000))
      return res.status(429).json({ ok: false, error: { message: '请求过于频繁，请稍后再试' } })
    }
    if (hits.size > 5000) {
      for (const [itemKey, item] of hits) {
        if (item.resetAt <= now) hits.delete(itemKey)
      }
    }
    next()
  }
}

const authRateLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, keyPrefix: 'auth' })
const orderRateLimit = rateLimit({ windowMs: 60 * 1000, max: 20, keyPrefix: 'order' })
const aiRateLimit = rateLimit({ windowMs: 60 * 1000, max: 12, keyPrefix: 'ai' })

function normalizeStore(value = {}) {
  return {
    secret: typeof value.secret === 'string' && value.secret.length >= 32 ? value.secret : randomBytes(48).toString('hex'),
    users: Array.isArray(value.users) ? value.users : [],
    rechargeOrders: Array.isArray(value.rechargeOrders) ? value.rechargeOrders : [],
    settings: { ...defaultServerSettings, ...(value.settings || {}) },
  }
}

async function loadStore() {
  await fs.mkdir(dataDirectory, { recursive: true })
  try {
    runtimeStore = normalizeStore(JSON.parse(await fs.readFile(dataFile, 'utf8')))
  } catch {
    runtimeStore = normalizeStore()
    await persistStore()
  }
}

function persistStore() {
  const serialized = JSON.stringify(runtimeStore, null, 2)
  persistQueue = persistQueue.then(() => fs.writeFile(dataFile, serialized, 'utf8'))
  return persistQueue
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName || user.username,
    role: user.role,
    enabled: user.enabled !== false,
    pointsBalance: normalizePointCost(user.pointsBalance, 0),
    membershipLevel: normalizeMembershipLevel(user.membershipLevel),
    membershipActivatedAt: user.membershipActivatedAt || null,
    checkIn: checkInStatus(user),
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  }
}

function storageSettingsForUser(user) {
  const hasOwnStorage = Object.hasOwn(user || {}, 'autoSave') || Object.hasOwn(user || {}, 'saveDirectory')
  if (!hasOwnStorage && user?.role === 'admin') {
    return {
      autoSave: runtimeStore.settings.autoSave === true,
      saveDirectory: (runtimeStore.settings.saveDirectory || '').toString(),
    }
  }
  return {
    autoSave: user?.autoSave === true,
    saveDirectory: (user?.saveDirectory || '').toString(),
  }
}

function adminUser(user) {
  const checkIn = checkInStatus(user)
  return {
    ...publicUser(user),
    remark: (user.remark || '').toString(),
    checkIn,
  }
}

function validateUsername(value) {
  const username = (value || '').toString().trim()
  if (!/^[A-Za-z0-9]{10,40}$/.test(username)) {
    throw new Error('用户名只能使用英文和数字，长度必须大于 9 位')
  }
  return username
}

function validatePassword(value) {
  const password = (value || '').toString()
  if (password.length < 8 || password.length > 128) throw new Error('密码长度需为 8 到 128 位')
  return password
}

function normalizePointCost(value, fallback) {
  const cost = Number(value)
  if (!Number.isFinite(cost) || cost < 0 || cost > 1_000_000) return fallback
  return Math.round(cost * 100) / 100
}

function normalizeCheckInRewardPoints(value, fallback = defaultCheckInRewardPoints) {
  const points = normalizePointCost(value, fallback)
  return points > 0 ? points : fallback
}

function normalizeCheckInWindowDays(value, fallback = defaultCheckInWindowDays) {
  const days = Number(value)
  if (!Number.isFinite(days) || days < 1 || days > 3650) return fallback
  return Math.floor(days)
}

function checkInRules() {
  const settings = runtimeStore?.settings || {}
  return {
    rewardPoints: normalizeCheckInRewardPoints(settings.checkInRewardPoints, defaultCheckInRewardPoints),
    totalDays: normalizeCheckInWindowDays(settings.checkInWindowDays, defaultCheckInWindowDays),
    timezone: checkInTimezone,
  }
}

function checkInSettingsPatch(input = {}) {
  const current = runtimeStore.settings || {}
  return {
    checkInRewardPoints: normalizeCheckInRewardPoints(Object.hasOwn(input, 'checkInRewardPoints') ? input.checkInRewardPoints : current.checkInRewardPoints, defaultServerSettings.checkInRewardPoints),
    checkInWindowDays: normalizeCheckInWindowDays(Object.hasOwn(input, 'checkInWindowDays') ? input.checkInWindowDays : current.checkInWindowDays, defaultServerSettings.checkInWindowDays),
  }
}

function zonedDayParts(value, timeZone = checkInTimezone) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return null
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date)
    const map = Object.fromEntries(parts.map(part => [part.type, part.value]))
    return {
      year: Number(map.year),
      month: Number(map.month),
      day: Number(map.day),
    }
  } catch {
    const fallback = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date)
    const map = Object.fromEntries(fallback.map(part => [part.type, part.value]))
    return {
      year: Number(map.year),
      month: Number(map.month),
      day: Number(map.day),
    }
  }
}

function dayKeyFromParts(parts) {
  if (!parts) return ''
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`
}

function dayNumberFromParts(parts) {
  if (!parts) return null
  return Math.floor(Date.UTC(parts.year, parts.month - 1, parts.day) / 86400000)
}

function checkInStatus(user, now = new Date()) {
  const { rewardPoints, totalDays, timezone } = checkInRules()
  const createdParts = zonedDayParts(user?.createdAt, checkInTimezone)
  const todayParts = zonedDayParts(now, checkInTimezone)
  const createdDayNumber = dayNumberFromParts(createdParts)
  const todayDayNumber = dayNumberFromParts(todayParts)
  const todayKey = dayKeyFromParts(todayParts)
  const checkedDays = Array.from(new Set(Array.isArray(user?.checkInDays) ? user.checkInDays : []))
    .filter(day => /^\d{4}-\d{2}-\d{2}$/.test(day))
  const todayChecked = checkedDays.includes(todayKey)
  const enabled = user?.role !== 'admin'
  const rawDayIndex = createdDayNumber === null || todayDayNumber === null ? 0 : todayDayNumber - createdDayNumber + 1
  const dayIndex = Math.max(0, Math.min(totalDays, rawDayIndex))
  const withinWindow = enabled && rawDayIndex >= 1 && rawDayIndex <= totalDays
  const expired = enabled && rawDayIndex > totalDays
  const remainingDays = withinWindow ? Math.max(0, totalDays - rawDayIndex) : 0
  return {
    enabled,
    available: withinWindow && !todayChecked,
    todayChecked,
    expired,
    rewardPoints,
    totalDays,
    dayIndex,
    checkedDays: checkedDays.length,
    remainingDays,
    timezone,
  }
}

async function performCheckIn(user) {
  if (user.role === 'admin') throw new Error('管理员账号无需签到')
  const status = checkInStatus(user)
  if (status.expired) throw new Error('新用户签到福利已结束')
  if (!status.dayIndex) throw new Error('签到活动尚未开始')
  if (status.todayChecked) throw new Error('今天已经签到过了')
  if (!status.available) throw new Error('当前不可签到')
  const todayKey = dayKeyFromParts(zonedDayParts(new Date(), checkInTimezone))
  const existing = Array.from(new Set(Array.isArray(user.checkInDays) ? user.checkInDays : []))
    .filter(day => /^\d{4}-\d{2}-\d{2}$/.test(day))
  if (!existing.includes(todayKey)) existing.push(todayKey)
  user.checkInDays = existing.sort()
  user.lastCheckInAt = new Date().toISOString()
  user.pointsBalance = normalizePointCost(normalizePointCost(user.pointsBalance, 0) + status.rewardPoints, 0)
  user.updatedAt = user.lastCheckInAt
  await persistStore()
  return { checkIn: checkInStatus(user), user: publicUser(user), rewardPoints: status.rewardPoints }
}

function normalizeMoney(value, fallback) {
  const amount = Number(value)
  if (!Number.isFinite(amount) || amount < 0 || amount > 1_000_000) return fallback
  return Math.round(amount * 100) / 100
}

function normalizeMembershipLevel(value) {
  return ['normal', 'vip', 'svip'].includes(value) ? value : 'normal'
}

function membershipRank(level) {
  return { normal: 0, vip: 1, svip: 2 }[normalizeMembershipLevel(level)] || 0
}

function membershipLabel(level) {
  return ({ normal: '普通用户', vip: 'VIP', svip: 'SVIP' })[normalizeMembershipLevel(level)] || '普通用户'
}

function membershipPricing() {
  const settings = runtimeStore.settings
  const rate = normalizePointCost(settings.rechargeRate, defaultServerSettings.rechargeRate) || defaultServerSettings.rechargeRate
  const normalImageFallback = normalizePointCost(settings.imagePointCost, defaultServerSettings.imagePointCost) / rate
  const normalCopyFallback = normalizePointCost(settings.copyPointCost, defaultServerSettings.copyPointCost) / rate
  return {
    normal: {
      imagePrice: normalizeMoney(settings.normalImagePrice, normalImageFallback),
      copyPrice: normalizeMoney(settings.normalCopyPrice, normalCopyFallback),
      openPrice: 0,
    },
    vip: {
      imagePrice: normalizeMoney(settings.vipImagePrice, defaultServerSettings.vipImagePrice),
      copyPrice: normalizeMoney(settings.vipCopyPrice, defaultServerSettings.vipCopyPrice),
      openPrice: normalizeMoney(settings.vipOpenPrice, defaultServerSettings.vipOpenPrice),
      description: (settings.vipDescription || defaultServerSettings.vipDescription).toString().trim().slice(0, 500),
    },
    svip: {
      imagePrice: normalizeMoney(settings.svipImagePrice, defaultServerSettings.svipImagePrice),
      copyPrice: normalizeMoney(settings.svipCopyPrice, defaultServerSettings.svipCopyPrice),
      openPrice: normalizeMoney(settings.svipOpenPrice, defaultServerSettings.svipOpenPrice),
      description: (settings.svipDescription || defaultServerSettings.svipDescription).toString().trim().slice(0, 500),
    },
  }
}

function membershipUpgradeAmount(pricing, currentLevel, targetLevel) {
  const normalizedCurrent = normalizeMembershipLevel(currentLevel)
  const normalizedTarget = normalizeMembershipLevel(targetLevel)
  const targetPrice = normalizeMoney(pricing[normalizedTarget]?.openPrice, 0)
  const creditAmount = normalizedCurrent === 'normal' ? 0 : normalizeMoney(pricing[normalizedCurrent]?.openPrice, 0)
  return {
    amount: normalizeMoney(Math.max(0, targetPrice - creditAmount), 0),
    targetPrice,
    creditAmount,
  }
}

function membershipSettingsPatch(input = {}) {
  const current = runtimeStore.settings
  const rate = normalizePointCost(Object.hasOwn(input, 'rechargeRate') ? input.rechargeRate : current.rechargeRate, defaultServerSettings.rechargeRate) || defaultServerSettings.rechargeRate
  return {
    normalImagePrice: normalizeMoney(Object.hasOwn(input, 'normalImagePrice') ? input.normalImagePrice : Object.hasOwn(input, 'imagePointCost') ? Number(input.imagePointCost) / rate : current.normalImagePrice, defaultServerSettings.normalImagePrice),
    normalCopyPrice: normalizeMoney(Object.hasOwn(input, 'normalCopyPrice') ? input.normalCopyPrice : Object.hasOwn(input, 'copyPointCost') ? Number(input.copyPointCost) / rate : current.normalCopyPrice, defaultServerSettings.normalCopyPrice),
    vipImagePrice: normalizeMoney(Object.hasOwn(input, 'vipImagePrice') ? input.vipImagePrice : current.vipImagePrice, defaultServerSettings.vipImagePrice),
    vipCopyPrice: normalizeMoney(Object.hasOwn(input, 'vipCopyPrice') ? input.vipCopyPrice : current.vipCopyPrice, defaultServerSettings.vipCopyPrice),
    vipDescription: (Object.hasOwn(input, 'vipDescription') ? input.vipDescription : current.vipDescription || defaultServerSettings.vipDescription).toString().trim().slice(0, 500),
    svipImagePrice: normalizeMoney(Object.hasOwn(input, 'svipImagePrice') ? input.svipImagePrice : current.svipImagePrice, defaultServerSettings.svipImagePrice),
    svipCopyPrice: normalizeMoney(Object.hasOwn(input, 'svipCopyPrice') ? input.svipCopyPrice : current.svipCopyPrice, defaultServerSettings.svipCopyPrice),
    svipDescription: (Object.hasOwn(input, 'svipDescription') ? input.svipDescription : current.svipDescription || defaultServerSettings.svipDescription).toString().trim().slice(0, 500),
    vipOpenPrice: normalizeMoney(Object.hasOwn(input, 'vipOpenPrice') ? input.vipOpenPrice : current.vipOpenPrice, defaultServerSettings.vipOpenPrice),
    svipOpenPrice: normalizeMoney(Object.hasOwn(input, 'svipOpenPrice') ? input.svipOpenPrice : current.svipOpenPrice, defaultServerSettings.svipOpenPrice),
  }
}

function membershipView(user = null) {
  const rules = membershipPricing()
  const rate = normalizePointCost(runtimeStore.settings.rechargeRate, defaultServerSettings.rechargeRate)
  const level = normalizeMembershipLevel(user?.membershipLevel)
  const tiers = Object.fromEntries(Object.entries(rules).map(([key, rule]) => [key, {
    label: membershipLabel(key),
    imagePrice: rule.imagePrice,
    copyPrice: rule.copyPrice,
    imagePointCost: normalizePointCost(rule.imagePrice * rate, 0),
    copyPointCost: normalizePointCost(rule.copyPrice * rate, 0),
    openPrice: rule.openPrice,
    description: rule.description || '',
  }]))
  return {
    membershipLevel: level,
    membershipLabel: membershipLabel(level),
    membershipTiers: tiers,
    normalImagePrice: tiers.normal.imagePrice,
    normalCopyPrice: tiers.normal.copyPrice,
    vipImagePrice: tiers.vip.imagePrice,
    vipCopyPrice: tiers.vip.copyPrice,
    vipDescription: tiers.vip.description,
    svipImagePrice: tiers.svip.imagePrice,
    svipCopyPrice: tiers.svip.copyPrice,
    svipDescription: tiers.svip.description,
    vipOpenPrice: tiers.vip.openPrice,
    svipOpenPrice: tiers.svip.openPrice,
  }
}

function pointSettings(user = null) {
  const rate = normalizePointCost(runtimeStore.settings.rechargeRate, defaultServerSettings.rechargeRate)
  const level = normalizeMembershipLevel(user?.membershipLevel)
  const tier = membershipView(user).membershipTiers[level]
  const checkIn = checkInRules()
  return {
    imagePointCost: normalizePointCost(tier.imagePointCost, defaultServerSettings.imagePointCost),
    copyPointCost: normalizePointCost(tier.copyPointCost, defaultServerSettings.copyPointCost),
    rechargeRate: rate,
    checkInRewardPoints: checkIn.rewardPoints,
    checkInWindowDays: checkIn.totalDays,
  }
}

function paymentSettings({ admin = false } = {}) {
  const settings = runtimeStore.settings
  const gatewayUrl = (settings.paymentGatewayUrl || '').toString().trim()
  const callbackBaseUrl = (settings.paymentCallbackBaseUrl || '').toString().trim().replace(/\/+$/, '')
  const returnUrl = (settings.paymentReturnUrl || '').toString().trim()
  const merchantId = (settings.paymentMerchantId || '').toString().trim()
  const merchantKey = (settings.paymentMerchantKey || '').toString().trim()
  const minAmount = normalizePointCost(settings.paymentMinAmount, defaultServerSettings.paymentMinAmount)
  const configured = Boolean(gatewayUrl && merchantId && merchantKey)
  const view = {
    paymentEnabled: settings.paymentEnabled === true,
    paymentConfigured: configured,
    paymentGatewayUrl: admin ? gatewayUrl : '',
    paymentCallbackBaseUrl: admin ? callbackBaseUrl : '',
    paymentReturnUrl: admin ? returnUrl : '',
    paymentMerchantId: admin ? merchantId : '',
    paymentMinAmount: minAmount > 0 ? minAmount : defaultServerSettings.paymentMinAmount,
    paymentMethods: [{ type: 'alipay', label: '支付宝' }],
  }
  if (admin) {
    view.hasPaymentMerchantKey = Boolean(merchantKey)
    view.paymentMerchantKeyHint = merchantKey ? `${merchantKey.slice(0, 3)}••••${merchantKey.slice(-4)}` : ''
    view.paymentMerchantKey = ''
  }
  return view
}

function normalizeHttpUrl(value, label, { required = false } = {}) {
  const text = (value || '').toString().trim().replace(/\/+$/, '')
  if (!text) {
    if (required) throw new Error(`请填写${label}`)
    return ''
  }
  if (!/^https?:\/\//i.test(text)) throw new Error(`${label}必须以 http:// 或 https:// 开头`)
  return text
}

function paymentSettingsPatch(input = {}) {
  const current = runtimeStore.settings
  const patch = {
    paymentEnabled: Object.hasOwn(input, 'paymentEnabled') ? input.paymentEnabled === true : current.paymentEnabled === true,
    paymentGatewayUrl: normalizeHttpUrl(Object.hasOwn(input, 'paymentGatewayUrl') ? input.paymentGatewayUrl : current.paymentGatewayUrl, '支付网关地址'),
    paymentCallbackBaseUrl: normalizeHttpUrl(Object.hasOwn(input, 'paymentCallbackBaseUrl') ? input.paymentCallbackBaseUrl : current.paymentCallbackBaseUrl, '支付回调根地址'),
    paymentReturnUrl: normalizeHttpUrl(Object.hasOwn(input, 'paymentReturnUrl') ? input.paymentReturnUrl : current.paymentReturnUrl, '支付返回地址'),
    paymentMerchantId: (Object.hasOwn(input, 'paymentMerchantId') ? input.paymentMerchantId : current.paymentMerchantId || '').toString().trim().slice(0, 80),
    paymentMinAmount: normalizePointCost(Object.hasOwn(input, 'paymentMinAmount') ? input.paymentMinAmount : current.paymentMinAmount, defaultServerSettings.paymentMinAmount),
  }
  if (typeof input.paymentMerchantKey === 'string' && input.paymentMerchantKey.trim()) {
    patch.paymentMerchantKey = input.paymentMerchantKey.trim()
  }
  const nextKey = Object.hasOwn(patch, 'paymentMerchantKey') ? patch.paymentMerchantKey : (runtimeStore.settings.paymentMerchantKey || '')
  if (patch.paymentEnabled) {
    if (!patch.paymentGatewayUrl) throw new Error('启用在线充值前，请填写支付网关地址')
    if (!patch.paymentMerchantId) throw new Error('启用在线充值前，请填写商户 ID')
    if (!nextKey) throw new Error('启用在线充值前，请填写商户密钥')
  }
  if (patch.paymentMinAmount <= 0) patch.paymentMinAmount = defaultServerSettings.paymentMinAmount
  return patch
}

function effectivePaymentConfig(req) {
  const settings = runtimeStore.settings
  const gatewayUrl = (settings.paymentGatewayUrl || '').toString().trim()
  const merchantId = (settings.paymentMerchantId || '').toString().trim()
  const merchantKey = (settings.paymentMerchantKey || '').toString().trim()
  const callbackBaseUrl = ((settings.paymentCallbackBaseUrl || '').toString().trim().replace(/\/+$/, '') || requestBaseUrl(req))
  return {
    enabled: settings.paymentEnabled === true,
    configured: Boolean(gatewayUrl && merchantId && merchantKey),
    gatewayUrl,
    callbackBaseUrl,
    returnUrl: (settings.paymentReturnUrl || '').toString().trim(),
    merchantId,
    merchantKey,
    minAmount: paymentSettings().paymentMinAmount,
  }
}

function requestBaseUrl(req) {
  const forwardedProto = (req.get('x-forwarded-proto') || '').split(',')[0].trim()
  const forwardedHost = (req.get('x-forwarded-host') || '').split(',')[0].trim()
  const proto = forwardedProto || req.protocol || 'http'
  const host = forwardedHost || req.get('host') || ''
  return host ? `${proto}://${host}` : ''
}

function formatMoneyMinor(value) {
  const minor = Number(value)
  return `${Math.floor(minor / 100)}.${String(Math.abs(minor % 100)).padStart(2, '0')}`
}

function parseMoneyMinor(value) {
  const input = (value ?? '').toString().trim()
  if (!/^\d+(\.\d{1,2})?$/.test(input)) throw new Error('金额最多支持两位小数')
  const [yuan, cents = ''] = input.split('.')
  const minor = Number(yuan) * 100 + Number(cents.padEnd(2, '0'))
  if (!Number.isSafeInteger(minor) || minor <= 0) throw new Error('请输入有效的充值金额')
  return minor
}

function amountToMinor(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('请输入有效的充值金额')
    const minor = Math.round(value * 100)
    if (Math.abs(value * 100 - minor) > 0.000001) throw new Error('充值金额最多支持两位小数')
    if (!Number.isSafeInteger(minor) || minor <= 0) throw new Error('请输入有效的充值金额')
    return minor
  }
  return parseMoneyMinor(value)
}

function epaySign(values, merchantKey) {
  const canonical = Object.keys(values)
    .filter(key => key !== 'sign' && key !== 'sign_type' && (values[key] ?? '').toString() !== '')
    .sort()
    .map(key => `${key}=${values[key]}`)
    .join('&')
  return createHash('md5').update(canonical + merchantKey).digest('hex')
}

function epayVerify(values, merchantKey) {
  const provided = (values.sign || '').toString().trim().toLowerCase()
  const expected = epaySign(values, merchantKey)
  if (provided.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
}

function epayPurchaseUrl(raw) {
  const trimmed = (raw || '').toString().trim()
  try {
    const parsed = new URL(trimmed)
    const pathname = parsed.pathname.replace(/\/+$/, '')
    if (!pathname.toLowerCase().endsWith('/submit.php') && pathname.toLowerCase() !== '/submit.php') {
      parsed.pathname = `${pathname || ''}/submit.php`
    }
    return parsed.toString()
  } catch {
    return trimmed
  }
}

function newTradeNo() {
  const now = new Date()
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('')
  return `IMG${stamp}${randomBytes(6).toString('hex').toUpperCase()}`
}

function rechargeOrderForUser(order) {
  return {
    id: order.id,
    kind: order.kind || 'recharge',
    tradeNo: order.tradeNo,
    amount: order.amount,
    points: order.points,
    membershipLevel: order.membershipLevel || '',
    membershipFromLevel: order.membershipFromLevel || '',
    membershipFullPrice: order.membershipFullPrice || 0,
    membershipCreditAmount: order.membershipCreditAmount || 0,
    paymentAmount: order.paymentAmount,
    currency: order.currency,
    provider: order.provider,
    method: order.method,
    status: order.status,
    createdAt: order.createdAt,
    completedAt: order.completedAt || null,
    canceledAt: order.canceledAt || null,
  }
}

function adminRechargeOrder(order) {
  const user = runtimeStore.users.find(item => item.id === order.userId)
  return {
    ...rechargeOrderForUser(order),
    userId: order.userId,
    providerTradeNo: order.providerTradeNo || '',
    user: user ? { id: user.id, username: user.username, displayName: user.displayName || user.username } : null,
  }
}

function paymentForm(config, order) {
  const returnUrl = config.returnUrl || config.callbackBaseUrl
  const orderName = order.kind === 'membership'
    ? `造像所${membershipLabel(order.membershipLevel)}会员开通`
    : `造像所积分充值 ${order.points} 积分`
  const form = {
    pid: config.merchantId,
    type: order.method,
    out_trade_no: order.tradeNo,
    notify_url: `${config.callbackBaseUrl}/api/payment/epay/notify`,
    return_url: returnUrl,
    name: orderName,
    money: formatMoneyMinor(order.paymentAmountMinor),
    device: 'pc',
    sign_type: 'MD5',
  }
  form.sign = epaySign(form, config.merchantKey)
  return form
}

function ensurePoints(user, cost) {
  const required = normalizePointCost(cost, 0)
  if (required <= 0 || user.role === 'admin') return required
  const balance = normalizePointCost(user.pointsBalance, 0)
  if (balance < required) {
    const error = new Error(`积分不足，本次需要 ${required} 分，当前余额 ${balance} 分`)
    error.statusCode = 402
    throw error
  }
  return required
}

async function consumePoints(user, cost) {
  const required = ensurePoints(user, cost)
  if (required <= 0 || user.role === 'admin') return normalizePointCost(user.pointsBalance, 0)
  user.pointsBalance = normalizePointCost(normalizePointCost(user.pointsBalance, 0) - required, 0)
  user.updatedAt = new Date().toISOString()
  await persistStore()
  return user.pointsBalance
}

async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex')
  const hash = await scryptAsync(password, salt, 64)
  return `${salt}:${Buffer.from(hash).toString('hex')}`
}

async function verifyPassword(password, stored) {
  const [salt, expectedHex] = (stored || '').split(':')
  if (!salt || !expectedHex) return false
  const actual = Buffer.from(await scryptAsync(password, salt, 64))
  const expected = Buffer.from(expectedHex, 'hex')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

function parseCookies(req) {
  try {
    return Object.fromEntries((req.headers.cookie || '').split(';').map(part => {
      const index = part.indexOf('=')
      if (index < 0) return ['', '']
      return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())]
    }).filter(([key]) => key))
  } catch {
    return {}
  }
}

function signSession(user) {
  const payload = Buffer.from(JSON.stringify({
    sub: user.id,
    version: user.sessionVersion || 0,
    exp: Date.now() + sessionMaxAgeSeconds * 1000,
  })).toString('base64url')
  const signature = createHmac('sha256', runtimeStore.secret).update(payload).digest('base64url')
  return `${payload}.${signature}`
}

function readSession(req) {
  const token = parseCookies(req)[sessionCookieName]
  if (!token) return null
  const [payload, signature] = token.split('.')
  if (!payload || !signature) return null
  const expected = createHmac('sha256', runtimeStore.secret).update(payload).digest()
  const actual = Buffer.from(signature, 'base64url')
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null
  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (!session.sub || session.exp < Date.now()) return null
    const user = runtimeStore.users.find(item => item.id === session.sub)
    if (!user || user.enabled === false || (user.sessionVersion || 0) !== session.version) return null
    return user
  } catch {
    return null
  }
}

function setSessionCookie(res, user) {
  const secure = secureSessionCookies ? '; Secure' : ''
  res.setHeader('Set-Cookie', `${sessionCookieName}=${encodeURIComponent(signSession(user))}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionMaxAgeSeconds}${secure}`)
}

function clearSessionCookie(res) {
  const secure = secureSessionCookies ? '; Secure' : ''
  res.setHeader('Set-Cookie', `${sessionCookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`)
}

function requireAuth(req, res, next) {
  const user = readSession(req)
  if (!user) return res.status(401).json({ ok: false, error: { message: '请先登录' } })
  req.user = user
  next()
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ ok: false, error: { message: '仅管理员可以执行此操作' } })
  next()
}

function requireWebUpdateEnabled(_req, res, next) {
  if (!webUpdateEnabled) {
    return res.status(403).json({
      ok: false,
      inProgress: updateInProgress,
      error: { message: '云端默认关闭网页自动更新。确认服务器 GitHub 权限、仓库可信且有重启方案后，可设置 ENABLE_WEB_UPDATE=true 开启。' },
    })
  }
  next()
}

function config() {
  const baseUrl = (runtimeStore.settings.baseUrl || '').toString().trim().replace(/\/$/, '')
  const apiKey = (runtimeStore.settings.apiKey || '').toString().trim()
  if (!baseUrl) throw new Error('请先填写 NewAPI Base URL')
  if (!apiKey) throw new Error('管理员尚未配置 API Key')
  return { baseUrl, apiKey }
}

function abortUpstreamWhenClientLeaves(res) {
  const controller = new AbortController()
  res.once('close', () => {
    if (!res.writableEnded) controller.abort()
  })
  return controller
}

async function parseResponse(response) {
  const text = await response.text()
  let data
  try { data = JSON.parse(text) } catch { data = { error: { message: text || `HTTP ${response.status}` } } }
  if (!response.ok) throw new Error(data?.error?.message || data?.message || `请求失败（${response.status}）`)
  return data
}

function extractMessageContent(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value.map(item => {
      if (typeof item === 'string') return item
      if (typeof item?.text === 'string') return item.text
      if (typeof item?.content === 'string') return item.content
      return ''
    }).join('\n')
  }
  return ''
}

function clampText(value, limit = maxChatCommandOutputChars) {
  const text = (value || '').toString()
  if (text.length <= limit) return text
  const keep = Math.floor((limit - 90) / 2)
  return `${text.slice(0, keep)}\n\n...输出过长，已省略中间内容...\n\n${text.slice(-keep)}`
}

function wantsLocalWorkspaceAccess(messages) {
  const latestUser = [...messages].reverse().find(item => item.role === 'user')?.content || ''
  return /(运行|启动|执行|命令|终端|powershell|cmd|shell|npm|node|git|目录|文件|项目|构建|测试|检查|列出|查看|安装|Get-ChildItem|\bls\b|\bdir\b)/i.test(latestUser)
}

function parseToolArgs(value) {
  if (!value) return {}
  if (typeof value === 'object') return value
  try { return JSON.parse(value) } catch { return {} }
}

function isBlockedChatCommand(command) {
  return /(?:^|[;&|({\s])(?:rm|del|erase|rmdir|rd|remove-item|move-item|ren|rename-item|format|shutdown|restart-computer|stop-process|taskkill|sc\s+delete|reg\s+delete|icacls|takeown|set-acl)\b/i.test(command)
    || />\s*[^&|]+|set-content\b|out-file\b|add-content\b/i.test(command)
}

function runChatCommand(command, timeoutMs = chatCommandTimeoutMs) {
  return new Promise(resolve => {
    const safeTimeout = Math.max(1000, Math.min(Number(timeoutMs) || chatCommandTimeoutMs, 120000))
    if (isBlockedChatCommand(command)) {
      resolve({
        command,
        cwd: __dirname,
        exitCode: 1,
        timedOut: false,
        durationMs: 0,
        output: '已拒绝执行：聊天命令工具只允许检查、测试、构建和启动项目，不允许删除、移动、重命名、覆盖写入、结束进程或修改系统设置。',
      })
      return
    }
    const startedAt = Date.now()
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], {
      cwd: __dirname,
      windowsHide: true,
      encoding: 'utf8',
      timeout: safeTimeout,
      maxBuffer: 2 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      const output = [
        stdout ? `STDOUT:\n${stdout}` : '',
        stderr ? `STDERR:\n${stderr}` : '',
        error ? `ERROR:\n${error.killed ? `命令超时（${safeTimeout}ms）` : error.message}` : '',
      ].filter(Boolean).join('\n\n') || '命令已执行，没有输出。'
      resolve({
        command,
        cwd: __dirname,
        exitCode: typeof error?.code === 'number' ? error.code : 0,
        timedOut: Boolean(error?.killed),
        durationMs: Date.now() - startedAt,
        output: clampText(output),
      })
    })
  })
}

function runUpdateCommand(command, args = [], { timeoutMs = updateCommandTimeoutMs } = {}) {
  return new Promise(resolve => {
    const startedAt = Date.now()
    execFile(command, args, {
      cwd: __dirname,
      windowsHide: true,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      shell: process.platform === 'win32',
    }, (error, stdout, stderr) => {
      const output = [
        stdout ? stdout.trim() : '',
        stderr ? stderr.trim() : '',
        error ? (error.killed ? `命令超时（${timeoutMs}ms）` : error.message) : '',
      ].filter(Boolean).join('\n')
      resolve({
        command: [command, ...args].join(' '),
        exitCode: typeof error?.code === 'number' ? error.code : 0,
        timedOut: Boolean(error?.killed),
        durationMs: Date.now() - startedAt,
        output: clampText(output || '命令已执行，没有输出。', 8000),
      })
    })
  })
}

function safeRestartServiceName() {
  const service = webUpdateRestartService.replace(/\.service$/, '')
  if (!/^[A-Za-z0-9_.@-]+$/.test(service)) return ''
  return service
}

function scheduleServiceRestart() {
  const service = safeRestartServiceName()
  if (!webUpdateRestartEnabled || !service) {
    return { scheduled: false, service, message: '自动重启未启用，请手动重启服务后生效。' }
  }
  setTimeout(() => {
    const child = spawn('systemctl', ['restart', `${service}.service`], {
      detached: true,
      stdio: 'ignore',
    })
    child.unref()
  }, 1000)
  return { scheduled: true, service, message: `已安排自动重启 ${service}.service，稍后刷新页面即可生效。` }
}

async function gitInfo() {
  const inside = await runUpdateCommand('git', ['rev-parse', '--is-inside-work-tree'], { timeoutMs: 30000 })
  if (inside.exitCode !== 0 || inside.output.trim() !== 'true') {
    return { ok: false, message: '当前部署目录不是 Git 仓库，无法自动更新。请先从 GitHub clone 项目后再使用更新功能。', steps: [inside] }
  }
  const branch = await runUpdateCommand('git', ['branch', '--show-current'], { timeoutMs: 30000 })
  const remote = await runUpdateCommand('git', ['config', '--get', `branch.${branch.output.trim()}.remote`], { timeoutMs: 30000 })
  const merge = await runUpdateCommand('git', ['config', '--get', `branch.${branch.output.trim()}.merge`], { timeoutMs: 30000 })
  const current = await runUpdateCommand('git', ['rev-parse', '--short', 'HEAD'], { timeoutMs: 30000 })
  return {
    ok: true,
    branch: branch.output.trim(),
    remote: remote.exitCode === 0 ? remote.output.trim() : '',
    upstream: merge.exitCode === 0 ? merge.output.trim().replace(/^refs\/heads\//, '') : '',
    current: current.exitCode === 0 ? current.output.trim() : '',
    steps: [inside, branch, remote, merge, current],
  }
}

async function checkSystemUpdate() {
  const info = await gitInfo()
  if (!info.ok) return info
  if (!info.branch || !info.remote || !info.upstream) {
    return { ok: false, message: '当前分支没有配置上游远程仓库，请先配置 GitHub remote/upstream 后再使用更新功能。', ...info }
  }
  const fetchResult = await runUpdateCommand('git', ['fetch', info.remote, info.branch], { timeoutMs: 120000 })
  const remoteHead = await runUpdateCommand('git', ['rev-parse', '--short', `${info.remote}/${info.upstream}`], { timeoutMs: 30000 })
  const behind = await runUpdateCommand('git', ['rev-list', '--count', `HEAD..${info.remote}/${info.upstream}`], { timeoutMs: 30000 })
  const ahead = await runUpdateCommand('git', ['rev-list', '--count', `${info.remote}/${info.upstream}..HEAD`], { timeoutMs: 30000 })
  const steps = [...info.steps, fetchResult, remoteHead, behind, ahead]
  if (fetchResult.exitCode !== 0) return { ok: false, message: '拉取远程更新信息失败，请检查服务器网络和 GitHub 权限。', steps }
  const behindCount = Number(behind.output.trim()) || 0
  const aheadCount = Number(ahead.output.trim()) || 0
  return {
    ok: true,
    message: behindCount > 0 ? `发现 ${behindCount} 个远程更新，可以执行更新。` : '当前已经是最新版本。',
    branch: info.branch,
    remote: info.remote,
    upstream: info.upstream,
    current: info.current,
    remoteHead: remoteHead.exitCode === 0 ? remoteHead.output.trim() : '',
    behindCount,
    aheadCount,
    hasUpdate: behindCount > 0,
    needsRestart: false,
    steps,
  }
}

async function runSystemUpdate() {
  if (updateInProgress) {
    const error = new Error('已有更新任务正在执行，请稍后再试')
    error.statusCode = 409
    throw error
  }
  updateInProgress = true
  const steps = []
  const lastOutput = () => {
    const latest = [...steps].reverse().find(step => step && typeof step.output === 'string' && step.output.trim())
    return latest ? latest.output.trim().slice(-1200) : ''
  }
  try {
    const info = await checkSystemUpdate()
    steps.push(...(info.steps || []))
    if (!info.ok) return { ...info, steps }
    if (!info.hasUpdate) return { ...info, steps }
    if (info.aheadCount > 0) {
      return {
        ...info,
        ok: false,
        message: `当前服务器本地比远程多 ${info.aheadCount} 个提交，为避免覆盖服务器改动，已停止自动更新。请先处理本地提交。`,
        steps,
      }
    }
    const pull = await runUpdateCommand('git', ['pull', '--ff-only', info.remote, info.branch])
    steps.push(pull)
    if (pull.exitCode !== 0) return { ...info, ok: false, message: `git pull 失败，请检查冲突、权限或网络。\n${lastOutput()}`, steps }
    const pulledCurrent = await runUpdateCommand('git', ['rev-parse', '--short', 'HEAD'], { timeoutMs: 30000 })
    steps.push(pulledCurrent)
    const pulledHead = pulledCurrent.exitCode === 0 ? pulledCurrent.output.trim() : info.current
    const nodeVersion = await runUpdateCommand('node', ['-v'], { timeoutMs: 30000 })
    steps.push(nodeVersion)
    const npmVersion = await runUpdateCommand('npm', ['-v'], { timeoutMs: 30000 })
    steps.push(npmVersion)
    const install = await runUpdateCommand('npm', ['install'])
    steps.push(install)
    if (install.exitCode !== 0) return { ...info, current: pulledHead, ok: false, message: `依赖安装失败，请查看日志后手动处理。\n${lastOutput()}`, steps }
    const build = await runUpdateCommand('npm', ['run', 'build'])
    steps.push(build)
    if (build.exitCode !== 0) return { ...info, current: pulledHead, ok: false, message: `项目构建失败，请查看日志后手动处理。\n${lastOutput()}`, steps }
    const restart = scheduleServiceRestart()
    return {
      ...info,
      ok: true,
      message: `更新完成。前端静态文件已重新构建。${restart.message}`,
      current: pulledHead,
      hasUpdate: false,
      needsRestart: !restart.scheduled,
      restartScheduled: restart.scheduled,
      restartService: restart.service,
      steps,
    }
  } finally {
    updateInProgress = false
  }
}

async function availableModels(baseUrl, apiKey) {
  const response = await fetch(`${baseUrl}/models`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
  })
  const data = await parseResponse(response)
  return Array.isArray(data?.data) ? data.data.map(item => item?.id).filter(Boolean) : []
}

function chooseVisionModel(models, preferred) {
  if (preferred && models.includes(preferred)) return preferred
  const candidates = models.filter(id => !/image|dall|flux|seedream|ideogram|recraft/i.test(id))
  const priorities = [
    /gpt-5/i, /gpt-4\.1/i, /gpt-4o/i, /gemini.*(?:pro|flash)/i,
    /claude.*(?:sonnet|opus|haiku)/i, /qwen.*(?:vl|vision)/i,
  ]
  for (const pattern of priorities) {
    const match = candidates.find(id => pattern.test(id))
    if (match) return match
  }
  return candidates[0] || ''
}

function parseModelJson(content) {
  if (typeof content !== 'string' || !content.trim()) throw new Error('文案模型没有返回分析内容')
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
  try { return JSON.parse(cleaned) } catch {}
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start >= 0 && end > start) {
    const candidate = cleaned.slice(start, end + 1)
    try { return JSON.parse(candidate) } catch {}
    try { return JSON.parse(jsonrepair(candidate)) } catch {}
  }
  if (start >= 0) {
    try { return JSON.parse(jsonrepair(cleaned.slice(start))) } catch {}
  }
  try { return JSON.parse(jsonrepair(cleaned)) } catch {}
  throw new Error('文案模型返回的格式无法解析，请重试')
}

await loadStore()

app.get('/api/health', (_, res) => res.json({ ok: true }))

app.get('/api/auth/status', (req, res) => {
  const user = readSession(req)
  res.json({
    ok: true,
    needsSetup: !runtimeStore.users.some(item => item.role === 'admin'),
    user: user ? publicUser(user) : null,
  })
})

app.post('/api/auth/setup', authRateLimit, async (req, res) => {
  try {
    if (runtimeStore.users.some(item => item.role === 'admin')) {
      return res.status(409).json({ ok: false, error: { message: '管理员已经初始化，请直接登录' } })
    }
    const username = validateUsername(req.body?.username)
    const password = validatePassword(req.body?.password)
    const now = new Date().toISOString()
    const user = {
      id: randomUUID(),
      username,
      displayName: (req.body?.displayName || username).toString().trim().slice(0, 60) || username,
      passwordHash: await hashPassword(password),
      role: 'admin',
      enabled: true,
      pointsBalance: 0,
      membershipLevel: 'normal',
      membershipActivatedAt: null,
      autoSave: false,
      saveDirectory: '',
      remark: '',
      checkInDays: [],
      lastCheckInAt: null,
      sessionVersion: 0,
      createdAt: now,
      updatedAt: now,
    }
    if (runtimeStore.users.some(item => item.role === 'admin')) {
      return res.status(409).json({ ok: false, error: { message: '管理员已经初始化，请直接登录' } })
    }
    runtimeStore.users.push(user)
    await persistStore()
    setSessionCookie(res, user)
    res.status(201).json({ ok: true, user: publicUser(user) })
  } catch (error) {
    res.status(400).json({ ok: false, error: { message: error.message } })
  }
})

app.post('/api/auth/login', authRateLimit, async (req, res) => {
  const username = (req.body?.username || '').toString().trim()
  const password = (req.body?.password || '').toString()
  const user = runtimeStore.users.find(item => item.username.toLowerCase() === username.toLowerCase())
  if (!user || user.enabled === false || !(await verifyPassword(password, user.passwordHash))) {
    return res.status(401).json({ ok: false, error: { message: '用户名或密码不正确' } })
  }
  setSessionCookie(res, user)
  res.json({ ok: true, user: publicUser(user) })
})

app.post('/api/auth/register', authRateLimit, async (req, res) => {
  try {
    if (!runtimeStore.users.some(item => item.role === 'admin')) {
      return res.status(409).json({ ok: false, error: { message: '请先创建管理员账号' } })
    }
    const username = validateUsername(req.body?.username)
    if (runtimeStore.users.some(item => item.username.toLowerCase() === username.toLowerCase())) {
      return res.status(409).json({ ok: false, error: { message: '用户名已存在' } })
    }
    const now = new Date().toISOString()
    const user = {
      id: randomUUID(),
      username,
      displayName: (req.body?.displayName || username).toString().trim().slice(0, 60) || username,
      passwordHash: await hashPassword(validatePassword(req.body?.password)),
      role: 'user',
      enabled: true,
      pointsBalance: 0,
      membershipLevel: 'normal',
      membershipActivatedAt: null,
      autoSave: false,
      saveDirectory: '',
      remark: '',
      checkInDays: [],
      lastCheckInAt: null,
      sessionVersion: 0,
      createdAt: now,
      updatedAt: now,
    }
    runtimeStore.users.push(user)
    await persistStore()
    setSessionCookie(res, user)
    res.status(201).json({ ok: true, user: publicUser(user) })
  } catch (error) {
    res.status(400).json({ ok: false, error: { message: error.message } })
  }
})

app.post('/api/auth/logout', (_req, res) => {
  clearSessionCookie(res)
  res.json({ ok: true })
})

app.get('/api/auth/me', requireAuth, (req, res) => res.json({ ok: true, user: publicUser(req.user) }))

app.put('/api/auth/password', requireAuth, async (req, res) => {
  try {
    if (!(await verifyPassword((req.body?.currentPassword || '').toString(), req.user.passwordHash))) {
      return res.status(400).json({ ok: false, error: { message: '当前密码不正确' } })
    }
    req.user.passwordHash = await hashPassword(validatePassword(req.body?.newPassword))
    req.user.sessionVersion = (req.user.sessionVersion || 0) + 1
    req.user.updatedAt = new Date().toISOString()
    await persistStore()
    setSessionCookie(res, req.user)
    res.json({ ok: true })
  } catch (error) {
    res.status(400).json({ ok: false, error: { message: error.message } })
  }
})

app.all('/api/payment/epay/notify', async (req, res) => {
  try {
    const values = {}
    for (const [key, value] of Object.entries({ ...(req.query || {}), ...(req.body || {}) })) {
      values[key] = Array.isArray(value) ? value[0]?.toString() || '' : (value ?? '').toString()
    }
    const config = effectivePaymentConfig(req)
    if (!config.enabled || !config.configured) throw new Error('payment disabled')
    const signType = (values.sign_type || '').trim()
    if (signType && signType.toUpperCase() !== 'MD5') throw new Error('invalid sign_type')
    if (!epayVerify(values, config.merchantKey)) throw new Error('invalid sign')
    if (values.pid !== config.merchantId || values.trade_status !== 'TRADE_SUCCESS') throw new Error('invalid notify')
    const tradeNo = (values.out_trade_no || '').trim()
    const method = (values.type || '').trim()
    const providerTradeNo = (values.trade_no || '').trim()
    if (!tradeNo || !method || !providerTradeNo || providerTradeNo.length > 128) throw new Error('invalid trade')
    const order = runtimeStore.rechargeOrders.find(item => item.tradeNo === tradeNo)
    if (!order || order.provider !== 'epay' || order.method !== method) throw new Error('order not found')
    const amountMinor = parseMoneyMinor(values.money)
    if (order.currency !== 'CNY' || order.paymentAmountMinor !== amountMinor) throw new Error('money mismatch')
    if (order.status === 'success') return res.type('text/plain').send('success')
    if (order.status !== 'pending') throw new Error('order state mismatch')
    const user = runtimeStore.users.find(item => item.id === order.userId)
    if (!user || user.enabled === false) throw new Error('user disabled')
    const now = new Date().toISOString()
    if ((order.kind || 'recharge') === 'membership') {
      const nextLevel = normalizeMembershipLevel(order.membershipLevel)
      if (nextLevel === 'normal') throw new Error('invalid membership')
      if (membershipRank(nextLevel) > membershipRank(user.membershipLevel)) {
        user.membershipLevel = nextLevel
        user.membershipActivatedAt = now
      }
    } else {
      user.pointsBalance = normalizePointCost(normalizePointCost(user.pointsBalance, 0) + normalizePointCost(order.points, 0), 0)
    }
    user.updatedAt = now
    order.status = 'success'
    order.completedAt = now
    order.providerTradeNo = providerTradeNo
    order.notifiedAmountMinor = amountMinor
    await persistStore()
    res.type('text/plain').send('success')
  } catch {
    res.type('text/plain').status(400).send('fail')
  }
})

app.use('/api', requireAuth)

app.get('/api/app-config', (req, res) => {
  const settings = runtimeStore.settings
  res.json({
    ok: true,
    configured: Boolean(settings.baseUrl && settings.apiKey),
    model: settings.model,
    copyModel: settings.copyModel,
    chatModel: settings.chatModel,
    format: settings.format,
    ...storageSettingsForUser(req.user),
    ...pointSettings(req.user),
    ...membershipView(req.user),
    ...paymentSettings({ admin: req.user.role === 'admin' }),
  })
})

app.get('/api/wallet', (req, res) => {
  const orders = runtimeStore.rechargeOrders
    .filter(order => order.userId === req.user.id)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 20)
    .map(rechargeOrderForUser)
  res.json({ ok: true, user: publicUser(req.user), settings: { ...pointSettings(req.user), ...membershipView(req.user), ...paymentSettings({ admin: req.user.role === 'admin' }) }, rechargeOrders: orders })
})

app.get('/api/check-in', (req, res) => {
  res.json({ ok: true, checkIn: checkInStatus(req.user), user: publicUser(req.user) })
})

app.post('/api/check-in', async (req, res) => {
  try {
    const result = await performCheckIn(req.user)
    res.json({ ok: true, ...result })
  } catch (error) {
    res.status(400).json({ ok: false, error: { message: error.message } })
  }
})

async function createRechargeOrder(req, res) {
  try {
    if (req.user.role === 'admin') throw new Error('管理员账户无需充值')
    const amountMinor = amountToMinor(req.body?.amount)
    if (amountMinor > 100_000_000) throw new Error('单笔充值金额过大')
    const { rechargeRate } = pointSettings()
    if (rechargeRate <= 0) throw new Error('管理员尚未配置有效的充值比例')
    const config = effectivePaymentConfig(req)
    if (!config.enabled || !config.configured) throw new Error('在线充值尚未启用，请联系管理员配置易支付参数')
    if (amountMinor < Math.round(config.minAmount * 100)) throw new Error(`最低充值金额为 ${formatMoneyMinor(Math.round(config.minAmount * 100))} 元`)
    const method = (req.body?.method || 'alipay').toString().trim()
    if (method !== 'alipay') throw new Error('当前仅支持支付宝充值')
    const amount = amountMinor / 100
    const points = normalizePointCost(amount * rechargeRate, 0)
    if (points <= 0) throw new Error('当前充值金额换算积分过低')
    const now = new Date().toISOString()
    const order = {
      id: randomUUID(),
      kind: 'recharge',
      userId: req.user.id,
      tradeNo: newTradeNo(),
      amount,
      points,
      paymentAmount: amount,
      paymentAmountMinor: amountMinor,
      currency: 'CNY',
      provider: 'epay',
      method,
      status: 'pending',
      providerTradeNo: '',
      createdAt: now,
      completedAt: null,
    }
    runtimeStore.rechargeOrders.push(order)
    await persistStore()
    res.status(201).json({ ok: true, order: rechargeOrderForUser(order), gatewayUrl: epayPurchaseUrl(config.gatewayUrl), form: paymentForm(config, order) })
  } catch (error) {
    res.status(400).json({ ok: false, error: { message: error.message } })
  }
}

app.post('/api/recharge-orders', orderRateLimit, createRechargeOrder)
app.post('/api/recharge', orderRateLimit, createRechargeOrder)

app.post('/api/membership-orders', orderRateLimit, async (req, res) => {
  try {
    if (req.user.role === 'admin') throw new Error('管理员账户无需开通会员')
    const level = normalizeMembershipLevel(req.body?.level)
    if (level === 'normal') throw new Error('请选择要开通的会员等级')
    const currentLevel = normalizeMembershipLevel(req.user.membershipLevel)
    if (membershipRank(level) <= membershipRank(currentLevel)) throw new Error(`当前已经是${membershipLabel(currentLevel)}，无需重复开通`)
    const pricing = membershipPricing()
    const { amount, targetPrice, creditAmount } = membershipUpgradeAmount(pricing, currentLevel, level)
    if (targetPrice <= 0) throw new Error(`${membershipLabel(level)}开通价格尚未配置`)
    if (amount <= 0) throw new Error(`${membershipLabel(level)}升级差价为 0，请联系管理员调整会员开通价格`)
    const amountMinor = Math.round(amount * 100)
    const config = effectivePaymentConfig(req)
    if (!config.enabled || !config.configured) throw new Error('在线支付尚未启用，请联系管理员配置易支付参数')
    const now = new Date().toISOString()
    const order = {
      id: randomUUID(),
      kind: 'membership',
      userId: req.user.id,
      tradeNo: newTradeNo(),
      amount,
      points: 0,
      membershipLevel: level,
      membershipFromLevel: currentLevel,
      membershipFullPrice: targetPrice,
      membershipCreditAmount: creditAmount,
      paymentAmount: amount,
      paymentAmountMinor: amountMinor,
      currency: 'CNY',
      provider: 'epay',
      method: 'alipay',
      status: 'pending',
      providerTradeNo: '',
      createdAt: now,
      completedAt: null,
    }
    runtimeStore.rechargeOrders.push(order)
    await persistStore()
    res.status(201).json({ ok: true, order: rechargeOrderForUser(order), gatewayUrl: epayPurchaseUrl(config.gatewayUrl), form: paymentForm(config, order) })
  } catch (error) {
    res.status(400).json({ ok: false, error: { message: error.message } })
  }
})

app.post('/api/orders/:id/cancel', orderRateLimit, async (req, res) => {
  try {
    const order = runtimeStore.rechargeOrders.find(item => item.id === req.params.id && item.userId === req.user.id)
    if (!order) return res.status(404).json({ ok: false, error: { message: '订单不存在' } })
    if (order.status !== 'pending') throw new Error('只有未完成的待支付订单可以取消')
    const now = new Date().toISOString()
    order.status = 'canceled'
    order.canceledAt = now
    await persistStore()
    res.json({ ok: true, order: rechargeOrderForUser(order) })
  } catch (error) {
    res.status(400).json({ ok: false, error: { message: error.message } })
  }
})

app.put('/api/storage-settings', async (req, res) => {
  try {
    req.user.autoSave = req.body?.autoSave === true
    req.user.saveDirectory = (req.body?.saveDirectory || '').toString().trim()
    req.user.updatedAt = new Date().toISOString()
    await persistStore()
    res.json({
      ok: true,
      settings: storageSettingsForUser(req.user),
    })
  } catch (error) {
    res.status(400).json({ ok: false, error: { message: error.message } })
  }
})

app.put('/api/admin/point-settings', requireAdmin, async (req, res) => {
  try {
    runtimeStore.settings = {
      ...runtimeStore.settings,
      rechargeRate: normalizePointCost(req.body?.rechargeRate, defaultServerSettings.rechargeRate),
      ...membershipSettingsPatch(req.body || {}),
      ...checkInSettingsPatch(req.body || {}),
    }
    runtimeStore.settings.imagePointCost = normalizePointCost(runtimeStore.settings.normalImagePrice * runtimeStore.settings.rechargeRate, defaultServerSettings.imagePointCost)
    runtimeStore.settings.copyPointCost = normalizePointCost(runtimeStore.settings.normalCopyPrice * runtimeStore.settings.rechargeRate, defaultServerSettings.copyPointCost)
    await persistStore()
    res.json({
      ok: true,
      settings: { ...pointSettings(req.user), ...membershipView(req.user) },
    })
  } catch (error) {
    res.status(400).json({ ok: false, error: { message: error.message } })
  }
})

app.put('/api/admin/payment-settings', requireAdmin, async (req, res) => {
  try {
    runtimeStore.settings = {
      ...runtimeStore.settings,
      ...paymentSettingsPatch(req.body || {}),
    }
    await persistStore()
    res.json({ ok: true, settings: paymentSettings({ admin: true }) })
  } catch (error) {
    res.status(400).json({ ok: false, error: { message: error.message } })
  }
})

app.get('/api/admin/users', requireAdmin, (req, res) => {
  res.json({ ok: true, users: runtimeStore.users.filter(item => item.role === 'user').map(adminUser), pointSettings: pointSettings(req.user), membership: membershipView(req.user), payment: paymentSettings({ admin: true }) })
})

app.post('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    const username = validateUsername(req.body?.username)
    if (runtimeStore.users.some(item => item.username.toLowerCase() === username.toLowerCase())) {
      return res.status(409).json({ ok: false, error: { message: '用户名已存在' } })
    }
    const now = new Date().toISOString()
    const user = {
      id: randomUUID(),
      username,
      displayName: (req.body?.displayName || username).toString().trim().slice(0, 60) || username,
      passwordHash: await hashPassword(validatePassword(req.body?.password)),
      role: 'user',
      enabled: req.body?.enabled !== false,
      pointsBalance: normalizePointCost(req.body?.pointsBalance, 0),
      membershipLevel: normalizeMembershipLevel(req.body?.membershipLevel),
      membershipActivatedAt: null,
      remark: (req.body?.remark || '').toString().trim().slice(0, 500),
      checkInDays: [],
      lastCheckInAt: null,
      sessionVersion: 0,
      createdAt: now,
      updatedAt: now,
    }
    runtimeStore.users.push(user)
    await persistStore()
    res.status(201).json({ ok: true, user: adminUser(user) })
  } catch (error) {
    res.status(400).json({ ok: false, error: { message: error.message } })
  }
})

app.patch('/api/admin/users/:id', requireAdmin, async (req, res) => {
  try {
    const user = runtimeStore.users.find(item => item.id === req.params.id && item.role === 'user')
    if (!user) return res.status(404).json({ ok: false, error: { message: '用户不存在' } })
    if (Object.hasOwn(req.body || {}, 'displayName')) {
      user.displayName = (req.body.displayName || user.username).toString().trim().slice(0, 60) || user.username
    }
    if (Object.hasOwn(req.body || {}, 'enabled')) {
      const nextEnabled = req.body.enabled === true
      if (user.enabled !== nextEnabled) user.sessionVersion = (user.sessionVersion || 0) + 1
      user.enabled = nextEnabled
    }
    if (Object.hasOwn(req.body || {}, 'pointsBalance')) {
      user.pointsBalance = normalizePointCost(req.body.pointsBalance, 0)
    }
    if (Object.hasOwn(req.body || {}, 'membershipLevel')) {
      const nextLevel = normalizeMembershipLevel(req.body.membershipLevel)
      const currentLevel = normalizeMembershipLevel(user.membershipLevel)
      user.membershipLevel = nextLevel
      if (nextLevel === 'normal') {
        user.membershipActivatedAt = null
      } else if (nextLevel !== currentLevel || !user.membershipActivatedAt) {
        user.membershipActivatedAt = new Date().toISOString()
      }
    }
    if (Object.hasOwn(req.body || {}, 'remark')) {
      user.remark = (req.body.remark || '').toString().trim().slice(0, 500)
    }
    if (req.body?.password) {
      user.passwordHash = await hashPassword(validatePassword(req.body.password))
      user.sessionVersion = (user.sessionVersion || 0) + 1
    }
    user.updatedAt = new Date().toISOString()
    await persistStore()
    res.json({ ok: true, user: adminUser(user) })
  } catch (error) {
    res.status(400).json({ ok: false, error: { message: error.message } })
  }
})

app.get('/api/admin/recharge-orders', requireAdmin, (req, res) => {
  const status = (req.query.status || '').toString().trim()
  const search = (req.query.search || '').toString().trim().toLowerCase()
  let orders = runtimeStore.rechargeOrders
  if (status) orders = orders.filter(order => order.status === status)
  if (search) {
    orders = orders.filter(order => {
      const user = runtimeStore.users.find(item => item.id === order.userId)
      return [order.tradeNo, order.providerTradeNo, user?.username, user?.displayName]
        .some(value => (value || '').toString().toLowerCase().includes(search))
    })
  }
  orders = orders.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 100)
  res.json({ ok: true, orders: orders.map(adminRechargeOrder) })
})

app.post('/api/admin/recharge-orders/:id/complete', requireAdmin, async (req, res) => {
  try {
    const order = runtimeStore.rechargeOrders.find(item => item.id === req.params.id)
    if (!order) return res.status(404).json({ ok: false, error: { message: '充值订单不存在' } })
    if (order.status === 'success') return res.json({ ok: true, order: adminRechargeOrder(order) })
    if (order.status !== 'pending') throw new Error('当前订单状态不能补单')
    const confirmTradeNo = (req.body?.confirmTradeNo || '').toString().trim()
    if (confirmTradeNo !== order.tradeNo) throw new Error('请填写并核对订单号后再手动确认入账')
    const user = runtimeStore.users.find(item => item.id === order.userId)
    if (!user) throw new Error('订单用户不存在')
    const now = new Date().toISOString()
    if ((order.kind || 'recharge') === 'membership') {
      const nextLevel = normalizeMembershipLevel(order.membershipLevel)
      if (nextLevel === 'normal') throw new Error('会员订单等级无效')
      if (membershipRank(nextLevel) <= membershipRank(user.membershipLevel)) {
        throw new Error(`用户当前已经是${membershipLabel(user.membershipLevel)}，请勿重复确认会员订单`)
      }
      user.membershipLevel = nextLevel
      user.membershipActivatedAt = now
    } else {
      user.pointsBalance = normalizePointCost(normalizePointCost(user.pointsBalance, 0) + normalizePointCost(order.points, 0), 0)
    }
    user.updatedAt = now
    order.status = 'success'
    order.completedAt = now
    order.providerTradeNo = `manual:${Date.now()}`
    order.manualConfirmedBy = req.user.id
    await persistStore()
    res.json({ ok: true, order: adminRechargeOrder(order), user: adminUser(user) })
  } catch (error) {
    res.status(400).json({ ok: false, error: { message: error.message } })
  }
})

app.get('/api/admin/settings', requireAdmin, (req, res) => {
  const settings = runtimeStore.settings
  res.json({
    ok: true,
    settings: {
      ...settings,
      apiKey: '',
      hasApiKey: Boolean(settings.apiKey),
      apiKeyHint: settings.apiKey ? `${settings.apiKey.slice(0, 3)}••••${settings.apiKey.slice(-4)}` : '',
      ...paymentSettings({ admin: true }),
      ...storageSettingsForUser(req.user),
    },
  })
})

app.put('/api/admin/settings', requireAdmin, async (req, res) => {
  try {
    const input = req.body || {}
    const baseUrl = (input.baseUrl || '').toString().trim().replace(/\/$/, '')
    if (!/^https?:\/\//i.test(baseUrl)) throw new Error('Base URL 必须以 http:// 或 https:// 开头')
    const model = (input.model || '').toString().trim()
    const copyModel = (input.copyModel || '').toString().trim()
    const chatModel = (input.chatModel || '').toString().trim()
    if (!model || !copyModel || !chatModel) throw new Error('请完整填写图片、文案和对话模型')
    runtimeStore.settings = {
      ...runtimeStore.settings,
      baseUrl,
      model,
      copyModel,
      chatModel,
      format: input.format === 'b64_json' ? 'b64_json' : 'url',
      ...(typeof input.apiKey === 'string' && input.apiKey.trim() ? { apiKey: input.apiKey.trim() } : {}),
    }
    req.user.autoSave = input.autoSave === true
    req.user.saveDirectory = (input.saveDirectory || '').toString().trim()
    req.user.updatedAt = new Date().toISOString()
    await persistStore()
    res.json({ ok: true, configured: Boolean(runtimeStore.settings.apiKey), settings: storageSettingsForUser(req.user) })
  } catch (error) {
    res.status(400).json({ ok: false, error: { message: error.message } })
  }
})

app.get('/api/admin/update/status', requireAdmin, requireWebUpdateEnabled, async (_req, res) => {
  try {
    const result = await checkSystemUpdate()
    res.json({ ...result, inProgress: updateInProgress })
  } catch (error) {
    res.status(500).json({ ok: false, inProgress: updateInProgress, error: { message: error.message } })
  }
})

app.post('/api/admin/update/run', requireAdmin, requireWebUpdateEnabled, async (_req, res) => {
  try {
    const result = await runSystemUpdate()
    res.status(result.ok ? 200 : 400).json({ ...result, inProgress: updateInProgress })
  } catch (error) {
    res.status(error.statusCode || 500).json({ ok: false, inProgress: updateInProgress, error: { message: error.message } })
  }
})

function runDirectoryPicker(script, req, res) {
  return new Promise((resolve, reject) => {
    let settled = false
    let child
    const cleanup = () => {
      req.off('aborted', abort)
      res.off('close', close)
    }
    const abort = () => {
      if (settled) return
      settled = true
      cleanup()
      child?.kill()
      const error = new Error('目录选择已取消')
      error.name = 'AbortError'
      reject(error)
    }
    const close = () => {
      if (!res.writableEnded) abort()
    }
    child = execFile('powershell.exe', ['-NoProfile', '-STA', '-Command', script], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 120000,
    }, (error, stdout) => {
      if (settled) return
      settled = true
      cleanup()
      if (error) reject(error)
      else resolve(stdout)
    })
    req.once('aborted', abort)
    res.once('close', close)
  })
}

app.post('/api/select-directory', async (req, res) => {
  try {
    if (process.platform !== 'win32') {
      throw new Error('当前浏览器版本暂时只支持在 Windows 中打开系统文件夹选择器')
    }
    const script = [
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
      'Add-Type -AssemblyName System.Windows.Forms',
      '$owner = New-Object System.Windows.Forms.Form',
      '$owner.ShowInTaskbar = $false',
      '$owner.TopMost = $true',
      '$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen',
      '$owner.Size = New-Object System.Drawing.Size(1, 1)',
      '$owner.Opacity = 0',
      '$owner.Show()',
      '$owner.BringToFront()',
      '$owner.Activate()',
      '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
      "$dialog.Description = '选择生成图片自动保存文件夹'",
      '$dialog.ShowNewFolderButton = $true',
      '$result = $dialog.ShowDialog($owner)',
      '$owner.Dispose()',
      'if ($result -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Write($dialog.SelectedPath) }',
    ].join('; ')
    const stdout = await runDirectoryPicker(script, req, res)
    res.json({ ok: true, directory: stdout.trim() })
  } catch (error) {
    if (error.name === 'AbortError' || res.destroyed || res.headersSent) return
    res.status(500).json({ ok: false, error: { message: error.message } })
  }
})

function safeFilename(value) {
  return value.toString().replace(/[<>:"/\\|?*\x00-\x1F]/g, '-').replace(/\s+/g, '-').slice(0, 100)
}

function isPrivateIp(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host === '0.0.0.0' || host === '::1') return true
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!ipv4) return false
  const parts = ipv4.slice(1).map(Number)
  if (parts.some(part => part < 0 || part > 255)) return true
  const [a, b] = parts
  return a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
}

function assertSafeImageUrl(value) {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('图片地址格式不受支持')
  if (isPrivateIp(url.hostname)) throw new Error('不允许保存来自内网或本机地址的远程图片')
  return url.toString()
}

function resolveImageSaveDirectory(req, directory, category) {
  if (allowArbitrarySavePaths) {
    if (!directory) throw new Error('请先设置图片保存目录')
    if (!path.isAbsolute(directory)) throw new Error('保存目录必须是完整的绝对路径')
    return path.join(directory, category)
  }
  const userFolder = safeFilename(req.user?.id || 'anonymous') || 'anonymous'
  const requestedFolder = safeFilename(directory ? path.basename(directory) : '默认保存位置') || '默认保存位置'
  const targetDirectory = path.resolve(imageSaveBaseDirectory, userFolder, requestedFolder, category)
  const relative = path.relative(imageSaveBaseDirectory, targetDirectory)
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('保存目录超出服务器允许范围')
  return targetDirectory
}

function assertImageBufferSize(buffer) {
  if (buffer.length > maxSavedImageBytes) {
    throw new Error(`图片文件过大，最大允许 ${(maxSavedImageBytes / 1024 / 1024).toFixed(0)}MB`)
  }
}

async function readImageBuffer(image) {
  let buffer
  let extension = 'png'
  let contentType = 'image/png'
  if (/^data:image\//i.test(image)) {
    const match = image.match(/^data:image\/([^;,]+);base64,(.+)$/s)
    if (!match) throw new Error('无法识别 Base64 图片数据')
    const type = match[1].replace('jpeg', 'jpg')
    extension = safeFilename(type)
    contentType = `image/${type === 'jpg' ? 'jpeg' : type}`
    buffer = Buffer.from(match[2], 'base64')
  } else if (/^https?:\/\//i.test(image)) {
    const response = await fetch(assertSafeImageUrl(image))
    if (!response.ok) throw new Error(`下载生成图片失败（${response.status}）`)
    const contentLength = Number(response.headers.get('content-length') || 0)
    if (contentLength > maxSavedImageBytes) throw new Error(`图片文件过大，最大允许 ${(maxSavedImageBytes / 1024 / 1024).toFixed(0)}MB`)
    const responseType = response.headers.get('content-type') || ''
    const type = responseType.match(/^image\/([^;]+)/i)?.[1]
    if (type) {
      extension = safeFilename(type.replace('jpeg', 'jpg'))
      contentType = `image/${type}`
    }
    buffer = Buffer.from(await response.arrayBuffer())
  } else {
    throw new Error('图片地址格式不受支持')
  }
  assertImageBufferSize(buffer)
  return { buffer, extension, contentType }
}

app.post('/api/image-blob', async (req, res) => {
  try {
    const image = (req.body?.image || '').toString()
    if (!image) throw new Error('没有可读取的图片数据')
    const { buffer, contentType } = await readImageBuffer(image)
    res.type(contentType).send(buffer)
  } catch (error) {
    res.status(400).json({ ok: false, error: { message: error.message } })
  }
})

app.post('/api/save-image', async (req, res) => {
  try {
    const directory = (req.body?.directory || '').toString().trim()
    const image = (req.body?.image || '').toString()
    const category = safeFilename(req.body?.category || '其他创作')
    const filename = safeFilename(req.body?.filename || `image-${Date.now()}`)
    if (!image) throw new Error('没有可保存的图片数据')

    const { buffer, extension } = await readImageBuffer(image)

    const targetDirectory = resolveImageSaveDirectory(req, directory, category)
    await fs.mkdir(targetDirectory, { recursive: true })
    const targetPath = path.resolve(targetDirectory, `${filename}.${extension}`)
    if (!allowArbitrarySavePaths) {
      const relative = path.relative(imageSaveBaseDirectory, targetPath)
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('保存路径超出服务器允许范围')
    }
    await fs.writeFile(targetPath, buffer)
    res.json({ ok: true, path: targetPath })
  } catch (error) {
    res.status(400).json({ ok: false, error: { message: error.message } })
  }
})

app.post('/api/test', requireAdmin, async (req, res) => {
  try {
    const baseUrl = (req.body?.baseUrl || runtimeStore.settings.baseUrl || '').toString().trim().replace(/\/$/, '')
    const apiKey = (req.body?.apiKey || runtimeStore.settings.apiKey || '').toString().trim()
    if (!/^https?:\/\//i.test(baseUrl)) throw new Error('请填写有效的 NewAPI Base URL')
    if (!apiKey) throw new Error('请填写 API Key')
    const model = (req.body?.model || '').toString().trim()
    const copyModel = (req.body?.copyModel || '').toString().trim()
    const chatModel = (req.body?.chatModel || '').toString().trim()
    const startedAt = Date.now()
    const response = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    })
    const data = await parseResponse(response)
    const models = Array.isArray(data?.data) ? data.data.map(item => item?.id).filter(Boolean) : []
    const imageModels = models.filter(id => /image|dall|flux|seedream|ideogram|recraft/i.test(id))
    const textModels = models.filter(id => !imageModels.includes(id))
    const modelAvailable = model ? models.includes(model) : null
    const copyModelAvailable = copyModel ? models.includes(copyModel) : null
    const chatModelAvailable = chatModel ? models.includes(chatModel) : null
    res.json({
      ok: true,
      latency: Date.now() - startedAt,
      model,
      modelAvailable,
      copyModel,
      copyModelAvailable,
      chatModel,
      chatModelAvailable,
      modelsCount: models.length,
      imageModels,
      textModels,
      message: modelAvailable === false
        ? `连接和鉴权正常，但模型列表中没有图片模型 ${model}`
        : copyModelAvailable === false
          ? `图片模型正常，但模型列表中没有文案分析模型 ${copyModel}`
          : chatModelAvailable === false
            ? `图片和文案模型正常，但模型列表中没有 AI 对话模型 ${chatModel}`
            : '连接、鉴权和模型检查正常',
    })
  } catch (error) {
    res.status(400).json({ ok: false, error: { message: error.message } })
  }
})

app.post('/api/generate', aiRateLimit, async (req, res) => {
  try {
    const requestedCount = Math.max(1, Math.min(10, Math.round(Number(req.body?.n) || 1)))
    const { imagePointCost } = pointSettings(req.user)
    ensurePoints(req.user, requestedCount * imagePointCost)
    const { baseUrl, apiKey } = config(req)
    const controller = abortUpstreamWhenClientLeaves(res)
    const response = await fetch(`${baseUrl}/images/generations`, {
      method: 'POST',
      signal: controller.signal,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
    })
    const data = await parseResponse(response)
    const returnedCount = Array.isArray(data?.data) ? data.data.length : requestedCount
    await consumePoints(req.user, returnedCount * imagePointCost)
    res.json({ ...data, user: publicUser(req.user) })
  } catch (error) {
    if (error.name === 'AbortError' || res.destroyed || res.headersSent) return
    res.status(error.statusCode || 400).json({ error: { message: error.message } })
  }
})

app.post('/api/edit', aiRateLimit, upload.fields([
  { name: 'image', maxCount: 10 },
  { name: 'mask', maxCount: 1 },
]), async (req, res) => {
  try {
    const images = req.files?.image || []
    const mask = req.files?.mask?.[0]
    if (!images.length) throw new Error('请选择要编辑的图片')
    const requestedCount = Math.max(1, Math.min(10, Math.round(Number(req.body?.n) || 1)))
    const { imagePointCost } = pointSettings(req.user)
    ensurePoints(req.user, requestedCount * imagePointCost)
    const { baseUrl, apiKey } = config(req)
    const controller = abortUpstreamWhenClientLeaves(res)
    const form = new FormData()
    for (const file of images) {
      form.append(images.length > 1 ? 'image[]' : 'image', new Blob([file.buffer], { type: file.mimetype }), file.originalname)
    }
    if (mask) form.append('mask', new Blob([mask.buffer], { type: 'image/png' }), 'mask.png')
    for (const [key, value] of Object.entries(req.body)) {
      if (value !== undefined && value !== '') form.append(key, value)
    }
    const response = await fetch(`${baseUrl}/images/edits`, {
      method: 'POST', signal: controller.signal, headers: { Authorization: `Bearer ${apiKey}` }, body: form,
    })
    const data = await parseResponse(response)
    const returnedCount = Array.isArray(data?.data) ? data.data.length : requestedCount
    await consumePoints(req.user, returnedCount * imagePointCost)
    res.json({ ...data, user: publicUser(req.user) })
  } catch (error) {
    if (error.name === 'AbortError' || res.destroyed || res.headersSent) return
    res.status(error.statusCode || 400).json({ error: { message: error.message } })
  }
})

app.post('/api/ecommerce-analyze', aiRateLimit, upload.array('image', 4), async (req, res) => {
  try {
    const images = req.files || []
    if (!images.length) throw new Error('请至少上传一张商品图片')
    const { copyPointCost } = pointSettings(req.user)
    ensurePoints(req.user, copyPointCost)
    const { baseUrl, apiKey } = config(req)
    const preferredModel = (req.body.model || 'gpt-5.6').toString()
    const parseCount = (value, fallback, max) => {
      if (value === undefined || value === null || value === '') return fallback
      const count = Number(value)
      return Number.isFinite(count) ? Math.max(0, Math.min(max, Math.round(count))) : fallback
    }
    const mainCount = parseCount(req.body.mainCount, 0, 10)
    const skuCount = parseCount(req.body.skuCount, 0, 10)
    const detailCount = parseCount(req.body.detailCount, 0, 30)
    const allowedSizes = new Set(['1024x1024', '1536x1024', '1024x1536', '512x512', '1024x1792', '1024x2048', '1024x2560'])
    const mainSize = allowedSizes.has(req.body.mainSize) ? req.body.mainSize : '1024x1024'
    const skuSize = allowedSizes.has(req.body.skuSize) ? req.body.skuSize : '1024x1024'
    const detailSize = allowedSizes.has(req.body.detailSize) ? req.body.detailSize : '1024x1536'
    const detailWithProductCount = Math.round(detailCount * 0.6)
    const detailWithoutProductCount = detailCount - detailWithProductCount
    const languageMap = {
      'zh-CN': '简体中文', 'zh-TW': '繁體中文', en: 'English', ja: '日本語', ko: '한국어',
      es: 'Español', 'pt-BR': 'Português do Brasil', fr: 'Français', de: 'Deutsch', it: 'Italiano',
      nl: 'Nederlands', pl: 'Polski', ru: 'Русский', uk: 'Українська', tr: 'Türkçe', ar: 'العربية',
      he: 'עברית', hi: 'हिन्दी', th: 'ไทย', vi: 'Tiếng Việt', id: 'Bahasa Indonesia',
      ms: 'Bahasa Melayu', fil: 'Filipino', sv: 'Svenska', da: 'Dansk', no: 'Norsk',
    }
    const languageCode = (req.body.language || 'zh-CN').toString()
    const targetLanguage = languageMap[languageCode] || '简体中文'
    const productDescription = (req.body.productDescription || '').toString().trim().slice(0, 1000)
    const descriptionGuidance = productDescription
      ? `用户已经人工确认了以下商品信息，可信度高于仅凭图片进行的品类猜测。你必须以此作为商品身份、用途和关键特征的主要依据，并用图片补充外观细节；即使外形容易被误认为其他商品，也不得擅自改变品类。\n【用户商品描述】\n${productDescription}\n【描述结束】`
      : '用户没有提供人工商品描述，请谨慎根据图片识别品类；无法确认时必须写入 uncertainties，不得武断判断。'
    const models = await availableModels(baseUrl, apiKey)
    const model = chooseVisionModel(models, preferredModel)
    if (!model) throw new Error('当前令牌没有可用于商品图片分析的文本模型')
    const imageContent = images.map(file => ({
      type: 'image_url',
      image_url: { url: `data:${file.mimetype};base64,${file.buffer.toString('base64')}` },
    }))
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        temperature: 0.4,
        max_tokens: 16000,
        messages: [
          { role: 'system', content: `你是资深爆款电商操盘手、视觉策划和商品文案编辑。用户只提供商品图片，你必须主动识别商品品类、视觉特征、潜在人群、使用场景、消费情绪和购买动机。严格区分图片可见事实和推测，禁止虚构材质、尺寸、成分、功效、认证、价格、销量、排名、SKU 规格或品牌背书；无法确认的内容放入 uncertainties。输出纯 JSON，字段必须为：productSummary 字符串、targetAudience 字符串、sellingPoints 字符串数组、titles 字符串数组、mainImageCopy 字符串数组、mainImagePrompts 字符串数组、skuImagePrompts 字符串数组、detailImagePrompts 字符串数组、uncertainties 字符串数组。必须严格输出 ${mainCount} 条 mainImagePrompts、${skuCount} 条 skuImagePrompts、${detailCount} 条 detailImagePrompts。所有分析、标题、卖点、说明文案和生图提示词必须使用 ${targetLanguage}；图片中要求呈现的文字也必须明确使用 ${targetLanguage}，禁止混入其他语言。每条都是可直接交给图片编辑模型的完整提示词。

分类规则：
1. mainImagePrompts：每条提示词必须明确要求使用 ${mainSize} 画布，整套主图尺寸完全一致。覆盖白底主图、核心利益点、使用场景、产品细节、氛围展示等不同角度。可以有少量简短主标题，但必须突出商品本身。
2. skuImagePrompts：每条提示词必须明确要求使用 ${skuSize} 画布，整套 SKU 图尺寸完全一致。必须生成纯商品图片。严禁任何文字、字母、数字、价格、参数、标签、表格、边框、按钮、色块说明、SKU 卡片、占位线或界面元素；只展示参考图中真实可见的商品款式，使用干净纯色或透明感背景、统一角度和清晰产品摄影。若只有一个款式，就通过正面、侧面、俯视、组合陈列等角度形成 SKU 图，不得虚构颜色和规格。
3. detailImagePrompts：每条提示词必须明确要求严格使用 ${detailSize} 画布，整套详情图的尺寸和比例必须完全一致，禁止输出其他宽高比。必须生成完成度高的图文详情页，不能只预留空白、占位框或指示线。严格规划 ${detailWithProductCount} 张展示商品的详情图和 ${detailWithoutProductCount} 张不展示商品的关联元素详情图；数组中每条提示词开头必须明确使用“【展示商品】”或“【关联元素】”标记，并保证数量准确。
   - 【展示商品】：画面中出现完整商品或有效商品细节，依次覆盖品牌首屏、完整商品加局部细节、核心卖点证据、真实使用场景、使用方式、包装展示等。商品局部特写不能占满整张图，必须同时出现完整商品参照。
   - 【关联元素】：画面中严禁出现商品本体，也不要出现相似替代商品。使用与商品相关的生活场景、人物动作、原料或材质氛围、环境细节、用户痛点、情绪画面、搭配物件来承接叙事。例如杯具可展示清晨阳光、咖啡豆、书本、办公桌、通勤包、阅读角或放松氛围，但不出现杯子。此类图片应作为详情页的视觉过渡和情绪铺垫。
   整套依次使用品牌首屏、生活场景、痛点与解决方案、商品细节、核心卖点、多场景适配、使用步骤、情绪氛围、购买收口等不同主题。优先采用类似杂志广告的成熟版式，不得出现无意义空白线框。每张详情图要明确写出需要在图片中真实呈现的 1 个简短主标题和 2–4 条短说明，并指定清晰可读的排版位置、字号层级和图文关系；不要生成长段文字。文案只能描述图片可确认的外观、场景和通用使用价值，未知参数用中性表达，不得虚构。

所有图片必须严格保持参考商品的造型、比例、颜色、结构、商标和包装文字一致。` },
          { role: 'user', content: [
            { type: 'text', text: `${descriptionGuidance}\n\n请分析商品图片并规划完整电商套图：商品主图 ${mainCount} 张（${mainSize}）、SKU 图 ${skuCount} 张（${skuSize}）、详情图 ${detailCount} 张（${detailSize}）。目标内容语言是 ${targetLanguage}。每张图的提示词必须用途不同、前后连贯且可以直接生成。所有分析、卖点、标题和生图提示词必须始终保持与人工确认的商品身份一致。不要向用户提问。` },
            ...imageContent,
          ] },
        ],
      }),
    })
    const data = await parseResponse(response)
    const content = data?.choices?.[0]?.message?.content
    const result = parseModelJson(content)
    result.mainImagePrompts = (Array.isArray(result.mainImagePrompts) ? result.mainImagePrompts : []).slice(0, mainCount)
    result.skuImagePrompts = (Array.isArray(result.skuImagePrompts) ? result.skuImagePrompts : []).slice(0, skuCount)
    result.detailImagePrompts = (Array.isArray(result.detailImagePrompts) ? result.detailImagePrompts : []).slice(0, detailCount)
    await consumePoints(req.user, copyPointCost)
    res.json({ ...result, analyzedBy: model, requestedModel: preferredModel, user: publicUser(req.user) })
  } catch (error) {
    res.status(error.statusCode || 400).json({ error: { message: error.message } })
  }
})

app.post('/api/chat', aiRateLimit, async (req, res) => {
  try {
    const { baseUrl, apiKey } = config(req)
    const model = (req.body?.model || 'gpt-5.5').toString().trim()
    const inputMessages = Array.isArray(req.body?.messages) ? req.body.messages : []
    const messages = inputMessages.slice(-30).map(item => ({
      role: item?.role === 'assistant' ? 'assistant' : 'user',
      content: (item?.content || '').toString().slice(0, 20000),
    })).filter(item => item.content.trim())
    if (!messages.length) throw new Error('请输入聊天内容')
    const allowLocalCommands = chatWorkspaceCommandsEnabled && req.user?.role === 'admin' && process.platform === 'win32' && wantsLocalWorkspaceAccess(messages)
    const conversation = [
      {
        role: 'system',
        content: allowLocalCommands
          ? `你是一位友好、专业且可靠的中文 AI 助手。优先使用简体中文回答。你可以通过 run_workspace_powershell 工具在当前项目目录执行必要的 PowerShell 命令来检查、构建、测试或启动项目。当前项目目录是 ${__dirname}。只执行完成用户请求所需的命令；不要声称没有终端或命令工具；如果执行了命令，要根据真实输出回答。`
          : '你是一位友好、专业且可靠的中文 AI 助手。优先使用简体中文回答，除非用户指定其他语言。回答清晰、实用，不虚构无法确认的事实。',
      },
      ...messages,
    ]
    const tools = allowLocalCommands ? [{
      type: 'function',
      function: {
        name: 'run_workspace_powershell',
        description: '在当前项目目录执行 PowerShell 命令，并返回 stdout、stderr、退出码、耗时和工作目录。仅用于检查、构建、测试或启动当前项目。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            command: {
              type: 'string',
              description: '要执行的 PowerShell 命令。工作目录固定为当前项目目录。',
            },
            timeoutMs: {
              type: 'number',
              description: '超时时间，单位毫秒，范围 1000 到 120000。',
            },
          },
          required: ['command'],
        },
      },
    }] : undefined
    let data
    for (let turn = 0; turn < 4; turn += 1) {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: conversation,
          ...(tools ? { tools, tool_choice: 'auto' } : {}),
        }),
      })
      data = await parseResponse(response)
      const message = data?.choices?.[0]?.message || {}
      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : []
      if (!toolCalls.length) break
      conversation.push(message)
      for (const call of toolCalls) {
        const args = parseToolArgs(call?.function?.arguments)
        const command = (args.command || '').toString().trim()
        const result = command
          ? await runChatCommand(command, args.timeoutMs)
          : { error: '缺少 command 参数' }
        conversation.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(result),
        })
      }
    }
    const rawContent = data?.choices?.[0]?.message?.content
    const content = extractMessageContent(rawContent)
    if (!content.trim()) throw new Error('模型没有返回可显示的回复')
    res.json({ content, model: data?.model || model })
  } catch (error) {
    res.status(400).json({ error: { message: error.message } })
  }
})

if (process.env.NODE_ENV === 'production') {
  const distDirectory = path.join(__dirname, 'dist')
  app.use(express.static(distDirectory, {
    index: false,
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-store')
      } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
      } else {
        res.setHeader('Cache-Control', 'no-cache')
      }
    },
  }))
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api/')) return next()
    res.setHeader('Cache-Control', 'no-store')
    res.sendFile(path.join(distDirectory, 'index.html'))
  })
}

const isMainModule = path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)

export function startServer(port = Number(process.env.PORT || 8787), host = process.env.HOST || (isProduction && !isElectron ? '0.0.0.0' : '127.0.0.1')) {
  const server = createServer(app)

  server.on('listening', () => {
    const actualPort = server.address().port
    console.log(`Image Studio API: http://${host}:${actualPort}`)
  })

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`Image Studio API 启动失败：${host}:${port} 端口已被占用`)
    } else {
      console.error('Image Studio API 启动失败：', error)
    }
    if (isMainModule) process.exitCode = 1
  })

  server.listen(port, host)
  server.requestTimeout = localRequestTimeoutMs
  server.headersTimeout = localRequestTimeoutMs + 1000
  server.timeout = localRequestTimeoutMs
  return server
}

if (isMainModule) startServer()
