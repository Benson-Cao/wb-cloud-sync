/**
 * P1 W3 · DSH Host 侧插件骨架
 * ---------------------------------------------------------------
 * 职责（docs/03 §3.1）：
 *   1. 主动 WSS 外连 Relay，发 `host/register` / 心跳；
 *   2. 订阅宿主 `session/event`，把事件原样（含 `seq`）上行；
 *   3. 处理 Relay 下行 `http/request`：`session/prompt` / `session/cancel` /
 *      `session/follow` 分派给适配器，结果回 `http/response`；
 *   4. 注册本地具名路由 `/__wbsync/status`、`/__wbsync/pair`；
 *   5. 所有注册与定时器交 `ctx.effect`，卸载即撤回。
 *
 * 铁律（ADR-008 / 03 §3.1）：**绝不 `open(id,'write')`**。手机投递必须走宿主
 * 的提交入口（P0 Spike Q2 已取证 `dsh-api-session-controller.prompt(request)`），
 * 本骨架把它抽象成可注入的 `submitPrompt` 适配器；未注入时明确回
 * `WRITER_UNAVAILABLE`，不自行追加日志。
 *
 * 适配器注入（正式版从 ctx 取，骨架期由调用方给）：
 *   submitPrompt({sessionId, text, clientMsgId}) -> {ok, value?, code?, message?}
 *   cancelTurn({sessionId})                     -> 同上
 *   replay({sessionId, sinceSeq})               -> 同上（历史补齐，见 src/replay.js）
 */
import { createReplayAdapter } from './replay.js'

export const name = 'wbsync-host-dev'
export const inject = ['webServer', 'sessionPersistence']

const PROTOCOL = 'wbsync/1'
const DEFAULTS = {
  relayUrl: '',
  hostToken: '',
  deviceId: '',
  autoConnect: true,
  reconnectBaseMs: 500,
  reconnectMaxMs: 15_000,
  heartbeatMs: 15_000,
  caps: ['attachments', 'artifacts', 'schedule', 'approval'],
}

const json = (res, status, payload) => {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'X-Protocol-Version': PROTOCOL,
  })
  res.end(body)
}
const okBody = (data) => ({ ok: true, data, protocol: PROTOCOL })
const errBody = (code, message, retryable = false) =>
  ({ ok: false, error: { code, message, retryable }, protocol: PROTOCOL })

/** 适配器失败码 → HTTP 状态：不可读是 404，能力缺失是 501，其余按冲突处理。 */
const STATUS_BY_CODE = {
  SESSION_UNREADABLE: 404,
  NOT_AVAILABLE: 501,
  WRITER_UNAVAILABLE: 409,
}
const unwrap = (r, fallback = {}) => (r?.ok === false
  ? {
    status: STATUS_BY_CODE[r.code] ?? 409,
    body: errBody(r.code ?? 'SESSION_BUSY', r.message ?? '适配器拒绝', false),
  }
  : { status: 200, body: okBody(r?.value ?? fallback) })

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...config }
  const state = {
    ws: null,
    connected: false,
    stopped: false,
    attempts: 0,
    forwarded: 0,
    dropped: 0,
    downlinks: 0,
    reconnects: 0,
    lastSeq: new Map(),
    reconnectTimer: null,
    heartbeatTimer: null,
  }

  /**
   * 回放句柄来源：优先用调用方注入的 `openSession`（便于测试与接管），否则绑宿主的
   * `sessionPersistence.open(id,'read')`——**只读句柄**，绝不请求写权限。
   * 拿不到就没有回放能力，明确回 `NOT_AVAILABLE`，不假装补齐成功。
   */
  const openSession = typeof cfg.openSession === 'function'
    ? cfg.openSession
    : (ctx.sessionPersistence?.open
      ? (id) => ctx.sessionPersistence.open(id, 'read')
      : null)

  const adapters = {
    submitPrompt: cfg.submitPrompt ?? (async () => ({
      ok: false, code: 'WRITER_UNAVAILABLE',
      message: '未注入 submitPrompt 适配器；真机需接宿主 prompt 入口（不得自开写句柄）',
    })),
    cancelTurn: cfg.cancelTurn ?? (async () => ({
      ok: false, code: 'WRITER_UNAVAILABLE', message: '未注入 cancelTurn 适配器',
    })),
    replay: cfg.replay ?? (openSession
      ? createReplayAdapter({ openSession, pageSize: cfg.replayPageSize })
      : async () => ({
        ok: false, code: 'NOT_AVAILABLE',
        message: '没有可用的只读句柄（未注入 sessionPersistence / openSession）',
      })),
  }

  const send = (frame) => {
    if (state.ws?.readyState !== 1) return false
    state.ws.send(JSON.stringify(frame))
    return true
  }

  /** relayUrl 用 http(s) base（本地配对路由要用 fetch），WS 由协议前缀派生。 */
  const toWsUrl = (base) => String(base)
    .replace(/\/$/, '')
    .replace(/^http:/, 'ws:')
    .replace(/^https:/, 'wss:')

  /** 上行：事件原样转发，`seq` 不改不重排。未连接时丢弃并计数，靠 follow 补齐。 */
  const forwardEvent = (session, ev) => {
    const sessionId = session?.header?.id
    if (!sessionId) return
    if (typeof ev?.seq === 'number') {
      state.lastSeq.set(sessionId, Math.max(state.lastSeq.get(sessionId) ?? -1, ev.seq))
    }
    if (send({ t: 'session/event', sessionId, ev })) state.forwarded++
    else state.dropped++
  }

  const handleDownlink = async (frame) => {
    state.downlinks++
    const { reqId, endpoint, body } = frame
    if (!reqId) return
    try {
      if (endpoint === 'session/prompt') {
        const r = await adapters.submitPrompt({
          sessionId: body?.sessionId, text: body?.text, clientMsgId: body?.clientMsgId,
        })
        const { status, body: payload } = unwrap(r, { accepted: true })
        return send({ t: 'http/response', reqId, status, body: payload })
      }
      if (endpoint === 'session/cancel') {
        const r = await adapters.cancelTurn({ sessionId: body?.sessionId })
        const { status, body: payload } = unwrap(r, { cancelled: true })
        return send({ t: 'http/response', reqId, status, body: payload })
      }
      if (endpoint === 'session/follow') {
        const r = await adapters.replay({ sessionId: body?.sessionId, sinceSeq: body?.sinceSeq })
        const { status, body: payload } = unwrap(r, { events: [] })
        return send({ t: 'http/response', reqId, status, body: payload })
      }
      return send({
        t: 'http/response', reqId, status: 403,
        body: errBody('ENDPOINT_NOT_ALLOWED', `端点不在白名单：${endpoint}`),
      })
    } catch (error) {
      return send({
        t: 'http/response', reqId, status: 500,
        body: errBody('NO_PROGRESS', `Host 处理异常：${error?.message ?? 'unknown'}`, true),
      })
    }
  }

  const stopHeartbeat = () => {
    if (state.heartbeatTimer) { clearInterval(state.heartbeatTimer); state.heartbeatTimer = null }
  }
  const startHeartbeat = () => {
    stopHeartbeat()
    state.heartbeatTimer = setInterval(() => send({ t: 'host/heartbeat', ts: Date.now() }), cfg.heartbeatMs)
  }

  const scheduleReconnect = () => {
    if (state.stopped || !cfg.relayUrl) return
    const delay = Math.min(cfg.reconnectMaxMs, cfg.reconnectBaseMs * 2 ** Math.min(state.attempts, 6))
    state.attempts++
    state.reconnects++
    state.reconnectTimer = setTimeout(() => { state.reconnectTimer = null; connect() }, delay)
  }

  const connect = () => {
    if (state.stopped || !cfg.relayUrl || !cfg.deviceId) return
    let ws
    try { ws = new WebSocket(`${toWsUrl(cfg.relayUrl)}/ws/host`) }
    catch { return scheduleReconnect() }
    state.ws = ws

    ws.addEventListener('open', () => {
      state.attempts = 0
      send({
        t: 'host/register', deviceId: cfg.deviceId, protocol: PROTOCOL,
        caps: cfg.caps, hostToken: cfg.hostToken,
      })
    })
    ws.addEventListener('message', (event) => {
      let msg
      try { msg = JSON.parse(String(event.data)) } catch { return }
      if (msg.t === 'host/registered') { state.connected = true; startHeartbeat(); return }
      if (msg.t === 'http/request') { void handleDownlink(msg); return }
    })
    ws.addEventListener('close', () => {
      state.connected = false
      stopHeartbeat()
      if (state.ws === ws) state.ws = null
      scheduleReconnect()
    })
    ws.addEventListener('error', () => { /* close 紧随其后 */ })
  }

  /** 本地路由：状态与配对码（配对码由 Relay/CP 登记，插件只代理一次 HTTP 调用）。 */
  const registerRoutes = () => {
    const disposers = []
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/__wbsync/status',
      handler: (req, res) => {
        json(res, 200, okBody({
          connected: state.connected,
          deviceId: cfg.deviceId || null,
          relayConfigured: Boolean(cfg.relayUrl),
          forwarded: state.forwarded,
          dropped: state.dropped,
          downlinks: state.downlinks,
          reconnects: state.reconnects,
          replayReady: Boolean(openSession),
          lastSeq: Object.fromEntries(state.lastSeq),
          protocol: PROTOCOL,
        }))
      },
    }))
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/__wbsync/pair',
      handler: async (req, res) => {
        if ((req.method ?? 'GET') !== 'POST') {
          return json(res, 405, errBody('ENDPOINT_NOT_ALLOWED', '仅支持 POST'))
        }
        if (!cfg.relayUrl) return json(res, 409, errBody('NO_PROGRESS', '未配置 relayUrl', true))
        try {
          const r = await fetch(`${cfg.relayUrl.replace(/\/$/, '')}/pair/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceId: cfg.deviceId }),
          })
          const payload = await r.json()
          return json(res, r.status, payload)
        } catch (error) {
          return json(res, 502, errBody('NO_PROGRESS', `Relay 不可达：${error?.message ?? ''}`, true))
        }
      },
    }))
    return disposers
  }

  ctx.effect(() => {
    // 宿主事件订阅：首参是 session 对象，sessionId 取 session.header.id（P0 实测）
    const offEvent = ctx.on('session/event', forwardEvent)
    const disposeRoutes = registerRoutes()
    if (cfg.autoConnect) connect()

    return () => {
      state.stopped = true
      if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null }
      stopHeartbeat()
      try { state.ws?.close(1000, 'plugin disposed') } catch { /* 已关闭 */ }
      state.ws = null
      state.connected = false
      offEvent?.()
      for (const dispose of disposeRoutes) dispose?.()
    }
  }, 'wbsync-host: uplink + local routes')

  return { state, adapters, connect }
}
