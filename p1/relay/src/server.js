/**
 * W3 开发骨架 · Relay（零依赖，Node >= 24.9）
 * ---------------------------------------------------------------
 * 范围（05 W3 第一项）：配对、设备注册、心跳与离线判定、白名单、
 * Host 离线立即 409，以及一个 HTTP 轮询桥。
 *
 * 与正式契约的关系：**WS 帧代理尚未实现**。正式设计是 Host 主动 WSS 外连
 * Relay（docs/04 §5.2 / docs/03 §3.3）；本骨架用
 *   GET  /host/poll?deviceId=   （取待转发帧）
 *   POST /host/respond          （回响应）
 * 作为开发期等价物，帧字段与 docs/04 §5.3 一致。W3 下一提交替换为 WSS
 * 时，只替换传输层，配对 / 鉴权 / 白名单 / 离线判定逻辑不变。
 *
 * 四项 P1 前置按 SIGNOFF-WAIVER.md §5 的**默认口径**实现（未经会签）：
 *   #2 pairSecret = per-challenge 一次性随机数，不落盘、不参与令牌派生；
 *   #3 单机期 Relay 内存表为活跃令牌与在线状态权威；
 *   #4 只开放 session/* 与 $events/*，其余端点默认拒绝；
 *   #5b 客户端 sinceSeq 唯一权威，服务端 Cursor 仅作可观测性快照。
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'

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

const sha256 = (s) => createHash('sha256').update(s).digest('hex')
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a), 'hex')
  const y = Buffer.from(String(b), 'hex')
  return x.length === y.length && timingSafeEqual(x, y)
}
const isAllowed = (endpoint, allowlist = ALLOWED_ENDPOINTS) =>
  allowlist.some((rule) => rule.endsWith('/*')
    ? endpoint.startsWith(rule.slice(0, -1))
    : endpoint === rule)

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

  const state = {
    codes: new Map(),        // code -> { deviceId, expiresAt }
    challenges: new Map(),   // challenge -> { code, deviceId, pairSecret, expiresAt }
    devices: new Map(),      // deviceId -> { state, lastSeenAt, tokenDigest, tombstone, caps }
    rateHits: new Map(),     // `${deviceId}|${ip}` -> number[] (ms)
    queue: new Map(),        // deviceId -> 待转发的 http/request 帧
    pending: new Map(),      // reqId -> { resolve, timer }
    cursors: new Map(),      // 仅可观测性：clientId -> sinceSeq（不参与补齐决策）
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

  const isOnline = (deviceId) => {
    const d = state.devices.get(deviceId)
    if (!d || d.tombstone) return false
    return now() - d.lastSeenAt <= cfg.heartbeatTimeoutMs
  }

  /** 手机侧 /d/<id>/<endpoint> 请求 → 帧 → 等待 Host 响应。 */
  const bridge = (req, res, deviceId, endpoint, body) => {
    const reqId = hex(16)
    const frame = { t: 'http/request', reqId, method: req.method, endpoint, body, sinceSeq: body?.sinceSeq ?? null }
    const frames = state.queue.get(deviceId) ?? []
    frames.push(frame)
    state.queue.set(deviceId, frames)

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
      },
      timer,
    })
  }

  const handler = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname
    const method = req.method ?? 'GET'
    const ip = req.socket?.remoteAddress ?? 'unknown'

    try {
      if (method === 'GET' && path === '/health') {
        return ok(res, { protocol: PROTOCOL, online: [...state.devices.keys()].filter(isOnline).length })
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
        const prev = state.devices.get(c.deviceId)
        // 单活跃令牌：重新配对作废旧令牌；墓碑设备不复活
        if (prev?.tombstone) return fail(res, 401, 'UNAUTHORIZED', '设备已吊销')
        state.devices.set(c.deviceId, {
          state: 'online',
          lastSeenAt: now(),
          tokenDigest: sha256(deviceToken),
          tombstone: false,
          caps: prev?.caps ?? [],
        })
        return ok(res, { deviceToken, protocol: PROTOCOL, relayUrl: cfg.publicBaseUrl ?? 'http://127.0.0.1' })
      }

      // Host 注册 / 心跳（开发期 HTTP 模拟 WS 帧）
      if (method === 'POST' && path === '/host/register') {
        const body = await readBody(req, cfg.maxBodyBytes)
        if (cfg.hostToken && body.hostToken !== cfg.hostToken) return fail(res, 401, 'UNAUTHORIZED', 'HOST_TOKEN 不匹配')
        const prev = state.devices.get(body.deviceId)
        if (prev?.tombstone) return fail(res, 401, 'UNAUTHORIZED', '设备已吊销')
        state.devices.set(body.deviceId, {
          state: 'online', lastSeenAt: now(),
          tokenDigest: prev?.tokenDigest ?? null, tombstone: false,
          caps: body.caps ?? [],
        })
        return ok(res, { deviceId: body.deviceId, protocol: PROTOCOL })
      }
      if (method === 'POST' && path === '/host/heartbeat') {
        const body = await readBody(req, cfg.maxBodyBytes)
        const d = state.devices.get(body.deviceId)
        if (!d || d.tombstone) return fail(res, 409, 'HOST_OFFLINE', '设备未注册或已吊销', true)
        d.lastSeenAt = now()
        d.state = 'online'
        return ok(res, { deviceId: body.deviceId, lastSeenAt: d.lastSeenAt })
      }

      // 轮询桥：Host 取待转发帧 / 回响应
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
        const rows = [...state.devices.entries()].map(([deviceId, d]) => ({
          deviceId, state: isOnline(deviceId) ? 'online' : 'offline',
          lastSeenAt: d.lastSeenAt, tokenDigest: d.tokenDigest, tombstone: d.tombstone,
        }))
        return ok(res, { rows })
      }

      // 手机侧端点：/d/<deviceId>/<endpoint>
      const m = /^\/d\/([^/]+)\/(.+)$/.exec(path)
      if (m) {
        const [, deviceId, endpoint] = m
        const auth = String(req.headers.authorization ?? '')
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
        const d = state.devices.get(deviceId)
        if (!d || d.tombstone || !d.tokenDigest || !safeEqual(sha256(token), d.tokenDigest)) {
          return fail(res, 401, 'UNAUTHORIZED', '令牌缺失、失效或已吊销')
        }
        if (!isAllowed(endpoint, allowlist)) {
          return fail(res, 403, 'ENDPOINT_NOT_ALLOWED', `端点不在白名单：${endpoint}`)
        }
        if (!isOnline(deviceId)) {
          d.state = 'offline'
          return fail(res, 409, 'HOST_OFFLINE', '目标 Host 离线', true)
        }
        let body = {}
        try { body = await readBody(req, cfg.maxBodyBytes) } catch (e) {
          return fail(res, 400, 'INVALID_JSON', String(e.message))
        }
        // #5b：客户端 sinceSeq 只作观测记录，服务端不据此替客户端决定补齐起点
        if (typeof body.sinceSeq === 'number') {
          state.cursors.set(`${body.clientId ?? 'anonymous'}|${deviceId}`, body.sinceSeq)
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
  const start = (port = 0) => new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve(server.address().port))
  })
  const stop = () => new Promise((resolve) => {
    for (const p of state.pending.values()) clearTimeout(p.timer)
    state.pending.clear()
    server.close(() => resolve())
  })

  return { server, state, start, stop, protocol: PROTOCOL, allowedEndpoints: allowlist, isOnline }
}
