/**
 * 猪齿鱼（Choerodon）接入的 Host 半区。
 * 负责：浏览器回环登录、平台上下文、项目级代理会话、模型目录，以及把模型路由写进
 * `@deepseek-ai/dsh-llm-pi-ai` 的那一行配置。渲染全部在 client.js。
 *
 * 协议来源：Choerodon Harness 0.1.6 源码（auth/browser-login.ts、platform-client.ts、
 * local-runtime.ts 的 local-llm 代理）。模型端点是会话级的，baseURL 必须带服务端会话 id。
 */
import { createServer } from 'node:http'
import { createDecipheriv, createECDH, createHash, hkdfSync, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { hostname } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { execFile } from 'node:child_process'

const OPENAI_ROUTE = 'choerodon'
const ANTHROPIC_ROUTE = 'choerodon-anthropic'
const ROUTES = [OPENAI_ROUTE, ANTHROPIC_ROUTE]
const LOGIN_KEY_INFO = 'choerodon-harness/browser-login/v1'
const LOGIN_AAD = 'choerodon-harness-login:'
const MAX_BODY = 1 << 20
/** 单个附件上限：走的平台分块上传，实测 50MB 没问题，留一倍余量。 */
const MAX_ATTACHMENT = 100 * 1024 * 1024

const DEFAULTS = {
  apiOrigin: 'https://api.choerodon.com.cn',
  portalOrigin: 'https://choerodon.com.cn',
  oauthClientId: 'choerodonparent',
  oauthRedirectUri: 'https://www.choerodon.com.cn/',
  tokenClient: 'client',
  tokenSecret: 'secret',
  llmRowId: 'llm-pi-ai',
  proxyTitle: 'DSH 模型代理',
}

const DEFAULT_CONTEXT = 131072
const DEFAULT_MAX_TOKENS = 8192
/** 会话摘要留多少条：一篇工作项正文几 KB，留多了 state.json 会被撑大。 */
const SESSION_BRIEF_LIMIT = 40

/** 看板的泳道顺序：按研发生命周期排，未列出的状态排在后面。 */
const STATUS_RANK = [
  '暂挂',
  '设计评审',
  '故事-待分解',
  '待开发',
  '待处理',
  '开发中',
  '故事-实现中',
  '处理中',
  '联调中',
  '待测试',
  '测试中',
  '已合并',
  'DEV-已完成',
  'SIT-待发布',
  'SIT-测试中',
  'SIT-已完成',
  'UAT-待发布',
  'UAT-测试中',
  'UAT-已完成',
  'PRD-待发布',
  '故事-已完成',
  '已完成',
  '取消',
]
const TYPE_RANK = { todo: 0, doing: 1, done: 2 }
const BOARD_LANE_ITEMS = 12
const STATUS_TTL = 12 * 60 * 60 * 1000
/** 新任务基线的取样口径版本；换口径就 +1，旧基线会被静默重建。 */
const BASELINE_VERSION = 2
/** 宿主半区能力版本：与 package.json 的 version 同步递增，界面拿它对账。 */
const HOST_VERSION = '0.9.1'

function statusRank(status) {
  const index = STATUS_RANK.indexOf(status.name)
  if (index >= 0) return index
  return STATUS_RANK.length + (TYPE_RANK[status.type] ?? 3) * 100
}

function orderStatuses(list) {
  return [...list].sort((a, b) => statusRank(a) - statusRank(b) || String(a.name).localeCompare(String(b.name)))
}

function slugify(summary, issueNum) {
  // 分支名只用 ASCII：中文概要无法稳定出现在各种 Git 工具与 CI 里。
  const ascii = String(summary)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .filter(Boolean)
    .slice(0, 6)
    .join('-')
    .slice(0, 48)
    .replace(/-+$/g, '')
  return ascii ? `${issueNum}-${ascii}` : String(issueNum)
}

function safeName(value) {
  return String(value)
    .replace(/[^\w.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
}

/** 两个字符串的最长公共子串长度，用于把问题摘要匹配到 docs 下的主题目录。 */
function longestCommon(a, b) {
  const left = String(a)
  const right = String(b)
  if (!left || !right) return 0
  let best = 0
  const previous = new Array(right.length + 1).fill(0)
  for (let i = 1; i <= left.length; i++) {
    let diagonal = 0
    for (let j = 1; j <= right.length; j++) {
      const carry = previous[j]
      previous[j] = left[i - 1] === right[j - 1] ? diagonal + 1 : 0
      if (previous[j] > best) best = previous[j]
      diagonal = carry
    }
  }
  return best
}

/** 匹配问题与 docs 主题目录：返回命中目录与备选。 */
function pickDocTopic(topics, summary) {
  const textValue = String(summary ?? '')
  let best = null
  for (const topic of topics) {
    if (topic.number === '90' || topic.number === '00') continue
    // 只用主题名本身比，中文短词 2 字重合（如「预算」）会把无关问题也吸进来，至少 3 字才算。
    const length = longestCommon(topic.name, textValue)
    const score = length / Math.max(1, topic.name.length)
    if (!best || score > best.score) best = { topic, score, length }
  }
  if (best && best.length >= 3 && best.score >= 0.34) return { target: best.topic, score: best.score }
  const fallback = topics.find((topic) => topic.number === '90') ?? topics.find((topic) => topic.number === '00')
  return { target: fallback ?? null, score: best?.score ?? 0 }
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise) => {
    execFile(
      command,
      args,
      { cwd: options.cwd, timeout: options.timeout ?? 60000, windowsHide: true, env: options.env ?? process.env },
      (error, stdout, stderr) => {
        resolvePromise({
          ok: !error,
          code: error?.code ?? 0,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          message: error?.message ?? '',
        })
      },
    )
  })
}

/** 操作记录里这些字段平台只给英文键，翻成人话才好读。 */
const ACTIVITY_FIELDS = {
  assignee: '经办人',
  status: '状态',
  timeestimate: '剩余预估',
  timeoriginalestimate: '原始预估',
  timespent: '耗费时间',
  WorklogId: '工作日志',
  description: '描述',
  summary: '概要',
  priority: '优先级',
  issuetype: '类型',
  type: '类型',
  resolution: '解决结果',
  reporter: '报告人',
  sprint: '冲刺',
  Sprint: '冲刺',
  epic: '史诗',
  Component: '模块',
  'Epic Link': '史诗',
  'Fix Version': '修复版本',
  'Actual Start Time': '实际开始',
  'Actual End Time': '实际结束',
  'Estimated Start Time': '计划开始',
  'Estimated End Time': '计划结束',
  Rank: '排名',
  rank: '排名',
  Attachment: '附件',
  Comment: '评论',
  comment: '评论',
  attach: '附件',
  lastUpdateDate: '更新时间',
  predictedStartTime: '预计开始',
  predictedEndTime: '预计结束',
  actualStartTime: '实际开始',
  actualEndTime: '实际结束',
  remainingTime: '剩余预估',
  estimatedStartTime: '预计开始',
  estimatedEndTime: '预计结束',
}

function activityFieldName(row, field) {
  const named = text(row?.fieldName, 40)
  if (named) return named
  return ACTIVITY_FIELDS[field] ?? field
}

/**
 * 空值统一成空串（渲染成「空」）；富文本折成纯文本；其它值截断到 200 字。
 *
 * <p>评论正文是<b>两层</b>转义：接口给的是 {@code &lt;p&gt;123 &lt;span data-mention-user-id&gt;@某人&lt;/span&gt;&lt;/p&gt;}，
 * 解开实体后标签才现形。所以要反复「折标签 → 解实体」几轮，否则读出来还是一串标签。</p>
 */
function activityValue(raw) {
  const value = raw === null || raw === undefined ? '' : String(raw).trim()
  if (!value) return ''
  const looksMarkup = /<[a-z!/][\s\S]*>/i.test(value) || /&lt;|&gt;|&quot;|&#39;|&amp;/i.test(value)
  if (!looksMarkup) return value.slice(0, 200)
  let text = value
  for (let round = 0; round < 4; round++) {
    const next = plainDescription(text, 400)
    if (next === text || !/<[a-z!/][^>]*>/i.test(next)) {
      text = next
      break
    }
    text = next
  }
  return text.replace(/\s+/g, ' ').trim().slice(0, 200)
}

function roundHours(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0 || number > 999.9) return null
  return Math.round(number * 10) / 10
}

/**
 * 工时日志的「工作日期」：平台要 `yyyy-MM-dd HH:mm:ss`，
 * 浏览器 datetime-local 给的是 `yyyy-MM-ddTHH:mm`，这里统一补秒。
 */
function workLogDate(value) {
  const pad = (number) => String(number).padStart(2, '0')
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) {
    const now = new Date()
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  }
  const normalized = raw.replace('T', ' ')
  const match = normalized.match(/^(\d{4}-\d{2}-\d{2})(?:[ ](\d{2}:\d{2})(?::(\d{2}))?)?$/)
  if (!match) throw new Error('工作日期格式应为 YYYY-MM-DD HH:mm:ss')
  const [hour, minute] = (match[2] ?? '00:00').split(':')
  return `${match[1]} ${hour}:${minute}:${match[3] ?? '00'}`
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function workItemSummary(raw) {
  return {
    id: String(raw.issueId ?? ''),
    num: String(raw.issueNum ?? ''),
    summary: text(raw.summary, 400),
    typeCode: text(raw.typeCode, 40),
    typeName: text(raw.issueTypeVO?.name, 80),
    statusId: String(raw.statusMapVO?.id ?? raw.statusId ?? ''),
    statusName: text(raw.statusMapVO?.name, 80),
    statusType: text(raw.statusMapVO?.type, 20),
    assigneeName: text(raw.assigneeName ?? raw.assigneeRealName, 120),
    reporterName: text(raw.reporterName ?? raw.reporterRealName, 120),
    priority: text(raw.priorityVO?.name, 40),
    priorityColor: text(raw.priorityVO?.colour, 20),
    epicName: text(raw.epicName ?? raw.issueEpicName, 120),
    sprintName: text(raw.issueSprintVOS?.[0]?.sprintName ?? raw.activeSprint?.sprintName, 120),
    estimatedStart: text(raw.estimatedStartTime, 32),
    estimatedEnd: text(raw.estimatedEndTime, 32),
    estimateTime: raw?.estimateTime === undefined || raw?.estimateTime === null ? null : Number(raw.estimateTime),
    remainingTime: raw?.remainingTime === undefined || raw?.remainingTime === null ? null : Number(raw.remainingTime),
    creationDate: text(raw.creationDate, 32),
  }
}

function dataDir() {
  const home = process.env.DSH_HOME || process.env.DSH_PROFILE_DIR
  if (!home) throw new Error('无法确定 DSH_HOME，插件状态无处存放')
  return join(home, 'choerodon-harness')
}

function text(value, max = 512) {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

/**
 * 猪齿鱼的工作项描述是富文本：段落、`<br>`、图片都在 HTML 里。
 * 系统和会话只吃纯文本，这里把块级标签折成换行，图片折成标题行，再去标签解实体。
 *
 * <p>正文里可能夹着<b>真标签</b>（旧的 @ 提及写法把 {@code <span>} 当文本存了下来），
 * 所以解完实体后若又冒出标签，要再折一轮；连续两轮仍不变才算收敛，避免无限递归。</p>
 */
function plainDescription(raw, max = 4000) {
  const html = String(raw ?? '')
  if (!html) return ''
  let current = html
  for (let round = 0; round < 3; round++) {
    const folded = current
      .replace(/<figure[^>]*>[\s\S]*?<\/figure>/gi, '\n')
      .replace(/<img[^>]*>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6]|blockquote)>/gi, '\n')
    const text = folded
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
    if (text === current || !/<[a-z!/][^>]*>/i.test(text)) {
      current = text
      break
    }
    current = text
  }
  return current.slice(0, max)
}

/** 描述里的图片地址：客户端渲染缩略图、会话首条消息里给链接。 */
function descriptionImages(raw, limit = 4) {
  const html = String(raw ?? '')
  const urls = []
  for (const match of html.matchAll(/<img[^>]*src="([^"]+)"/gi)) {
    const url = match[1]
    if (!/^https?:\/\//i.test(url) || urls.includes(url)) continue
    urls.push(url)
    if (urls.length >= limit) break
  }
  return urls
}

/** 绑定工作项时的问题转成人能读的提示。 */
function bindingWarnings(binding) {
  const warnings = []
  if (binding?.assigneeError) warnings.push(`经办人没设上：${binding.assigneeError}`)
  if (binding?.statusError) warnings.push(`状态没自动流转：${binding.statusError}`)
  return warnings
}

/**
 * 会话首条用户消息（已废弃，勿再用作会话种子）。
 *
 * <p>种子里的 user/message 会占住 v4 会话日志的<b>第一个表层节点</b>，而 v4 校验要求第一个
 * 表层节点必须是 {@code system/message}（{@code system/message requires a protected first surface
 * head}）。一旦写进去，这条日志之后每次打开都过不了校验，前端显示
 * 「历史加载失败：stored log is corrupt」。工作项全文改由 {@code systemPrompt.context} 注入。</p>
 *
 * @deprecated 会话种子只用 {@code systemPrompt.context}；保留函数仅为兼容旧调用点。
 */
function userMessageEvent(rawText) {
  return {
    type: 'user/message',
    seq: 0,
    time: Date.now(),
    data: {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: String(rawText).slice(0, 12000) }],
      source: { kind: 'user' },
    },
    surfaceOp: 'append',
  }
}

function idOf(value) {
  if (typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\r\n]/.test(value)) return value
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value)
  throw new Error('服务返回的标识无效')
}

function disabled(value) {
  return value === false || value === 0 || value === '0' || value === 'false'
}

function yes(value) {
  return value === true || value === 1 || value === '1' || value === 'true'
}

function replyJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

function replyHtml(res, status, title, message) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  })
  res.end(
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${title}</title>` +
      '<style>body{font:16px/1.8 system-ui;margin:15vh auto;padding:24px;max-width:520px;color:#252833}' +
      'h1{font-size:22px}p{color:#747b89}</style>' +
      `<h1>${title}</h1><p>${message}</p></html>`,
  )
}

async function readBody(req, limit = MAX_BODY) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (!size) return {}
  const raw = Buffer.concat(chunks).toString('utf8')
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}

function pickModels(rawList) {
  const items = []
  const seen = new Set()
  for (const raw of Array.isArray(rawList) ? rawList : []) {
    if (!raw || typeof raw !== 'object') continue
    const name = text(raw.model, 200)
    const key = text(raw.modelKey, 200)
    const provider = text(raw.provider, 32).toUpperCase()
    if (!name || !key) continue
    if (provider !== 'OPENAI' && provider !== 'ANTHROPIC') continue
    const dedupe = `${provider}:${key}`
    if (seen.has(dedupe)) continue
    seen.add(dedupe)
    const advanced = raw.advancedConfig && typeof raw.advancedConfig === 'object' ? raw.advancedConfig : {}
    const flags = advanced.flags && typeof advanced.flags === 'object' ? advanced.flags : {}
    items.push({
      id: key,
      modelKey: key,
      serverName: name,
      // 展示名加前缀；请求体里的 model 必须是服务端 modelKey，因此 id 保持原样。
      name: `choerodon-${name}`,
      provider,
      contextWindow: Number(advanced.inputContextLength) || DEFAULT_CONTEXT,
      maxTokens: Number(advanced.maxOutputTokens) || DEFAULT_MAX_TOKENS,
      imageInput: flags.imageInput === true,
      thinking: flags.thinking === true,
    })
  }
  return items
}

function wireModel(item) {
  return {
    id: item.id,
    name: item.name,
    contextWindow: item.contextWindow,
    maxTokens: item.maxTokens,
    // 猪齿鱼这几个项目模型都吃图片；不声明的话 DSH 会把图片压成占位文本。
    input: item.imageInput ? ['text', 'image'] : ['text'],
  }
}

export class ChoerodonPlugin {
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = { ...DEFAULTS, ...(config && typeof config === 'object' ? config : {}) }
    this.state = {
      version: 1,
      token: null,
      user: null,
      device: null,
      organizations: [],
      tenantId: null,
      projects: [],
      projectId: null,
      proxies: {},
      models: [],
      proxyError: null,
      routeError: null,
      projectError: null,
      routeEntry: null,
      worktrees: [],
      preferredModel: null,
      userCache: null,
      epicCache: null,
      /** 新任务角标的基线：只存见过的 issueId 与所属 组织:项目:用户。 */
      taskBaseline: null,
    }
    this.pendingLogin = null
    this.loadError = null
    /** 本次进程加载 Host 的时间，界面用它判断是不是旧进程。 */
    this.startedAt = Date.now()
    // 只在本进程内去重，不落盘：避免重启后误以为配置已写过。
    this.routesHash = null
    // 本插件创建过的会话 id（宿主持有句柄，插件只用来判断「同分支是否见过」）。
    this.sessions = new Set()
    /** 工作项类型清单缓存：建子任务要挑 sub_task，别每次现查。 */
    this.typesCache = null
    this.ready = this.load().catch((error) => {
      this.loadError = error instanceof Error ? error : new Error('插件状态初始化失败')
    })
  }

  // ---------- 持久化 ----------

  filePath() {
    return join(dataDir(), 'state.json')
  }

  async load() {
    await mkdir(dataDir(), { recursive: true })
    try {
      const raw = await readFile(this.filePath(), 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && parsed.version === 1) this.state = { ...this.state, ...parsed }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    if (!this.state.device) {
      this.state.device = {
        deviceId: randomUUID(),
        deviceName: hostname().slice(0, 128),
        deviceSecret: randomBytes(32).toString('base64url'),
      }
      await this.persist()
    }
  }

  async persist() {
    const target = this.filePath()
    const temp = `${target}.${randomUUID()}.tmp`
    await writeFile(temp, JSON.stringify(this.state, null, 2), { mode: 0o600 })
    await rename(temp, target)
  }

  // ---------- 平台请求 ----------

  headers(tenantId) {
    const headers = {
      Accept: 'application/json',
      'H-Menu-Id': '0',
      'H-Tenant-Id': tenantId ?? this.state.tenantId ?? '0',
    }
    if (this.state.token) headers.Authorization = `bearer ${this.state.token.accessToken}`
    return headers
  }

  deviceHeaders() {
    const d = this.state.device
    return {
      'X-Harness-Device-Id': d.deviceId,
      'X-Harness-Device-Name': 'DSH Choerodon',
      'X-Harness-Device-Secret': d.deviceSecret,
      'X-Harness-Client': 'DESKTOP',
    }
  }

  conversationBase(tenantId, projectId) {
    return (
      `/cagent/v1/organizations/${encodeURIComponent(tenantId)}` +
      `/projects/${encodeURIComponent(projectId)}/conversations`
    )
  }

  async requestJson(path, options = {}) {
    const { method = 'GET', tenantId, body, extraHeaders } = options
    if (!this.state.token) throw new Error('请先登录猪齿鱼')
    if (this.state.token.expiresAt && this.state.token.expiresAt <= Date.now()) {
      this.state.token = null
      await this.persist()
      throw new Error('登录已过期，请重新登录猪齿鱼')
    }
    const url = new URL(path, this.config.apiOrigin)
    const headers = { ...this.headers(tenantId), ...(extraHeaders ?? {}) }
    // multipart 由 fetch 自己带 boundary，不能手写 Content-Type；rawBody 是已经编码好的字符串
    const { formData, rawBody } = options
    if (formData === undefined && rawBody === undefined && body !== undefined) headers['Content-Type'] = 'application/json'
    const response = await fetch(url, {
      method,
      headers,
      body: formData ?? rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      signal: AbortSignal.timeout(60_000),
    })
    if (response.status === 401) {
      this.state.token = null
      await this.persist()
      throw new Error('登录已失效，请重新登录猪齿鱼')
    }
    const raw = await response.text()
    let parsed
    if (raw) {
      try {
        parsed = JSON.parse(raw)
      } catch {
        parsed = undefined
      }
    }
    if (!response.ok) {
      const detail = parsed && typeof parsed === 'object' ? text(parsed.message, 200) : ''
      throw new Error(`请求失败（HTTP ${response.status}）${detail ? `：${detail}` : ''}`)
    }
    if (parsed && typeof parsed === 'object' && parsed.failed === true) {
      throw new Error(text(parsed.message, 300) || '服务端拒绝了该请求')
    }
    return parsed
  }

  // ---------- 登录 ----------

  async startLogin() {
    await this.closeLogin()
    const state = randomBytes(32).toString('base64url')
    const ecdh = createECDH('prime256v1')
    const publicKey = ecdh.generateKeys().toString('base64url')
    const pending = {
      state,
      ecdh,
      busy: false,
      consumed: false,
      closed: false,
      expiresAt: Date.now() + 600_000,
      port: 0,
      server: null,
      result: null,
    }
    pending.server = createServer((req, res) => {
      this.handleCallback(pending, req, res).catch(() => {
        if (!res.headersSent) replyHtml(res, 400, '登录未完成', '登录请求处理失败，请返回 DSH 重新发起。')
        else res.destroy()
      })
    })
    pending.server.requestTimeout = 10_000
    pending.server.headersTimeout = 10_000
    await new Promise((resolve, reject) => {
      pending.server.once('error', reject)
      pending.server.listen(0, '127.0.0.1', () => {
        pending.server.off('error', reject)
        resolve()
      })
    })
    pending.server.on('error', () => {})
    pending.port = pending.server.address().port
    this.pendingLogin = pending
    const url = new URL(this.config.portalOrigin)
    url.hash =
      '/harness/authorize?' +
      new URLSearchParams({
        version: '1',
        port: String(pending.port),
        state,
        public_key: publicKey,
        device: hostname().slice(0, 128),
        created_at: String(Date.now()),
      }).toString()
    return { url: url.href, state, expiresAt: pending.expiresAt }
  }

  async closeLogin() {
    const pending = this.pendingLogin
    this.pendingLogin = null
    if (!pending) return
    pending.closed = true
    try {
      pending.server.close()
      pending.server.closeIdleConnections?.()
    } catch {}
  }

  loginStatus() {
    const pending = this.pendingLogin
    if (!pending) return { status: 'idle' }
    if (pending.result) return pending.result
    if (Date.now() >= pending.expiresAt) return { status: 'expired' }
    return { status: 'pending', expiresAt: pending.expiresAt }
  }

  async handleCallback(pending, req, res) {
    if (pending.closed || pending.consumed || Date.now() >= pending.expiresAt) {
      return replyHtml(res, 410, '登录未完成', '此登录请求已过期或已使用，请返回 DSH 重新发起。')
    }
    if (req.socket.remoteAddress !== '127.0.0.1') return replyHtml(res, 404, '登录未完成', '来源无效。')
    if (req.headers.host !== `127.0.0.1:${pending.port}`) return replyHtml(res, 404, '登录未完成', '来源无效。')
    if (req.url !== `/harness/callback/${pending.state}`) return replyHtml(res, 404, '登录未完成', '来源无效。')
    if (req.method !== 'POST') return replyHtml(res, 404, '登录未完成', '来源无效。')
    const allowedOrigins = new Set([this.config.portalOrigin, new URL(this.config.oauthRedirectUri).origin])
    if (!allowedOrigins.has(req.headers.origin ?? '')) return replyHtml(res, 403, '登录未完成', '来源站点未授权。')
    if (!String(req.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded')) {
      return replyHtml(res, 403, '登录未完成', '请求格式无效。')
    }
    if (pending.busy) return replyHtml(res, 409, '登录未完成', '已有登录请求在处理。')
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > 32_768) return replyHtml(res, 413, '登录未完成', '请求体过大。')
      chunks.push(chunk)
    }
    pending.busy = true
    try {
      const parsed = await this.openEnvelope(pending, Buffer.concat(chunks)).catch(() => null)
      if (!parsed) {
        pending.busy = false
        return replyHtml(res, 400, '登录未完成', '收到的认证信息无法解析，请返回 DSH 重新发起。')
      }
      if (parsed.cancel) {
        pending.consumed = true
        pending.result = { status: 'cancelled' }
        return replyHtml(res, 200, '已取消登录', 'DSH 未获得认证信息，此标签页可以关闭。')
      }
      this.state.token = parsed.credential
      this.state.user = null
      await this.persist()
      await this.loadContext()
      pending.consumed = true
      pending.result = { status: 'done' }
      replyHtml(res, 200, '登录成功', '已登录猪齿鱼。请返回 DSH，此标签页可以关闭。')
    } catch (error) {
      pending.busy = false
      pending.result = { status: 'error', message: error instanceof Error ? error.message : '登录失败' }
      replyHtml(res, 401, '登录未完成', 'DSH 未能完成登录，请返回重新发起。')
    } finally {
      pending.busy = false
      setTimeout(() => {
        this.closeLogin().catch(() => {})
      }, 2_000).unref?.()
    }
  }

  async openEnvelope(pending, body) {
    const params = new URLSearchParams(body.toString('utf8'))
    if (params.getAll('payload').length !== 1) return null
    let envelope
    try {
      envelope = JSON.parse(params.get('payload') ?? '')
    } catch {
      return null
    }
    if (envelope.version !== 1 || envelope.state !== pending.state) return null
    if (envelope.action === 'cancel') return { cancel: true }
    const decode = (value, max) => {
      if (typeof value !== 'string' || value.length > max || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('envelope')
      return Buffer.from(value, 'base64url')
    }
    const peer = decode(envelope.publicKey, 100)
    const iv = decode(envelope.iv, 20)
    const data = decode(envelope.data, 20_000)
    if (peer.length !== 65 || iv.length !== 12 || data.length < 17) return null
    const secret = pending.ecdh.computeSecret(peer)
    const key = Buffer.from(hkdfSync('sha256', secret, Buffer.from(pending.state), Buffer.from(LOGIN_KEY_INFO), 32))
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAAD(Buffer.from(`${LOGIN_AAD}${pending.state}`))
    decipher.setAuthTag(data.subarray(-16))
    const plain = JSON.parse(
      Buffer.concat([decipher.update(data.subarray(0, -16)), decipher.final()]).toString('utf8'),
    )
    if (plain.state !== pending.state) return null
    const credential = plain.credential
    if (!credential || credential.tokenType !== 'bearer') return null
    if (!/^[\x21-\x7E]{1,8192}$/.test(credential.accessToken ?? '')) return null
    if (credential.expiresAt !== null && !(Number.isSafeInteger(credential.expiresAt) && credential.expiresAt > Date.now())) {
      return null
    }
    return {
      credential: {
        accessToken: credential.accessToken,
        tokenType: 'bearer',
        expiresAt: credential.expiresAt ?? null,
      },
      userId: text(plain.userId, 512),
    }
  }

  async useToken(token) {
    const value = typeof token === 'string' ? token.trim().replace(/^bearer\s+/i, '') : ''
    if (!/^[\x21-\x7E]{1,8192}$/.test(value)) throw new Error('access_token 格式不正确')
    this.state.token = { accessToken: value, tokenType: 'bearer', expiresAt: null }
    await this.persist()
    await this.loadContext()
    return { ok: true }
  }

  /** 密码模式换取 token；密码只在本次请求内使用，不落盘。 */
  async usePassword(username, password) {
    const account = typeof username === 'string' ? username.trim() : ''
    const secret = typeof password === 'string' ? password : ''
    if (!account || !secret) throw new Error('请填写账号和密码')
    const basic = Buffer.from(`${this.config.tokenClient}:${this.config.tokenSecret}`).toString('base64')
    const response = await fetch(new URL('/oauth/oauth/token', this.config.apiOrigin), {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({ grant_type: 'password', username: account, password: secret }),
      redirect: 'error',
      credentials: 'omit',
      signal: AbortSignal.timeout(30_000),
    })
    const raw = await response.text()
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {}
    if (!parsed?.access_token) {
      const reason =
        text(parsed?.message, 200) ||
        text(parsed?.error_description, 200) ||
        `登录失败（HTTP ${response.status}）`
      throw new Error(reason)
    }
    const expiresIn = Number(parsed.expires_in)
    this.state.token = {
      accessToken: parsed.access_token,
      tokenType: 'bearer',
      expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : null,
    }
    await this.persist()
    await this.loadContext()
    return this.view()
  }

  async logout() {
    await this.closeLogin()
    this.state.token = null
    this.state.user = null
    this.state.organizations = []
    this.state.tenantId = null
    this.state.projects = []
    this.state.projectId = null
    this.state.proxies = {}
    this.state.models = []
    this.state.proxyError = null
    this.state.routeError = null
    this.state.projectError = null
    await this.persist()
    return { ok: true }
  }

  // ---------- 平台上下文 ----------

  async loadContext() {
    const self = await this.requestJson('/iam/choerodon/v1/users/self')
    this.state.user = {
      id: idOf(self?.id),
      realName: text(self?.realName) || text(self?.loginName) || '已登录用户',
      loginName: text(self?.loginName),
      defaultTenantId: self?.tenantId === undefined || self?.tenantId === null ? null : String(self.tenantId),
    }
    const tenants = await this.requestJson('/iam/choerodon/v1/users/self-tenants')
    const organizations = []
    const seen = new Set()
    for (const raw of Array.isArray(tenants) ? tenants : []) {
      if (!raw || typeof raw !== 'object' || disabled(raw.enabledFlag)) continue
      const id = idOf(raw.tenantId)
      if (seen.has(id)) continue
      seen.add(id)
      organizations.push({ id, name: text(raw.tenantName) || '未命名组织', code: text(raw.tenantNum) })
    }
    this.state.organizations = organizations
    const preferred = [this.state.tenantId, this.state.user.defaultTenantId].find((id) =>
      id ? organizations.some((o) => o.id === id) : false,
    )
    this.state.tenantId = preferred ?? organizations[0]?.id ?? null
    this.state.projects = []
    this.state.projectId = null
    if (this.state.tenantId) {
      try {
        await this.loadProjects(this.state.tenantId, true)
      } catch (error) {
        this.state.projectError = error instanceof Error ? error.message : '读取项目失败'
      }
    }
    await this.persist()
    return this.view()
  }

  async pageProjects(tenantId) {
    const userId = this.state.user?.id
    if (!userId) throw new Error('请先登录猪齿鱼')
    const projects = []
    const seen = new Set()
    for (let page = 0; page < 100; page++) {
      const data = await this.requestJson(
        `/cbase/choerodon/v1/organizations/${encodeURIComponent(tenantId)}` +
          `/users/${encodeURIComponent(userId)}/projects/paging` +
          `?page=${page}&size=100&button_permission=true&business_type=project&group=project`,
        { tenantId },
      )
      const payload = data && typeof data === 'object' ? data : {}
      const list = Array.isArray(data) ? data : payload.content ?? payload.list
      if (!Array.isArray(list)) throw new Error('项目列表格式异常')
      for (const raw of list) {
        if (!raw || typeof raw !== 'object') continue
        if (!yes(raw.into)) continue
        if (!(raw.operateType === 'update' || raw.projectStatus === 'success')) continue
        if (disabled(raw.enabled)) continue
        const id = idOf(raw.id)
        if (seen.has(id)) continue
        seen.add(id)
        projects.push({ id, name: text(raw.name) || '未命名项目', code: text(raw.code) })
      }
      const lastPage =
        Array.isArray(data) ||
        payload.last === true ||
        (typeof payload.totalPages === 'number' && page + 1 >= payload.totalPages) ||
        (payload.last !== false && list.length < 100)
      if (lastPage) break
      if (!list.length) throw new Error('项目分页返回异常')
    }
    return projects
  }

  async latestProject(tenantId) {
    const recent = await this.requestJson(
      `/cbase/choerodon/v1/organizations/${encodeURIComponent(tenantId)}/projects/latest_visit`,
      { tenantId },
    )
    const first = Array.isArray(recent) ? recent[0] : undefined
    const candidate = first?.projectDTO ?? first?.project ?? {}
    const id = candidate.id ?? first?.projectId
    if (id === undefined || id === null) return null
    return { id: String(id), name: text(candidate.name) || '最近访问的项目', code: text(candidate.code) }
  }

  /**
   * 项目列表接口对没有「项目列表」菜单权限的账号会返回 PERMISSION_MISMATCH（HTTP 404），
   * 这时退回到 latest_visit：它只要求项目访问权限，能给出最近访问的那一个项目。
   */
  async loadProjects(tenantId, preferRecent) {
    let projects = []
    try {
      projects = await this.pageProjects(tenantId)
    } catch {
      projects = []
    }
    if (!projects.length) {
      let fallback = null
      try {
        fallback = await this.latestProject(tenantId)
      } catch {
        fallback = null
      }
      if (fallback) projects = [fallback]
    }
    if (!projects.length) {
      this.state.projects = []
      this.state.projectId = null
      throw new Error('组织下没有可访问的项目，请确认账号的项目权限')
    }
    this.state.projects = projects
    let nextProject = projects.some((p) => p.id === this.state.projectId) ? this.state.projectId : null
    if (!nextProject && preferRecent) {
      try {
        const recent = await this.latestProject(tenantId)
        if (recent && projects.some((p) => p.id === recent.id)) nextProject = recent.id
      } catch {}
    }
    this.state.projectId = nextProject ?? projects[0].id
    return projects
  }

  // ---------- 代理会话与模型目录 ----------

  proxyKey(tenantId, projectId) {
    return `${tenantId}:${projectId}`
  }

  async ensureProxy(tenantId, projectId) {
    const key = this.proxyKey(tenantId, projectId)
    if (this.state.proxies[key]) return this.state.proxies[key]
    const base = this.conversationBase(tenantId, projectId)
    const created = await this.requestJson(`${base}/local`, {
      method: 'POST',
      tenantId,
      body: {
        clientId: `dsh-${this.state.device.deviceId}`,
        title: this.config.proxyTitle,
        device: this.state.device,
      },
      extraHeaders: this.deviceHeaders(),
    })
    const conversationId = created?.conversationId
    if (typeof conversationId !== 'string' || !conversationId) {
      throw new Error('服务端未返回代理会话 id，本地会话协议可能未开放')
    }
    if (created.executionLocation !== 'LOCAL') {
      throw new Error('服务端未把代理会话标记为 LOCAL，模型代理不可用')
    }
    this.state.proxies[key] = conversationId
    await this.persist()
    return conversationId
  }

  baseUrl(tenantId, projectId, conversationId) {
    return (
      new URL(this.config.apiOrigin).origin +
      `/cagent/v1/organizations/${encodeURIComponent(tenantId)}` +
      `/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/local-llm`
    )
  }

  async sync() {
    const tenantId = this.state.tenantId
    const projectId = this.state.projectId
    if (!tenantId || !projectId) throw new Error('请先选择组织与项目')
    this.state.proxyError = null
    this.state.routeError = null
    let conversationId
    try {
      conversationId = await this.ensureProxy(tenantId, projectId)
    } catch (error) {
      this.state.proxyError = error instanceof Error ? error.message : '创建代理会话失败'
      await this.persist()
      return this.view()
    }
    try {
      const base = this.conversationBase(tenantId, projectId)
      const catalog = await this.requestJson(
        `${base}/${encodeURIComponent(conversationId)}/local-llm/models`,
        { tenantId, extraHeaders: this.deviceHeaders() },
      )
      this.state.models = pickModels(catalog)
    } catch (error) {
      this.state.proxyError = error instanceof Error ? error.message : '读取模型目录失败'
      await this.persist()
      return this.view()
    }
    try {
      await this.applyRoutes(tenantId, projectId, conversationId)
    } catch (error) {
      this.state.routeError = error instanceof Error ? error.message : '写入模型路由失败'
    }
    await this.persist()
    return this.view()
  }

  buildProviders(tenantId, projectId, conversationId) {
    const baseURL = this.baseUrl(tenantId, projectId, conversationId)
    const common = {
      baseURL,
      // pi-ai 的 OpenAI 实现要求至少有 Authorization，真实值由 request-headers 覆盖。
      headers: { Authorization: 'Bearer choerodon-proxy', 'X-Harness-Client': 'DESKTOP' },
      defaultContextWindow: DEFAULT_CONTEXT,
      defaultMaxTokens: DEFAULT_MAX_TOKENS,
      defaultInput: ['text', 'image'],
    }
    const openaiModels = this.state.models.filter((m) => m.provider === 'OPENAI').map(wireModel)
    const anthropicModels = this.state.models.filter((m) => m.provider === 'ANTHROPIC').map(wireModel)
    const providers = {}
    if (openaiModels.length) {
      providers[OPENAI_ROUTE] = { ...common, displayName: '猪齿鱼', api: 'openai-completions', models: openaiModels }
    }
    if (anthropicModels.length) {
      providers[ANTHROPIC_ROUTE] = {
        ...common,
        displayName: '猪齿鱼（Anthropic）',
        api: 'anthropic-messages',
        models: anthropicModels,
      }
    }
    return providers
  }

  findEntry(editor, id) {
    const nameOf = (entry) => entry?.name ?? entry?.options?.name ?? entry?.entry?.name
    for (const entry of editor.entries()) {
      const candidates = [entry?.id, entry?.options?.id, entry?.entry?.id, entry?.patchId]
      if (candidates.some((value) => typeof value === 'string' && value === id)) {
        this.state.routeEntry = String(entry?.id ?? id)
        return entry
      }
    }
    // 兜底：模型适配器在 profile 里只有一个实例，按包名定位也安全。
    for (const entry of editor.entries()) {
      if (nameOf(entry) === '@deepseek-ai/dsh-llm-pi-ai') {
        this.state.routeEntry = String(entry?.id ?? 'llm-pi-ai')
        return entry
      }
    }
    return undefined
  }

  async applyRoutes(tenantId, projectId, conversationId) {
    const editor = this.ctx.get('configEditor')
    if (!editor) throw new Error('当前 profile 未启用 configEditor，无法写入模型路由')
    const entry = this.findEntry(editor, this.config.llmRowId)
    if (!entry) throw new Error(`未找到配置行 ${this.config.llmRowId}`)
    const providers = this.buildProviders(tenantId, projectId, conversationId)
    const fingerprint = JSON.stringify(providers)
    if (this.routesHash === fingerprint) return
    await editor.edit(entry, (current) => {
      // 与用户在模型设置里自己加的路由共存：只替换本插件拥有的两条路由。
      const previous = current && typeof current === 'object' ? current : {}
      const merged = previous.providers && typeof previous.providers === 'object' ? { ...previous.providers } : {}
      for (const route of ROUTES) delete merged[route]
      return { ...previous, providers: { ...merged, ...providers } }
    })
    this.routesHash = fingerprint
  }

  /**
   * 插件激活时直接接入模型，不依赖面板：这样即使桌面版的页面传输层调不到
   * 插件的 HTTP 路由，模型选择器里也能出现 choerodon-* 的模型。
   */
  async autoWire() {
    if (!this.state.token || !this.state.tenantId || !this.state.projectId) return
    // 看板的状态集探测较慢，激活时在后台先热一遍，面板打开就能直接用缓存。
    this.discoverStatuses().catch(() => {})
    const conversationId = this.state.proxies[this.proxyKey(this.state.tenantId, this.state.projectId)]
    if (!conversationId || !this.state.models?.length) {
      await this.sync()
      return
    }
    try {
      await this.applyRoutes(this.state.tenantId, this.state.projectId, conversationId)
      this.state.routeError = null
      await this.keepModelSelection()
    } catch (error) {
      this.state.routeError = error instanceof Error ? error.message : '写入模型路由失败'
      await this.persist()
    }
  }

  /**
   * 保持模型选择：路由重写后如果选中的模型已经不在目录里（服务端改名/换项目），
   * 就落到当前路由的第一个模型，避免每次重启都要重新点一遍。
   */
  async keepModelSelection() {
    const service = this.ctx.get('agentDefaultModel')
    if (!service?.currentSelection || !service?.saveSelection) return
    const models = this.state.models ?? []
    if (!models.length) return
    let current
    try {
      current = service.currentSelection()
    } catch {
      return
    }
    const routeOf = (provider) => models.filter((m) => (m.provider === 'ANTHROPIC' ? ANTHROPIC_ROUTE : OPENAI_ROUTE) === provider)
    const provider = current?.provider
    if (provider && ROUTES.includes(provider)) {
      const candidates = routeOf(provider)
      if (candidates.length && !candidates.some((m) => m.id === current.model)) {
        try {
          await service.saveSelection({ ...current, provider, model: candidates[0].id })
        } catch {}
      }
      return
    }
    // 上次选中的是猪齿鱼模型但路由换了：恢复记住的选择。
    const preferred = this.state.preferredModel
    if (preferred && models.some((m) => m.id === preferred.model)) {
      try {
        await service.saveSelection({ provider: preferred.provider, model: preferred.model })
      } catch {}
    }
  }

  /** 记住当前选中的猪齿鱼模型，供路由重建后恢复。 */
  async rememberModel() {
    const service = this.ctx.get('agentDefaultModel')
    if (!service?.currentSelection) return
    try {
      const current = service.currentSelection()
      if (current?.provider && ROUTES.includes(current.provider)) {
        this.state.preferredModel = { provider: current.provider, model: current.model }
        await this.persist()
      }
    } catch {}
  }

  // ---------- 动态请求头 ----------

  requestHeaders(request, headers, next) {
    if (!ROUTES.includes(request?.provider)) return next()
    const token = this.state.token
    if (token) headers.set('authorization', `bearer ${token.accessToken}`)
    headers.set('h-tenant-id', this.state.tenantId ?? '0')
    headers.set('h-menu-id', '0')
    for (const [name, value] of Object.entries(this.deviceHeaders())) headers.set(name, value)
    return next()
  }

  // ---------- 看板 ----------

  workListPath() {
    return `/agile/v2/projects/${encodeURIComponent(this.state.projectId)}/issues/work_list`
  }

  async workList(body, page = 0, size = 20, sort = 'creationDate,desc') {
    return this.requestJson(
      `${this.workListPath()}?page=${page}&size=${size}&sort=${encodeURIComponent(sort)}`,
      { method: 'POST', body },
    )
  }

  statusCondition(statusId) {
    return {
      field: { fieldCode: 'status', predefined: true, fieldType: 'multiple', name: '状态' },
      relationship: 'AND',
      operation: 'IN',
      value: { valueIdList: [statusId] },
    }
  }

  mineCondition() {
    const assigneeId = this.state.user?.id
    if (!assigneeId) throw new Error('请先登录猪齿鱼')
    return {
      field: { fieldCode: 'assignee', predefined: true, fieldType: 'multiple', name: '经办人' },
      relationship: 'AND',
      operation: 'IN',
      value: { valueIdList: [assigneeId] },
    }
  }

  /**
   * 状态集不能直接从看板列接口读（该项目对当前账号返回 403），
   * 改用两条真实数据源合成：活跃工作项上出现过的状态 + 流转关系闭包。
   */
  async discoverStatuses(options = {}) {
    const cacheKey = `${this.state.tenantId}:${this.state.projectId}`
    const cached = this.state.statusCache
    if (!options.force && cached && cached.key === cacheKey && Date.now() - cached.at < STATUS_TTL) {
      // 返回副本：调用方（看板）会把它当队列 shift()，直接给缓存引用会被抽空。
      return Array.isArray(cached.statuses) ? [...cached.statuses] : []
    }
    // 换项目时旧缓存直接作废，别把上一个项目的状态带过来。
    if (cached && cached.key !== cacheKey) this.state.statusCache = null

    /**
     * 累积底稿：把上一轮已经知道的状态先铺进去。
     *
     * <p>状态来自工作项采样，采样集随数据变化，单次结果不稳定。
     * 平台上的状态是长期配置，这里按「只增不减」合并，泳道集合就稳定了；
     * 真被删掉的状态最多留一条 0 条的泳道，不会给出错误数据。</p>
     */
    // 注意：force 也要保留累积底稿。强制刷新是「重新探一遍平台」，不是「把已知道的扔掉」，
    // 否则刷新反而会让泳道变少（快路径采样覆盖不到低频状态）。
    const seed = cached && cached.key === cacheKey && Array.isArray(cached.statuses) ? cached.statuses : []
    const statuses = new Map(seed.map((row) => [String(row.id), { id: String(row.id), name: row.name, type: row.type }]))
    const typeIds = new Set()
    const samples = []

    // 三页（300 条）才能覆盖到子任务那几种低频类型的状态（待处理 / 处理中）；
    // 砍到两页会让这几个状态消失，泳道就少两条。状态发现加过缓存，这一次多一页不影响日常。
    for (let page = 0; page < 3; page++) {
      const result = await this.workList({ conditions: [], treeFlag: false, withSubIssues: false }, page, 100)
      const rows = Array.isArray(result?.content) ? result.content : []
      if (!rows.length) break
      for (const row of rows) {
        const id = String(row?.statusMapVO?.id ?? '')
        if (id && !statuses.has(id)) {
          statuses.set(id, { id, name: text(row.statusMapVO?.name, 80), type: text(row.statusMapVO?.type, 20) })
        }
        if (row?.issueTypeId) typeIds.add(String(row.issueTypeId))
        if (samples.length < 12 && row?.issueId && row?.issueTypeId && row?.statusMapVO?.id) {
          samples.push({ issueId: String(row.issueId), typeId: String(row.issueTypeId), statusId: String(row.statusMapVO.id) })
        }
      }
      if (!result?.content?.length) break
    }

    const seenQueries = new Set()
    /**
     * 查一次流转。只负责查与登记，**不**在这里判断预算 ——
     * 预算判断放在并发调度那层，否则并发顺序会决定哪些状态被探到，结果不稳定。
     */
    const queryTransitions = async (issueId, typeId, statusId) => {
      const key = `${issueId}:${typeId}:${statusId}`
      if (seenQueries.has(key)) return []
      seenQueries.add(key)
      const query = new URLSearchParams({
        current_status_id: statusId,
        issue_id: issueId,
        issue_type_id: typeId,
        apply_type: 'agile',
      })
      try {
        const raw = await this.requestJson(
          `/agile/v1/projects/${encodeURIComponent(this.state.projectId)}/schemes/query_transforms?${query}`,
        )
        if (!Array.isArray(raw)) return []
        // 只返回「这次才第一次见到」的状态，调用方靠它判断状态图有没有收敛。
        const fresh = []
        for (const row of raw) {
          const id = String(row?.endStatusId ?? '')
          if (!id) continue
          const name = text(row?.statusVO?.name, 80)
          const type = text(row?.statusVO?.type, 20)
          if (!statuses.has(id)) {
            statuses.set(id, { id, name, type })
            fresh.push(id)
          }
        }
        return fresh
      } catch {
        return []
      }
    }

    /**
     * 顺着流转关系把状态补全。
     *
     * <p>三层约束叠在一起：既要并发（串行时首次看板 20 次请求里 17 次耗在这），
     * 又要结果稳定（同一份数据反复打开必须得到同一批泳道），还要能收敛（状态图有环）。</p>
     *
     * <p>做法是按「固定分波」推进：每一波取队首若干个（上限 6），并发查完后
     * 只把**新出现的**状态追加到队尾，队列顺序由数据决定、不由响应快慢决定。
     * 某一波没有发现任何新状态就说明状态图已闭包，停止。
     * 48 次只是安全阀，正常项目用不到（本环境实测 18 次收敛）。</p>
     */
    const perType = new Map()
    for (const sample of samples) {
      if (!perType.has(sample.typeId)) perType.set(sample.typeId, sample)
    }
    const pickSample = (statusId) => samples.find((item) => item.statusId === statusId) ?? samples[0]
    const queue = [...perType.values()].map((sample) => ({ sample, statusId: sample.statusId }))
    let explored = 0
    while (queue.length && explored < 48) {
      const wave = queue.splice(0, 6)
      explored += wave.length
      const results = await Promise.all(
        wave.map(({ sample, statusId }) => queryTransitions(sample.issueId, sample.typeId, statusId)),
      )
      const fresh = results.flat()
      for (const next of fresh) {
        const sample = pickSample(next)
        if (sample) queue.push({ sample, statusId: next })
      }
      if (!fresh.length) break
    }

    const ordered = orderStatuses([...statuses.values()])
    // force 刷新不清 complete：状态集合本来就已补全过，重探只是同步最新变化。
    const previousComplete = cached?.key === cacheKey && cached?.complete === true
    this.state.statusCache = {
      key: cacheKey,
      at: Date.now(),
      sampledAt: Date.now(),
      discoveredAt: cached?.discoveredAt ?? Date.now(),
      // 只有后台补全验证过才是 complete；快路径的结果一律不完整。
      complete: previousComplete,
      statuses: ordered,
    }
    await this.persist()
    // 已知不全就在后台补一把，别让用户等这一百秒。
    if (!previousComplete) this.scheduleStatusCompletion(cacheKey)
    return [...ordered]
  }

  /**
   * 后台补全状态集合：全量翻页，直到「各状态计数之和 == 工作项总数」。
   *
   * <p>判据是硬性的：只有 Σcount 与 totalElements 相等，才说明没有任何状态被漏掉。
   * 跑一次约 100 秒（247 页 × 500 条），所以只在后台做，同一时刻只允许一个在跑。</p>
   */
  scheduleStatusCompletion(cacheKey) {
    if (this.statusCompletion) return
    this.statusCompletion = (async () => {
      try {
        const seen = new Map()
        const first = await this.workList(
          { conditions: [], treeFlag: false, withSubIssues: false },
          0,
          500,
          'lastUpdateDate,desc',
        )
        const totalPages = Number(first?.totalPages ?? 1)
        const totalElements = Number(first?.totalElements ?? 0)
        const collect = (page) => {
          for (const row of Array.isArray(page?.content) ? page.content : []) {
            const st = row?.statusMapVO
            if (st?.id) seen.set(String(st.id), { id: String(st.id), name: text(st.name, 80), type: text(st.type, 20) })
          }
        }
        collect(first)
        // 并发 8 路翻页；平台对 size=500 偶有抖动，单页失败跳过，不影响已收集的部分。
        const CONC = 8
        for (let base = 1; base < totalPages; base += CONC) {
          const batch = []
          for (let i = 0; i < CONC && base + i < totalPages; i++) {
            batch.push(
              this.workList({ conditions: [], treeFlag: false, withSubIssues: false }, base + i, 500, 'lastUpdateDate,desc').catch(
                () => null,
              ),
            )
          }
          for (const page of await Promise.all(batch)) collect(page)
        }
        // 硬判据：逐状态计数求和，必须等于平台总数。
        let sum = 0
        for (const st of seen.values()) {
          try {
            const counted = await this.workList(
              { conditions: [this.statusCondition(st.id)], treeFlag: false, withSubIssues: false },
              0,
              1,
            )
            sum += Number(counted?.totalElements ?? 0)
          } catch { /* 单个状态数不出来就当 0，后面判据会把它挡掉 */ }
        }
        // 容差：判据是先取总数、再逐状态计数，两次测量之间的并发变动不该被当成「漏了状态」。
        // 真漏一个状态会差几百上千条，远在容差之外。
        const tolerance = Math.max(5, Math.round(totalElements * 0.001))
        if (seen.size && Math.abs(sum - totalElements) <= tolerance) {
          this.state.statusCache = {
            key: cacheKey,
            at: Date.now(),
            sampledAt: Date.now(),
            discoveredAt: Date.now(),
            complete: true,
            statuses: orderStatuses([...seen.values()]),
          }
          await this.persist()
          this.statusCompletedAt = Date.now()
        }
      } catch { /* 补全失败不影响已有缓存，下次打开再试 */ } finally {
        this.statusCompletion = null
      }
    })()
  }

  /** 当前项目的史诗目录：看板的史诗多选与名称匹配都从这里取。 */
  async epicCatalog() {
    if (!this.state.projectId) throw new Error('请先在面板里选择项目')
    const key = `${this.state.tenantId}:${this.state.projectId}`
    const cached = this.state.epicCache
    if (cached?.key === key && Date.now() - cached.at < 5 * 60 * 1000) return cached.items
    const raw = await this.requestJson(
      `/agile/v1/projects/${encodeURIComponent(this.state.projectId)}/issues/epics`,
    )
    const items = (Array.isArray(raw) ? raw : [])
      .map((row) => ({
        id: String(row?.issueId ?? ''),
        name: text(row?.epicName ?? row?.summary, 120),
        color: text(row?.color, 20),
        issueCount: Number(row?.issueCount ?? 0),
      }))
      .filter((row) => row.id && row.name)
    this.state.epicCache = { key, at: Date.now(), items }
    await this.persist().catch(() => {})
    return items
  }

  /** 名称包含任一子串（逗号分隔，中英文逗号都认）的史诗。 */
  async epicsBySubstrings(substring) {
    const needles = String(substring ?? '')
      .split(/[,，]/)
      .map((item) => item.trim())
      .filter(Boolean)
    if (!needles.length) return []
    const catalog = await this.epicCatalog()
    return catalog.filter((row) => needles.some((needle) => row.name.includes(needle)))
  }

  epicCondition(epicIds) {
    return {
      field: { fieldCode: 'epic', predefined: true, fieldType: 'multiple', name: '史诗' },
      relationship: 'AND',
      operation: 'IN',
      value: { valueIdList: epicIds },
    }
  }

  /**
   * 项目成员目录：cbase 的 projects/{p}/users/search 能一次拿全（1000 上限），
   * 比原来的「看板行并集」覆盖全，还能按姓名/工号精确挑人。拿不到就退回看板采样。
   */
  async userCatalog() {
    if (!this.state.projectId) throw new Error('请先在面板里选择项目')
    const key = `${this.state.tenantId}:${this.state.projectId}`
    const cached = this.state.userCache
    if (cached?.key === key && Date.now() - cached.at < 10 * 60 * 1000) return cached.items
    let items = []
    try {
      const raw = await this.requestJson(
        `${this.cbaseBase()}/users/search?page=0&size=1000&enabled=true`,
      )
      const rows = Array.isArray(raw?.content) ? raw.content : []
      items = rows
        .map((row) => ({
          id: String(row?.id ?? ''),
          name: text(row?.realName, 60),
          loginName: text(row?.loginName, 60),
        }))
        .filter((row) => row.id && (row.name || row.loginName))
        .map((row) => ({ ...row, name: row.name ? `${row.name}（${row.loginName || row.id}）` : row.loginName }))
    } catch {
      items = []
    }
    if (!items.length) {
      try {
        const sample = await this.workList({ conditions: [], treeFlag: false, withSubIssues: false }, 0, 200)
        const seen = new Set()
        for (const row of Array.isArray(sample?.content) ? sample.content : []) {
          const id = String(row?.assigneeId ?? '').trim()
          const name = text(row?.assigneeRealName ?? row?.assigneeName, 60)
          const login = text(row?.assigneeLoginName, 60)
          if (!id || !name || seen.has(id)) continue
          seen.add(id)
          items.push({ id, name: login ? `${name}（${login}）` : name, loginName: login })
        }
      } catch {}
    }
    const me = this.state.user
    if (me?.id) {
      const meId = String(me.id)
      items = items.filter((row) => row.id !== meId)
      items.unshift({ id: meId, name: `${me.realName ?? ''}（${me.loginName ?? meId}）`, loginName: me.loginName ?? '' })
    }
    this.state.userCache = { key, at: Date.now(), items }
    await this.persist().catch(() => {})
    return items
  }

  cbaseBase() {
    return `/cbase/choerodon/v1/projects/${encodeURIComponent(this.state.projectId)}`
  }

  /**
   * 按姓名 / 工号 / 用户 id 解析经办人，必填唯一命中：重名时报出候选，
   * 交给人用 id 再指一次，不替用户猜。
   */
  async resolveUser(value) {
    const raw = String(value ?? '').trim()
    if (!raw) throw new Error('请给出经办人的姓名、工号或用户 id')
    const lowered = raw.toLowerCase()
    if (['me', 'self', '我'].includes(lowered)) {
      const me = this.state.user
      if (!me?.id) throw new Error('请先登录猪齿鱼')
      return { id: String(me.id), name: `${me.realName ?? ''}（${me.loginName ?? me.id}）` }
    }
    const catalog = await this.userCatalog()
    const byId = catalog.find((row) => row.id === raw)
    if (byId) return byId
    const exact = catalog.filter(
      (row) => row.name === raw || row.loginName === raw || row.name.replace(/[（(].*$/, '') === raw,
    )
    if (exact.length === 1) return exact[0]
    if (exact.length > 1) {
      throw new Error(`「${raw}」匹配到多个经办人：${exact.map((row) => row.name).join('、')}，请补工号或直接用 id`)
    }
    const loose = catalog.filter((row) => row.name.includes(raw) || row.loginName.includes(raw))
    if (loose.length === 1) return loose[0]
    if (loose.length > 1) {
      throw new Error(`「${raw}」匹配到 ${loose.length} 个经办人：${loose.slice(0, 8).map((row) => row.name).join('、')}，请写全名或工号`)
    }
    throw new Error(`项目成员里没有「${raw}」`)
  }

  assigneeCondition(userIds) {
    return {
      field: { fieldCode: 'assignee', predefined: true, fieldType: 'multiple', name: '经办人' },
      relationship: 'AND',
      operation: 'IN',
      value: { valueIdList: userIds },
    }
  }

  /** 看板行的经办人补进候选缓存：成员目录没覆盖到的（离职、跨项目）也能在筛选里选到。 */
  mergeAssigneeRows(rows) {
    const key = `${this.state.tenantId}:${this.state.projectId}`
    const cache = this.state.userCache
    if (cache?.key !== key || !Array.isArray(rows) || !rows.length) return
    const known = new Map(cache.items.map((row) => [row.id, row]))
    for (const row of rows) {
      const id = String(row?.assigneeId ?? '').trim()
      const name = text(row?.assigneeRealName ?? row?.assigneeName, 60)
      const loginName = text(row?.assigneeLoginName, 60)
      if (!id || !name || known.has(id)) continue
      known.set(id, { id, name: loginName ? `${name}（${loginName}）` : name, loginName })
      cache.items.push(known.get(id))
    }
  }

  /**
   * 看板：每条泳道查一次，拿到该状态的真实总数与该泳道第一屏。
   * 默认只看「我的」；`mine: false` 才是全部。史诗与经办人都下推成 work_list 的 IN 条件，
   * 泳道 total 与任务数一致，不会出现「筛完总数还是全量」。
   */
  async board(options = {}) {
    const mine = options.mine !== false
    const epic = text(options.epic, 200).trim()
    const epicIdInput = Array.isArray(options.epicIds)
      ? [...new Set(options.epicIds.map((id) => String(id ?? '').trim()).filter(Boolean))]
      : []
    const assignee = text(options.assignee, 200).trim()
    const assigneeIdInput = Array.isArray(options.assigneeIds)
      ? [...new Set(options.assigneeIds.map((id) => String(id ?? '').trim()).filter(Boolean))]
      : []
    const statuses = await this.discoverStatuses({ force: options.refreshStatuses === true })
    const mineCondition = mine ? this.mineCondition() : null
    const extra = mineCondition ? [mineCondition] : []
    let epicSelected = []
    if (epicIdInput.length) {
      const catalog = await this.epicCatalog()
      epicSelected = epicIdInput.map((id) => catalog.find((row) => row.id === id)).filter(Boolean)
    } else if (epic) {
      epicSelected = await this.epicsBySubstrings(epic)
    }
    let assigneeSelected = []
    if (assigneeIdInput.length) {
      const catalog = await this.userCatalog()
      assigneeSelected = assigneeIdInput.map((id) => catalog.find((row) => row.id === id)).filter(Boolean)
    } else if (assignee) {
      assigneeSelected = await this.resolveUserMany(assignee)
    }
    if (epicSelected.length) extra.push(this.epicCondition(epicSelected.map((row) => row.id)))
    if (assigneeSelected.length) extra.push(this.assigneeCondition(assigneeSelected.map((row) => row.id)))
    // 明确筛了经办人就以筛选为准：选了同事却还压一条「我的」只会得到空看板。
    if (assigneeSelected.length && mineCondition) extra.splice(extra.indexOf(mineCondition), 1)
    const lanes = []
    const hasEpicFilter = epicIdInput.length > 0 || epic !== ''
    const hasAssigneeFilter = assigneeIdInput.length > 0 || assignee !== ''
    if ((!hasEpicFilter || epicSelected.length) && (!hasAssigneeFilter || assigneeSelected.length)) {
      /**
       * 先花一次请求看清「这批工作项实际落在哪些状态」。
       *
       * <p>原来 20 个泳道一律各查一次，其中 14 个是 0 条的空泳道 —— 一次打开看板
       * 就多出十几趟往返。先取 200 条最近更新的，看状态分布；分布里没有的状态直接
       * 记 0，不再单独查询。空泳道照旧渲染，只是不再为它打接口。</p>
       */
      /**
       * 先确认这批筛选下到底有没有候选单。
       *
       * <p>早先试过「用最近 200 条的状态分布来决定跳过哪些泳道」，被实测打回：
       * 低频状态在那 200 条里不出现，就被判成 0 条，实际有 594 条（DEV-已完成）。
       * 现在只判「有没有候选」：有候选就每个状态都查，0 条由查询本身给出 ——
       * 少几百毫秒远不如少 736 条数据严重。省时间靠状态数量与并发度，不靠猜。</p>
       */
      let hasCandidate = statuses.length > 0
      try {
        const peek = await this.workList(
          { conditions: extra, treeFlag: false, withSubIssues: false },
          0,
          1,
        )
        hasCandidate = Number(peek?.totalElements ?? 0) > 0
      } catch { /* 探测失败就按有候选处理，宁可多查 */ }
      // 再复制一份：queue 会被 shift() 抽空，绝不能动到 statuses 本身。
      const queue = hasCandidate ? [...statuses] : []
      const skipped = hasCandidate ? [] : [...statuses]
      const workers = []
      const take = async () => {
        for (;;) {
          const status = queue.shift()
          if (!status) return
          try {
            const result = await this.workList(
              { conditions: [this.statusCondition(status.id), ...extra], treeFlag: false, withSubIssues: false },
              0,
              BOARD_LANE_ITEMS,
            )
            const rows = Array.isArray(result?.content) ? result.content : []
            this.mergeAssigneeRows(rows)
            lanes.push({
              id: status.id,
              name: status.name,
              type: status.type,
              total: Number(result?.totalElements ?? rows.length),
              items: rows.map(workItemSummary),
            })
          } catch (error) {
            lanes.push({ id: status.id, name: status.name, type: status.type, total: 0, items: [], error: error.message })
          }
        }
      }
      for (let index = 0; index < 8; index++) workers.push(take())
      await Promise.all(workers)
      for (const status of skipped) {
        lanes.push({ id: status.id, name: status.name, type: status.type, total: 0, items: [] })
      }
    }
    lanes.sort((a, b) => statusRank(a) - statusRank(b))
    return {
      mine,
      epicFilter: epic || null,
      epicIds: epicSelected.map((row) => row.id),
      epicNames: epicSelected.map((row) => row.name),
      assigneeFilter: assignee || null,
      assigneeIds: assigneeSelected.map((row) => row.id),
      assigneeNames: assigneeSelected.map((row) => row.name),
      repoPath: await this.repoPath(),
      lanes,
      statuses: statuses.length,
      fetchedAt: Date.now(),
    }
  }

  /** 逗号分隔的多个姓名/工号，逐个解析后去重。 */
  async resolveUserMany(value) {
    const needles = String(value ?? '')
      .split(/[,，]/)
      .map((item) => item.trim())
      .filter(Boolean)
    const seen = new Set()
    const matched = []
    for (const needle of needles) {
      const user = await this.resolveUser(needle)
      if (seen.has(user.id)) continue
      seen.add(user.id)
      matched.push(user)
    }
    return matched
  }

  async issue(issueId) {
    const id = String(issueId ?? '')
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('工作项标识无效')
    const query = new URLSearchParams({
      organizationId: String(this.state.tenantId),
      instanceProjectId: String(this.state.projectId),
    })
    const raw = await this.requestJson(
      `/agile/v1/projects/${encodeURIComponent(this.state.projectId)}/issues/${encodeURIComponent(id)}?${query}`,
    )
    const detail = {
      ...workItemSummary({ ...raw, issueId: raw?.issueId ?? id, statusMapVO: raw?.statusVO ?? raw?.statusMapVO }),
      description: text(raw?.description, 8000),
      descriptionImages: descriptionImages(raw?.description),
      descriptionText: plainDescription(raw?.description, 8000),
      version: Number(raw?.objectVersionNumber ?? -1),
      typeId: String(raw?.issueTypeId ?? ''),
      statusId: String(raw?.statusVO?.id ?? raw?.statusId ?? ''),
      statusCode: text(raw?.statusVO?.code, 60),
      assigneeId: String(raw?.assigneeId ?? ''),
      reporterId: String(raw?.reporterId ?? ''),
      epicId: String(raw?.epicId ?? ''),
      sprintId: String(raw?.sprintId ?? ''),
      estimateTime: raw?.estimateTime === undefined || raw?.estimateTime === null ? null : Number(raw.estimateTime),
      remainingTime: raw?.remainingTime === undefined || raw?.remainingTime === null ? null : Number(raw.remainingTime),
    }
    let transitions = []
    try {
      const q = new URLSearchParams({
        current_status_id: detail.statusId,
        issue_id: id,
        issue_type_id: detail.typeId,
        apply_type: 'agile',
      })
      const rows = await this.requestJson(
        `/agile/v1/projects/${encodeURIComponent(this.state.projectId)}/schemes/query_transforms?${q}`,
      )
      transitions = (Array.isArray(rows) ? rows : [])
        .map((row) => ({
          // transformId 是流转接口真正要的那个 id，endStatusId 只是目标状态。
          transformId: String(row?.id ?? ''),
          statusId: String(row?.endStatusId ?? ''),
          name: text(row?.statusVO?.name, 80),
          type: text(row?.statusVO?.type, 20),
          code: text(row?.statusVO?.code, 60),
          auditRequired: yes(row?.statusVO?.auditFlag),
        }))
        .filter((row) => row.statusId)
    } catch {}
    return {
      detail,
      transitions,
      boundSession: this.boundSessionOf(id),
      // 下面这些详情接口本来就一并返回，不用再打别的接口，省一次往返。
      attachments: (Array.isArray(raw?.issueAttachmentVOList) ? raw.issueAttachmentVOList : []).map((row) => ({
        id: String(row?.attachmentId ?? ''),
        fileName: text(row?.fileName, 260) || '未命名文件',
        url: text(row?.url, 2000),
        commentId: String(row?.commentId ?? ''),
        // 附件元数据带原始字节数，面板下载后可以核对，也方便判断是不是被截断。
        size: row?.size === undefined || row?.size === null ? null : Number(row.size),
        fileType: text(row?.fileType, 40),
      })),
      subIssues: (Array.isArray(raw?.subIssueVOList) ? raw.subIssueVOList : []).map((row) => ({
        id: String(row?.issueId ?? row?.id ?? ''),
        num: text(row?.issueNum ?? row?.num, 60),
        summary: text(row?.summary, 400),
        typeName: text(row?.issueTypeVO?.name, 60),
        statusName: text(row?.statusVO?.name ?? row?.statusName, 60),
        statusType: text(row?.statusVO?.type ?? row?.statusType, 30),
        assigneeName: text(row?.assigneeName, 120),
      })),
      components: (Array.isArray(raw?.componentIssueRelVOList) ? raw.componentIssueRelVOList : []).map((row) => ({
        id: String(row?.componentId ?? ''),
        name: text(row?.name, 120),
      })),
      versions: (Array.isArray(raw?.versionIssueRelVOList) ? raw.versionIssueRelVOList : []).map((row) => ({
        id: String(row?.versionId ?? ''),
        name: text(row?.name ?? row?.versionName, 120),
      })),
      links: await this.issueLinks(id),
    }
  }

  /**
   * 关联工作项（复制 / 被复制 / 阻塞 / 被阻塞…）。
   *
   * <p>接口只按当前工作项返回一份列表，每条自己带 ward（「复制」「被复制」这种视角词），
   * 所以前端要按 ward 分组，不能假设全是一个方向。</p>
   */
  async issueLinks(issueId) {
    const id = String(issueId ?? '')
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return []
    try {
      const rows = await this.requestJson(
        `${this.issueApiBase()}/issue_links/${encodeURIComponent(id)}`,
      )
      const list = Array.isArray(rows) ? rows : Array.isArray(rows?.issueLinks) ? rows.issueLinks : []
      return list.map((row) => ({
        linkId: String(row?.linkId ?? ''),
        linkTypeId: String(row?.linkTypeId ?? ''),
        linkTypeName: text(row?.linkTypeName, 60),
        // ward 表示本条相对当前单的方向：复制 / 被复制 / 阻塞 / 被阻塞
        ward: text(row?.ward, 40),
        id: String(row?.linkedIssueId ?? row?.issueId ?? ''),
        num: text(row?.issueNum, 60),
        summary: text(row?.summary, 400),
        typeCode: text(row?.typeCode, 40),
        typeName: text(row?.issueTypeVO?.name, 60),
        statusName: text(row?.statusName, 60),
        assigneeName: text(row?.assigneeName, 120),
        imageUrl: text(row?.imageUrl, 500),
      }))
    } catch {
      // 关联工作项读不到不该影响整个详情
      return []
    }
  }

  /** 这个工作项已经建过会话时，把它带出来，面板可以直接跳过去。 */
  boundSessionOf(issueId) {
    const hit = (this.state.worktrees ?? []).find(
      (item) => String(item.issueId ?? '') === String(issueId) && item.sessionId,
    )
    if (!hit) return null
    return {
      sessionId: String(hit.sessionId),
      sessionTitle: text(hit.sessionTitle, 160),
      branch: text(hit.branch, 120),
      workspaceId: String(hit.workspaceId ?? ''),
      fixed: hit.fixed === true,
      status: text(hit.status, 40),
    }
  }

  issueApiBase() {
    return `/agile/v1/projects/${encodeURIComponent(this.state.projectId)}`
  }

  /**
   * 在可流转状态里找目标：先按 id / transformId，再按全名，最后按唯一包含。
   * 找不到返回 null，由调用方给出可选清单。
   */
  pickTransition(transitions, wanted) {
    const value = String(wanted ?? '').trim()
    if (!value) return null
    const byId = transitions.find((item) => item.statusId === value || item.transformId === value)
    if (byId) return byId
    const exact = transitions.filter((item) => item.name === value)
    if (exact.length === 1) return exact[0]
    const lower = value.toLowerCase()
    const loose = transitions.filter((item) => item.name.toLowerCase().includes(lower))
    if (loose.length === 1) return loose[0]
    if (loose.length > 1) {
      throw new Error(`状态「${value}」匹配到多个：${loose.map((item) => item.name).join('、')}，请写全名`)
    }
    return null
  }

  /**
   * 走状态机的流转接口：先读详情拿版本号与 transformId，PUT 完再回读真实结果，
   * 不信任返回值，避免乐观锁冲突时误报成功。
   */
  async changeStatus(input = {}) {
    const id = String(input.issueId ?? '')
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('工作项标识无效')
    const current = await this.issue(id)
    const wanted = text(input.status, 80).trim()
    if (!wanted) throw new Error('请指定目标状态')
    const target = this.pickTransition(current.transitions, wanted)
    if (!target) {
      const options = current.transitions.map((item) => item.name).join('、')
      throw new Error(`「${current.detail.statusName}」不能流转到「${wanted}」${options ? `；可选：${options}` : ''}`)
    }
    if (target.statusId === current.detail.statusId) {
      return {
        ok: true,
        unchanged: true,
        issueId: id,
        num: current.detail.num,
        status: current.detail.statusName,
        statusId: current.detail.statusId,
        assigneeName: current.detail.assigneeName,
      }
    }
    if (!(current.detail.version >= 0)) throw new Error('工作项缺少版本号，请刷新后重试')
    const comment = text(input.comment, 500).trim()
    if (target.auditRequired && !comment) throw new Error(`流转到「${target.name}」需要填写审批说明`)
    const query = new URLSearchParams({
      issueId: id,
      applyType: 'agile',
      transformId: target.transformId,
      objectVersionNumber: String(current.detail.version),
      auditComment: comment,
    })
    await this.requestJson(`${this.issueApiBase()}/issues/update_status?${query}`, { method: 'PUT' })
    const after = await this.issue(id)
    if (after.detail.statusId !== target.statusId) {
      throw new Error(`服务端没有把状态改成「${target.name}」，当前仍是「${after.detail.statusName}」`)
    }
    return {
      ok: true,
      issueId: id,
      num: after.detail.num,
      from: current.detail.statusName,
      to: after.detail.statusName,
      statusId: after.detail.statusId,
      assigneeName: after.detail.assigneeName,
    }
  }

  /**
   * 改经办人：部分更新接口，只发版本号与 assigneeId，不动其它字段。
   * assignee 支持 me/我、用户 id、姓名或工号；clear=true 传 0 清空。
   */
  async setAssignee(input = {}) {
    const id = String(input.issueId ?? '')
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('工作项标识无效')
    const current = await this.issue(id)
    if (!(current.detail.version >= 0)) throw new Error('工作项缺少版本号，请刷新后重试')
    if (input.clear === true) {
      if (!current.detail.assigneeId) {
        return { ok: true, unchanged: true, issueId: id, num: current.detail.num, assigneeName: '未分配', assigneeId: '' }
      }
      await this.requestJson(`${this.issueApiBase()}/issues`, {
        method: 'PUT',
        body: { issueId: id, objectVersionNumber: current.detail.version, assigneeId: 0 },
      })
      const cleared = await this.issue(id)
      return {
        ok: true,
        issueId: id,
        num: cleared.detail.num,
        assigneeName: cleared.detail.assigneeName || '未分配',
        assigneeId: cleared.detail.assigneeId,
      }
    }
    const raw = String(input.assigneeId ?? input.assignee ?? '').trim()
    if (!raw) throw new Error('请给出经办人：me、姓名、工号或用户 id')
    const target = await this.resolveUser(raw)
    if (current.detail.assigneeId === target.id) {
      return {
        ok: true,
        unchanged: true,
        issueId: id,
        num: current.detail.num,
        assigneeName: current.detail.assigneeName,
        assigneeId: target.id,
      }
    }
    await this.requestJson(`${this.issueApiBase()}/issues`, {
      method: 'PUT',
      body: { issueId: id, objectVersionNumber: current.detail.version, assigneeId: target.id },
    })
    const after = await this.issue(id)
    if (after.detail.assigneeId !== target.id) {
      throw new Error(`经办人没改成 ${target.name}，请刷新后重试`)
    }
    return { ok: true, issueId: id, num: after.detail.num, assigneeName: after.detail.assigneeName, assigneeId: target.id }
  }

  /**
  /**
   * 会话建好之后把工作项挂到人身上并推到「开发中」。
   * 经办人怎么处理由调用方给：keep（保持原样，未分配也不动）、me（改成我）、
   * target（改成指定的人，assignee 里给姓名/工号/id）、auto（旧行为：只补空经办人）。
   * 每一步单独兜底：状态改不动不影响会话，只在结果里留 warning。
   */
  async bindIssueToSession(detail, options = {}) {
    const mode = ['keep', 'me', 'target', 'auto'].includes(options.assigneeMode)
      ? options.assigneeMode
      : 'auto'
    const report = {
      statusFrom: detail.statusName,
      statusTo: detail.statusName,
      statusNote: '',
      statusError: '',
      assigneeMode: mode,
      assigneeName: detail.assigneeName,
      assigneeNote: '',
      assigneeError: '',
    }
    const me = String(this.state.user?.id ?? '')
    let assigneeTarget = ''
    if (mode === 'me') {
      if (!me) report.assigneeError = '请先登录猪齿鱼'
      else assigneeTarget = 'me'
    } else if (mode === 'target') {
      assigneeTarget = String(options.assignee ?? '').trim()
      if (!assigneeTarget) report.assigneeError = '指定经办人时姓名或工号不能为空'
    } else if (mode === 'auto') {
      if (me && !detail.assigneeId) assigneeTarget = 'me'
    }
    if (assigneeTarget) {
      try {
        const assigned = await this.setAssignee({ issueId: detail.id, assigneeId: assigneeTarget })
        report.assigneeName = assigned.assigneeName
        report.assigneeNote = assigned.unchanged ? `经办人保持 ${assigned.assigneeName}` : `经办人改为 ${assigned.assigneeName}`
      } catch (error) {
        report.assigneeError = error instanceof Error ? error.message : '设置经办人失败'
      }
    } else if (mode === 'keep') {
      report.assigneeNote = detail.assigneeName ? `经办人保持 ${detail.assigneeName}` : '保持未分配，没有动经办人'
    } else if (mode === 'target' && !report.assigneeError) {
      report.assigneeNote = `经办人保持 ${detail.assigneeName || '未分配'}`
    }
    if (options.advanceStatus === false) {
      report.statusNote = '按选择没有流转状态'
      return report
    }
    try {
      if (detail.statusName === '开发中') {
        report.statusNote = '已是开发中'
      } else {
        const changed = await this.changeStatus({
          issueId: detail.id,
          status: '开发中',
          comment: 'DSH 创建开发会话，自动置为开发中',
        })
        const next = changed.status ?? changed.to ?? detail.statusName
        report.statusTo = next
        report.statusNote = changed.unchanged ? '状态未变化' : `${report.statusFrom} → ${next}`
      }
    } catch (error) {
      report.statusError = error instanceof Error ? error.message : '切换状态失败'
    }
    return report
  }

  // ---------- 评论 / 建单 / 工时 ----------

  /**
   * 评论正文：默认当纯文本，<p>/<br> 换行转义后包段落；传入 markdown 时做最小转换
   * （标题、列表、代码、粗体、链接）。没有服务端 markdown 渲染，转换在本地做。
   */
  formatComment(body, markdown) {
    const raw = String(body ?? '').trim()
    if (!raw) throw new Error('评论内容不能为空')
    if (!markdown) {
      return raw
        .split(/\n{2,}/)
        .map((block) => `<p>${escapeHtml(block).replace(/\n/g, '<br>')}</p>`)
        .join('')
    }
    const inline = (line) =>
      escapeHtml(line)
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank">$1</a>')
    const lines = raw.split(/\r?\n/)
    const html = []
    let listOpen = false
    let codeOpen = false
    for (const line of lines) {
      if (/^```/.test(line)) {
        if (listOpen) {
          html.push('</ul>')
          listOpen = false
        }
        html.push(codeOpen ? '</pre>' : '<pre>')
        codeOpen = !codeOpen
        continue
      }
      if (codeOpen) {
        html.push(escapeHtml(line))
        continue
      }
      const heading = line.match(/^(#{1,6})\s+(.*)$/)
      if (heading) {
        if (listOpen) {
          html.push('</ul>')
          listOpen = false
        }
        const level = Math.min(6, heading[1].length)
        html.push(`<h${level}>${inline(heading[2])}</h${level}>`)
        continue
      }
      const bullet = line.match(/^\s*[-*]\s+(.*)$/)
      if (bullet) {
        if (!listOpen) {
          html.push('<ul>')
          listOpen = true
        }
        html.push(`<li>${inline(bullet[1])}</li>`)
        continue
      }
      if (listOpen) {
        html.push('</ul>')
        listOpen = false
      }
      if (!line.trim()) continue
      html.push(`<p>${inline(line)}</p>`)
    }
    if (listOpen) html.push('</ul>')
    if (codeOpen) html.push('</pre>')
    return html.join('')
  }

  /** 评论里的 @：正文出现 @姓名 就转成平台的提及标签，mentionList 带上 targetId。 */
  async buildMentions(body, mentionNames) {
    const wanted = [
      ...String(body ?? '').matchAll(/@([^\s@，,。；;:：]+)/g),
      ...String(mentionNames ?? '')
        .split(/[,，]/)
        .map((item) => item.trim())
        .filter(Boolean),
    ].map((item) => (typeof item === 'string' ? item : item[1]))
    const seen = new Set()
    const users = []
    for (const name of wanted) {
      try {
        const user = await this.resolveUser(name)
        if (seen.has(user.id)) continue
        seen.add(user.id)
        users.push(user)
      } catch {
        // 名字对不上项目成员就跳过：不能让一条评论因为一个 @ 发不出去。
      }
    }
    return users
  }

  async addComment(input = {}) {
    const id = String(input.issueId ?? '')
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('工作项标识无效')
    const markdown = input.markdown === true
    let body = String(input.body ?? input.comment ?? '').trim()
    if (!body) throw new Error('评论内容不能为空')
    const mentions = await this.buildMentions(body, input.mention)
    /*
     * 顺序很关键：先占位 → 再格式化 → 最后把占位换回提及标签。
     * 反过来（先把 <span> 塞进正文再格式化）会被 formatComment 的 escapeHtml 转义，
     * 发出去的评论里就留下一串 &lt;span ...&gt; 源码，页面上看着像乱码。
     */
    const tokens = []
    let text = body
    for (const user of mentions) {
      const label = user.name.replace(/[（(].*$/, '')
      if (!label || !text.includes(`@${label}`)) continue
      const token = `\u0001mention${tokens.length}\u0001`
      tokens.push({ token, user, label })
      text = text.split(`@${label}`).join(token)
    }
    const tagOf = (user, label) =>
      `<span style="color:#536DFE;" data-mention-user-id="${user.id}">@${escapeHtml(label)}</span>`
    let html = this.formatComment(text, markdown)
    for (const item of tokens) html = html.split(item.token).join(tagOf(item.user, item.label))
    // 只在 mention 参数里点名、正文里没写的，放到开头单独一行
    const extra = mentions.filter((user) => !tokens.some((item) => item.user.id === user.id))
    if (extra.length) {
      const line = extra
        .map((user) => tagOf(user, user.name.replace(/[（(].*$/, '')))
        .join(' ')
      html = `<p>${line}</p>${html}`
    }
    const result = await this.requestJson(`${this.issueApiBase()}/issue_comment`, {
      method: 'POST',
      body: {
        issueId: id,
        commentText: html,
        mentionList: mentions.map((user) => ({ userId: user.id, targetId: user.id, targetType: 'user' })),
        commentAttachmentVOList: [],
      },
    })
    if (result?.failed) throw new Error(text(result.message, 300) || '评论被服务端拒绝')
    if (result?.issueId && String(result.issueId) !== id) throw new Error('评论返回的工作项与请求不一致，请到网页核实')
    return {
      ok: true,
      issueId: id,
      commentId: String(result?.commentId ?? ''),
      mentions: mentions.map((user) => user.name),
      text: plainDescription(html, 400),
    }
  }

  /**
   * 评论列表：一页评论，回复按需展开。回复接口是 reply/{commentId}，
   * 每条最多取一次；评论多时只看第一页，省得一次拉几百条。
   */
  async comments(input = {}) {
    const id = String(input.issueId ?? '')
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('工作项标识无效')
    const page = Math.max(0, Math.min(999, Number(input.page ?? 0) || 0))
    const size = Math.max(1, Math.min(50, Number(input.size ?? 20) || 20))
    const raw = await this.requestJson(
      `${this.issueApiBase()}/issue_comment/issue/${encodeURIComponent(id)}/page?page=${page}&size=${size}&sort=creationDate,desc`,
    )
    const rows = Array.isArray(raw?.content) ? raw.content : []
    const items = []
    for (const row of rows) {
      const commentId = String(row?.commentId ?? '')
      const replies = []
      if (Number(row?.replySize ?? 0) > 0) {
        try {
          const list = await this.requestJson(
            `${this.issueApiBase()}/issue_comment/reply/${encodeURIComponent(commentId)}`,
          )
          for (const reply of Array.isArray(list) ? list.slice(0, 20) : []) {
            replies.push({
              author: text(reply?.userRealName ?? reply?.userName, 60),
              text: plainDescription(reply?.commentText, 2000),
              createdAt: text(reply?.creationDate, 32),
            })
          }
        } catch {}
      }
      items.push({
        id: commentId,
        author: text(row?.userRealName ?? row?.userName, 60),
        text: plainDescription(row?.commentText, 4000),
        createdAt: text(row?.creationDate, 32),
        replies,
        attachments: (Array.isArray(row?.commentAttachmentVOList) ? row.commentAttachmentVOList : [])
          .slice(0, 20)
          .map((file) => ({ name: text(file?.attachmentName, 200), url: text(file?.attachmentUrl, 900) }))
          .filter((file) => file.name),
      })
    }
    return {
      issueId: id,
      total: Number(raw?.totalElements ?? items.length),
      page,
      size,
      hasMore: Number(raw?.totalPages ?? 1) > page + 1,
      items,
    }
  }

  /**
   * 优先级目录：`backlog/priority/list` 是 backlog 的优先级（和敏捷问题不对齐，
   * 拿它建单会被「优先级ID为空或不合法」挡回来），真正能用的是 `priority/default`。
   * 列表接口对该账号返回 404，所以这里先试列表，拿不到就只给默认优先级。
   */
  async priorities() {
    if (!this.state.projectId) throw new Error('请先在面板里选择项目')
    const base = this.issueApiBase()
    const q = `?organizationId=${encodeURIComponent(this.state.tenantId)}`
    try {
      const list = await this.requestJson(`${base}/priority/list${q}`)
      const rows = (Array.isArray(list) ? list : [])
        .map((row) => ({
          id: String(row?.id ?? ''),
          name: text(row?.name, 40),
          colour: text(row?.colour ?? row?.color, 20),
          isDefault: row?.default === true,
        }))
        .filter((row) => row.id && row.name)
      if (rows.length) return rows
    } catch {}
    const single = await this.requestJson(`${base}/priority/default${q}`)
    if (!single?.id) return []
    return [{ id: String(single.id), name: text(single.name, 40), colour: text(single.colour, 20), isDefault: true }]
  }

  /** 建单/复制用的表单默认值：类型、优先级、经办人。 */
  async createMeta() {
    const [types, priorities] = await Promise.all([this.issueTypes(), this.priorities()])
    const me = this.state.user
    return {
      types,
      priorities,
      defaultType: types.find((row) => row.typeCode === 'sub_task') ?? types[0] ?? null,
      defaultPriority: priorities.find((row) => row.isDefault) ?? priorities[0] ?? null,
      me: me ? { id: String(me.id), name: `${me.realName ?? ''}（${me.loginName ?? me.id}）` } : null,
    }
  }

  /**
   * 项目字典：模块、标签、冲刺、可用关联类型。
   *
   * <p>本环境实测：`component/query_all` 与 `sprint/names` 全系返回
   * `error.error`（程序错误），`issue_link_types` 403。可用的替代是
   * `/component`（26 个模块）与 `/issue_labels`，冲刺只能从工作项上的
   * `activeSprint` / `issueSprintVOS` 反查，关联类型从已有关联里收集。
   * 所以这里每个来源都单独兜底，取不到就给空数组并带上 error，不让整体失败。</p>
   */
  async projectDict() {
    const key = `${this.state.tenantId}:${this.state.projectId}`
    const cached = this.state.dictCache
    if (cached && cached.key === key && Date.now() - cached.at < 10 * 60_000) return cached.value
    const result = { components: [], labels: [], sprints: [], linkTypes: [], errors: [] }
    const base = this.issueApiBase()
    try {
      const rows = await this.requestJson(`${base}/component?organizationId=${encodeURIComponent(this.state.tenantId)}`)
      result.components = (Array.isArray(rows) ? rows : [])
        .map((row) => ({ id: String(row?.componentId ?? ''), name: text(row?.name, 120), issueCount: Number(row?.issueCount ?? 0) }))
        .filter((row) => row.id && row.name)
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
    } catch (error) {
      result.errors.push('模块：' + (error instanceof Error ? error.message : String(error)))
    }
    try {
      const rows = await this.requestJson(`${base}/issue_labels?${new URLSearchParams({ organizationId: String(this.state.tenantId) })}`)
      result.labels = (Array.isArray(rows) ? rows : [])
        .map((row) => ({ id: String(row?.labelId ?? row?.id ?? ''), name: text(row?.labelName ?? row?.name, 120) }))
        .filter((row) => row.id && row.name)
    } catch (error) {
      result.errors.push('标签：' + (error instanceof Error ? error.message : String(error)))
    }
    // 冲刺接口在本环境全挂，从最近的工作项里反查当前在用的冲刺。
    try {
      const seen = new Map()
      for (let page = 0; page < 3 && seen.size < 40; page++) {
        const resultPage = await this.workList({ conditions: [], treeFlag: false, withSubIssues: false }, page, 100)
        for (const row of Array.isArray(resultPage?.content) ? resultPage.content : []) {
          const active = row?.activeSprint
          if (active?.sprintId) seen.set(String(active.sprintId), text(active.sprintName, 120))
          for (const sp of Array.isArray(row?.issueSprintVOS) ? row.issueSprintVOS : []) {
            if (sp?.sprintId) seen.set(String(sp.sprintId), text(sp.sprintName, 120))
          }
        }
        if ((resultPage?.content ?? []).length < 100) break
      }
      result.sprints = [...seen.entries()].map(([id, name]) => ({ id, name }))
    } catch (error) {
      result.errors.push('冲刺：' + (error instanceof Error ? error.message : String(error)))
    }
    // 关联类型：接口本身 403，从现有关联里收集（linkTypeId + linkTypeName）。
    try {
      const rows = await this.workList({ conditions: [], treeFlag: false, withSubIssues: false }, 0, 30)
      const seen = new Map()
      for (const row of Array.isArray(rows?.content) ? rows.content : []) {
        if (!row?.issueId) continue
        const links = await this.issueLinks(String(row.issueId))
        for (const link of links) {
          if (link.linkTypeId && link.linkTypeName && !seen.has(link.linkTypeId)) {
            seen.set(link.linkTypeId, link.linkTypeName)
          }
        }
        if (seen.size >= 8) break
      }
      result.linkTypes = [...seen.entries()].map(([id, name]) => ({ id, name }))
    } catch (error) {
      result.errors.push('关联类型：' + (error instanceof Error ? error.message : String(error)))
    }
    result.fetchedAt = Date.now()
    this.state.dictCache = { key, at: Date.now(), value: result }
    await this.persist().catch(() => {})
    return result
  }

  /**
   * 按关键字搜工作项。
   *
   * <p>平台没有独立的搜索接口（`issues/search` 报 error.error，POST 403），
   * 唯一可用的是 work_list 的条件查询。关键字的字段码是 `content`、类型 `input`、
   * 值必须放在 `value.valueStr` —— 用 `summary`/`value`/`valueIdList` 都会被
   * 「数据校验不通过」挡回来（这几种形状都实测过）。</p>
   */
  async searchIssues(input = {}) {
    if (!this.state.projectId) throw new Error('请先在面板里选择项目')
    const keyword = text(input.keyword, 256).trim()
    const conditions = []
    if (keyword) {
      conditions.push({
        field: { fieldCode: 'content', predefined: true, fieldType: 'input', name: '概要' },
        relationship: 'AND',
        operation: 'LIKE',
        value: { valueStr: keyword },
      })
    }
    if (input.mine === true) conditions.push(this.mineCondition())
    if (Array.isArray(input.statusIds) && input.statusIds.length) {
      conditions.push(this.statusCondition(String(input.statusIds[0])))
    }
    const page = Math.max(0, Number(input.page ?? 0) || 0)
    const size = Math.min(100, Math.max(1, Number(input.size ?? 20) || 20))
    const result = await this.workList(
      { conditions, treeFlag: false, withSubIssues: false },
      page,
      size,
      text(input.sort, 60) || 'lastUpdateDate,desc',
    )
    const rows = Array.isArray(result?.content) ? result.content : []
    this.mergeAssigneeRows(rows)
    return {
      keyword,
      total: Number(result?.totalElements ?? rows.length),
      page,
      size,
      hasMore: page + 1 < Number(result?.totalPages ?? 1),
      items: rows.map(workItemSummary),
    }
  }

  /**
   * 改工作项的普通字段：描述、计划时间、预估/剩余、模块、标签、报告人、冲刺、史诗。
   *
   * <p>走 PUT /issues 的部分更新，必须带 objectVersionNumber；改完回读核对，
   * 不信任返回值（平台可能在乐观锁冲突时仍返回 200）。</p>
   */
  async updateIssueFields(input = {}) {
    const id = String(input.issueId ?? '')
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('工作项标识无效')
    const current = await this.issue(id)
    if (!(current.detail.version >= 0)) throw new Error('工作项缺少版本号，请刷新后重试')
    // PUT /issues 会校验请求体里的每个字段，带上未声明的字段（如 projectId）整单失败。
    const body = { issueId: id, objectVersionNumber: current.detail.version }
    const changed = []

    if (input.description !== undefined) {
      let description = String(input.description ?? '')
      if (description && !/<[a-z][\s\S]*>/i.test(description)) {
        description = description
          .split(/\n{2,}/)
          .map((block) => `<p>${escapeHtml(block).replace(/\n/g, '<br>')}</p>`)
          .join('')
      }
      body.description = description
      changed.push('描述')
    }
    if (input.summary !== undefined) {
      const summary = text(input.summary, 200).trim()
      if (!summary) throw new Error('概要不能改成空')
      body.summary = summary
      changed.push('概要')
    }
    if (input.estimatedStart !== undefined) { body.estimatedStartTime = text(input.estimatedStart, 32); changed.push('计划开始') }
    if (input.estimatedEnd !== undefined) { body.estimatedEndTime = text(input.estimatedEnd, 32); changed.push('计划结束') }
    const estimate = input.estimateTime === undefined ? null : roundHours(input.estimateTime)
    if (estimate !== null) { body.estimateTime = estimate; changed.push('原始预估') }
    const remaining = input.remainingTime === undefined ? null : roundHours(input.remainingTime)
    if (remaining !== null) { body.remainingTime = remaining; changed.push('剩余预估') }
    if (input.epicId !== undefined) { body.epicId = String(input.epicId || 0); changed.push('史诗') }
    if (input.sprintId !== undefined) { body.sprintId = String(input.sprintId || 0); changed.push('冲刺') }
    const componentIds = Array.isArray(input.componentIds)
      ? input.componentIds.map((v) => String(v ?? '').trim()).filter(Boolean)
      : null
    if (componentIds) { body.componentIssueRelVOList = componentIds.map((cid) => ({ componentId: cid })); changed.push('模块') }
    const labelIds = Array.isArray(input.labelIds)
      ? input.labelIds.map((v) => String(v ?? '').trim()).filter(Boolean)
      : null
    if (labelIds) { body.labelIssueRelVOList = labelIds.map((lid) => ({ labelId: lid })); changed.push('标签') }
    if (input.reporter !== undefined) {
      const rawText = String(input.reporter ?? '').trim()
      body.reporterId = rawText ? (await this.resolveUser(rawText)).id : String(current.detail.reporterId || '')
      changed.push('报告人')
    }
    if (!changed.length) throw new Error('没有要改的字段')

    /* 平台在写 estimateTime 时会把 remainingTime 一起对齐成原始预估，
       两个都要改就必须分两次：先原始预估，再单独写剩余预估。 */
    const remainingBody = body.remainingTime === undefined ? null : { issueId: id, remainingTime: body.remainingTime }
    if (remainingBody && body.estimateTime !== undefined) delete body.remainingTime
    await this.requestJson(`${this.issueApiBase()}/issues`, { method: 'PUT', body })
    if (remainingBody) {
      const mid = await this.issue(id)
      remainingBody.objectVersionNumber = mid.detail.version
      await this.requestJson(`${this.issueApiBase()}/issues`, { method: 'PUT', body: remainingBody })
    }
    const after = await this.issue(id)
    return {
      ok: true,
      issueId: id,
      num: after.detail.num,
      changed,
      detail: after.detail,
      components: after.components,
      links: after.links.length,
    }
  }

  /**
   * 转换工作项类型（缺陷 → 任务这种）。
   *
   * <p>平台接口是 PUT /issues/update_type，必须带 objectVersionNumber；
   * 类型必须在该项目的可选类型里，且目标类型不能是禁用状态。</p>
   */
  async changeIssueType(input = {}) {
    const id = String(input.issueId ?? '')
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('工作项标识无效')
    const wanted = String(input.typeCode ?? input.issueTypeId ?? '').trim()
    if (!wanted) throw new Error('请指定目标工作项类型')
    const current = await this.issue(id)
    const types = await this.issueTypes()
    const target = types.find((row) => row.id === wanted || row.typeCode === wanted || row.name === wanted)
    if (!target) throw new Error(`没有这个工作项类型：${wanted}；可选：${types.map((row) => row.name).join('、')}`)
    if (target.id === current.detail.typeId) {
      return { ok: true, unchanged: true, issueId: id, num: current.detail.num, typeName: current.detail.typeName }
    }
    if (!(current.detail.version >= 0)) throw new Error('工作项缺少版本号，请刷新后重试')
    const path = `${this.issueApiBase()}/issues/update_type`
    /* 这个接口在不同猪齿鱼版本上形状不一样：有的收 PUT + body，有的要先探测。
       逐个试，全失败就把服务端原话带回去，不假装成功。 */
    const attempts = [
      { method: 'PUT', body: { issueId: id, issueTypeId: target.id, objectVersionNumber: current.detail.version } },
      { method: 'POST', body: { issueId: id, issueTypeId: target.id, objectVersionNumber: current.detail.version, applyType: 'agile' } },
    ]
    const reasons = []
    for (const attempt of attempts) {
      try {
        await this.requestJson(path, { method: attempt.method, body: attempt.body })
        const after = await this.issue(id)
        if (after.detail.typeId === target.id) {
          return {
            ok: true,
            issueId: id,
            num: after.detail.num,
            from: current.detail.typeName,
            to: after.detail.typeName,
            status: after.detail.statusName,
          }
        }
        reasons.push(`${attempt.method} 返回成功但类型没变（仍是「${after.detail.typeName}」）`)
      } catch (error) {
        reasons.push(`${attempt.method}：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return {
      ok: false,
      issueId: id,
      num: current.detail.num,
      from: current.detail.typeName,
      wanted: target.name,
      available: false,
      reasons,
      hint: '这个环境的猪齿鱼没有开放类型转换接口（update_type 返回权限不符 / 程序错误），到网页端改类型即可；本插件已确认缺陷不能直接转故事类。',
    }
  }

  /**
   * 建工作项。复制模式（copyFrom）会把来源单的描述、优先级、经办人、史诗、
   * 预估/剩余工时、计划时间都抄过来，概要加「（副本）」并在正文里注明来源。
   */
  async createIssue(input = {}) {
    if (!this.state.projectId) throw new Error('请先在面板里选择项目')
    const copyFrom = String(input.copyFrom ?? '').trim()
    let source = null
    if (copyFrom) {
      const sourceId = await this.resolveIssueId(copyFrom)
      source = await this.issue(sourceId)
    }
    const summary = text(input.summary, 200).trim() || (source ? `${source.detail.summary}（副本）` : '')
    if (!summary) throw new Error('请填写工作项概要')
    const meta = await this.createMeta()
    const typeInput = String(input.typeCode ?? input.issueTypeId ?? '').trim()
    let type = null
    if (typeInput) {
      type = meta.types.find((row) => row.id === typeInput || row.typeCode === typeInput || row.name === typeInput) ?? null
      if (!type) throw new Error(`没有这个工作项类型：${typeInput}；可选：${meta.types.map((row) => row.name).join('、')}`)
    } else if (source?.detail.typeId) {
      type = meta.types.find((row) => row.id === source.detail.typeId) ?? null
    }
    type = type ?? meta.defaultType
    if (!type) throw new Error('项目里没有可建的工作项类型')
    let priority = null
    const priorityInput = String(input.priorityId ?? '').trim()
    if (priorityInput) priority = meta.priorities.find((row) => row.id === priorityInput || row.name === priorityInput) ?? null
    priority = priority ?? meta.defaultPriority
    if (!priority) throw new Error('项目里没有可用的优先级')

    let description = input.description === undefined ? source?.detail.description ?? '' : String(input.description ?? '')
    if (input.description !== undefined && !/<[a-z][\s\S]*>/i.test(description)) {
      // 弹窗里改的描述是纯文本：折成段落，别当成 HTML 直接塞。
      description = description
        .split(/\n{2,}/)
        .map((block) => `<p>${escapeHtml(block).replace(/\n/g, '<br>')}</p>`)
        .join('')
    }
    if (source && input.description === undefined) {
      description = `${description || ''}<p><br></p><p>—— 由 ${source.detail.num} 复制而来</p>`
    }
    const assigneeInput = String(input.assignee ?? '').trim()
    const assignee = assigneeInput ? await this.resolveUser(assigneeInput) : null
    // 复制时默认沿用来源单的经办人；显式选「不分配」时传 0。
    const assigneeId = input.noAssignee === true ? 0 : assignee ? assignee.id : source?.detail.assigneeId || 0

    const epicInput = String(input.epicId ?? '').trim()
    const epicId = epicInput || (source?.detail.epicId ? String(source.detail.epicId) : '')
    const body = {
      projectId: String(this.state.projectId),
      typeCode: type.typeCode,
      issueTypeId: type.id,
      summary,
      description,
      priorityId: priority.id,
      assigneeId,
      epicId: epicId || 0,
      sprintId: String(input.sprintId ?? source?.detail.sprintId ?? '') || 0,
      applyType: 'agile',
    }
    const start = text(input.estimatedStart ?? source?.detail.estimatedStart, 32)
    const end = text(input.estimatedEnd ?? source?.detail.estimatedEnd, 32)
    // 模块与标签都是「关系数组」，平台在同一个创建请求里一起收。
    const componentIds = Array.isArray(input.componentIds)
      ? input.componentIds.map((id) => String(id ?? '').trim()).filter(Boolean)
      : []
    if (componentIds.length) body.componentIssueRelVOList = componentIds.map((id) => ({ componentId: id }))
    const labelIds = Array.isArray(input.labelIds)
      ? input.labelIds.map((id) => String(id ?? '').trim()).filter(Boolean)
      : []
    if (labelIds.length) body.labelIssueRelVOList = labelIds.map((id) => ({ labelId: id }))
    const reporterInput = String(input.reporter ?? '').trim()
    if (reporterInput) body.reporterId = (await this.resolveUser(reporterInput)).id
    if (start) body.estimatedStartTime = start
    if (end) body.estimatedEndTime = end
    const estimate = roundHours(input.estimateTime ?? source?.detail.estimateTime)
    const remaining = roundHours(input.remainingTime ?? source?.detail.remainingTime)
    if (estimate !== null) body.estimateTime = estimate
    if (remaining !== null) body.remainingTime = remaining
    // 平台字段是 parentIssueId；传 parentId 会被静默忽略，建出一条游离单。
    if (input.parentId) body.parentIssueId = String(input.parentId)
    if (input.parentIssueId) body.parentIssueId = String(input.parentIssueId)

    const created = await this.requestJson(
      `${this.issueApiBase()}/issues?applyType=agile`,
      { method: 'POST', body },
    )
    if (!created?.issueId) throw new Error(text(created?.message, 300) || '服务端没有返回新工作项 id')
    const detail = await this.issue(String(created.issueId))
    return {
      ok: true,
      issueId: String(created.issueId),
      num: detail.detail.num,
      summary: detail.detail.summary,
      status: detail.detail.statusName,
      typeName: detail.detail.typeName,
      assignee: detail.detail.assigneeName,
      priority: detail.detail.priority,
      copiedFrom: source ? { num: source.detail.num, summary: source.detail.summary } : null,
    }
  }

  /**
   * 预填一份新建表单：source 为空给默认值，给了来源单就把它的字段抄过来，
   * 由面板弹窗（或模型）改完再提交 createIssue。
   */
  async issueDraft(input = {}) {
    const meta = await this.createMeta()
    const copyFrom = String(input.copyFrom ?? '').trim()
    if (!copyFrom) {
      return {
        mode: 'new',
        summary: '',
        description: '',
        typeId: meta.defaultType?.id ?? '',
        typeCode: meta.defaultType?.typeCode ?? '',
        priorityId: meta.defaultPriority?.id ?? '',
        assigneeId: meta.me?.id ?? '',
        assigneeName: meta.me?.name ?? '',
        epicId: '',
        estimateTime: null,
        remainingTime: null,
        estimatedStart: '',
        estimatedEnd: '',
        types: meta.types,
        priorities: meta.priorities,
      }
    }
    const sourceId = await this.resolveIssueId(copyFrom)
    const source = await this.issue(sourceId)
    return {
      mode: 'copy',
      copiedFrom: source.detail.num,
      summary: `${source.detail.summary}（副本）`.slice(0, 200),
      description: source.detail.descriptionText,
      typeId: source.detail.typeId,
      typeCode: '',
      priorityId: '',
      priorityName: source.detail.priority,
      assigneeId: source.detail.assigneeId,
      assigneeName: source.detail.assigneeName,
      epicId: String(source.detail.epicId ?? ''),
      epicName: source.detail.epicName,
      estimateTime: source.detail.estimateTime ?? null,
      remainingTime: source.detail.remainingTime ?? null,
      estimatedStart: source.detail.estimatedStart,
      estimatedEnd: source.detail.estimatedEnd,
      types: meta.types,
      priorities: meta.priorities,
    }
  }

  /**
   * 工时字段。平台没有单独的工时记录接口（web 端也是写工作项本身），
   * 实际可写的是「原始预估」「剩余预估」两个字段，走部分更新接口。
   */
  async setEstimate(input = {}) {
    const id = String(input.issueId ?? '')
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('工作项标识无效')
    const estimate = input.estimateTime === undefined || input.estimateTime === '' ? null : roundHours(input.estimateTime)
    const remaining = input.remainingTime === undefined || input.remainingTime === '' ? null : roundHours(input.remainingTime)
    if (estimate === null && remaining === null) throw new Error('给个原始预估或剩余预估（小时，0.1~999.9）')
    const current = await this.issue(id)
    if (!(current.detail.version >= 0)) throw new Error('工作项缺少版本号，请刷新后重试')
    const body = { issueId: id, objectVersionNumber: current.detail.version }
    if (estimate !== null) body.estimateTime = estimate
    if (remaining !== null) body.remainingTime = remaining
    await this.requestJson(`${this.issueApiBase()}/issues`, { method: 'PUT', body })
    const after = await this.issue(id)
    return {
      ok: true,
      issueId: id,
      num: after.detail.num,
      estimateTime: after.detail.estimateTime ?? null,
      remainingTime: after.detail.remainingTime ?? null,
    }
  }

  // ---------- 工时日志 ----------

  /**
   * 工作项上的工时流水。平台把「登记工作日志」放在敏捷服务的 work_log 下，
   * 和工作项上的「原始预估 / 剩余预估」是两套：前者是流水，后者是汇总字段。
   */
  async workLogs(input = {}) {
    const id = String(input.issueId ?? '')
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('工作项标识无效')
    const rows = await this.requestJson(`${this.issueApiBase()}/work_log/issue/${encodeURIComponent(id)}`)
    const items = (Array.isArray(rows) ? rows : []).map((row) => ({
      logId: String(row?.logId ?? ''),
      workTime: row?.workTime === undefined || row?.workTime === null ? null : Number(row.workTime),
      startDate: text(row?.startDate, 32),
      description: text(row?.description, 2000),
      userId: String(row?.createdBy ?? ''),
      userName: text(row?.realName ?? row?.userName, 120),
      loginName: text(row?.loginName, 60),
      updatedAt: text(row?.lastUpdateDate, 32),
    }))
    const total = items.reduce((sum, item) => sum + (Number.isFinite(item.workTime) ? item.workTime : 0), 0)
    return { issueId: id, items, total: Math.round(total * 100) / 100, mine: this.state.user?.id ?? '' }
  }

  /**
   * 登记一条工时。剩余预估按网页端的四种口径原样下传：
   * self_adjustment 自动调整、no_set_prediction_time 不调整、set_to 设置为、reduce 缩减。
   */
  async addWorkLog(input = {}) {
    const id = String(input.issueId ?? '')
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('工作项标识无效')
    const workTime = roundHours(input.workTime)
    if (workTime === null || workTime <= 0) throw new Error('耗费时间要给 0.1~999.9 小时')
    const mode = ['self_adjustment', 'no_set_prediction_time', 'set_to', 'reduce'].includes(input.residualPrediction)
      ? input.residualPrediction
      : 'self_adjustment'
    const body = {
      issueId: id,
      projectId: this.state.projectId,
      workTime,
      startDate: workLogDate(input.startDate),
      description: text(input.description, 2000),
      residualPrediction: mode,
    }
    if (mode === 'set_to' || mode === 'reduce') {
      const prediction = roundHours(input.predictionTime)
      if (prediction === null) throw new Error('选择「设置为 / 缩减」时必须给预估时间')
      body.predictionTime = prediction
    }
    const created = await this.requestJson(`${this.issueApiBase()}/work_log`, { method: 'POST', body })
    return {
      ok: true,
      logId: String(created?.logId ?? ''),
      issueId: id,
      workTime: created?.workTime ?? workTime,
      startDate: text(created?.startDate, 32),
      residualPrediction: mode,
    }
  }

  async removeWorkLog(input = {}) {
    const logId = String(input.logId ?? '')
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(logId)) throw new Error('工时记录标识无效')
    await this.requestJson(`${this.issueApiBase()}/work_log/${encodeURIComponent(logId)}`, { method: 'DELETE' })
    return { ok: true, logId }
  }

  // ---------- 附件 ----------

  /**
   * 给工作项加附件。
   *
   * <p>接口是 multipart：文件本体 + issueId + bucketName 一起提交，
   * 服务端自己上传 OBS 并把记录挂到工作项上，不用先传文件拿 URL 再挂。
   * bucketName 必须是 agile-service —— 传成别的会报 OBS 上传失败。</p>
   */
  async addAttachment(input = {}) {
    const issueId = String(input.issueId ?? '')
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(issueId)) throw new Error('工作项标识无效')
    const fileName = text(input.fileName, 260) || 'attachment'
    const contentBase64 = String(input.contentBase64 ?? '')
    if (!contentBase64) throw new Error('没有文件内容')
    const buffer = Buffer.from(contentBase64, 'base64')
    if (!buffer.length) throw new Error('文件内容为空')
    if (buffer.length > MAX_ATTACHMENT) {
      throw new Error(`文件超过 ${Math.round(MAX_ATTACHMENT / 1024 / 1024)}MB，换个小的或到网页上传`)
    }
    const contentType = text(input.contentType, 120) || 'application/octet-stream'
    // guid 与平台页面一致：文件内容的 MD5，服务端据此判断这份文件是不是已经传过。
    const guid = createHash('md5').update(buffer).digest('hex')
    const org = encodeURIComponent(this.state.tenantId)

    /**
     * ① 断点续传探针：问服务端这个 guid 已经存了几片。
     *
     * <p>实测语义：从没传过返回 0；save 之后、combine 之前返回 1；
     * combine 把临时文件消费掉后又回到 0。所以它反映的是「临时存储里有没有半成品」，
     * 不是去重开关。正常一次传完这条路走不到续传分支，但上传中断后重试能省掉重传。</p>
     */
    let uploaded = 0
    try {
      const probe = await this.requestJson(
        `/hfle/v1/${org}/upload/check-block`,
        {
          method: 'POST',
          extraHeaders: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
          rawBody: new URLSearchParams({ chunk: '0', chunkSize: String(buffer.length), guid }).toString(),
        },
      )
      uploaded = Number(probe ?? 0) || 0
    } catch { /* 探测失败不挡上传，直接传一遍 */ }

    // ② 传文件本体
    if (!uploaded) {
      const form = new FormData()
      form.append('guid', guid)
      form.append('fileMd5', guid)
      form.append('id', 'WU_FILE_1')
      form.append('name', fileName)
      form.append('type', contentType)
      form.append('lastModifiedDate', new Date().toString())
      form.append('size', String(buffer.length))
      form.append('file', new Blob([buffer], { type: contentType }), fileName)
      await this.requestJson(`/hfle/v1/${org}/upload/save`, { method: 'POST', formData: form })
    }

    // ③ 挂到工作项上
    const rows = await this.requestJson(`${this.issueApiBase()}/issue_attachment/combine`, {
      method: 'POST',
      body: { guid, fileName, issueId },
    })
    const row = Array.isArray(rows) ? rows[0] : rows
    if (!row?.attachmentId) throw new Error('服务端没有返回附件记录')
    return {
      ok: true,
      id: String(row.attachmentId),
      fileName: text(row.fileName, 260) || fileName,
      url: text(row.url, 2000),
      size: buffer.length,
      resumed: uploaded > 0,
    }
  }

  /**
   * 删除工作项。
   *
   * <p>平台是真的删掉（204，之后详情 404），不可撤销，所以必须显式给 confirm:true。
   * 平台偶尔返回 "source cannot be null"，重试一次即可，不需要额外参数。</p>
   */
  async deleteIssue(input = {}) {
    const id = String(input.issueId ?? '')
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('工作项标识无效')
    if (input.confirm !== true) {
      throw new Error('删除不可撤销，确认要删请传 confirm: true')
    }
    const current = await this.issue(id)
    const path = `${this.issueApiBase()}/issues/${encodeURIComponent(id)}`
    /**
     * 判定只看「条目还在不在」，不看接口返回。
     *
     * <p>这个接口有两种反直觉的行为，都实测到了：
     *   1. 返回 204 且确实删掉（正常情况）；
     *   2. 返回 `source cannot be null` **但条目已经删掉**（平台侧边删边报错）。
     * 所以既不能把报错当失败，也不能把 204 当成功 —— 唯一可信的判据是回读。</p>
     */
    const stillExists = async () => {
      try {
        await this.issue(id)
        return true
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (/不存在|没有找到|HTTP 404/.test(message)) return false
        throw error
      }
    }
    let lastError = null
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.requestJson(path, { method: 'DELETE' })
      } catch (error) {
        lastError = error
      }
      // 每次动作后都回读：删掉了就成功，报错与否都不重要。
      if (!(await stillExists())) {
        return { ok: true, deleted: true, issueId: id, num: current.detail.num, summary: current.detail.summary }
      }
      if (lastError) {
        const message = lastError instanceof Error ? lastError.message : String(lastError)
        // 只有平台抖动值得重试；其它错误说明这次请求根本没生效。
        if (!/source cannot be null/i.test(message)) throw lastError
      }
      await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)))
    }
    if (lastError) throw lastError
    throw new Error('服务端返回成功，但工作项仍然存在，请刷新后重试')
  }

  /**
   * 把附件的原始 OBS 地址换成可下载的预签名地址。
   *
   * <p>附件直链在私有桶里，浏览器直接点会被 403。平台的 `redirect-url` 接口会返回
   * 302 到带 AccessKeyId/Expires/Signature 的 OBS 地址，那个地址有时效、可直接下载。
   * 这里只取 Location，不跟随 —— 把地址交给前端在浏览器里打开，下载流量不走插件进程。</p>
   */
  async attachmentDownloadUrl(input = {}) {
    const raw = text(input.url, 2000)
    if (!raw) throw new Error('没有附件地址')
    if (!/^https:\/\//i.test(raw)) throw new Error('附件地址必须是 http(s)')
    const query = new URLSearchParams({ bucketName: 'private', url: raw })
    const response = await fetch(new URL(`/hfle/v1/files/redirect-url?${query}`, this.config.apiOrigin), {
      method: 'GET',
      // 不跟随重定向：要的就是那一跳的 Location
      redirect: 'manual',
      headers: { ...this.headers(), Accept: '*/*' },
      cache: 'no-store',
      signal: AbortSignal.timeout(30_000),
    })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location') || ''
      if (!location) throw new Error('平台没有返回下载地址')
      // 预签名地址有时效；把过期时间一并带回，界面可以提示「链接会过期」。
      const expires = (() => {
        try { return Number(new URL(location).searchParams.get('Expires') ?? 0) * 1000 || null } catch { return null }
      })()
      return { ok: true, url: location, expiresAt: expires, fileName: text(input.fileName, 260) }
    }
    const body = await response.text().catch(() => '')
    let detail = ''
    try { detail = text(JSON.parse(body).message, 200) } catch { detail = text(body, 160) }
    throw new Error(`取下载地址失败（HTTP ${response.status}）${detail ? '：' + detail : ''}`)
  }

  async removeAttachment(input = {}) {
    const attachmentId = String(input.attachmentId ?? '')
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(attachmentId)) throw new Error('附件标识无效')
    await this.requestJson(
      `${this.issueApiBase()}/issue_attachment/${encodeURIComponent(attachmentId)}`,
      { method: 'DELETE' },
    )
    return { ok: true, attachmentId }
  }

  // ---------- 子任务 ----------

  /**
   * 在当前工作项下快速建一个子任务。
   *
   * <p>只有概要是必填，类型可按 id / 编码 / 名称指定，都没给才挑项目里第一个 sub_task；
   * 平台要求 priorityId，所以没传时沿用父单的优先级，再不行用详情的默认优先级。</p>
   */
  async createSubIssue(input = {}) {
    const parentId = String(input.parentId ?? input.issueId ?? '')
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(parentId)) throw new Error('父工作项标识无效')
    const summary = text(input.summary, 400).trim()
    if (!summary) throw new Error('子任务概要不要为空')

    const parent = await this.requestJson(
      `${this.issueApiBase()}/issues/${encodeURIComponent(parentId)}?${new URLSearchParams({
        organizationId: String(this.state.tenantId),
        instanceProjectId: String(this.state.projectId),
      })}`,
    )

    /*
     * 类型：项目把 sub_task 拆成「前端开发任务 / 后端开发任务 / 测试子任务」等多个变体，
     * 只按编码挑第一个就永远是「非开发子任务」。调用方给了 id / 编码 / 名称就按给的建，
     * 编码必须跟选中的类型一致，不能一律写 sub_task；都没给才退回第一个 sub_task。
     */
    const wantedId = text(input.issueTypeId, 40)
    const wantedCode = text(input.typeCode, 40)
    let types = null
    let picked = null
    if (wantedId || wantedCode) {
      types = await this.issueTypes().catch(() => [])
      picked =
        types.find((row) => row.id === wantedId) ??
        types.find((row) => row.typeCode === wantedCode || row.name === wantedCode) ??
        null
      if (!picked && !wantedId) {
        const subs = types.filter((row) => row.typeCode === 'sub_task')
        const names = (subs.length ? subs : types).map((row) => row.name).join('、') || '无'
        throw new Error(`没有这个工作项类型：${wantedCode}；可选：${names}`)
      }
    } else {
      types = await this.issueTypes()
      picked = types.find((row) => row.typeCode === 'sub_task') ?? types[0] ?? null
    }
    const issueTypeId = picked?.id ? String(picked.id) : wantedId || String(parent?.issueTypeId ?? '')
    const typeCode = picked?.typeCode || wantedCode || 'sub_task'
    if (!issueTypeId) throw new Error('这个项目里没有可用的子任务类型')

    // 优先级：平台强制要 id，没传就沿父单
    const priorityId =
      text(input.priorityId, 40) || String(parent?.priorityVO?.id ?? parent?.priorityId ?? '')
    if (!priorityId) throw new Error('取不到优先级，子任务建不了')

    // 雪花 id 都是 64 位，超过 JS 安全整数范围，一律按字符串传，转 Number 会丢精度导致「id 不合法」。
    const body = {
      issueTypeId,
      typeCode,
      summary,
      projectId: String(this.state.projectId),
      // 父单字段是 parentIssueId；传 parentId 会被静默忽略，建出来是个游离单
      parentIssueId: parentId,
      priorityId,
      sprintId: String(parent?.sprintId ?? '0') || '0',
    }
    if (input.assignee) body.assigneeId = String(input.assignee)
    const created = await this.requestJson(`${this.issueApiBase()}/issues?applyType=agile`, {
      method: 'POST',
      body,
    })
    const newId = String(created?.issueId ?? '')
    if (!newId) throw new Error(text(created?.message, 200) || '服务端没有返回新子任务 id')

    const detail = await this.issue(newId)
    return {
      ok: true,
      id: newId,
      num: detail.detail.num,
      summary: detail.detail.summary,
      statusName: detail.detail.statusName,
      typeName: detail.detail.typeName,
      typeId: issueTypeId,
      parentId,
    }
  }

  /**
   * 项目里的工作项类型清单。建单弹窗的类型下拉与子任务挑 sub_task 都读这一份。
   *
   * <p>平台字段叫 typeCode；这个类里曾经有两份同名实现，后者把字段写成 code，
   * 于是 createIssue 的 body.typeCode 变成 undefined、按 typeCode 指定类型也匹配不到。
   * 这里统一叫 typeCode，并保留 code 作为别名给老调用点。</p>
   */
  async issueTypes() {
    if (!this.state.projectId) throw new Error('请先在面板里选择项目')
    const key = `${this.state.tenantId}:${this.state.projectId}`
    const cached = this.typesCache
    if (cached && cached.key === key && Date.now() - cached.at < 10 * 60_000) return cached.value
    const rows = await this.requestJson(
      `${this.issueApiBase()}/schemes/query_issue_types_with_sm_id?${new URLSearchParams({
        organizationId: String(this.state.tenantId),
        applyType: 'agile',
      })}`,
    )
    const list = (Array.isArray(rows) ? rows : [])
      .filter((row) => row?.enabled !== false && row?.applyType !== 'backlog' && row?.applyType !== 'risk')
      .map((row) => {
        const typeCode = text(row?.typeCode ?? row?.code, 40)
        return {
          id: String(row?.id ?? ''),
          name: text(row?.name, 80),
          typeCode,
          code: typeCode,
          colour: text(row?.colour, 20),
        }
      })
      .filter((row) => row.id && row.typeCode)
    this.typesCache = { at: Date.now(), key, value: list }
    return list
  }

  // ---------- 关联工作项 ----------

  /**
   * 建立工作项关联。
   *
   * <p>平台这个接口收的是数组，且必须带 linkTypeId；只传 linkedIssueId 会 400。
   * ward 是视角词，建「复制」关系时要写「被复制」表示对方处于被复制方。</p>
   */
  async addIssueLinks(input = {}) {
    const issueId = String(input.issueId ?? '')
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(issueId)) throw new Error('工作项标识无效')
    const rows = Array.isArray(input.links) ? input.links : []
    if (!rows.length) throw new Error('没有要建立的关联')
    const payload = rows
      .map((row) => ({
        issueId,
        linkedIssueId: String(row?.linkedIssueId ?? row?.issueId ?? ''),
        linkTypeId: String(row?.linkTypeId ?? ''),
        ward: text(row?.ward, 40) || '被复制',
      }))
      .filter((row) => row.linkedIssueId && row.linkTypeId)
    if (!payload.length) throw new Error('关联缺 linkTypeId 或目标工作项')

    const result = await this.requestJson(`${this.issueApiBase()}/issue_links/${encodeURIComponent(issueId)}`, {
      method: 'POST',
      body: payload,
    })
    const created = Array.isArray(result?.issueLinks) ? result.issueLinks : []
    return { ok: true, count: created.length || payload.length, links: created }
  }

  async removeIssueLink(input = {}) {
    const linkId = String(input.linkId ?? '')
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(linkId)) throw new Error('关联标识无效')
    await this.requestJson(`${this.issueApiBase()}/issue_links/${encodeURIComponent(linkId)}`, {
      method: 'DELETE',
    })
    return { ok: true, linkId }
  }
  // ---------- 消息通知 / 新任务 ----------

  /** 站内消息未读数：网页端右上角那个铃铛。 */
  async unreadMessages() {
    if (!this.state.tenantId) return { unread: 0 }
    try {
      const result = await this.requestJson(`/hmsg/v1/${encodeURIComponent(this.state.tenantId)}/messages/user/count`)
      return { unread: Number(result?.unreadMessageCount ?? 0) }
    } catch {
      // 消息服务在部分环境里没装，铃铛不可用不该影响其它能力。
      return { unread: 0, unavailable: true }
    }
  }

  /**
   * 新任务基线：只记「已经见过哪些工作项」，不记业务字段。
   * 首次跑时把当前全量当基线，之后轮询只算增量，避免一上线就报几百条。
   */
  baselineKey() {
    return `${this.state.tenantId}:${this.state.projectId}:${this.state.user?.id ?? ''}`
  }

  async myIssues(limit = 100, sort = 'creationDate,desc', page = 0) {
    const assigneeId = this.state.user?.id
    if (!assigneeId) throw new Error('请先登录猪齿鱼')
    if (!this.state.projectId) throw new Error('请先在面板里选择项目')
    const result = await this.workList(
      { conditions: [this.mineCondition()], treeFlag: false, withSubIssues: false },
      page,
      limit,
      sort,
    )
    return (Array.isArray(result?.content) ? result.content : []).map(workItemSummary)
  }

  /**
   * 基线要覆盖「我名下全部工作项」，否则别人把一条很早创建的单改派给我时，
   * 它既不在基线里、又排在创建时间很后面，会被反复当成新任务报出来。
   * 最多扫 10 页（1000 条），再多的项目只按最近更新的那批算基线。
   */
  async allMyIssueIds() {
    const ids = new Set()
    for (let page = 0; page < 10; page++) {
      const rows = await this.myIssues(100, 'lastUpdateDate,desc', page)
      const before = ids.size
      for (const row of rows) if (row.id) ids.add(row.id)
      if (rows.length < 100 || ids.size === before) break
    }
    return [...ids]
  }

  /**
   * 新任务计数：经办人是我、且不在基线里的工作项。
   * 按「最近更新」取样，别人刚改派过来的老单也会浮到第一页，不会被漏掉。
   * 数字会随「见过的单被并进基线」而跳跃，这是预期行为。
   *
   * <p>基线带 {@link BASELINE_VERSION}：取样方式一变就静默重建，
   * 否则升级那一刻会把旧口径漏掉的单当成新任务一起报出来。</p>
   */
  async newTasks(options = {}) {
    if (!this.state.token || !this.state.projectId) return { count: 0, items: [] }
    const key = this.baselineKey()
    const baseline = this.state.taskBaseline
    if (!baseline || baseline.key !== key || baseline.v !== BASELINE_VERSION || !Array.isArray(baseline.ids)) {
      const ids = await this.allMyIssueIds()
      this.state.taskBaseline = { v: BASELINE_VERSION, key, ids, at: Date.now() }
      await this.persist()
      return { count: 0, items: [], baselineReset: true, scanned: ids.length }
    }
    const seen = new Set(baseline.ids)
    const rows = await this.myIssues(100, 'lastUpdateDate,desc', 0)
    const fresh = rows.filter((row) => row.id && !seen.has(row.id))
    if (options.acknowledge === true) {
      this.state.taskBaseline = {
        v: BASELINE_VERSION,
        key,
        ids: [...new Set([...baseline.ids, ...rows.map((row) => row.id)])].slice(0, 1000),
        at: Date.now(),
      }
      await this.persist()
      return { count: 0, items: fresh, acknowledged: fresh.length }
    }
    const mapRow = (row) => ({
      id: row.id,
      num: row.num,
      summary: row.summary,
      status: row.statusName,
      statusType: row.statusType,
      priority: row.priority,
      assignee: row.assigneeName,
      creationDate: row.creationDate,
    })
    return {
      count: fresh.length,
      // 角标只要前几条；面板里的通知弹窗要全量，用 all: true 取。
      // 上限 500 只是防呆：真分了一千条也不会把响应撑爆。
      items: (options.all === true ? fresh.slice(0, 500) : fresh.slice(0, 8)).map(mapRow),
      truncated: options.all === true ? Math.max(0, fresh.length - 500) : Math.max(0, fresh.length - 8),
      baselineAt: baseline.at ?? null,
    }
  }

  // ---------- 操作记录 ----------

  /**
   * 工作项操作记录。网页端「操作记录」页读的就是这条接口：
   * 一个字段一行（旧值 → 新值），同一次提交会产生多行。
   * 这里按「同一个人、同一秒」合并成一条事件，读起来才像人写的。
   */
  async activity(input = {}) {
    const id = String(input.issueId ?? '')
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('工作项标识无效')
    const query = new URLSearchParams({
      issueId: id,
      instanceProjectId: String(this.state.projectId),
    })
    let rows = []
    try {
      rows = await this.requestJson(
        `/agile/v1/projects/${encodeURIComponent(this.state.projectId)}/data_log?${query}`,
      )
    } catch (error) {
      return { issueId: id, events: [], error: error instanceof Error ? error.message : String(error) }
    }
    const list = Array.isArray(rows) ? rows : []

    const events = []
    let current = null
    for (const row of list) {
      const field = text(row?.field, 60)
      // WorklogId 是工时流水的内部主键，一行 timespent 已经说明了同一件事。
      if (!field || field === 'WorklogId') continue
      const at = text(row?.lastUpdateDate ?? row?.creationDate, 32)
      const by = text(row?.realName ?? row?.name, 60)
      const key = `${at}|${row?.createdBy ?? ''}`
      const change = {
        field,
        fieldName: activityFieldName(row, field),
        from: activityValue(row?.oldString ?? row?.oldValue),
        to: activityValue(row?.newString ?? row?.newValue),
        category: text(row?.categoryCode, 20),
      }
      if (!current || current.key !== key) {
        current = {
          key,
          at,
          by,
          loginName: text(row?.loginName, 40),
          avatar: text(row?.imageUrl, 400),
          changes: [],
        }
        events.push(current)
      }
      current.changes.push(change)
    }

    // 最近一次经办人变更单独拎出来：分回给谁就看它。
    const assignees = events
      .flatMap((event) => event.changes.filter((change) => change.field === 'assignee').map((change) => ({ ...change, at: event.at, by: event.by })))
      .slice(0, 10)
    return {
      issueId: id,
      total: events.length,
      events: (input.limit ? events.slice(0, Number(input.limit)) : events).map(({ key, ...rest }) => rest),
      assignees,
      latest: events[0]
        ? {
            at: events[0].at,
            by: events[0].by,
            changes: events[0].changes,
          }
        : null,
    }
  }

  // ---------- 工作区 / 分支 ----------

  /**
   * 走 DSH 的 subprocess 服务执行命令：它负责可执行文件解析、输出采集与取消，
   * 比直接 spawn 更适合宿主进程。服务缺失时退回 execFile。
   */
  async exec(argv, cwd) {
    const subprocess = this.ctx.get('subprocess')
    if (subprocess?.spawn) {
      let executable = argv[0]
      try {
        executable = await subprocess.resolveExecutable(argv[0])
      } catch {}
      const handle = subprocess.spawn({
        argv: [executable, ...argv.slice(1)],
        cwd,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: 1 << 20 },
          stderr: { maxBytes: 1 << 18 },
        },
        graceMs: 2000,
      })
      let outcome
      try {
        outcome = await handle.done
      } catch (error) {
        return { ok: false, stdout: '', stderr: '', message: error?.message ?? '子进程失败' }
      }
      const stdout = handle.collected?.stdout?.readFrom(0)?.text ?? ''
      const stderr = handle.collected?.stderr?.readFrom(0)?.text ?? ''
      return { ok: outcome?.exitCode === 0, stdout, stderr, message: '' }
    }
    return run(argv[0], argv.slice(1), { cwd })
  }

  /**
   * 目录在 DSH 里注册成工作区，侧栏才认这个目录；已经注册过就直接复用。
   * @returns 工作区 id；失败时给 error，由调用方决定是否阻断。
   */
  async ensureWorkspace(dir) {
    const registry = this.ctx.get('workspaceRegistry')
    if (!registry?.create) return { error: '当前 profile 没有 workspaceRegistry' }
    try {
      const workspace = (await registry.resolveByPath?.(dir)) ?? (await registry.create(dir))
      if (!workspace) return { error: `目录 ${dir} 没有对应的工作区` }
      return { workspaceId: String(workspace.id ?? ''), workspace }
    } catch (error) {
      return { error: `注册工作区失败：${error instanceof Error ? error.message : String(error)}` }
    }
  }

  async repoPath() {
    if (this.state.repoPath) {
      if (existsSync(this.state.repoPath)) return this.state.repoPath
      // 目录被删了（临时测试仓库、清掉的 checkout）：别再把它当默认仓库。
      this.state.repoPath = null
      await this.persist().catch(() => {})
    }
    // 优先用已在 DSH 里注册过、且确实是 Git 仓库的工作区目录。
    const registry = this.ctx.get('workspaceRegistry')
    if (registry?.list) {
      try {
        for (const workspace of registry.list()) {
          const path = workspace?.path
          if (typeof path !== 'string' || !path) continue
          if (existsSync(join(path, '.git'))) return path
        }
      } catch {}
    }
    const service = this.ctx.get('workingDirectory')
    if (service?.defaultDirectory) return service.defaultDirectory
    return process.cwd()
  }

  async setRepoPath(value) {
    const path = typeof value === 'string' ? value.trim() : ''
    if (!path) {
      this.state.repoPath = null
      await this.persist()
      return this.repoPath()
    }
    if (!existsSync(path)) throw new Error(`路径不存在：${path}`)
    // 允许直接指到 worktree 或多层子目录，统一收敛到仓库根。
    const probe = await this.exec(['git', '-C', path, 'rev-parse', '--show-toplevel'], path)
    if (!probe.ok) throw new Error(`不是 Git 仓库：${path}`)
    // git 在 Windows 上吐正斜杠，统一成平台原生路径，否则候选里会出现同一个目录的两条。
    this.state.repoPath = resolve(probe.stdout.trim() || path)
    await this.persist()
    // 手动选的目录也登记成 DSH 工作区，否则侧栏不认它，会话也没处挂。
    // 这里失败不阻断保存：建分支时还会再试一次，并把原因显示在弹窗里。
    await this.ensureWorkspace(this.state.repoPath)
    return this.state.repoPath
  }

  /** 候选仓库：DSH 里已注册的 Git 工作区，再加手动选过的那个目录。 */
  async repos() {
    const list = []
    const seen = new Set()
    const push = (rawPath, title) => {
      if (typeof rawPath !== 'string' || !rawPath) return
      // 正斜杠与反斜杠指同一个目录，统一后再判重。
      const path = resolve(rawPath)
      if (seen.has(path)) return
      if (!existsSync(join(path, '.git'))) return
      seen.add(path)
      list.push({ path, title: text(title, 120) || basename(path) })
    }
    // 手动选的排最前：它才是用户刚挑的那个，但仍要过 Git 仓库这一关。
    push(this.state.repoPath, '')
    const registry = this.ctx.get('workspaceRegistry')
    if (registry?.list) {
      try {
        for (const workspace of registry.list()) push(workspace?.path, workspace?.title)
      } catch {}
    }
    return list
  }

  /** 列出本地与远端分支，供「自定义来源分支」使用。 */
  async branches(repoPath) {
    const repo = repoPath ? await this.resolveRepo(repoPath) : await this.repoPath()
    const probe = await this.exec(['git', '-C', repo, 'rev-parse', '--show-toplevel'], repo)
    if (!probe.ok) throw new Error(`不是 Git 仓库：${repo}`)
    const root = probe.stdout.trim()
    const result = await this.exec(
      ['git', '-C', root, 'for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes'],
      root,
    )
    const names = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.endsWith('/HEAD'))
    const local = names.filter((name) => !name.includes('/') || !name.startsWith('origin/'))
    const remote = names.filter((name) => name.startsWith('origin/')).map((name) => name.slice('origin/'.length))
    return {
      repo: root,
      local: [...new Set(local)],
      remote: [...new Set(remote)],
      current: (await this.exec(['git', '-C', root, 'rev-parse', '--abbrev-ref', 'HEAD'], root)).stdout.trim(),
    }
  }

  /** 分支已检出到哪个工作目录；没检出返回空字符串。 */
  async worktreePathOfBranch(root, branch) {
    const listed = await this.exec(['git', '-C', root, 'worktree', 'list', '--porcelain'], root)
    if (!listed.ok) return ''
    let path = ''
    for (const line of listed.stdout.split(/\r?\n/)) {
      if (line.startsWith('worktree ')) path = line.slice('worktree '.length).trim()
      else if (line.startsWith('branch ') && line.slice('branch '.length).trim() === `refs/heads/${branch}`) return path
    }
    return ''
  }

  /**
   * 固定分支开发：不建分支、不建 worktree、不动任何引用，
   * 直接用该分支已检出的工作目录开一个会话。
   */
  async openFixedSession({ root, fixedBranch, detail, issueNum, input }) {
    const branch = text(fixedBranch, 120).trim()
    if (!branch || branch.includes('..') || /[\s~^:?*[\\]/.test(branch)) throw new Error('分支名不合法')

    const exists = await this.exec(['git', '-C', root, 'rev-parse', '--verify', `refs/heads/${branch}`], root)
    if (!exists.ok) throw new Error(`本地没有分支 ${branch}，先在仓库里创建或拉取它`)

    let worktreePath = await this.worktreePathOfBranch(root, branch)
    if (!worktreePath) {
      throw new Error(`分支 ${branch} 当前没有检出到任何工作目录，先手动 checkout 再开会话`)
    }

    const docEnabled = input.docEnabled !== false
    const context = await this.writeIssueContext({
      root,
      detail: detail.detail,
      branch,
      base: branch,
      baseCommit: '',
      worktreePath,
      docEnabled,
      docTarget: input.docTarget,
      docName: input.docName,
      reused: true,
      fixed: true,
    })
    const folders = await this.ensureFolders({
      root,
      worktreePath,
      contextFile: context.contextFile,
      contextRelative: context.contextRelative,
      docEnabled: context.docEnabled,
      docTarget: context.docTarget,
    })

    const description = detail.detail.descriptionText || plainDescription(detail.detail.description, 2000)
    const brief = [
      `本次任务来自猪齿鱼工作项 ${issueNum}：${detail.detail.summary}`,
      description ? `工作项描述：\n${description}` : '',
      `固定分支模式：直接在 ${branch} 上开发，工作目录 ${worktreePath}，不新建分支、不建 worktree。`,
      `主仓库 ${root}，完整上下文见 ${context.contextRelative}。`,
      context.docEnabled
        ? `产出文档必须放在 ${context.docTarget} 下，不要写到仓库根或 .dsh。`
        : '本次不要求产出文档目录，按需在仓库内合适位置存放即可。',
      '只做本地提交，不要 push、不要 merge、不要 reset --hard；推送与合并由人执行。',
      `需要推进工作项状态（如开发完成置为「待测试」）或改经办人时，调用 choerodon_update 工具，issue 传 ${issueNum}；不要让人回猪齿鱼网页操作。`,
    ]
      .filter(Boolean)
      .join('\n')

    const session = await this.createIssueSession({
      repoPath: root,
      worktreePath,
      issueNum,
      summary: detail.detail.summary,
      // 工作项要点进系统提示，全文作为首条用户消息发进对话（见上面同样处理）。
      brief,
      kickoff: this.issueKickoffText({
        detail: detail.detail,
        branch,
        worktreePath,
        root,
        contextRelative: context.contextRelative,
        docEnabled: context.docEnabled,
        docTarget: context.docTarget,
        fixed: true,
      }),
      branch,
      agentPreset: input.agentPreset,
    })
    const binding = await this.bindIssueToSession(detail.detail, {
      assigneeMode: input.assigneeMode,
      assignee: input.assignee,
      advanceStatus: input.advanceStatus,
    })

    const result = {
      id: `${issueNum}-${Date.now()}`,
      repo: root,
      branch,
      kind: 'fixed',
      fixed: true,
      path: worktreePath,
      base: branch,
      baseCommit: '',
      reused: true,
      behind: null,
      warnings: bindingWarnings(binding),
      docEnabled: context.docEnabled,
      issueId: String(detail.detail.id ?? issueNum),
      issueNum,
      summary: detail.detail.summary,
      status: binding.statusTo,
      typeName: detail.detail.typeName,
      assignee: binding.assigneeName,
      binding,
      contextFile: context.contextFile,
      contextRelative: context.contextRelative,
      docTarget: context.docTarget,
      docTopics: context.topics,
      folders,
      sessionId: session.sessionId ?? '',
      sessionTitle: session.title ?? '',
      sessionError: session.error ?? '',
      sessionReused: session.reused === true,
      presetError: session.presetError ?? '',
      directoryError: session.directoryError ?? '',
      promptError: session.promptError ?? '',
      workspaceId: session.workspaceId ?? '',
      workspaceError: session.workspaceError ?? '',
      createdAt: Date.now(),
    }
    this.state.worktrees = [result, ...(this.state.worktrees ?? [])].slice(0, 50)
    await this.persist()
    return result
  }

  async resolveRepo(repoPath) {    if (!repoPath) return this.repoPath()
    const path = String(repoPath)
    if (!existsSync(path)) throw new Error(`路径不存在：${path}`)
    const probe = await this.exec(['git', '-C', path, 'rev-parse', '--show-toplevel'], path)
    if (!probe.ok) throw new Error(`不是 Git 仓库：${path}`)
    return probe.stdout.trim()
  }

  /**
   * 建分支前把主工作区切到来源分支并快进一次，保证新分支基于最新代码。
   * 只做 fetch/checkout/pull --ff-only，绝不 push、merge、reset --hard。
   */
  async prepareBase(root, base) {
    const warnings = []
    const status = await this.exec(['git', '-C', root, 'status', '--porcelain'], root)
    if (status.stdout.trim()) {
      throw new Error('主工作区有未提交的改动，先处理掉再建分支，避免切换分支时丢东西')
    }
    const exists = await this.exec(['git', '-C', root, 'rev-parse', '--verify', `refs/heads/${base}`], root)
    if (!exists.ok) {
      const remote = await this.exec(['git', '-C', root, 'rev-parse', '--verify', `refs/remotes/origin/${base}`], root)
      if (!remote.ok) throw new Error(`仓库里没有分支 ${base}`)
      const track = await this.exec(['git', '-C', root, 'checkout', '--track', `origin/${base}`], root)
      if (!track.ok) throw new Error(`切到 ${base} 失败：${track.stderr.trim()}`)
    } else {
      const checkout = await this.exec(['git', '-C', root, 'checkout', base], root)
      if (!checkout.ok) throw new Error(`切到 ${base} 失败：${checkout.stderr.trim()}`)
    }
    const fetch = await this.exec(['git', '-C', root, 'fetch', 'origin', base], root)
    if (!fetch.ok) {
      warnings.push(`fetch origin ${base} 未成功：${fetch.stderr.trim() || '网络或凭据问题'}`)
    } else {
      const pull = await this.exec(['git', '-C', root, 'pull', '--ff-only', 'origin', base], root)
      if (!pull.ok) warnings.push(`pull 未快进：${pull.stderr.trim() || pull.stdout.trim()}`)
    }
    const head = await this.exec(['git', '-C', root, 'rev-parse', '--short', 'HEAD'], root)
    return { commit: head.stdout.trim(), warnings }
  }

  /** 让 .worktrees 目录不进入主仓库的改动列表。 */
  async ignoreWorktreesDir(root) {
    await this.ensureExcluded(root, '.worktrees/')
  }

  /**
   * 把条目写进 .git/info/exclude（对应 IDEA 里「Add to .git/info/exclude」）：
   * 只影响本仓库、不进 .gitignore，所有 worktree 共用同一份。
   */
  async ensureExcluded(root, pattern) {
    const excludePath = join(root, '.git', 'info', 'exclude')
    try {
      let current = ''
      try {
        current = await readFile(excludePath, 'utf8')
      } catch {}
      const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      if (new RegExp(`^${escaped}$`, 'm').test(current)) return false
      const next = `${current.replace(/\s*$/, '')}${current.trim() ? '\n' : ''}${pattern}\n`
      await mkdir(dirname(excludePath), { recursive: true })
      await writeFile(excludePath, next, 'utf8')
      return true
    } catch {
      // 排除规则失败不影响主流程，只是主工作区可能看到未跟踪目录。
      return false
    }
  }

  /**
   * 保证每个分支里都有 .dsh 与 docs 两个目录：
   * 已存在就跳过，缺失就补上。.dsh 通过 .git/info/exclude 排除，docs 随分支提交。
   */
  async ensureFolders({ root, worktreePath, contextFile, contextRelative, docEnabled = true, docTarget }) {
    const report = { dsh: 'existed', docs: docEnabled ? 'existed' : 'disabled', excludeUpdated: false }

    // .dsh：本地上下文目录，主仓库与 worktree 各一份，统一排除出版本库。
    const rootDsh = join(root, '.dsh')
    if (!existsSync(rootDsh)) report.dsh = 'created'
    await mkdir(join(rootDsh, 'choerodon'), { recursive: true })
    const worktreeDsh = join(worktreePath, '.dsh')
    const worktreeDshExisted = existsSync(worktreeDsh)
    await mkdir(join(worktreeDsh, 'choerodon'), { recursive: true })
    if (!worktreeDshExisted && report.dsh === 'existed') report.dsh = 'created'
    if (contextFile) {
      try {
        const body = await readFile(contextFile, 'utf8')
        await writeFile(join(worktreeDsh, ...contextRelative.split('/').slice(1)), body, 'utf8')
      } catch {}
    }
    report.excludeUpdated = await this.ensureExcluded(root, '.dsh/')

    if (docEnabled) {
      // docs：交付文档目录，必须在分支里真实存在。
      const worktreeDocs = join(worktreePath, 'docs')
      if (!existsSync(worktreeDocs)) {
        report.docs = 'created'
        await mkdir(worktreeDocs, { recursive: true })
        const readme = join(worktreeDocs, 'README.md')
        if (!existsSync(readme)) {
          await writeFile(
            readme,
            '# 文档目录\n\n按 `NN-主题` 分目录存放交付文档，编号两位递增，与主仓库 `docs/` 保持一致。\n',
            'utf8',
          )
        }
      }
      if (docTarget && /^docs\/[^/]+$/.test(docTarget)) {
        await mkdir(join(root, ...docTarget.split('/')), { recursive: true })
        await mkdir(join(worktreePath, ...docTarget.split('/')), { recursive: true })
      }
    }
    return report
  }

  /**
   * 按工作项创建 Git 分支与 worktree：目录放主仓库下的 .worktrees/。
   * 分支名 `feature-<编号>` / `bugfix-<编号>`；已存在就复用并把来源分支的代码合并进来。
   * 只做本地操作，不 push；合并主分支代码是唯一允许的写操作。
   */
  async createWorktree(input = {}) {
    const issueId = String(input.issueId ?? '')
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(issueId)) throw new Error('工作项标识无效')
    const root = await this.resolveRepo(input.repoPath)

    const detail = await this.issue(issueId)
    const issueNum = detail.detail.num || issueId

    // 固定分支模式：不碰 Git，直接用该分支已检出的目录开会话。
    if (text(input.fixedBranch, 120).trim()) {
      return await this.openFixedSession({ root, fixedBranch: input.fixedBranch, detail, issueNum, input })
    }

    const kind = input.kind === 'bugfix' ? 'bugfix' : 'feature'
    const branch = safeName(`${kind}-${issueNum}`)

    const mode = text(input.baseMode, 20) || 'develop'
    let base = ''
    if (mode === 'custom') {
      base = text(input.customBase, 120).trim()
      if (!base) throw new Error('自定义来源分支不能为空')
      if (base.includes('..') || /[\s~^:?*[\\]/.test(base)) throw new Error('来源分支名不合法')
    } else if (['develop', 'uat', 'prod'].includes(mode)) {
      base = mode
    } else {
      throw new Error('来源分支模式无效')
    }

    // 已有分支不做任何合并：只把分支挂成 worktree，并把与来源分支的差距读出来告诉你。
    const existing = await this.exec(['git', '-C', root, 'rev-parse', '--verify', `refs/heads/${branch}`], root)
    let preparedRef = null
    const reused = existing.ok
    let behind = null
    if (!reused) {
      const prepared = await this.prepareBase(root, base)
      preparedRef = prepared
    }

    const destinationRoot = join(root, '.worktrees')
    const target = join(destinationRoot, branch)
    await mkdir(destinationRoot, { recursive: true })
    await this.ignoreWorktreesDir(root)

    // 目录可能来自上一次尝试：是这条分支的工作树就直接用，不是就改名留存后重建（不删用户文件）。
    let worktreeReady = false
    const aside = []
    if (existsSync(target)) {
      const inside = await this.exec(['git', '-C', target, 'rev-parse', '--is-inside-work-tree'], target)
      if (inside.ok && inside.stdout.trim() === 'true') {
        const head = await this.exec(['git', '-C', target, 'rev-parse', '--abbrev-ref', 'HEAD'], target)
        const current = head.stdout.trim()
        if (current === branch) worktreeReady = true
        else throw new Error(`目录 ${target} 已是另一条分支的工作树（${current}），请手工处理`)
      } else {
        const moved = `${target}.stale-${Date.now()}`
        await rename(target, moved).catch(() => {})
        if (existsSync(target)) throw new Error(`目录 ${target} 已存在且无法挪开，请手工清理后重试`)
        aside.push(moved)
      }
    }
    // 清掉已失效的 worktree 注册，避免 add 时撞到"already registered"。
    await this.exec(['git', '-C', root, 'worktree', 'prune'], root)

    if (reused) {
      // 分支已在主工作区检出时不能再挂到 worktree，先让主工作区离开它。
      const current = await this.exec(['git', '-C', root, 'rev-parse', '--abbrev-ref', 'HEAD'], root)
      if (current.stdout.trim() === branch) {
        throw new Error(`分支 ${branch} 正在主工作区检出，先在主工作区切到别的分支再创建 worktree`)
      }
    }

    if (!worktreeReady) {
      const created = reused
        ? await this.exec(['git', '-C', root, 'worktree', 'add', target, branch], root)
        : await this.exec(['git', '-C', root, 'worktree', 'add', '-b', branch, target, base], root)
      if (!created.ok) throw new Error(`创建 worktree 失败：${created.stderr.trim() || created.message}`)
    }

    if (reused) {
      // 只统计，不改动任何引用：落后多少提交由你自己决定怎么合。
      // 先刷新远端追踪引用，让统计更接近真实（只更新 refs/remotes，不动工作分支）。
      await this.exec(['git', '-C', root, 'fetch', 'origin', base], root)
      const ref = await this.exec(['git', '-C', target, 'rev-parse', '--verify', `refs/remotes/origin/${base}`], target)
      const baseRef = ref.ok ? `origin/${base}` : base
      const count = await this.exec(['git', '-C', target, 'rev-list', '--count', `HEAD..${baseRef}`], target)
      if (count.ok && /^\d+$/.test(count.stdout.trim())) behind = Number(count.stdout.trim())
    }

    const docEnabled = input.docEnabled !== false
    const warnings = [...(preparedRef?.warnings ?? [])]
    for (const moved of aside) warnings.push(`旧目录已改名保留：${moved}`)
    if (reused) {
      warnings.push(
        behind === null || behind === 0
          ? `复用了已有分支 ${branch}，未做任何合并。`
          : `复用了已有分支 ${branch}，它比 ${base} 落后 ${behind} 个提交；需要你自己合并，插件不动 Git 历史。`,
      )
    }
    const result = {
      id: `${issueNum}-${Date.now()}`,
      repo: root,
      branch,
      kind,
      path: target,
      base,
      baseCommit: preparedRef?.commit ?? '',
      reused,
      behind,
      warnings,
      docEnabled,
      issueId,
      issueNum,
      summary: detail.detail.summary,
      status: detail.detail.statusName,
      typeName: detail.detail.typeName,
      assignee: detail.detail.assigneeName,
      createdAt: Date.now(),
    }

    // 上下文写进仓库的 .dsh/choerodon/；docs 目录按开关决定是否创建。
    const context = await this.writeIssueContext({
      root,
      detail: detail.detail,
      branch,
      base,
      baseCommit: preparedRef?.commit ?? '',
      worktreePath: target,
      docEnabled,
      docTarget: input.docTarget,
      docName: input.docName,
      reused,
      behind,
    })
    result.contextFile = context.contextFile
    result.contextRelative = context.contextRelative
    result.docEnabled = context.docEnabled
    result.docTarget = context.docTarget
    result.docTopics = context.topics

    // 保证这个分支里 .dsh（以及需要时的 docs）都在：缺谁补谁，已有的不动。
    const folders = await this.ensureFolders({
      root,
      worktreePath: target,
      contextFile: context.contextFile,
      contextRelative: context.contextRelative,
      docEnabled: context.docEnabled,
      docTarget: context.docTarget,
    })
    result.folders = folders

    // 会话在 worktree 里干活，读不到主仓库的 .dsh，这里给一份精简要点注入系统提示。
    const description = detail.detail.descriptionText || plainDescription(detail.detail.description, 2000)
    const brief = [
      `本次任务来自猪齿鱼工作项 ${issueNum}：${detail.detail.summary}`,
      description ? `工作项描述：\n${description}` : '',
      `分支 ${branch}${reused ? '（复用已有分支）' : ''}，来源 ${base}${preparedRef?.commit ? `（${preparedRef.commit}）` : ''}，工作目录 ${target}。`,
      `主仓库 ${root}，完整上下文见 ${context.contextRelative}。`,
      context.docEnabled
        ? `产出文档必须放在 ${context.docTarget} 下，不要写到仓库根或 .dsh。`
        : '本次不要求产出文档目录，按需在仓库内合适位置存放即可。',
      '只做本地提交，不要 push、不要 merge、不要 reset --hard；推送与合并由人执行。',
      `需要推进工作项状态（如开发完成置为「待测试」）或改经办人时，调用 choerodon_update 工具，issue 传 ${issueNum}；不要让人回猪齿鱼网页操作。`,
    ]
      .filter(Boolean)
      .join('\n')

    // 在仓库目录建一个会话，名字就是「编号 + 概要」，工作目录指向这个 worktree。
    // 不再单独注册同名工作区：会话本身就会挂在仓库这个工作区下面。
    const session = await this.createIssueSession({
      repoPath: root,
      worktreePath: target,
      issueNum,
      summary: detail.detail.summary,
      // 工作项要点进系统提示（模型一开始就知道上下文），全文作为首条用户消息发进对话
      // （打开会话就能看到，不是白纸）。首条消息走正常 prompt 入队，不写会话日志种子。
      brief,
      kickoff: this.issueKickoffText({
        detail: detail.detail,
        branch,
        worktreePath: target,
        root,
        contextRelative: context.contextRelative,
        docEnabled: context.docEnabled,
        docTarget: context.docTarget,
        fixed: false,
      }),
      branch,
      agentPreset: input.agentPreset,
    })
    const binding = await this.bindIssueToSession(detail.detail, {
      assigneeMode: input.assigneeMode,
      assignee: input.assignee,
      advanceStatus: input.advanceStatus,
    })
    result.status = binding.statusTo
    result.assignee = binding.assigneeName
    result.binding = binding
    result.warnings = [...(result.warnings ?? []), ...bindingWarnings(binding)]
    result.sessionId = session.sessionId ?? ''
    result.sessionTitle = session.title ?? ''
    result.sessionError = session.error ?? ''
    result.sessionReused = session.reused === true
    result.presetError = session.presetError ?? ''
    result.directoryError = session.directoryError ?? ''
    result.promptError = session.promptError ?? ''
    result.workspaceId = session.workspaceId ?? ''
    result.workspaceError = session.workspaceError ?? ''

    this.state.worktrees = [result, ...(this.state.worktrees ?? [])].slice(0, 50)
    await this.persist()
    return result
  }

  /**
   * 会话只有被工作区登记（attachSession）后才会出现在侧栏的工作区下。
   * 正常路径走 {@code sessionController.create({ workspaceId })} 已经登记过，
   * 这里只是兜底：拿不到工作区、或者退回底层工厂建会话时补一次。登记失败不阻断建会话。
   * @returns 工作区 id；失败时给 error，由调用方提示。
   */
  async attachWorkspaceSession(dir, sessionId) {
    const registry = this.ctx.get('workspaceRegistry')
    if (!registry?.resolveByPath || !registry?.create) {
      return { error: '当前 profile 没有 workspaceRegistry，会话没进工作区' }
    }
    const resolved = await this.ensureWorkspace(dir)
    if (resolved.error) return { workspaceId: resolved.workspaceId ?? '', error: resolved.error }
    const workspace = resolved.workspace
    const workspaceId = resolved.workspaceId
    if (typeof workspace.attachSession !== 'function') {
      return { workspaceId, error: '工作区对象没有 attachSession，当前 DSH 版本不支持会话登记' }
    }
    try {
      await workspace.attachSession(sessionId)
    } catch (error) {
      return {
        workspaceId,
        error: `会话没挂进工作区：${error instanceof Error ? error.message : String(error)}`,
      }
    }
    return { workspaceId }
  }

  /**
   * 建会话要挂的 preset：显式指定 > 用户在设置里选的默认 > 部署默认。
   *
   * <p>正常路径已经走 {@code sessionController.create}，preset 由宿主的 composeAgent 挂好，用不到这里。
   * 只有 DSH 没有会话控制器（老版本）时才由 {@code createIssueSessionLegacy} 退回底层
   * {@code agentLoop.createAgent}——那是只建 Agent 的底层工厂，**不会**把 preset 的插件树挂到
   * Agent 作用域上，所以得自己解析并挂一次，否则建出来的会话没有
   * {@code read}/{@code write}/{@code edit}/{@code pwsh}，改不了文件。</p>
   */
  async resolveCreatePreset(requested) {
    const presets = this.ctx.get('agentPresets')
    if (!presets?.resolve || !presets?.mount) return { error: '' }
    try {
      const resolved = await presets.resolve(requested)
      return { presets, id: resolved.id }
    } catch (error) {
      // preset 解析失败不阻断建会话，但要如实报出来：不挂 preset 的会话就是没有文件工具的会话。
      return { error: error instanceof Error ? error.message : '解析 agent preset 失败' }
    }
  }

  /**
   * 在仓库目录建一个以工作项命名的会话：会话挂在仓库这个工作区下，
   * 工作目录指到该工作项的 worktree，标题改成「编号 + 概要」。
   */
  async createIssueSession({ repoPath, worktreePath, issueNum, summary, brief, kickoff, branch, agentPreset }) {
    this.state.issueSessions ??= {}
    const key = `${repoPath}|${branch ?? issueNum}`
    const known = this.state.issueSessions[key]
    // 统一成平台原生路径：会话头里的 cwd 要和侧栏工作区的 path 是同一个拼写。
    const repoDir = resolve(String(repoPath))
    const workDir = resolve(String(worktreePath))

    // 同一条分支这次运行里已经建过会话才复用。用户把对话删掉/归档了、
    // 或者 DSH 重启过（内存里没有句柄），都按「新建一个对话」处理。
    const archived = new Set(this.ctx.get('workspaceRegistry')?.archivedSessionIds ?? [])
    if (known && this.sessions.has(known) && !archived.has(known)) {
      // 旧版本建的会话没登记过工作区，这里补一次。
      const attached = await this.attachWorkspaceSession(repoDir, known)
      return {
        sessionId: known,
        title: this.state.issueSessionTitles?.[known] ?? '',
        reused: true,
        workspaceId: attached.workspaceId ?? '',
        workspaceError: attached.error ?? '',
      }
    }

    const sessionId = randomUUID()
    const title = `${issueNum} ${summary}`.slice(0, 120)

    // 工作区先解析出来：走 sessionController.create({ workspaceId }) 时它顺带做 attachSession，
    // 侧栏才把这个会话挂在仓库名下。解析不出来就退回 cwd，建完再手工登记。
    const resolved = await this.ensureWorkspace(repoDir)
    const workspaceId = resolved.error ? '' : (resolved.workspaceId ?? '')

    // 建会话一律走会话控制器，和侧栏「新建对话」是同一条路径：
    // composeAgent 会挂 preset 插件树（persona / skill 目录 / read / write / edit / pwsh 都在里面），
    // 也注入默认模型。以前直接调 agentLoop.createAgent 绕过了这一步，建出来的会话只有宿主级插件，
    // 没有文件工具 —— 这就是「通过问题创建的会话改不了文件」。
    const controller = this.ctx.get('sessionController')
    let created = { sessionId, workspaceError: resolved.error ?? '' }
    let presetError = ''
    if (controller?.create) {
      try {
        const value = await controller.create({
          ...(workspaceId ? { workspaceId } : { cwd: repoDir }),
          sessionId,
          ...(agentPreset ? { agentPreset } : {}),
        })
        created = { sessionId: value.sessionId ?? sessionId, workspaceError: '' }
      } catch (error) {
        return { error: error instanceof Error ? error.message : '创建会话失败' }
      }
    } else {
      // 老版本 DSH 没有会话控制器：退回底层工厂，preset 自己挂。
      const fallback = await this.createIssueSessionLegacy({
        sessionId, repoDir, agentPreset,
      })
      if (fallback.error) return { error: fallback.error }
      presetError = fallback.presetError ?? ''
    }
    const liveSessionId = created.sessionId
    this.sessions.add(liveSessionId)

    // 会话的工作目录指向本次分支的 worktree，模型默认就在这里干活。
    // 必须在发首条消息前设置，模型拿到的 system prompt 里才是对的目录。
    const registry = this.ctx.get('agents')
    const agent = registry?.get?.(liveSessionId)
    const workingDirectory = this.ctx.get('workingDirectory')
    let directoryError = ''
    if (!agent) {
      directoryError = '拿不到会话句柄，工作目录仍停在仓库根'
    } else if (workingDirectory?.set) {
      try {
        await workingDirectory.set(agent, workDir)
      } catch (error) {
        directoryError = error instanceof Error ? error.message : '工作目录没切到 worktree'
      }
    }

    // 标题：控制器和本地标题服务哪个能用就用哪个。
    let titleError = ''
    try {
      if (controller?.rename) await controller.rename({ sessionId: liveSessionId, title })
      else {
        const sessionTitle = this.ctx.get('sessionTitle')
        const target = agent?.session ?? agent?.ctx?.session
        if (target && sessionTitle?.rename) sessionTitle.rename(target, title)
        else titleError = '未能取得会话对象，标题保持默认'
      }
    } catch (error) {
      titleError = error instanceof Error ? error.message : '重命名会话失败'
    }
    this.rememberSession(key, liveSessionId, title)
    // 工作项全文另存一份给界面：会话在第一次发消息之前没有可展示的日志节点，
    // 客户端靠这条摘要把全文填进输入框（能看、能改），会话头也用它显示原文。
    if (kickoff) this.rememberBrief(liveSessionId, { num: issueNum, summary, kickoff })

    // 工作项要点注册进这个 Agent 自己的系统提示层：模型一开始就知道分支、目录、文档落位与 Git 纪律，
    // 又不会把这一大段当成用户说的话。作用域是 agent.ctx，会话销毁时自动收回。
    // 注意别退回插件自己的 ctx 去注册——那是全局层，会把这一条塞进所有会话。
    if (brief && agent?.ctx?.get) {
      try {
        agent.ctx.get('systemPrompt')?.context?.({
          name: `choerodon:${issueNum}`,
          order: 900,
          text: brief,
          interpolate: false,
        })
      } catch {}
    }

    // 工作项全文不再在 Host 侧塞进会话：整段文字要能让人看见、能改，甚至整段换掉，
    // 所以由界面填进输入框（客户端拿到 session-brief 后 requestDraftInitialization），
    // 人自己决定发不发、发什么。只有界面填不进去时，才走 /session-context 兜底注入。
    const promptError = ''

    // 工作区没被控制器登记过时补一次。
    let workspaceError = created.workspaceError ?? ''
    let attachedWorkspaceId = workspaceId
    if (!workspaceId) {
      const attached = await this.attachWorkspaceSession(repoDir, liveSessionId)
      attachedWorkspaceId = attached.workspaceId ?? ''
      workspaceError = [workspaceError, attached.error ?? ''].filter(Boolean).join('；')
    }

    return {
      sessionId: liveSessionId,
      title,
      ...(titleError ? { error: titleError } : {}),
      ...(presetError ? { presetError } : {}),
      ...(directoryError ? { directoryError } : {}),
      ...(promptError ? { promptError } : {}),
      workspaceId: attachedWorkspaceId,
      workspaceError,
    }
  }

  /**
   * 没有 sessionController 时的退路：agentLoop.createAgent + 自己挂 preset。
   * 保留了旧实现，兼容老 DSH；新版本一律走会话控制器。
   */
  async createIssueSessionLegacy({ sessionId, repoDir, agentPreset }) {
    const loop = this.ctx.get('agentLoop')
    if (!loop?.createAgent) return { error: '当前 profile 没有 agentLoop，无法自动建会话' }
    // 直接调工厂会漏掉会话控制器的默认模型注入；缺 provider/model 的会话第一个 turn 就报错。
    const defaults = this.ctx.get('agentDefaultModel')
    const agentOptions = defaults?.currentSelection
      ? {
          get provider() { return defaults.currentSelection().provider },
          get model() { return defaults.currentSelection().model },
          get reasoningEffort() { return defaults.currentSelection().reasoningEffort },
        }
      : undefined
    const preset = await this.resolveCreatePreset(agentPreset)
    const meta = { cwd: repoDir }
    if (preset.id) meta.agentPreset = preset.id
    const setup = async (agentCtx) => {
      if (preset.presets && preset.id) await preset.presets.mount(agentCtx, preset.id)
      return undefined
    }
    try {
      await loop.createAgent(this.ctx, { sessionId, agentOptions, meta, setup })
    } catch (error) {
      return { error: error instanceof Error ? error.message : '创建会话失败' }
    }
    return {
      presetError: preset.error
        ? `agent preset 没挂上（会话已建，但没有文件工具）：${preset.error}`
        : '',
    }
  }

  rememberSession(key, sessionId, title) {
    this.state.issueSessions ??= {}
    this.state.issueSessions[key] = sessionId
    this.state.issueSessionTitles ??= {}
    this.state.issueSessionTitles[sessionId] = title
  }

  /**
   * 记住某个会话对应的工作项摘要，给界面用。
   * 只留最近 {@code SESSION_BRIEF_LIMIT} 条：正文一篇几 KB，留太多会把 state.json 撑大。
   * @param {string} sessionId - 会话 id。
   * @param {{ num: string, summary: string, kickoff: string }} brief - 编号、概要与首条消息全文。
   */
  rememberBrief(sessionId, brief) {
    this.state.sessionBriefs ??= {}
    this.state.sessionBriefs[sessionId] = {
      num: text(brief.num, 60),
      summary: text(brief.summary, 200),
      kickoff: String(brief.kickoff ?? '').slice(0, 12000),
      at: Date.now(),
    }
    const entries = Object.entries(this.state.sessionBriefs)
    const overflow = entries.length - SESSION_BRIEF_LIMIT
    if (overflow <= 0) return
    entries.sort((left, right) => (left[1]?.at ?? 0) - (right[1]?.at ?? 0))
    for (const [stale] of entries.slice(0, overflow)) delete this.state.sessionBriefs[stale]
  }

  /**
   * @param {string} sessionId - 会话 id。
   * @returns {{ num: string, summary: string, kickoff: string } | null} 摘要，或 null。
   */
  briefFor(sessionId) {
    const brief = this.state.sessionBriefs?.[String(sessionId ?? '')]
    if (!brief || !brief.kickoff) return null
    return { num: brief.num ?? '', summary: brief.summary ?? '', kickoff: brief.kickoff }
  }

  /**
   * 把工作项全文补进会话的待处理输入（不唤醒模型）。
   *
   * 正常路径是界面把全文填进输入框，人自己改、自己发；只有界面填不进去
   * （会话没在前台、绑定还没就绪、输入框正在提交）时才走这里兜底，
   * 免得模型连任务描述都没见过。同一个会话只补一次。
   * @param {string} sessionId - 会话 id。
   * @returns {Promise<{ ok: boolean, reason?: string, already?: boolean }>} 结果。
   */
  async deliverKickoff(sessionId) {
    const brief = this.briefFor(sessionId)
    if (!brief) return { ok: false, reason: '这个会话没存过工作项摘要' }
    this.state.kickoffDelivered ??= {}
    if (this.state.kickoffDelivered[sessionId]) return { ok: true, already: true }
    const agent = this.ctx.get('agents')?.get?.(sessionId)
    if (!agent) return { ok: false, reason: '会话不在内存里，请在输入框里自己描述' }
    if (typeof agent.inject !== 'function') return { ok: false, reason: '当前 DSH 没有 inject' }
    const message = {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: String(brief.kickoff).slice(0, 12000) }],
      source: { kind: 'user' },
    }
    try {
      agent.inject(message)
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : '注入失败' }
    }
    this.state.kickoffDelivered[sessionId] = Date.now()
    await this.persist()
    return { ok: true }
  }

  /** 新会话的首条消息：把工作项原样摊开，省得人再回网页核对描述与附件。 */
  issueKickoffText({ detail, branch, worktreePath, root, contextRelative, docEnabled, docTarget, fixed }) {
    const description = detail.descriptionText || plainDescription(detail.description, 4000)
    const images = Array.isArray(detail.descriptionImages) ? detail.descriptionImages : []
    const lines = [
      `# ${detail.num} ${detail.summary}`,
      '',
      `- 状态：${detail.statusName || '-'}　类型：${detail.typeName || '-'}`,
      `- 经办人：${detail.assigneeName || '未分配'}　优先级：${detail.priority || '-'}`,
      detail.estimatedStart ? `- 计划：${detail.estimatedStart} ~ ${detail.estimatedEnd}` : null,
      `- 分支：\`${branch}\`${fixed ? '（固定分支，就地开发）' : ''}`,
      `- 工作目录：\`${worktreePath}\``,
      `- 主仓库：\`${root}\``,
      contextRelative ? `- 上下文：\`${contextRelative}\`` : null,
      docEnabled && docTarget ? `- 文档落位：\`${docTarget}\`` : null,
      '',
      description ? '## 描述' : null,
      description || null,
      images.length ? '\n## 描述里的图片' : null,
      ...images.map((url) => `- ${url}`),
      '',
      '---',
      '改状态或改经办人直接跟我说，例如「置为待测试」；我会调用 `choerodon_update`，不用回猪齿鱼网页点。',
    ]
    return lines.filter((line) => line !== null).join('\n')
  }

  /** 读出仓库 docs 下「NN-主题」形式的目录，保持编号顺序。 */
  async docTopics(root) {
    const docsRoot = join(root, 'docs')
    let entries = []
    try {
      entries = await readdir(docsRoot, { withFileTypes: true })
    } catch {
      return []
    }
    const topics = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const match = /^(\d{2})-*(.+)$/.exec(entry.name)
      if (!match) continue
      topics.push({ number: match[1], name: match[2], dir: join(docsRoot, entry.name), relative: `docs/${entry.name}` })
    }
    topics.sort((a, b) => a.number.localeCompare(b.number))
    return topics
  }

  /**
   * 把本次任务上下文写进仓库的 .dsh/choerodon/：
   * 工作项信息、分支来源、worktree 路径，以及文档必须落到 docs/NN-主题/ 的规则。
   */
  async writeIssueContext({
    root,
    detail,
    branch,
    base,
    baseCommit,
    worktreePath,
    docEnabled = true,
    docTarget,
    docName,
    reused = false,
    behind = null,
    fixed = false,
  }) {
    const contextDir = join(root, '.dsh', 'choerodon')
    await mkdir(contextDir, { recursive: true })
    const file = join(contextDir, `${safeName(detail.num || detail.id)}.md`)

    let picked = null
    let topics = []
    if (docEnabled) {
      topics = (await this.nextDocNumber(root)).topics
      if (docTarget) {
        const wanted = String(docTarget).replace(/\\/g, '/').replace(/^\.?\//, '')
        if (!/^docs\/[^/]+$/.test(wanted) || wanted.includes('..')) throw new Error('文档目录不合法')
        const existing = topics.find((topic) => topic.relative === wanted)
        if (existing) picked = { target: existing, score: 1 }
        else {
          const match = /^docs\/(\d{2})-(.+)$/.exec(wanted)
          if (!match) throw new Error('文档目录必须是 docs/NN-主题 形式')
          picked = { target: { number: match[1], name: match[2], dir: join(root, wanted), relative: wanted }, score: 1 }
        }
      } else {
        const name = (docName && String(docName).trim()) || this.topicNameFrom(detail.summary)
        const { number } = await this.nextDocNumber(root)
        picked = { target: { number, name, dir: join(root, 'docs', `${number}-${name}`), relative: `docs/${number}-${name}` }, score: 1 }
      }
      await mkdir(picked.target.dir, { recursive: true })
      if (!topics.some((topic) => topic.relative === picked.target.relative)) topics.push(picked.target)
      topics.sort((a, b) => a.number.localeCompare(b.number))
    }

    const docTargetText = docEnabled ? picked.target.relative : '未启用'
    const topicList = topics.length ? topics.map((topic) => `- ${topic.relative}`).join('\n') : '- （暂无）'

    const body = [
      `# ${detail.num} ${detail.summary}`,
      '',
      `- 工作项：${detail.num}（${detail.id}）`,
      `- 类型：${detail.typeName || '-'}`,
      `- 状态：${detail.statusName || '-'}`,
      `- 经办人：${detail.assigneeName || '未分配'}`,
      `- 优先级：${detail.priority || '-'}`,
      `- 计划：${detail.estimatedStart || '-'} ~ ${detail.estimatedEnd || '-'}`,
      detail.epicName ? `- 史诗：${detail.epicName}` : null,
      '',
      '## 分支',
      '',
      `- 分支：\`${branch}\`${fixed ? '（固定分支，就地开发）' : reused ? '（复用已有分支）' : '（新建）'}`,
      `- 来源：\`${base}\`${baseCommit ? `（${baseCommit}）` : ''}`,
      reused && behind !== null ? `- 与 ${base} 的差距：落后 ${behind} 个提交（插件不合并，需人工处理）` : null,
      `- 工作目录：\`${worktreePath}\``,
      `- 主仓库：\`${root}\``,
      '',
      docEnabled ? '## 文档落位（必须遵守）' : '## 文档',
      '',
      docEnabled ? `本次产出文档放到 **${docTargetText}**。` : '本次未启用文档目录，按需存放。',
      '',
      docEnabled ? '`docs/` 下已有主题目录：' : null,
      docEnabled ? '' : null,
      docEnabled ? topicList : null,
      docEnabled ? '' : null,
      docEnabled ? '规则：' : null,
      docEnabled ? '' : null,
      docEnabled ? '- 文档一律写在 `docs/NN-主题/` 里，不要放到仓库根或 `.dsh/`。' : null,
      docEnabled ? '- `.dsh/` 只放本文件这类上下文，不放交付文档。' : null,
      '',
      '## Git 纪律',
      '',
      '- 只允许本地提交；**不要 push、不要 merge、不要 reset --hard**。',
      '- 推送与合并由人手动执行。',
      '',
      detail.description ? '## 工作项描述\n\n' + detail.description.slice(0, 4000) : null,
      '',
    ]
      .filter((line) => line !== null)
      .join('\n')

    await writeFile(file, body, 'utf8')
    return {
      contextFile: file,
      contextRelative: `.dsh/choerodon/${safeName(detail.num || detail.id)}.md`,
      docEnabled,
      docTarget: docEnabled ? picked.target.relative : '',
      topics: topics.map((topic) => topic.relative),
    }
  }

  /** docs 下一个可用编号：取现有最大编号 +1，两位补零。 */
  async nextDocNumber(root) {
    const topics = await this.docTopics(root)
    let max = 0
    for (const topic of topics) {
      if (topic.number === '00') continue
      const value = Number(topic.number)
      if (Number.isFinite(value) && value > max) max = value
    }
    const next = Math.min(99, max + 1)
    return { number: String(next).padStart(2, '0'), topics }
  }

  /** 主题名从工作项摘要里取一个短标题，用来生成 docs/NN-名字。 */
  topicNameFrom(summary) {
    const cleaned = String(summary)
      .replace(/^[【\[][^】\]]{1,20}[】\]]/, '')
      .replace(/[\\/:*?"<>|]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    return (cleaned || String(summary)).slice(0, 24).trim() || '其他'
  }

  // ---------- 视图 ----------

  view() {
    const models = this.state.models.map((m) => ({
      id: m.id,
      name: m.name,
      provider: m.provider,
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
      imageInput: m.imageInput,
    }))
    return {
      apiOrigin: this.config.apiOrigin,
      loggedIn: Boolean(this.state.token),
      user: this.state.user,
      expiresAt: this.state.token?.expiresAt ?? null,
      organizations: this.state.organizations,
      tenantId: this.state.tenantId,
      projects: this.state.projects,
      projectId: this.state.projectId,
      models,
      proxyError: this.state.proxyError,
      routeError: this.state.routeError,
      projectError: this.state.projectError,
      routeEntry: this.state.routeEntry,
      login: this.loginStatus(),
      // 宿主半区在进程启动时加载一次；界面刷新拿到的是新 client.js。
      // 把「本次进程里到底有哪些能力」报给界面，两边对不上就能当场看出来。
      host: {
        version: HOST_VERSION,
        features: ['worklog', 'activity', 'inbox', 'attachment', 'attachment-download', 'subissue', 'links', 'search', 'dict', 'fields', 'type'],
        startedAt: this.startedAt,
      },
    }
  }
}

async function dispatch(plugin, req, res) {
  if (plugin.loadError) throw plugin.loadError
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const path = url.pathname.replace(/^\/choerodon/, '') || '/'
  const method = req.method ?? 'GET'
  if (method === 'GET' && path === '/state') return replyJson(res, 200, plugin.view())
  if (method === 'GET' && path === '/session-brief') {
    // 会话第一次发消息之前日志是空的，界面靠这条摘要把工作项填进输入框。
    const sessionId = text(url.searchParams.get('sessionId'), 160)
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(sessionId)) return replyJson(res, 400, { message: 'sessionId 不合法' })
    return replyJson(res, 200, { brief: plugin.briefFor(sessionId), prefill: true })
  }
  if (method === 'POST' && path === '/session-context') {
    // 界面没把全文填进输入框时的兜底：补进待处理输入，模型照样能看到任务。
    const body = await readBody(req)
    const sessionId = text(body?.sessionId, 160)
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(sessionId)) return replyJson(res, 400, { message: 'sessionId 不合法' })
    return replyJson(res, 200, await plugin.deliverKickoff(sessionId))
  }
  if (method === 'POST' && path === '/login') {
    const started = await plugin.startLogin()
    return replyJson(res, 200, { ...started, state: plugin.view() })
  }
  if (method === 'GET' && path === '/login/status') return replyJson(res, 200, plugin.loginStatus())
  if (method === 'POST' && path === '/login/cancel') {
    await plugin.closeLogin()
    return replyJson(res, 200, { ok: true, state: plugin.view() })
  }
  if (method === 'POST' && path === '/token') {
    const body = await readBody(req)
    await plugin.useToken(body.token)
    return replyJson(res, 200, plugin.view())
  }
  if (method === 'POST' && path === '/password') {
    const body = await readBody(req)
    return replyJson(res, 200, await plugin.usePassword(body.username, body.password))
  }
  if (method === 'POST' && path === '/logout') return replyJson(res, 200, await plugin.logout())
  if (method === 'POST' && path === '/select') {
    const body = await readBody(req)
    const tenantId = String(body.tenantId ?? '')
    const projectId = String(body.projectId ?? '')
    if (!plugin.state.organizations.some((o) => o.id === tenantId)) throw new Error('组织不存在，请刷新')
    if (tenantId !== plugin.state.tenantId) {
      plugin.state.tenantId = tenantId
      plugin.state.projectId = null
      await plugin.loadProjects(tenantId, false)
    }
    if (projectId && !plugin.state.projects.some((p) => p.id === projectId)) throw new Error('项目不存在，请刷新')
    plugin.state.projectId = projectId || plugin.state.projectId
    plugin.state.models = []
    plugin.state.proxyError = null
    plugin.state.routeError = null
    await plugin.persist()
    return replyJson(res, 200, await plugin.sync())
  }
  if (method === 'POST' && path === '/sync') return replyJson(res, 200, await plugin.sync())
  if (method === 'POST' && path === '/remember-model') {
    await plugin.rememberModel()
    return replyJson(res, 200, { ok: true, preferredModel: plugin.state.preferredModel })
  }
  if (method === 'GET' && path === '/board') {
    const mine = url.searchParams.get('mine') !== '0'
    const epic = text(url.searchParams.get('epic'), 200)
    const epicIds = text(url.searchParams.get('epicIds'), 2000)
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
    const assignee = text(url.searchParams.get('assignee'), 200)
    const assigneeIds = text(url.searchParams.get('assigneeIds'), 2000)
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
    return replyJson(res, 200, await plugin.board({ mine, epic, epicIds, assignee, assigneeIds }))
  }
  if (method === 'GET' && path === '/epics') return replyJson(res, 200, { epics: await plugin.epicCatalog() })
  if (method === 'GET' && path === '/users') {
    const keyword = text(url.searchParams.get('keyword'), 60).trim()
    const users = await plugin.userCatalog()
    if (!keyword) return replyJson(res, 200, { users })
    const needle = keyword.toLowerCase()
    return replyJson(res, 200, {
      users: users.filter((row) => row.name.toLowerCase().includes(needle) || String(row.loginName ?? '').toLowerCase().includes(needle)),
    })
  }
  if (method === 'GET' && path === '/meta') return replyJson(res, 200, await plugin.createMeta())
  if (method === 'GET' && path === '/dict') return replyJson(res, 200, await plugin.projectDict())
  if (method === 'GET' && path === '/search') {
    return replyJson(
      res,
      200,
      await plugin.searchIssues({
        keyword: url.searchParams.get('keyword'),
        mine: url.searchParams.get('mine') === '1',
        page: url.searchParams.get('page'),
        size: url.searchParams.get('size'),
      }),
    )
  }
  if (method === 'POST' && path === '/issue/delete') {
    const body = await readBody(req)
    return replyJson(res, 200, await plugin.deleteIssue({ issueId: body.issueId, confirm: body.confirm === true }))
  }
  if (method === 'POST' && path === '/fields') {
    const body = await readBody(req)
    return replyJson(res, 200, await plugin.updateIssueFields(body))
  }
  if (method === 'POST' && path === '/type') {
    const body = await readBody(req)
    return replyJson(res, 200, await plugin.changeIssueType({ issueId: body.issueId, typeCode: body.typeCode, issueTypeId: body.issueTypeId }))
  }
  if (method === 'POST' && path === '/issue') {
    const body = await readBody(req)
    return replyJson(res, 200, await plugin.createIssue(body))
  }
  if (method === 'GET' && path === '/draft') {
    return replyJson(res, 200, await plugin.issueDraft({ copyFrom: url.searchParams.get('copyFrom') }))
  }
  if (method === 'GET' && path === '/comments') {
    return replyJson(
      res,
      200,
      await plugin.comments({
        issueId: url.searchParams.get('id'),
        page: url.searchParams.get('page'),
        size: url.searchParams.get('size'),
      }),
    )
  }
  if (method === 'POST' && path === '/comment') {
    const body = await readBody(req)
    return replyJson(
      res,
      200,
      await plugin.addComment({
        issueId: body.issueId,
        body: body.body,
        markdown: body.markdown === true,
        mention: body.mention,
      }),
    )
  }
  if (method === 'POST' && path === '/estimate') {
    const body = await readBody(req)
    return replyJson(
      res,
      200,
      await plugin.setEstimate({
        issueId: body.issueId,
        estimateTime: body.estimateTime,
        remainingTime: body.remainingTime,
      }),
    )
  }
  if (method === 'GET' && path === '/activity') {
    return replyJson(
      res,
      200,
      await plugin.activity({
        issueId: url.searchParams.get('issueId'),
        limit: url.searchParams.get('limit'),
      }),
    )
  }
  if (method === 'GET' && path === '/worklogs') {
    return replyJson(res, 200, await plugin.workLogs({ issueId: url.searchParams.get('issueId') }))
  }
  if (method === 'POST' && path === '/worklog') {
    const body = await readBody(req)
    return replyJson(
      res,
      200,
      await plugin.addWorkLog({
        issueId: body.issueId,
        workTime: body.workTime,
        startDate: body.startDate,
        description: body.description,
        residualPrediction: body.residualPrediction,
        predictionTime: body.predictionTime,
      }),
    )
  }
  if (method === 'POST' && path === '/attachment') {
    // 附件走 base64，默认 1MB 不够，单独放宽；20MB 原始文件 base64 后约 27MB
    const body = await readBody(req, 32 << 20)
    return replyJson(res, 200, await plugin.addAttachment(body))
  }
  if (method === 'GET' && path === '/attachment/url') {
    return replyJson(
      res,
      200,
      await plugin.attachmentDownloadUrl({
        url: url.searchParams.get('url'),
        fileName: url.searchParams.get('fileName'),
      }),
    )
  }
  if (method === 'POST' && path === '/attachment/delete') {
    const body = await readBody(req)
    return replyJson(res, 200, await plugin.removeAttachment({ attachmentId: body.attachmentId }))
  }
  if (method === 'POST' && path === '/sub-issue') {
    const body = await readBody(req)
    return replyJson(res, 200, await plugin.createSubIssue(body))
  }
  if (method === 'POST' && path === '/links') {
    const body = await readBody(req)
    return replyJson(res, 200, await plugin.addIssueLinks(body))
  }
  if (method === 'POST' && path === '/links/delete') {
    const body = await readBody(req)
    return replyJson(res, 200, await plugin.removeIssueLink({ linkId: body.linkId }))
  }  if (method === 'POST' && path === '/worklog/delete') {
    const body = await readBody(req)
    return replyJson(res, 200, await plugin.removeWorkLog({ logId: body.logId }))
  }
  if (method === 'GET' && path === '/status/refresh') {
    if (url.searchParams.get('full') === '1') {
      plugin.state.statusCache = null
      plugin.scheduleStatusCompletion(`${plugin.state.tenantId}:${plugin.state.projectId}`)
    }
    return replyJson(res, 200, { ok: true, started: true, completedAt: plugin.statusCompletedAt ?? null })
  }
  if (method === 'GET' && path === '/notifications') {
    // 角标是背景装饰：任何一个源失败都不该把整个请求打回 500，否则前端永远停在上一次的数。
    const unread = await plugin.unreadMessages()
    let fresh = { count: 0, items: [] }
    let taskError = ''
    try {
      fresh = await plugin.newTasks()
    } catch (error) {
      taskError = error instanceof Error ? error.message : String(error)
    }
    // 状态集合刚补全：前端看到这个标记就把看板重拉一次，泳道就齐了。
    const statusJustCompleted = plugin.statusCompletedAt && Date.now() - plugin.statusCompletedAt < 30_000
    return replyJson(res, 200, { ...unread, newTasks: fresh, taskError, statusCompleted: Boolean(statusJustCompleted) })
  }
  if (method === 'GET' && path === '/new-tasks') {
    return replyJson(
      res,
      200,
      await plugin.newTasks({
        acknowledge: url.searchParams.get('ack') === '1',
        all: url.searchParams.get('all') === '1',
      }),
    )
  }
  if (method === 'GET' && path === '/issue') {
    return replyJson(res, 200, await plugin.issue(url.searchParams.get('id')))
  }
  if (method === 'POST' && path === '/transition') {
    const body = await readBody(req)
    return replyJson(res, 200, await plugin.changeStatus({ issueId: body.issueId, status: body.status, comment: body.comment }))
  }
  if (method === 'POST' && path === '/assignee') {
    const body = await readBody(req)
    return replyJson(
      res,
      200,
      await plugin.setAssignee({ issueId: body.issueId, assigneeId: body.assignee, clear: body.clear === true }),
    )
  }
  if (method === 'GET' && path === '/repos') return replyJson(res, 200, { repos: await plugin.repos() })
  if (method === 'GET' && path === '/branches') {
    return replyJson(res, 200, await plugin.branches(url.searchParams.get('repo')))
  }
  if (method === 'GET' && path === '/docs') {
    const repo = url.searchParams.get('repo') ? await plugin.resolveRepo(url.searchParams.get('repo')) : await plugin.repoPath()
    const { number, topics } = await plugin.nextDocNumber(repo)
    return replyJson(res, 200, { repo, next: number, topics: topics.map((topic) => topic.relative) })
  }
  if (method === 'GET' && path === '/worktrees') {
    return replyJson(res, 200, { items: plugin.state.worktrees ?? [] })
  }
  if (method === 'POST' && path === '/worktree') {
    const body = await readBody(req)
    return replyJson(res, 200, await plugin.createWorktree(body))
  }
  if (method === 'POST' && path === '/repo') {
    const body = await readBody(req)
    const repoPath = await plugin.setRepoPath(body.path)
    // 一起把候选吐回去：客户端选完目录要立刻能显示，不用再请求一次。
    return replyJson(res, 200, { repoPath, repos: await plugin.repos() })
  }
  return replyJson(res, 404, { message: '未知接口' })
}

export const inject = ['webServer']

export function apply(ctx, config) {
  const plugin = new ChoerodonPlugin(ctx, config)
  ctx.effect(() => () => {
    plugin.closeLogin().catch(() => {})
  })
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: '/choerodon',
      handler: (req, res) => {
        plugin.ready
          .then(() => dispatch(plugin, req, res))
          .catch((error) => {
            if (res.headersSent) return res.destroy()
            replyJson(res, 500, { message: error instanceof Error ? error.message : '插件内部错误' })
          })
      },
    }),
  )
  ctx.on('llm-pi-ai/request-headers', (request, headers, next) => plugin.requestHeaders(request, headers, next))

  const tools = ctx.get('tools')
  if (tools) {
    const textOutput = (value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]
    const register = (definition) => {
      ctx.effect(() => tools.register(definition))
    }
    register({
      name: 'choerodon_board',
      description:
        '读取猪齿鱼任务看板：按状态分泳道返回工作项。默认只看当前登录人经办的，mine=false 看全部（含别人的）；' +
        'epic 按史诗名包含匹配、assignee 按经办人姓名/工号包含匹配，都可逗号分隔多个。' +
        'used for 查看我的任务/看板，决定先做哪一项。',
      parameters: {
        type: 'object',
        properties: {
          mine: { type: 'boolean', description: 'true 只看自己经办的（默认），false 看全部（含别人的）。' },
          epic: { type: 'string', description: '按史诗名筛选：史诗名包含任一子串即命中，逗号分隔可多个，如 瑞安 或 海亮,明康汇。' },
          epicIds: { type: 'array', items: { type: 'string' }, description: '按史诗 id 精确筛选，优先于 epic。' },
          assignee: { type: 'string', description: '按经办人筛选：姓名或工号包含任一子串即命中，逗号分隔可多个，如 叶红柳 或 21582,47307。' },
          assigneeIds: { type: 'array', items: { type: 'string' }, description: '按经办人 id 精确筛选，优先于 assignee。' },
        },
        additionalProperties: false,
      },
      output: { schema: { type: 'object' }, render: (_args, value) => textOutput(value) },
      async execute(args) {
        await plugin.ready
        const board = await plugin.board({
          mine: args?.mine !== false,
          epic: text(args?.epic, 200),
          epicIds: Array.isArray(args?.epicIds) ? args.epicIds : [],
          assignee: text(args?.assignee, 200),
          assigneeIds: Array.isArray(args?.assigneeIds) ? args.assigneeIds : [],
        })
        return {
          mine: board.mine,
          epicFilter: board.epicFilter,
          epicNames: board.epicNames,
          assigneeFilter: board.assigneeFilter,
          assigneeNames: board.assigneeNames,
          lanes: board.lanes.map((lane) => ({
            status: lane.name,
            total: lane.total,
            items: lane.items.map((item) => ({
              num: item.num,
              summary: item.summary,
              epic: item.epicName,
              sprint: item.sprintName,
              assignee: item.assigneeName,
              type: item.typeName,
              priority: item.priority,
              estimateTime: item.estimateTime,
              id: item.id,
            })),
          })),
        }
      },
    })
    register({
      name: 'choerodon_issue',
      description:
        '读取一个猪齿鱼工作项的详情与可流转状态（含评论入口需要的编号）。issueId 或工作项编号（如 PROJ-123）都可以。',
      parameters: {
        type: 'object',
        properties: {
          issue: { type: 'string', description: '工作项 id 或编号。' },
        },
        required: ['issue'],
        additionalProperties: false,
      },
      output: { schema: { type: 'object' }, render: (_args, value) => textOutput(value) },
      async execute(args) {
        await plugin.ready
        const id = await plugin.resolveIssueId(args?.issue)
        return plugin.issue(id)
      },
    })
    register({
      name: 'choerodon_comment',
      description:
        '读写猪齿鱼工作项评论：不传 body 是读评论（含回复、附件），传 body 就是发一条评论。' +
        'used for 在问题里留开发结论、回应人家的提问、把处理结果写进讨论区。',
      parameters: {
        type: 'object',
        properties: {
          issue: { type: 'string', description: '工作项 id 或编号，如 PROJ-456。' },
          body: { type: 'string', description: '要发的评论正文；不传则只读评论。' },
          markdown: { type: 'boolean', description: 'body 按 Markdown 处理（标题/列表/代码/粗体/链接）。' },
          mention: { type: 'string', description: '要 @ 的人，姓名或工号，逗号分隔；正文里的 @姓名 也会自动转成提及。' },
          page: { type: 'number', description: '读评论的页码，从 0 开始，默认 0。' },
          size: { type: 'number', description: '读评论每页条数，默认 20，最大 50。' },
        },
        required: ['issue'],
        additionalProperties: false,
      },
      output: { schema: { type: 'object' }, render: (_args, value) => textOutput(value) },
      async execute(args) {
        await plugin.ready
        const id = await plugin.resolveIssueId(args?.issue)
        const body = typeof args?.body === 'string' ? args.body.trim() : ''
        if (!body) return plugin.comments({ issueId: id, page: args?.page, size: args?.size })
        return plugin.addComment({ issueId: id, body, markdown: args?.markdown === true, mention: args?.mention })
      },
    })
    register({
      name: 'choerodon_create_issue',
      description:
        '在猪齿鱼建一个工作项，或按现有工作项复制一份新单（copyFrom）。' +
        'used for 会上临时记问题、把一个任务拆成两路、照着别人的单复制一份给自己。',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: '概要；复制时省略则用「原概要（副本）」。' },
          description: { type: 'string', description: '描述，纯文本或 HTML；复制时省略则沿用来源单描述并注明来源。' },
          typeCode: { type: 'string', description: '工作项类型编码或名称，如 缺陷、前端开发任务；建子任务时别省略，省略会取项目里第一个子任务类型，先用 choerodon_dict 看可选类型。' },
          issueTypeId: { type: 'string', description: '工作项类型 id，优先于 typeCode。' },
          componentIds: { type: 'array', items: { type: 'string' }, description: '模块 id 数组；先用 choerodon_dict 取。' },
          labelIds: { type: 'array', items: { type: 'string' }, description: '标签 id 数组；该项目没配标签就传空。' },
          reporter: { type: 'string', description: '报告人：姓名、工号或用户 id；不给就是当前登录人。' },
          sprintId: { type: 'string', description: '冲刺 id；传 0 表示不挂冲刺（默认不擅自选当前冲刺）。' },
          parentIssueId: { type: 'string', description: '父工作项 id，给了就是建子任务。' },
          priorityId: { type: 'string', description: '优先级 id 或名称；省略用来源单或项目默认优先级。' },
          assignee: { type: 'string', description: '经办人：姓名、工号、用户 id 或 me；省略时沿用来源单，没有就不分配。' },
          epicId: { type: 'string', description: '史诗 id；省略时沿用来源单。' },
          estimateTime: { type: 'number', description: '原始预估工时（小时，0.1~999.9）。' },
          remainingTime: { type: 'number', description: '剩余预估工时（小时，0~999.9）。' },
          estimatedStart: { type: 'string', description: '预计开始时间，如 2026-11-26 00:00:00。' },
          estimatedEnd: { type: 'string', description: '预计结束时间，如 2026-11-30 00:00:00。' },
          copyFrom: { type: 'string', description: '复制来源的工作项编号或 id；给了就是「按它复制一份」。' },
        },
        additionalProperties: false,
      },
      output: { schema: { type: 'object' }, render: (_args, value) => textOutput(value) },
      async execute(args) {
        await plugin.ready
        return plugin.createIssue({
          summary: args?.summary,
          description: args?.description,
          typeCode: args?.typeCode,
          issueTypeId: args?.issueTypeId,
          priorityId: args?.priorityId,
          assignee: args?.assignee,
          epicId: args?.epicId,
          estimateTime: args?.estimateTime,
          remainingTime: args?.remainingTime,
          estimatedStart: args?.estimatedStart,
          estimatedEnd: args?.estimatedEnd,
          copyFrom: args?.copyFrom,
          componentIds: args?.componentIds,
          labelIds: args?.labelIds,
          reporter: args?.reporter,
          sprintId: args?.sprintId,
          parentIssueId: args?.parentIssueId,
        })
      },
    })
    register({
      name: 'choerodon_estimate',
      description:
        '改猪齿鱼工作项的工时：原始预估（estimateTime）与剩余预估（remainingTime），单位小时。' +
        'used for 开发前登记预估、收尾时更新剩余工时。',
      parameters: {
        type: 'object',
        properties: {
          issue: { type: 'string', description: '工作项 id 或编号。' },
          estimateTime: { type: 'number', description: '原始预估工时（小时，0.1~999.9）。' },
          remainingTime: { type: 'number', description: '剩余预估工时（小时，0~999.9）。' },
        },
        required: ['issue'],
        additionalProperties: false,
      },
      output: { schema: { type: 'object' }, render: (_args, value) => textOutput(value) },
      async execute(args) {
        await plugin.ready
        const id = await plugin.resolveIssueId(args?.issue)
        return plugin.setEstimate({ issueId: id, estimateTime: args?.estimateTime, remainingTime: args?.remainingTime })
      },
    })
    register({
      name: 'choerodon_activity',
      description:
        '读猪齿鱼工作项的操作记录（谁在什么时候把什么字段从什么改成了什么），' +
        '并单独列出经办人变更，用来回答「这张单现在归谁、是谁分的」。' +
        'used for 交接前确认负责人、追查单据被谁改派、核对改完该分回给谁。',
      parameters: {
        type: 'object',
        properties: {
          issue: { type: 'string', description: '工作项 id 或编号，如 PROJ-789。' },
          limit: { type: 'number', description: '最多返回多少条操作事件，默认全给。' },
        },
        required: ['issue'],
        additionalProperties: false,
      },
      output: { schema: { type: 'object' }, render: (_args, value) => textOutput(value) },
      async execute(args) {
        await plugin.ready
        const id = await plugin.resolveIssueId(args?.issue)
        return plugin.activity({ issueId: id, limit: args?.limit })
      },
    })
    register({
      name: 'choerodon_worklog',
      description:
        '登记 / 查看猪齿鱼工作项的工时日志（工作项详情里的「工时日志」页）。' +
        '给 workTime 就是登记一条，不给就是读已有日志与合计。' +
        'used for 每天登记投入工时、按工作日期补登记、核对这个单已经记了多少小时。',
      parameters: {
        type: 'object',
        properties: {
          issue: { type: 'string', description: '工作项 id 或编号，如 PROJ-789。' },
          workTime: { type: 'number', description: '本次耗费时间（小时，0.1~999.9）；不传则只读日志。' },
          startDate: { type: 'string', description: '工作日期，如 2026-11-26 14:26:54；不传用当前时间。' },
          description: { type: 'string', description: '工作描述，写清这次做了什么。' },
          residualPrediction: {
            type: 'string',
            enum: ['self_adjustment', 'no_set_prediction_time', 'set_to', 'reduce'],
            description: '剩余预估怎么处理：自动调整（默认）/ 不调整 / 设置为 / 缩减。',
          },
          predictionTime: { type: 'number', description: '剩余预估小时数，选「设置为 / 缩减」时必填。' },
        },
        required: ['issue'],
        additionalProperties: false,
      },
      output: { schema: { type: 'object' }, render: (_args, value) => textOutput(value) },
      async execute(args) {
        await plugin.ready
        const id = await plugin.resolveIssueId(args?.issue)
        if (args?.workTime === undefined || args?.workTime === null || args?.workTime === '') {
          return plugin.workLogs({ issueId: id })
        }
        const created = await plugin.addWorkLog({
          issueId: id,
          workTime: args.workTime,
          startDate: args.startDate,
          description: args.description,
          residualPrediction: args.residualPrediction,
          predictionTime: args.predictionTime,
        })
        return { ...created, log: await plugin.workLogs({ issueId: id }) }
      },
    })
    register({
      name: 'choerodon_inbox',
      description:
        '看猪齿鱼的站内消息未读数与「新分给我的任务」：经办人是我、且不在上次基线里的工作项。' +
        'acknowledge=true 表示把这些新任务标记为已看过（角标清零）。' +
        'used for 别人把任务分给我时确认有没有新单、上线后先看看漏了什么。',
      parameters: {
        type: 'object',
        properties: {
          acknowledge: { type: 'boolean', description: 'true 表示确认已看过，把当前新任务并入基线、角标归零。' },
        },
        additionalProperties: false,
      },
      output: { schema: { type: 'object' }, render: (_args, value) => textOutput(value) },
      async execute(args) {
        await plugin.ready
        const unread = await plugin.unreadMessages()
        const fresh = await plugin.newTasks({ acknowledge: args?.acknowledge === true })
        return { unread: unread.unread, unavailable: unread.unavailable === true, ...fresh }
      },
    })
    register({
      name: 'choerodon_search',
      description:
        '按关键字搜猪齿鱼工作项（概要/描述全文匹配），可按「只看我的」过滤，带分页。' +
        '平台没有独立搜索接口，走的是工作项列表的内容匹配；关键字为空时退化成列表浏览。' +
        'used for 找单、按摘要关键词定位历史工作项、查某人名下有没有相关单。',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '关键字，匹配概要/描述正文；留空就是按时间顺序列最近的工作项。' },
          mine: { type: 'boolean', description: 'true 只看当前登录人经办的。' },
          page: { type: 'number', description: '页码，从 0 开始，默认 0。' },
          size: { type: 'number', description: '每页条数，1–100，默认 20。' },
        },
        additionalProperties: false,
      },
      output: { schema: { type: 'object' }, render: (_args, value) => textOutput(value) },
      async execute(args) {
        await plugin.ready
        return plugin.searchIssues({
          keyword: args?.keyword,
          mine: args?.mine === true,
          page: args?.page,
          size: args?.size,
        })
      },
    })
    register({
      name: 'choerodon_delete_issue',
      description:
        '删除一条工作项。平台是真的删掉（之后详情 404），**不可撤销**，所以必须显式传 confirm: true，' +
        '否则直接拒绝并说明后果。删除前会先读一次详情，把编号与概要带回给你核对。' +
        'used for 清理误建的单、删掉测试垃圾；不要用它代替「取消/关闭」这类状态流转。',
      parameters: {
        type: 'object',
        properties: {
          issue: { type: 'string', description: '工作项 id 或编号。' },
          confirm: { type: 'boolean', description: '必须为 true，表示已确认要永久删除。' },
        },
        required: ['issue', 'confirm'],
        additionalProperties: false,
      },
      output: { schema: { type: 'object' }, render: (_args, value) => textOutput(value) },
      async execute(args) {
        await plugin.ready
        const id = await plugin.resolveIssueId(args?.issue)
        return plugin.deleteIssue({ issueId: id, confirm: args?.confirm === true })
      },
    })
    register({
      name: 'choerodon_attachment_url',
      description:
        '把一个猪齿鱼附件换成可直接下载的临时地址。附件存在公司私有 OBS 桶里，原始 url 直接打开会 403；' +
        '这个工具通过平台的 redirect-url 换出带签名、有时效的地址，返回 url 与 expiresAt。' +
        '附件地址从 choerodon_issue 的 attachments[].url 取。' +
        'used for 需要把附件交给用户下载、或要把附件内容取下来看的场景。',
      parameters: {
        type: 'object',
        properties: {
          issue: { type: 'string', description: '工作项 id 或编号，用来取附件列表。' },
          fileName: { type: 'string', description: '附件文件名；同一工作项里有多个附件时用它指定。' },
          attachmentId: { type: 'string', description: '附件 id，优先于 fileName。' },
        },
        required: ['issue'],
        additionalProperties: false,
      },
      output: { schema: { type: 'object' }, render: (_args, value) => textOutput(value) },
      async execute(args) {
        await plugin.ready
        const id = await plugin.resolveIssueId(args?.issue)
        const detail = await plugin.issue(id)
        const wantedId = String(args?.attachmentId ?? '')
        const wantedName = text(args?.fileName, 260)
        const hit = wantedId
          ? detail.attachments.find((row) => row.id === wantedId)
          : wantedName
            ? detail.attachments.find((row) => row.fileName === wantedName)
            : detail.attachments[0]
        if (!hit) {
          throw new Error(
            detail.attachments.length
              ? `没有这个附件；可选：${detail.attachments.map((row) => row.fileName).join('、')}`
              : '这张工作项没有附件',
          )
        }
        const url = await plugin.attachmentDownloadUrl({ url: hit.url, fileName: hit.fileName })
        return { ...url, issueNum: detail.detail.num, attachmentId: hit.id, fileName: hit.fileName }
      },
    })
    register({
      name: 'choerodon_dict',
      description:
        '读项目的建单字典：模块、标签、冲刺、可用关联类型、工作项类型。' +
        '本环境里模块走 /component、标签走 /issue_labels，冲刺与关联类型因为平台对应接口返回错误，' +
        '改成从最近工作项上反查。任何一路取不到只在 errors 里记一笔，不影响其它项。' +
        'used for 建单前拿模块/标签/冲刺 id，确认可选的子任务类型（前端开发任务/后端开发任务等），或确认这个项目有没有配标签。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: { type: 'object' }, render: (_args, value) => textOutput(value) },
      async execute() {
        await plugin.ready
        const dict = await plugin.projectDict()
        // 类型不进 projectDict 的缓存：它有自己的 10 分钟缓存，且字典缓存可能还是旧结构。
        const issueTypes = await plugin.issueTypes().catch(() => [])
        return { ...dict, issueTypes }
      },
    })
    register({
      name: 'choerodon_update_fields',
      description:
        '改工作项的普通字段：描述、概要、计划起止、原始/剩余预估、史诗、冲刺、模块、标签、报告人。' +
        '每次只提交你给的字段，带乐观锁并回读核对。' +
        'used for 补描述、挪史诗、换冲刺、挂模块标签、改报告人。',
      parameters: {
        type: 'object',
        properties: {
          issue: { type: 'string', description: '工作项 id 或编号，如 PROJ-123。' },
          summary: { type: 'string', description: '新概要。' },
          description: { type: 'string', description: '新描述，纯文本会自动折成段落，也可以直接给 HTML。' },
          estimatedStart: { type: 'string', description: '计划开始，格式 2026-11-26 00:00:00。' },
          estimatedEnd: { type: 'string', description: '计划结束，格式 2026-11-26 00:00:00。' },
          estimateTime: { type: 'number', description: '原始预估工时（小时）。' },
          remainingTime: { type: 'number', description: '剩余预估工时（小时）。' },
          epicId: { type: 'string', description: '史诗 id，传 0 表示不挂史诗。' },
          sprintId: { type: 'string', description: '冲刺 id，传 0 表示不挂冲刺。' },
          componentIds: { type: 'array', items: { type: 'string' }, description: '模块 id 数组，整组替换。' },
          labelIds: { type: 'array', items: { type: 'string' }, description: '标签 id 数组，整组替换。' },
          reporter: { type: 'string', description: '报告人：姓名、工号或用户 id。' },
        },
        required: ['issue'],
        additionalProperties: false,
      },
      output: { schema: { type: 'object' }, render: (_args, value) => textOutput(value) },
      async execute(args) {
        await plugin.ready
        const id = await plugin.resolveIssueId(args?.issue)
        return plugin.updateIssueFields({
          issueId: id,
          summary: args?.summary,
          description: args?.description,
          estimatedStart: args?.estimatedStart,
          estimatedEnd: args?.estimatedEnd,
          estimateTime: args?.estimateTime,
          remainingTime: args?.remainingTime,
          epicId: args?.epicId,
          sprintId: args?.sprintId,
          componentIds: args?.componentIds,
          labelIds: args?.labelIds,
          reporter: args?.reporter,
        })
      },
    })
    register({
      name: 'choerodon_change_type',
      description:
        '转换工作项类型（例如缺陷转任务）。改完回读核对，类型不在项目可选清单里会直接拒绝。' +
        'used for 建错类型要纠正、缺陷实际是需求这类场景。',
      parameters: {
        type: 'object',
        properties: {
          issue: { type: 'string', description: '工作项 id 或编号。' },
          typeCode: { type: 'string', description: '目标类型：typeCode（如 bug、sub_task）或中文名（如 缺陷）。' },
        },
        required: ['issue', 'typeCode'],
        additionalProperties: false,
      },
      output: { schema: { type: 'object' }, render: (_args, value) => textOutput(value) },
      async execute(args) {
        await plugin.ready
        const id = await plugin.resolveIssueId(args?.issue)
        return plugin.changeIssueType({ issueId: id, typeCode: args?.typeCode })
      },
    })
    register({
      name: 'choerodon_worktree',
      description:
        '按猪齿鱼工作项创建本地开发分支与 Git worktree，目录在主仓库的 .worktrees/ 下。只建本地分支，不 push、不 merge。',
      parameters: {
        type: 'object',
        properties: {
          issue: { type: 'string', description: '工作项 id 或编号。' },
          repoPath: { type: 'string', description: '仓库根目录；省略则用最近选过的仓库。' },
          baseMode: {
            type: 'string',
            enum: ['develop', 'uat', 'prod', 'custom'],
            description: '从哪条分支开出来；custom 时用 customBase 指定。',
          },
          customBase: { type: 'string', description: '自定义来源分支，仅 baseMode 为 custom 时生效。' },
        },
        required: ['issue'],
        additionalProperties: false,
      },
      output: { schema: { type: 'object' }, render: (_args, value) => textOutput(value) },
      async execute(args) {
        await plugin.ready
        const id = await plugin.resolveIssueId(args?.issue)
        return plugin.createWorktree({
          issueId: id,
          repoPath: args?.repoPath,
          baseMode: args?.baseMode,
          customBase: args?.customBase,
        })
      },
    })
    register({
      name: 'choerodon_update',
      description:
        '改猪齿鱼工作项的状态或经办人：状态必须落在当前工作项的可流转状态里（如 开发中、待测试、已完成）。' +
        '经办人可以给姓名、工号、用户 id 或 me，也可以 clear 清空；不给就不动经办人。' +
        'used for 开发开始时置「开发中」、开发完成置「待测试」、把问题转给指定的人。',
      parameters: {
        type: 'object',
        properties: {
          issue: { type: 'string', description: '工作项 id 或编号，如 PROJ-456。' },
          status: { type: 'string', description: '目标状态名，例如 开发中、待测试、已完成；留空表示不改状态。' },
          assignee: { type: 'string', description: '经办人：姓名、工号、用户 id 或 me；不传就不动经办人。' },
          clearAssignee: { type: 'boolean', description: 'true 表示把经办人清空。' },
          comment: { type: 'string', description: '流转审批说明，目标状态要求审批时必填。' },
        },
        required: ['issue'],
        additionalProperties: false,
      },
      output: { schema: { type: 'object' }, render: (_args, value) => textOutput(value) },
      async execute(args) {
        await plugin.ready
        const hasStatus = typeof args?.status === 'string' && args.status.trim() !== ''
        const hasAssignee = typeof args?.assignee === 'string' && args.assignee.trim() !== ''
        const clearAssignee = args?.clearAssignee === true
        if (!hasStatus && !hasAssignee && !clearAssignee) throw new Error('status、assignee、clearAssignee 至少给一个')
        const id = await plugin.resolveIssueId(args?.issue)
        const result = { issueId: id }
        if (hasStatus) result.status = await plugin.changeStatus({ issueId: id, status: args.status, comment: args.comment })
        if (hasAssignee || clearAssignee) {
          result.assignee = await plugin.setAssignee({
            issueId: id,
            assigneeId: args?.assignee,
            clear: clearAssignee,
          })
        }
        const latest = await plugin.issue(id)
        result.current = {
          num: latest.detail.num,
          summary: latest.detail.summary,
          status: latest.detail.statusName,
          assignee: latest.detail.assigneeName,
        }
        return result
      },
    })
  }

  plugin.ready.then(() => plugin.autoWire()).catch(() => {})
}

/** 允许用工作项编号代替 id：先按编号在最近的工作项里找，找不到再按 id 走。 */
ChoerodonPlugin.prototype.resolveIssueId = async function resolveIssueId(rawValue) {
  const value = typeof rawValue === 'string' ? rawValue.trim() : ''
  if (!value) throw new Error('请提供工作项编号或 id')
  if (/^[A-Za-z0-9_-]{1,128}$/.test(value) && /^\d{6,}$/.test(value)) return value
  for (let page = 0; page < 5; page += 1) {
    const result = await this.workList({ conditions: [], treeFlag: false, withSubIssues: false }, page, 100)
    const rows = Array.isArray(result?.content) ? result.content : []
    if (!rows.length) break
    const hit = rows.find((row) => String(row?.issueNum ?? '').toLowerCase() === value.toLowerCase())
    if (hit?.issueId) return String(hit.issueId)
    const byId = rows.find((row) => String(row?.issueId ?? '') === value)
    if (byId?.issueId) return String(byId.issueId)
    if (rows.length < 100) break
  }
  throw new Error(`没有找到工作项：${value}`)
}
