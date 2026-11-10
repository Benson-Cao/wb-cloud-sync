/**
 * P1 W3 · 手机侧 PWA 客户端（纯逻辑核心，零依赖）
 * ---------------------------------------------------------------
 * 职责（docs/03 §3.2 / 05 W3「PWA 骨架」）：
 *   1. 会话列表：`GET /api/sessions?deviceId=`（设备令牌鉴权，W3 期由 Relay 代挂的
 *      CP 读端点，P2 CP 独立成服务后 URL 不变）；
 *   2. 事件订阅：`WS /d/<deviceId>/events/<sessionId>?token=&sinceSeq=`——
 *      浏览器 WebSocket 不能设 Authorization 头，**令牌只能走 query，绝不写日志**；
 *   3. 重连补拉：断线后按指数退避重连，重连时带上**本地记录的 `lastSeq`**，
 *      由 Relay 按 #5b 口径（客户端 `sinceSeq` 唯一权威）补发 dropped 窗口；
 *   4. 缺口回 Host 补齐：收到 `session/gap` 或 `replay(complete=false)` 时，
 *      走白名单内的 `POST /d/<deviceId>/session/follow` 桥到 Host 的只读回放
 *      适配器（`p1/host-plugin/src/replay.js`），拿回连续前缀后再重订阅续实时流。
 *
 * 铁律：
 *   - **连续 `seq` 是唯一游标**（ADR-004）；`ev.seq <= lastSeq` 的帧幂等丢弃，
 *     不重复回调 `onEvent`；
 *   - 本客户端**只读会话、只收事件、只发白名单内的补齐请求**，不做任何
 *     置顶 / 调序写操作（协议 §4：手机端对 SessionIndex 403）；
 *   - 所有 I/O 可注入（`fetchImpl` / `WebSocketImpl` / `now`），Node 里也能
 *     对着真 Relay 跑端到端。
 */

const toWsUrl = (base) => String(base)
  .replace(/\/$/, '')
  .replace(/^http:/, 'ws:')
  .replace(/^https:/, 'wss:')

export function createPwaClient({
  baseUrl,
  deviceId,
  token,
  clientId = 'pwa',
  fetchImpl = globalThis.fetch,
  WebSocketImpl = globalThis.WebSocket,
  now = () => Date.now(),
  reconnectBaseMs = 500,
  reconnectMaxMs = 15_000,
  refillPageSize = 500,
  onEvent = null,        // ({ sessionId, ev, source }) source: 'live' | 'replay'
  onNotice = null,       // ({ type, sessionId, ... })  gap / replay / reconnect / refill-failed / sessions
  onStateChange = null,  // (snapshot) => void
} = {}) {
  if (!baseUrl || !deviceId || !token) {
    throw new TypeError('createPwaClient 需要 baseUrl / deviceId / token')
  }
  if (typeof fetchImpl !== 'function' || typeof WebSocketImpl !== 'function') {
    throw new TypeError('fetchImpl / WebSocketImpl 必须是函数')
  }

  const base = String(baseUrl).replace(/\/$/, '')
  const sessions = new Map()   // sessionId -> 会话索引行（最近一次刷新的缓存）
  const follows = new Map()    // sessionId -> 订阅记录
  let stopped = false

  const notify = (notice) => { try { onNotice?.(notice) } catch { /* 回调异常不影响客户端 */ } }
  const emitState = () => { try { onStateChange?.(snapshot()) } catch { /* 同上 */ } }

  const authHeaders = () => ({ Authorization: `Bearer ${token}` })

  /* -------------------------------------------------------- 会话列表 */

  const refreshSessions = async () => {
    const r = await fetchImpl(`${base}/api/sessions?deviceId=${encodeURIComponent(deviceId)}`, {
      headers: authHeaders(),
    })
    const payload = await r.json().catch(() => null)
    if (!r.ok || payload?.ok !== true) {
      const code = payload?.error?.code ?? `HTTP_${r.status}`
      throw Object.assign(new Error(`会话列表获取失败：${code}`), { code })
    }
    sessions.clear()
    for (const row of payload.data?.rows ?? []) sessions.set(row.sessionId, row)
    notify({ type: 'sessions', rows: [...sessions.values()] })
    emitState()
    return [...sessions.values()]
  }

  /* ---------------------------------------------------------- 补齐 */

  /**
   * 缺口回 Host 补齐：桥接 `session/follow` → Host 只读回放。
   * 只接受 `ev.seq === lastSeq + 1` 的连续前缀；`hasMore` 分页循环，其余情况
   * （硬缺口）如实停在 `gap`，绝不跳跃式消费。
   * `replay(complete=false)` 与 `session/gap` 往往背靠背到达，会各自触发一次
   * 补齐——`refilling` 守卫保证同一会话同一时刻只有一个补齐在跑。
   */
  const refill = async (rec) => {
    if (rec.refilling) return
    rec.refilling = true
    try { await refillRun(rec) } finally { rec.refilling = false }
  }

  const refillRun = async (rec) => {
    for (let attempt = 0; attempt < 8; attempt++) {
      if (stopped || rec.status === 'closed') return
      rec.status = 'refilling'
      emitState()
      let payload = null
      try {
        const r = await fetchImpl(
          `${base}/d/${encodeURIComponent(deviceId)}/session/follow`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: JSON.stringify({
              clientId, sessionId: rec.sessionId,
              sinceSeq: rec.lastSeq, pageSize: refillPageSize,
            }),
          },
        )
        payload = await r.json().catch(() => null)
      } catch (error) {
        rec.status = 'gap'
        emitState()
        notify({ type: 'refill-failed', sessionId: rec.sessionId, reason: String(error?.message ?? error) })
        return
      }
      const data = payload?.data
      if (!payload?.ok || !Array.isArray(data?.events)) {
        rec.status = 'gap'
        emitState()
        notify({ type: 'refill-failed', sessionId: rec.sessionId, reason: payload?.error?.code ?? 'UNKNOWN' })
        return
      }
      for (const ev of data.events) {
        if (Number.isInteger(ev?.seq) && ev.seq === rec.lastSeq + 1) {
          rec.lastSeq = ev.seq
          try { onEvent?.({ sessionId: rec.sessionId, ev, source: 'replay' }) } catch { /* 忽略 */ }
        }
        // 不连续的帧直接丢：连续 seq 是唯一游标，跳帧等于撕裂视图
      }
      if (!data.hasMore) {
        if (data.complete === false) {
          // Host 日志本身有缺口：如实停住，让上层决定重试还是提示用户
          rec.status = 'gap'
          rec.expectedSeq = data.expectedSeq ?? rec.lastSeq + 1
          emitState()
          notify({ type: 'refill-failed', sessionId: rec.sessionId, reason: 'HISTORY_GAP', expectedSeq: rec.expectedSeq })
          return
        }
        // 补齐完成：先关旧订阅连接（gap 时它还挂在服务端的订阅集合里），
        // 再重订阅续实时流。旧连接不关会双连接重复推送（虽然幂等丢弃，但浪费）。
        closeSocket(rec, 1000, 'refill done')
        rec.status = 'connecting'
        emitState()
        connect(rec)
        return
      }
      // hasMore：带着新 lastSeq 翻下一页
    }
    // 翻页超限：放弃本次补齐，停在 gap（不静默跳过）
    rec.status = 'gap'
    emitState()
    notify({ type: 'refill-failed', sessionId: rec.sessionId, reason: 'REFILL_LIMIT' })
  }

  /* -------------------------------------------------------- 订阅 */

  /** 主动关闭：置 closing 标记，close 事件里据此不再安排重连。 */
  const closeSocket = (rec, code, reason) => {
    if (!rec.ws) return
    rec.closing = true
    try { rec.ws.close(code, reason) } catch { /* 已关闭 */ }
    rec.ws = null
  }

  const scheduleReconnect = (rec) => {
    if (stopped || rec.status === 'closed') return
    const delay = Math.min(reconnectMaxMs, reconnectBaseMs * 2 ** Math.min(rec.attempts, 6))
    rec.attempts++
    rec.status = 'reconnecting'
    rec.nextAttemptAt = now() + delay
    emitState()
    rec.reconnectTimer = setTimeout(() => {
      rec.reconnectTimer = null
      connect(rec)
    }, delay)
  }

  const connect = (rec) => {
    if (stopped || rec.status === 'closed') return
    let ws
    try {
      // token 走 query 是浏览器 WS 的无奈之举（不能设 Authorization 头）；
      // 该 URL 只进内存，不进任何日志。
      ws = new WebSocketImpl(
        `${toWsUrl(base)}/d/${encodeURIComponent(deviceId)}/events/${encodeURIComponent(rec.sessionId)}`
        + `?token=${encodeURIComponent(token)}&sinceSeq=${rec.lastSeq}`,
      )
    } catch {
      scheduleReconnect(rec)
      return
    }
    rec.ws = ws

    ws.addEventListener('message', (event) => {
      let msg
      try { msg = JSON.parse(String(event.data)) } catch { return }
      if (msg.t === 'session/event') {
        const ev = msg.ev
        if (!Number.isInteger(ev?.seq) || ev.seq <= rec.lastSeq) return   // 幂等丢弃
        if (ev.seq > rec.lastSeq + 1) {
          // 实时流不该跳帧；真发生了就当作缺口处理，不冒险继续渲染
          rec.expectedSeq = rec.lastSeq + 1
          rec.status = 'gap'
          emitState()
          notify({ type: 'gap', sessionId: rec.sessionId, expectedSeq: rec.expectedSeq })
          void refill(rec)
          return
        }
        rec.lastSeq = ev.seq
        rec.attempts = 0
        if (rec.status !== 'following') { rec.status = 'following'; emitState() }
        try { onEvent?.({ sessionId: rec.sessionId, ev, source: 'live' }) } catch { /* 忽略 */ }
        return
      }
      if (msg.t === 'session/replay') {
        notify({ type: 'replay', sessionId: rec.sessionId, fromSeq: msg.fromSeq, toSeq: msg.toSeq, complete: msg.complete })
        if (msg.complete === false && rec.status !== 'gap') {
          rec.status = 'gap'
          rec.expectedSeq = msg.toSeq + 1
          emitState()
          void refill(rec)
        }
        return
      }
      if (msg.t === 'session/gap') {
        rec.expectedSeq = msg.expectedSeq
        rec.status = 'gap'
        emitState()
        notify({ type: 'gap', sessionId: rec.sessionId, expectedSeq: msg.expectedSeq })
        void refill(rec)
      }
    })
    ws.addEventListener('close', () => {
      if (rec.ws === ws) rec.ws = null
      if (rec.closing) { rec.closing = false; return }   // 主动关闭（补齐换连 / 停止），不重连
      scheduleReconnect(rec)
    })
    ws.addEventListener('error', () => { /* close 紧随其后 */ })
  }

  /** 订阅一个会话；`sinceSeq` 缺省 -1 表示从头开始。重复 follow 先关旧连接。 */
  const follow = (sessionId, { sinceSeq = -1 } = {}) => {
    const prev = follows.get(sessionId)
    if (prev) unfollow(sessionId)
    const rec = {
      sessionId,
      lastSeq: Number.isSafeInteger(sinceSeq) ? sinceSeq : -1,
      status: 'connecting',
      attempts: 0,
      expectedSeq: null,
      ws: null,
      closing: false,
      refilling: false,
      reconnectTimer: null,
      nextAttemptAt: null,
    }
    follows.set(sessionId, rec)
    connect(rec)
    emitState()
    return rec
  }

  const unfollow = (sessionId) => {
    const rec = follows.get(sessionId)
    if (!rec) return
    rec.status = 'closed'
    if (rec.reconnectTimer) { clearTimeout(rec.reconnectTimer); rec.reconnectTimer = null }
    closeSocket(rec, 1000, 'client unfollow')
    follows.delete(sessionId)
    emitState()
  }

  const stop = () => {
    stopped = true
    for (const sessionId of [...follows.keys()]) unfollow(sessionId)
  }

  /* ---------------------------------------------------------- 新建会话 */

  /**
   * 新建会话：`POST /api/sessions`（协议 §4）。Relay 桥接 Host 的
   * `session/create` 适配器；Host 未注入适配器 → 409 `WRITER_UNAVAILABLE`，
   * Host 离线 → 409 `HOST_OFFLINE`（retryable）。创建成功即调
   * `refreshSessions()` 让列表立刻可见（Relay 已把引导行写进 CP）。
   */
  const createSession = async ({ text = '', cwd = null } = {}) => {
    const r = await fetchImpl(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      // deviceId 必须显式带上：令牌按 Host 设备登记，Relay 要用它定位校验对象
      body: JSON.stringify({ clientId, deviceId, text, cwd }),
    })
    const payload = await r.json().catch(() => null)
    if (!r.ok || payload?.ok !== true) {
      const code = payload?.error?.code ?? `HTTP_${r.status}`
      throw Object.assign(new Error(`新建会话失败：${code}`), { code })
    }
    await refreshSessions()
    return payload.data   // { sessionId, ... }
  }

  const snapshot = () => ({
    deviceId,
    stopped,
    sessions: [...sessions.values()],
    follows: [...follows.values()].map((r) => ({
      sessionId: r.sessionId,
      lastSeq: r.lastSeq,
      status: r.status,
      attempts: r.attempts,
      expectedSeq: r.expectedSeq,
      connected: Boolean(r.ws),
      nextAttemptAt: r.nextAttemptAt,
    })),
  })

  return { refreshSessions, createSession, follow, unfollow, stop, snapshot, getSession: (id) => sessions.get(id) ?? null }
}
