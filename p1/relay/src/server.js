/**
 * W3 开发骨架 · Relay（零依赖，Node >= 24.9）
 * ---------------------------------------------------------------
 * 范围（05 W3）：配对、设备注册、心跳与离线判定、白名单、Host 离线立即 409、
 * **Host 主动 WebSocket 长连与帧保序**，以及会话索引上报。
 *
 * 传输分工：
 *   - Host → Relay：`WS /ws/host` 长连（正式设计，docs/04 §5.2）。
 *   - 手机 → Relay：HTTP（W3 骨架；PWA 侧的 SSE/WS 属后续提交）。
 *   - 手机 HTTP 请求经 `http/request` 帧转给 Host，Host 用 `http/response` 回，
 *     帧字段与 docs/04 §5.3 一致；**同一连接的帧按发送顺序到达**（帧序即流序）。
 *   - HTTP 轮询桥（`GET /host/poll` + `POST /host/respond`）保留为**降级通道**：
 *     当设备没有活跃 WS 连接时使用，便于旧 Host 与单测。
 *
 * 四项 P1 前置按 SIGNOFF-WAIVER.md §5 的**默认口径**实现（未经会签）：
 *   #2 pairSecret = per-challenge 一次性随机数，不落盘、不参与令牌派生；
 *   #3 单机期 Relay 内存表为活跃令牌、在线状态与会话索引的权威；
 *   #4 只开放 session/* 与 $events/*，其余端点默认拒绝；
 *   #5b 客户端 sinceSeq 唯一权威，服务端 Cursor 仅作可观测性快照。
 *
 * **CP 分离（本轮）**：#3 那条口径已经过时——设备表、会话索引、写句柄租约、消费位点
 * 四张表迁到 `p1/cp`（接口按 PROTOCOL §2 的 Postgres 表设计）。Relay 只剩传输状态
 * （套接字、待转发帧、事件缓冲、配对短时码）。多个 Relay 实例共享同一个 CP 实例时，
 * 看到的是同一份设备与会话视图。
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createControlPlane } from '../../cp/src/index.js'
import { createEventHub } from './events.js'
import { upgradeToWebSocket } from './ws.js'

export const PROTOCOL = 'wbsync/1'
export const ALLOWED_ENDPOINTS = ['session/*', '$events/*']

const DEFAULTS = {
  codeTtlMs: 600_000,          // 6 位码 10 分钟
  challengeTtlMs: 60_000,      // 一次性挑战 60 秒
  heartbeatTimeoutMs: 45_000,  // >45s 无心跳判离线
  rateLimitPerMin: 5,          // 设备 + IP 维度 5 次/分
  rateWindowMs: 60_000,
  requestTimeoutMs: 10_000,    // 10s 无进度防悬挂
  maxBodyBytes: 1_048_576,
}

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a), 'hex')
  const y = Buffer.from(String(b), 'hex')
  return x.length === y.length && timingSafeEqual(x, y)
}
const isAllowed = (endpoint, allowlist = ALLOWED_ENDPOINTS) =>
  allowlist.some((rule) => rule.endsWith('/*')
    ? endpoint.startsWith(rule.slice(0, -1))
    : endpoint === rule)

/* ------------------------------------------------------------ 静态壳服务 */

const STATIC_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.css': 'text/css; charset=utf-8',
}

/**
 * 解析静态根目录对：createRelay 不传 `staticDir` → 自动探测 `p1/pwa/public`
 * （仓库内相对定位，存在才挂）；传 `null` 显式关闭；传字符串用给定目录
 * （public 与 src 约定为兄弟目录）。
 * 真机部署时 Relay 与 p1/ 同树分发，自动探测即命中。
 */
const resolveStaticRoots = (staticDir) => {
  if (staticDir === null) return null
  let base
  if (typeof staticDir === 'string') {
    base = staticDir.replace(/[\\/]+$/, '')
  } else {
    base = fileURLToPath(new URL('../../pwa/public/', import.meta.url))
    if (!existsSync(base)) return null
    base = base.replace(/[\\/]+$/, '')
  }
  // `/app/*` → public（壳），`/src/*` → 兄弟目录 src（client.js / pairing.js，
  // 页面里的 `../src/x.js` 从 /app/ 解析为 /src/x.js）
  return { publicRoot: base, srcRoot: `${base}/../src` }
}

/**
 * 静态文件读取：只允许**单层文件名**（两个根目录都约定平铺）。
 * 先 decodeURIComponent 再校验——编码形态的遍历（`%2e%2e`、`%2f`）解码后
 * 必然带 `..` / 路径分隔符，一样被拒；从根上排除路径遍历，不依赖 URL 归一化行为。
 */
const readStaticFile = (root, rawName) => {
  if (!root) return { status: 404, code: 'ENDPOINT_NOT_ALLOWED', message: '未启用静态壳服务' }
  let name = rawName
  try { name = decodeURIComponent(String(rawName)) } catch {
    return { status: 400, code: 'INVALID_JSON', message: '静态路径解码失败' }
  }
  if (!name || name.endsWith('/')) name += 'index.html'
  if (/[/\\]|\.\./.test(name)) return { status: 403, code: 'ENDPOINT_NOT_ALLOWED', message: '非法静态路径' }
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return { status: 404, code: 'ENDPOINT_NOT_ALLOWED', message: '未知静态文件' }
  const mime = STATIC_MIME[name.slice(dot)]
  if (!mime) return { status: 404, code: 'ENDPOINT_NOT_ALLOWED', message: '不支持的静态类型' }
  try {
    return { status: 200, body: readFileSync(`${root}/${name}`), mime }
  } catch {
    return { status: 404, code: 'ENDPOINT_NOT_ALLOWED', message: `静态文件不存在：${name}` }
  }
}

const sendStatic = (res, result) => {
  if (result.status !== 200) return fail(res, result.status, result.code, result.message)
  res.writeHead(200, {
    'Content-Type': result.mime,
    'Content-Length': result.body.length,
    // 壳页面无鉴权是 PWA 必需（docs/04）；内容变更靠 sw 版本号 + no-cache 兜底
    'Cache-Control': 'no-cache',
    'X-Protocol-Version': PROTOCOL,
  })
  res.end(result.body)
}

const reply = (res, status, payload, extraHeaders = {}) => {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'X-Protocol-Version': PROTOCOL,
    ...extraHeaders,
  })
  res.end(body)
}
const ok = (res, data, status = 200) => reply(res, status, { ok: true, data, protocol: PROTOCOL })
const fail = (res, status, code, message, retryable = false) =>
  reply(res, status, { ok: false, error: { code, message, retryable }, protocol: PROTOCOL })

const readBody = async (req, maxBytes) => {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) throw new Error('BODY_TOO_LARGE')
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  try { return JSON.parse(text) } catch { throw new Error('INVALID_JSON') }
}

/**
 * 创建 Relay 实例。返回未 listen 的 http.Server，便于测试。
 * 注入 now() / randomBytes() 可让时间与随机性确定，规则判定是纯函数。
 */
export function createRelay(options = {}) {
  const cfg = { ...DEFAULTS, ...options }
  const now = cfg.now ?? (() => Date.now())
  const rand = cfg.randomBytes ?? randomBytes
  const allowlist = cfg.allowedEndpoints ?? ALLOWED_ENDPOINTS
  // 元数据全在 CP；Relay 不再自己存设备表 / 索引 / 位点
  const cp = cfg.controlPlane ?? createControlPlane({ now, offlineAfterMs: cfg.heartbeatTimeoutMs })
  // PWA 壳静态根（/app → public/，/src → pwa/src）；null 关闭
  const staticRoots = resolveStaticRoots(cfg.staticDir)

  const state = {
    codes: new Map(),        // code -> { deviceId, expiresAt }（配对短时态，P2 迁 CP）
    challenges: new Map(),   // challenge -> { code, deviceId, pairSecret, expiresAt }
    rateHits: new Map(),     // `${deviceId}|${ip}` -> number[] (ms)
    queue: new Map(),        // deviceId -> 待转发帧（无 WS 时的降级通道）
    pending: new Map(),      // reqId -> { resolve, timer }
    sockets: new Map(),      // deviceId -> WS 连接（正式通道）
    hub: createEventHub({ capacity: cfg.eventBuffer ?? 1000 }),  // 事件缓冲 + 订阅广播
  }

  const sixDigitCode = () => String(rand(4).readUInt32BE(0) % 1_000_000).padStart(6, '0')
  const hex = (n) => rand(n).toString('hex')

  const rateLimited = (deviceId, ip) => {
    const key = `${deviceId}|${ip}`
    const t = now()
    const hits = (state.rateHits.get(key) ?? []).filter((ts) => t - ts < cfg.rateWindowMs)
    hits.push(t)
    state.rateHits.set(key, hits)
    return hits.length > cfg.rateLimitPerMin
  }

  /** 有活跃 WS 连接即在线；否则问 CP（心跳时间窗 / 墓碑）。 */
  const isOnline = (deviceId) => {
    const conn = state.sockets.get(deviceId)
    if (conn?.isOpen()) return true
    return cp.isDeviceAlive(deviceId, now())
  }

  /** 手机侧 /d/<id>/<endpoint> 请求 → 帧 → 等待 Host 响应。afterResponse 在响应落地后拿到原始应答（可选）。 */
  const bridge = (req, res, deviceId, endpoint, body, afterResponse = null) => {
    const reqId = hex(16)
    const frame = { t: 'http/request', reqId, method: req.method, endpoint, body, sinceSeq: body?.sinceSeq ?? null }
    const conn = state.sockets.get(deviceId)
    if (conn?.isOpen()) {
      conn.sendJson(frame)                 // 正式通道：WS 长连，帧序即流序
    } else {
      const frames = state.queue.get(deviceId) ?? []
      frames.push(frame)                   // 降级通道：HTTP 轮询
      state.queue.set(deviceId, frames)
    }

    const timer = setTimeout(() => {
      const p = state.pending.get(reqId)
      if (!p) return
      state.pending.delete(reqId)
      fail(res, 504, 'NO_PROGRESS', '10s 内 Host 未回响应', true)
    }, cfg.requestTimeoutMs)

    state.pending.set(reqId, {
      resolve: (response) => {
        clearTimeout(timer)
        reply(res, response.status ?? 200, response.body ?? { ok: true, data: {}, protocol: PROTOCOL })
        if (afterResponse) { try { afterResponse(response) } catch { /* 记录失败不影响响应 */ } }
      },
      timer,
    })
  }

  /** 处理 Host 通过 WS 发来的帧。 */
  const handleHostFrame = (deviceId, text, conn) => {
    let msg
    try { msg = JSON.parse(text) } catch { return conn.close(1003, 'invalid json') }
    if (msg.t === 'host/heartbeat') {
      try { cp.heartbeatDevice(deviceId, now()) } catch { /* 已吊销：等下一个请求自然 401 */ }
      return conn.sendJson({ t: 'host/heartbeat/ack', ts: now() })
    }
    if (msg.t === 'host/sessions') {
      const rows = Array.isArray(msg.rows) ? msg.rows : []
      cp.upsertSessions(deviceId, rows)
      return conn.sendJson({ t: 'host/sessions/ack', count: rows.length })
    }
    if (msg.t === 'http/response') {
      const p = state.pending.get(String(msg.reqId ?? ''))
      if (!p) return conn.sendJson({ t: 'ack', ref: msg.reqId, status: 'rejected' })
      state.pending.delete(String(msg.reqId))
      p.resolve({ status: msg.status ?? 200, body: msg.body ?? {} })
      return conn.sendJson({ t: 'ack', ref: msg.reqId, status: 'accepted' })
    }
    if (msg.t === 'session/event') {
      // 上行事件：按连续 seq 推进并广播给订阅该会话的手机
      const r = state.hub.ingest(String(msg.sessionId ?? ''), msg.ev)
      if (r.rejected) return conn.sendJson({ t: 'ack', ref: msg.sessionId ?? null, status: r.rejected })
      return conn.sendJson({
        t: 'ack', ref: msg.sessionId, status: 'accepted',
        advanced: r.advanced, delivered: r.delivered,
      })
    }
    return conn.sendJson({ t: 'ack', ref: msg.t ?? null, status: 'ignored' })
  }

  const handler = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname
    const method = req.method ?? 'GET'
    const ip = req.socket?.remoteAddress ?? 'unknown'

    try {
      if (method === 'GET' && path === '/health') {
        return ok(res, {
          protocol: PROTOCOL,
          online: cp.listDevices().filter((d) => isOnline(d.deviceId)).length,
          sockets: [...state.sockets.entries()].filter(([, c]) => c.isOpen()).length,
        })
      }

      // PC 侧登记配对码（正式设计由 CP 承担，单机开发期由 Relay 兼任）
      if (method === 'POST' && path === '/pair/generate') {
        const body = await readBody(req, cfg.maxBodyBytes)
        if (!body.deviceId) return fail(res, 400, 'PAIR_CODE_INVALID', '缺少 deviceId')
        if (rateLimited(body.deviceId, ip)) return fail(res, 400, 'PAIR_CODE_INVALID', '设备/IP 限速 5 次/分')
        const code = sixDigitCode()
        state.codes.set(code, { deviceId: body.deviceId, expiresAt: now() + cfg.codeTtlMs })
        return ok(res, { code, deviceId: body.deviceId, ttl: cfg.codeTtlMs / 1000 })
      }

      // 手机输码 → 一次性挑战 + #2 per-challenge pairSecret
      if (method === 'POST' && path === '/pair') {
        const body = await readBody(req, cfg.maxBodyBytes)
        const entry = state.codes.get(String(body.code ?? ''))
        if (!entry || entry.expiresAt < now()) return fail(res, 400, 'PAIR_CODE_INVALID', '配对码错误或过期')
        state.codes.delete(String(body.code))
        const challenge = hex(24)
        const pairSecret = hex(16)   // 128 bit，per-challenge，不落盘、不参与令牌派生
        state.challenges.set(challenge, {
          code: String(body.code), deviceId: entry.deviceId, pairSecret,
          expiresAt: now() + cfg.challengeTtlMs,
        })
        return ok(res, { challenge, pairSecret, expiresIn: cfg.challengeTtlMs / 1000, deviceId: entry.deviceId })
      }

      if (method === 'POST' && path === '/pair/verify') {
        const body = await readBody(req, cfg.maxBodyBytes)
        const c = state.challenges.get(String(body.challenge ?? ''))
        if (!c) return fail(res, 400, 'CHALLENGE_EXPIRED', '挑战不存在或已使用')
        state.challenges.delete(String(body.challenge))
        if (c.expiresAt < now()) return fail(res, 400, 'CHALLENGE_EXPIRED', '挑战超过 60s')
        // challenge 是 Map 的键，值里不重复存；用请求里的原始值参与 HMAC
        const expected = createHmac('sha256', c.pairSecret).update(String(body.challenge)).digest('hex')
        if (!safeEqual(String(body.sig ?? ''), expected)) return fail(res, 401, 'UNAUTHORIZED', 'HMAC 校验失败')

        const deviceToken = hex(32)
        // 单活跃令牌：重新配对作废旧令牌；墓碑设备不复活
        const prev = cp.getDevice(c.deviceId)
        if (prev?.tombstone) return fail(res, 401, 'UNAUTHORIZED', '设备已吊销')
        cp.upsertDevice({
          deviceId: c.deviceId,
          state: 'online',
          lastSeenAt: now(),
          capabilities: prev?.capabilities ?? [],
        })
        cp.setDeviceToken(c.deviceId, deviceToken)   // 只存摘要
        return ok(res, { deviceToken, protocol: PROTOCOL, relayUrl: cfg.publicBaseUrl ?? 'http://127.0.0.1' })
      }

      // Host 注册 / 心跳 / 索引（HTTP 降级通道；正式走 WS）
      if (method === 'POST' && path === '/host/register') {
        const body = await readBody(req, cfg.maxBodyBytes)
        if (cfg.hostToken && body.hostToken !== cfg.hostToken) return fail(res, 401, 'UNAUTHORIZED', 'HOST_TOKEN 不匹配')
        const prev = cp.getDevice(body.deviceId)
        if (prev?.tombstone) return fail(res, 401, 'UNAUTHORIZED', '设备已吊销')
        cp.upsertDevice({
          deviceId: body.deviceId,
          state: 'online',
          lastSeenAt: now(),
          capabilities: body.caps ?? [],
        })
        return ok(res, { deviceId: body.deviceId, protocol: PROTOCOL })
      }
      if (method === 'POST' && path === '/host/heartbeat') {
        const body = await readBody(req, cfg.maxBodyBytes)
        try {
          const d = cp.heartbeatDevice(body.deviceId, now())
          return ok(res, { deviceId: d.deviceId, lastSeenAt: d.lastSeenAt })
        } catch {
          return fail(res, 409, 'HOST_OFFLINE', '设备未注册或已吊销', true)
        }
      }
      if (method === 'POST' && path === '/host/sessions') {
        const body = await readBody(req, cfg.maxBodyBytes)
        const d = cp.getDevice(body.deviceId)
        if (!d || d.tombstone) return fail(res, 409, 'HOST_OFFLINE', '设备未注册或已吊销', true)
        const { upserted, removed } = cp.upsertSessions(body.deviceId, body.rows ?? [])
        return ok(res, { count: upserted, removed })
      }
      if (method === 'GET' && path === '/host/indexes') {
        // 开发降级通道，但**不能永远裸奔**：配置了 adminToken 就要求 Bearer。
        // 手机侧正式入口是下面的 GET /api/sessions（设备令牌鉴权）。
        if (cfg.adminToken && req.headers.authorization !== `Bearer ${cfg.adminToken}`) {
          return fail(res, 401, 'UNAUTHORIZED', 'admin token 缺失')
        }
        const deviceId = url.searchParams.get('deviceId') ?? ''
        return ok(res, { deviceId, rows: cp.listSessions({ ownerDeviceId: deviceId }) })
      }

      // 手机侧会话列表（协议 §4 CP API 的 W3 单机实现）。
      // CP 目前是 Relay 进程内的库对象，所以由 Relay 代挂 /api/*；P2 CP 独立成
      // 服务时这条路由整体迁走，客户端 URL 不变。
      if (method === 'GET' && path === '/api/sessions') {
        const deviceId = url.searchParams.get('deviceId') ?? ''
        const auth = String(req.headers.authorization ?? '')
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
        if (!cp.verifyDeviceToken(deviceId, token)) {
          return fail(res, 401, 'UNAUTHORIZED', '令牌缺失、失效或已吊销')
        }
        const rawPinned = url.searchParams.get('pinned')
        const pinned = rawPinned === null ? null : rawPinned === 'true'
        return ok(res, {
          deviceId,
          rows: cp.listSessions({ ownerDeviceId: deviceId, pinned }),
        })
      }

      // 手机侧新建会话（协议 §4：目标 Host 离线时 HOST_OFFLINE，入口置灰）。
      // 桥接白名单内的 session/create → Host 的 createSession 适配器（接宿主
      // 新建会话入口）；Host 未注入适配器时 409 透传，Relay 不代造会话。
      if (method === 'POST' && path === '/api/sessions') {
        const auth = String(req.headers.authorization ?? '')
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
        const probe = url.searchParams.get('deviceId') ?? ''
        const body = await readBody(req, cfg.maxBodyBytes)
        const deviceId = body.deviceId ?? probe
        if (!cp.verifyDeviceToken(deviceId, token)) {
          return fail(res, 401, 'UNAUTHORIZED', '令牌缺失、失效或已吊销')
        }
        if (!isOnline(deviceId)) {
          cp.markDeviceOffline(deviceId)
          return fail(res, 409, 'HOST_OFFLINE', '目标 Host 离线', true)
        }
        return bridge(req, res, deviceId, 'session/create', {
          clientId: body.clientId ?? 'pwa',
          text: typeof body.text === 'string' ? body.text : '',
          cwd: body.cwd ?? null,
        }, (response) => {
          // 创建成功即把会话写进 CP 索引，手机不用等 Host 下一个 60s 刷新周期。
          // 这里是**启动引导值**（同 sessions.js 的口径）：state/lastSeq 以 Host
          // 下一次全量上报为准，全量快照会校正本行。
          const data = response?.body?.data
          if (response.status !== 200 || !data?.sessionId) return
          const row = data.index && typeof data.index === 'object'
            ? { ...data.index, sessionId: data.sessionId }
            : { sessionId: data.sessionId, state: 'awaiting', title: data.title ?? null, lastActiveAt: now() }
          cp.upsertSessions(deviceId, [row])
        })
      }

      // 降级通道：轮询取帧 / 回响应
      if (method === 'GET' && path === '/host/poll') {
        const deviceId = url.searchParams.get('deviceId') ?? ''
        const frames = state.queue.get(deviceId) ?? []
        state.queue.set(deviceId, [])
        return ok(res, { frames })
      }
      if (method === 'POST' && path === '/host/respond') {
        const body = await readBody(req, cfg.maxBodyBytes)
        const p = state.pending.get(String(body.reqId ?? ''))
        if (!p) return fail(res, 409, 'NO_PROGRESS', '请求已超时或不存在', true)
        state.pending.delete(String(body.reqId))
        p.resolve({ status: body.status ?? 200, body: body.body ?? {} })
        return ok(res, { accepted: true })
      }

      // 管理台（只读设备总览）
      if (method === 'GET' && path === '/admin') {
        if (cfg.adminToken && req.headers.authorization !== `Bearer ${cfg.adminToken}`) {
          return fail(res, 401, 'UNAUTHORIZED', 'admin token 缺失')
        }
        const rows = cp.listDevices().map((d) => ({
          deviceId: d.deviceId,
          state: isOnline(d.deviceId) ? 'online' : 'offline',
          lastSeenAt: d.lastSeenAt,
          tokenDigest: d.tokenDigest,
          tombstone: d.tombstone,
          transport: state.sockets.get(d.deviceId)?.isOpen() ? 'ws' : 'http-poll',
        }))
        return ok(res, { rows })
      }

      // PWA 壳：/app → p1/pwa/public，/src → p1/pwa/src（页面里 `../src/client.js`
      // 从 /app/ 解析为 /src/client.js）。无鉴权静态（PWA 必需，docs/04）；
      // 业务数据仍全走鉴权端点。
      if (method === 'GET' && (path === '/app' || path.startsWith('/app/'))) {
        return sendStatic(res, readStaticFile(staticRoots?.publicRoot, path.replace(/^\/app\/?/, '')))
      }
      if (method === 'GET' && path.startsWith('/src/')) {
        return sendStatic(res, readStaticFile(staticRoots?.srcRoot, path.replace(/^\/src\//, '')))
      }

      // 手机侧端点：/d/<deviceId>/<endpoint>
      const m = /^\/d\/([^/]+)\/(.+)$/.exec(path)
      if (m) {
        const [, deviceId, endpoint] = m
        const auth = String(req.headers.authorization ?? '')
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
        if (!cp.verifyDeviceToken(deviceId, token)) {
          return fail(res, 401, 'UNAUTHORIZED', '令牌缺失、失效或已吊销')
        }
        if (!isAllowed(endpoint, allowlist)) {
          return fail(res, 403, 'ENDPOINT_NOT_ALLOWED', `端点不在白名单：${endpoint}`)
        }
        if (!isOnline(deviceId)) {
          cp.markDeviceOffline(deviceId)
          return fail(res, 409, 'HOST_OFFLINE', '目标 Host 离线', true)
        }
        let body = {}
        try { body = await readBody(req, cfg.maxBodyBytes) } catch (e) {
          return fail(res, 400, 'INVALID_JSON', String(e.message))
        }
        // #5b：客户端 sinceSeq 只作观测记录，服务端不据此替客户端决定补齐起点。
        // Cursor 的主键是 (clientId, sessionId)：拿不到 sessionId 就不记，
        // 不用 endpoint 或 deviceId 冒充会话键（那会让位点落到错误的行上）。
        if (typeof body.sinceSeq === 'number' && body.sessionId) {
          cp.putCursor({ clientId: body.clientId ?? 'anonymous', sessionId: body.sessionId, sinceSeq: body.sinceSeq })
        }
        return bridge(req, res, deviceId, endpoint, body)
      }

      return fail(res, 404, 'ENDPOINT_NOT_ALLOWED', `未知路径：${path}`)
    } catch (error) {
      const code = String(error?.message ?? '')
      if (code === 'BODY_TOO_LARGE') return fail(res, 413, 'INVALID_JSON', '请求体超过 1 MiB')
      if (code === 'INVALID_JSON') return fail(res, 400, 'INVALID_JSON', '请求体不是合法 JSON')
      // 开发期把真实异常打到 stderr，避免通用 500 把根因吞掉
      console.error('[relay] 未处理异常', error)
      return fail(res, 500, 'NO_PROGRESS', '内部错误', true)
    }
  }

  const server = createServer(handler)

  // 两条 upgrade 通道：Host 注册长连、手机事件订阅
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost')

    // 手机侧事件订阅：/d/<deviceId>/events/<sessionId>?token=&sinceSeq=
    // 浏览器 WebSocket 不能设 Authorization 头，所以令牌走 query；不得把它写进日志。
    const sub = /^\/d\/([^/]+)\/events\/([^/]+)$/.exec(url.pathname)
    if (sub) {
      const [, deviceId, sessionId] = sub
      const token = url.searchParams.get('token') ?? ''
      if (!cp.verifyDeviceToken(deviceId, token)) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n')
        return
      }
      if (!isOnline(deviceId)) {
        socket.end('HTTP/1.1 409 Conflict\r\nContent-Length: 0\r\n\r\n')
        return
      }
      const rawSince = url.searchParams.get('sinceSeq')
      const sinceSeq = rawSince === null ? -1 : Number(rawSince)
      let conn = null
      conn = upgradeToWebSocket(req, socket, head, {
        onMessage() { /* 手机侧只订阅；上行指令仍走 HTTP（白名单见 04 §7） */ },
        onClose() { if (conn) state.hub.unsubscribe(conn) },
      })
      if (!conn) { socket.destroy(); return }
      state.hub.subscribe(sessionId, Number.isInteger(sinceSeq) ? sinceSeq : -1, conn)
      return
    }

    // Host 主动长连：/ws/host → 注册帧 → 帧保序双向透传
    if (url.pathname !== '/ws/host') { socket.destroy(); return }

    let deviceId = null
    const conn = upgradeToWebSocket(req, socket, head, {
      onMessage(text) {
        if (deviceId === null) {
          let msg
          try { msg = JSON.parse(text) } catch { return conn.close(1003, 'invalid json') }
          if (msg.t !== 'host/register') return conn.close(1008, 'register first')
          if (cfg.hostToken && msg.hostToken !== cfg.hostToken) return conn.close(1008, 'bad host token')
          if (!msg.deviceId) return conn.close(1008, 'deviceId required')
          deviceId = String(msg.deviceId)
          const prev = cp.getDevice(deviceId)
          if (prev?.tombstone) return conn.close(1008, 'device revoked')
          state.sockets.set(deviceId, conn)
          cp.upsertDevice({
            deviceId,
            state: 'online',
            lastSeenAt: now(),
            capabilities: msg.caps ?? [],
          })
          return conn.sendJson({ t: 'host/registered', deviceId, protocol: PROTOCOL })
        }
        return handleHostFrame(deviceId, text, conn)
      },
      onClose() {
        if (deviceId === null) return
        if (state.sockets.get(deviceId) === conn) state.sockets.delete(deviceId)
        // WS 断开即视为离线，不等 45s 心跳窗口；HTTP 心跳可把状态再拉回 online
        cp.markDeviceOffline(deviceId)
      },
    })
    if (!conn) socket.destroy()
  })

  const start = (port = 0) => new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve(server.address().port))
  })
  const stop = () => new Promise((resolve) => {
    for (const p of state.pending.values()) clearTimeout(p.timer)
    state.pending.clear()
    state.hub.closeAll()                                    // 手机订阅连接
    for (const conn of state.sockets.values()) conn.close(1001, 'server stopping')
    state.sockets.clear()
    const timer = setTimeout(() => resolve(), 2000)         // 兜底：不被残留连接挂死
    server.closeAllConnections?.()
    server.close(() => { clearTimeout(timer); resolve() })
  })

  return { server, state, cp, start, stop, protocol: PROTOCOL, allowedEndpoints: allowlist, isOnline }
}
