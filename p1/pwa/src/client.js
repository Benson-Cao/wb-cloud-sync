/**
 * P1 W3 · 手机侧 PWA 客户端（纯逻辑核心，零依赖）
 * ---------------------------------------------------------------
 * 职责（docs/03 §3.2 / 05 W3「PWA 骨架」）：
 *   1. 会话列表：`GET /api/sessions?hostId=`（设备令牌鉴权，W3 期由 Relay 代挂的
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

/** File / Blob → 标准 base64（分块转二进制串，避免大文件展开参数爆栈）。 */
const fileToBase64 = async (file) => {
  const buf = new Uint8Array(await file.arrayBuffer())
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < buf.length; i += CHUNK) {
    bin += String.fromCharCode(...buf.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

/** 客户端消息幂等键：宿主用它去重，重发同一 clientMsgId 只落一条。 */
const makeClientMsgId = () =>
  globalThis.crypto?.randomUUID?.() ?? `c-${Date.now()}-${Math.random().toString(36).slice(2)}`

export function createPwaClient({
  baseUrl,
  deviceId,
  // v2.3（r22）：当前执行位置。命名迁移期 hostId 与 deviceId 同值；列表响应会
  // 回权威 hostId（r17），之后的写操作路径以它为准。缺省回落 deviceId。
  hostId = null,
  token,
  clientId = 'pwa',
  fetchImpl = globalThis.fetch,
  WebSocketImpl = globalThis.WebSocket,
  now = () => Date.now(),
  reconnectBaseMs = 500,
  reconnectMaxMs = 15_000,
  refillPageSize = 500,
  // Host 按 ≤48 KiB/页 裁帧（真机大正文会话一页只有几条），874 条会话需要上百页。
  // 旧上限 8 会让补齐在 REFILL_LIMIT 处停下；这里放宽并保留「无进展即停」的兜底。
  maxRefillPages = 200,
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
  // r22：写操作路径段的 hostId。初次缺省 deviceId（值兼容），refreshSessions
  // 拿到服务端权威值后同步；服务端切换器重绑后不会仍拿旧主机段去写。
  let activeHostId = hostId ?? deviceId
  const sessions = new Map()   // sessionId -> 会话索引行（最近一次刷新的缓存）
  const follows = new Map()    // sessionId -> 订阅记录
  // 这台电脑的在线状态（W7 状态点）：null = 还没探过，别画成离线
  let hostStatus = { deviceId, online: null, lastSeenAt: null }
  // r20（S-6.9 切换语义）：令牌有效但服务端绑定已换到另一台主机（409 HOST_MISMATCH）。
  // 置位后由 UI 提示用户切到对应档案；成功刷新即复位。
  let hostMismatch = false
  let stopped = false

  const notify = (notice) => { try { onNotice?.(notice) } catch { /* 回调异常不影响客户端 */ } }
  const emitState = () => { try { onStateChange?.(snapshot()) } catch { /* 同上 */ } }

  const authHeaders = () => ({ Authorization: `Bearer ${token}` })

  /* -------------------------------------------------------- 会话列表 */

  const refreshSessions = async () => {
    // r22：正式参数名 hostId=（r17）；deviceId= 兼容期仍被服务端接受，但客户端
    // 用正式名，避免「服务端已迁移、客户端还发旧名」的命名漂移。
    const r = await fetchImpl(`${base}/api/sessions?hostId=${encodeURIComponent(activeHostId)}`, {
      headers: authHeaders(),
    })
    const payload = await r.json().catch(() => null)
    if (!r.ok || payload?.ok !== true) {
      const code = payload?.error?.code ?? `HTTP_${r.status}`
      // r20（S-6.9 切换语义）：令牌有效但服务端绑定已换到另一台主机——不是 401 也
      // 不是网络错误，提示用户切档案；只通知一次，避免重连风暴刷屏。
      if (code === 'HOST_MISMATCH' && !hostMismatch) {
        hostMismatch = true
        emitState()
        notify({ type: 'host-mismatch', deviceId })
      }
      throw Object.assign(new Error(`会话列表获取失败：${code}`), { code })
    }
    hostMismatch = false
    // r22：服务端回的 hostId 是权威值（r17），写操作路径段以它为准。注意 PWA
    // 沿用 r9 的「多令牌档案切换」世界观——服务端切换器重绑不在这里自动跟随，
    // 那种场景由 r20 的 409 HOST_MISMATCH 兜底提示用户切档案。
    if (typeof payload.data?.hostId === 'string' && payload.data.hostId.trim()) {
      activeHostId = payload.data.hostId.trim()
    }
    sessions.clear()
    for (const row of payload.data?.rows ?? []) sessions.set(row.sessionId, row)
    // 状态点靠这一句更新：sessions 响应里带 host.online（协议 r10）
    if (payload.data?.host) {
      hostStatus = { ...hostStatus, ...payload.data.host }
      notify({ type: 'host', ...hostStatus })
    }
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
    for (let attempt = 0; attempt < Math.max(1, maxRefillPages); attempt++) {
      const beforeSeq = rec.lastSeq
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
      // hasMore：带着新 lastSeq 翻下一页。若 Host 说还有更多但这一页一条都没推进，
      // 立刻停住——否则 200 次循环会把 Relay 打一圈而游标原地不动。
      if (rec.lastSeq === beforeSeq) {
        rec.status = 'gap'
        emitState()
        notify({ type: 'refill-failed', sessionId: rec.sessionId, reason: 'NO_PROGRESS' })
        return
      }
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

    ws.addEventListener('open', () => {
      if (rec.ws !== ws || stopped || rec.status === 'closed') return
      // WS 握手成功即已订阅：冷会话没有新事件时，不能一直停在 connecting。
      // gap/refilling 状态由补齐流程自行收敛，这里不覆盖。
      if (rec.status === 'connecting' || rec.status === 'reconnecting') {
        rec.status = 'following'
        emitState()
      }
    })

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
        // Relay 缓冲里一条都没有（刚重启过就是这样）：complete:true 只说明「从你的位置往后
        // 没有缺口」，不等于「这段历史不存在」。必须去 Host 日志补一次——否则打开老会话是白屏，
        // 而 Host 明明有几百条事件。只补一次：补齐后会重新订阅，不设限会来回循环。
        if (msg.complete === true && msg.toSeq === -1 && !rec.bootstrapped) {
          rec.bootstrapped = true
          void refill(rec)
          return
        }
        if (msg.complete === false && rec.status !== 'gap') {
          rec.status = 'gap'
          rec.expectedSeq = msg.toSeq + 1
          emitState()
          void refill(rec)
        }
        return
      }
      // 审批推送：设备级广播，可能落在任意一条已订阅连接上；与事件游标无关，不碰 lastSeq
      if (msg.t === 'approval/request') {
        notify({
          type: 'approval', approvalId: msg.approvalId, sessionId: msg.sessionId ?? null,
          toolName: msg.toolName ?? 'unknown', reason: msg.reason ?? null, expiresAt: msg.expiresAt ?? null,
        })
        return
      }
      if (msg.t === 'approval/resolved') {
        notify({ type: 'approval-resolved', approvalId: msg.approvalId, outcome: msg.outcome ?? 'cancelled', by: msg.by ?? null })
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
      // 已经为「打开时 Relay 缓冲为空」去 Host 补过一次；只补一次，避免补齐后重订阅再触发
      bootstrapped: false,
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
      // 宿主适配器的 message 会经 Host http/response → Relay bridge 原样带回。
      // 真机排障全靠它（0.1.4 只显示 code，HOST_ADAPTER_ERROR 看不出根因）。
      const detail = typeof payload?.error?.message === 'string' ? payload.error.message : ''
      throw Object.assign(
        new Error(`新建会话失败：${code}${detail && detail !== code ? ` · ${detail}` : ''}`),
        { code, detail },
      )
    }
    await refreshSessions()
    return payload.data   // { sessionId, ... }
  }

  /**
   * 取消某会话当前正在运行的轮次：`POST /d/<deviceId>/session/cancel`
   * （白名单 `session/*`）。只请求宿主中断，不自行删事件、不关连接。
   */
  const cancelTurn = async ({ sessionId } = {}) => {
    if (!sessionId) {
      throw Object.assign(new Error('取消轮次缺 sessionId'), { code: 'INVALID_ARGUMENT' })
    }
    const r = await fetchImpl(`${base}/d/${encodeURIComponent(deviceId)}/session/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ clientId, sessionId }),
    })
    const payload = await r.json().catch(() => null)
    if (!r.ok || payload?.ok !== true) {
      const code = payload?.error?.code ?? `HTTP_${r.status}`
      const detail = typeof payload?.error?.message === 'string' ? payload.error.message : ''
      throw Object.assign(
        new Error(`取消失败：${code}${detail && detail !== code ? ` · ${detail}` : ''}`),
        { code, detail },
      )
    }
    return payload.data
  }

  /**
   * 置顶 / 取消置顶（r11，r22 路径形态）：`PATCH /api/sessions/:hostId/:id { pinned }`。
   * hostId 走路径段（r21 服务端路径优先）；body 里的 deviceId 只是兼容期冗余字段。
   * 返回宿主给的最新行；**排序（pinnedOrder）由宿主权威**（最近置顶在前），
   * 客户端不改序——两端各自维护顺序只会打架。
   */
  const setPinned = async ({ sessionId, pinned = true } = {}) => {
    if (!sessionId) {
      throw Object.assign(new Error('置顶缺 sessionId'), { code: 'INVALID_ARGUMENT' })
    }
    const r = await fetchImpl(`${base}/api/sessions/${encodeURIComponent(activeHostId)}/${encodeURIComponent(sessionId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ deviceId, pinned: Boolean(pinned) }),
    })
    const payload = await r.json().catch(() => null)
    if (!r.ok || payload?.ok !== true) {
      const code = payload?.error?.code ?? `HTTP_${r.status}`
      const detail = typeof payload?.error?.message === 'string' ? payload.error.message : ''
      throw Object.assign(
        new Error(`置顶失败：${code}${detail && detail !== code ? ` · ${detail}` : ''}`),
        { code, detail },
      )
    }
    return payload.data
  }

  /**
   * 归档 / 恢复（r12，r22 路径形态）：`PATCH /api/sessions/:hostId/:id { archived }`。
   * 软移除——只把会话从默认列表藏起来，落盘日志不动，随时能恢复。
   */
  const setArchived = async ({ sessionId, archived = true } = {}) => {
    if (!sessionId) {
      throw Object.assign(new Error('归档缺 sessionId'), { code: 'INVALID_ARGUMENT' })
    }
    const r = await fetchImpl(`${base}/api/sessions/${encodeURIComponent(activeHostId)}/${encodeURIComponent(sessionId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ deviceId, archived: Boolean(archived) }),
    })
    const payload = await r.json().catch(() => null)
    if (!r.ok || payload?.ok !== true) {
      const code = payload?.error?.code ?? `HTTP_${r.status}`
      const detail = typeof payload?.error?.message === 'string' ? payload.error.message : ''
      throw Object.assign(
        new Error(`归档失败：${code}${detail && detail !== code ? ` · ${detail}` : ''}`),
        { code, detail },
      )
    }
    return payload.data
  }

  /** 只查已归档的行（恢复列表用）；不覆盖 refreshSessions 的内部缓存。 */
  const getArchivedSessions = async () => {
    const r = await fetchImpl(`${base}/api/sessions?hostId=${encodeURIComponent(activeHostId)}&archived=true`, {
      headers: authHeaders(),
    })
    const payload = await r.json().catch(() => null)
    if (!r.ok || payload?.ok !== true) {
      const code = payload?.error?.code ?? `HTTP_${r.status}`
      throw Object.assign(new Error(`读取归档失败：${code}`), { code })
    }
    return payload.data?.rows ?? []
  }

  /** 定时任务（W9）：列表 / 创建（N 分钟后）/ 立即运行一次。 */
  const listSchedules = async () => {
    const r = await fetchImpl(`${base}/api/schedules?deviceId=${encodeURIComponent(deviceId)}`, { headers: authHeaders() })
    const payload = await r.json().catch(() => null)
    if (!r.ok || payload?.ok !== true) {
      const code = payload?.error?.code ?? `HTTP_${r.status}`
      throw Object.assign(new Error(`读取定时任务失败：${code}`), { code })
    }
    return payload.data?.rows ?? []
  }

  const createSchedule = async ({ title, prompt, afterSeconds, target = null } = {}) => {
    const r = await fetchImpl(`${base}/api/schedules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ deviceId, title, prompt, afterSeconds, target }),
    })
    const payload = await r.json().catch(() => null)
    if (!r.ok || payload?.ok !== true) {
      const code = payload?.error?.code ?? `HTTP_${r.status}`
      const detail = typeof payload?.error?.message === 'string' ? payload.error.message : ''
      throw Object.assign(new Error(detail || `创建定时任务失败：${code}`), { code })
    }
    return payload.data
  }

  const runSchedule = async ({ id } = {}) => {
    const r = await fetchImpl(`${base}/api/schedules/${encodeURIComponent(id)}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ deviceId }),
    })
    const payload = await r.json().catch(() => null)
    if (!r.ok || payload?.ok !== true) {
      const code = payload?.error?.code ?? `HTTP_${r.status}`
      throw Object.assign(new Error(`运行失败：${code}`), { code })
    }
    return payload.data
  }

  /** 会话改名（M2-10，r22 路径形态）：`PATCH /api/sessions/:hostId/:id { title }`；标题由宿主写事件并权威回传。 */
  const renameSession = async ({ sessionId, title } = {}) => {
    const r = await fetchImpl(`${base}/api/sessions/${encodeURIComponent(activeHostId)}/${encodeURIComponent(sessionId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ deviceId, title }),
    })
    const payload = await r.json().catch(() => null)
    if (!r.ok || payload?.ok !== true) {
      const code = payload?.error?.code ?? `HTTP_${r.status}`
      throw Object.assign(new Error(`改名失败：${code}`), { code })
    }
    return payload.data
  }

  /**
   * 向已有会话发一条消息：文本 + 已上传附件的 receiptId。
   * 走白名单 `session/prompt`；`clientMsgId` 是宿主原生幂等键，重发同一条不会重复落库。
   */
  const submitPrompt = async ({ sessionId, text = '', attachments = [], clientMsgId } = {}) => {
    if (!sessionId) {
      throw Object.assign(new Error('发消息缺 sessionId'), { code: 'INVALID_ARGUMENT' })
    }
    const rid = clientMsgId ?? makeClientMsgId()
    const r = await fetchImpl(`${base}/d/${encodeURIComponent(deviceId)}/session/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ clientId, sessionId, text, attachments, clientMsgId: rid }),
    })
    const payload = await r.json().catch(() => null)
    if (!r.ok || payload?.ok !== true) {
      const code = payload?.error?.code ?? `HTTP_${r.status}`
      const detail = typeof payload?.error?.message === 'string' ? payload.error.message : ''
      throw Object.assign(
        new Error(`发送失败：${code}${detail && detail !== code ? ` · ${detail}` : ''}`),
        { code, detail },
      )
    }
    return payload.data
  }

  /**
   * 附件上行：文件 → base64 → 宿主 `fileUploads`，拿回 receiptId 供同一会话的 prompt 引用。
   * 只走白名单 `fileUploads/upload`；本客户端不缓存文件内容。
   */
  /**
   * 反向补读：取窗口前面那一段（手机首屏只看最近 N 条，往上翻时才要更早的）。
   * 走 session/backfill，与 session/follow 同一条 `session/*` 下行通道。
   */
  const backfill = async ({ sessionId, beforeSeq, limit = 50, bytes } = {}) => {
    if (!sessionId) throw Object.assign(new Error('补读缺 sessionId'), { code: 'INVALID_ARGUMENT' })
    if (!Number.isInteger(beforeSeq)) throw Object.assign(new Error('补读缺 beforeSeq'), { code: 'INVALID_ARGUMENT' })
    const r = await fetchImpl(`${base}/d/${encodeURIComponent(deviceId)}/session/backfill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      // bytes 只在想覆盖「一页预算」时带上（首屏窗口）；翻页不带，用 Host 默认值
      body: JSON.stringify({ sessionId, beforeSeq, limit, clientId, ...(bytes ? { bytes } : {}) }),
    })
    const payload = await r.json().catch(() => null)
    if (!r.ok || payload?.ok !== true) {
      const code = payload?.error?.code ?? `HTTP_${r.status}`
      // 旧版 Host 还不认识 session/backfill（白名单内但没实现，回 403）。
      // 别让「加载更早」直接变砖：退回 follow 拿一页，再筛出窗口前面的部分。
      if (code === 'ENDPOINT_NOT_ALLOWED' || r.status === 403 || r.status === 501) {
        return await backfillViaFollow({ sessionId, beforeSeq, limit })
      }
      throw Object.assign(new Error(`补读失败：${code}`), { code, status: r.status })
    }
    return payload.data ?? { events: [], hasMoreEarlier: false }
  }

  /** 兼容旧 Host：用 follow 从更早一点开始取一页，筛出 beforeSeq 之前的部分。 */
  const backfillViaFollow = async ({ sessionId, beforeSeq, limit }) => {
    const from = Math.max(-1, beforeSeq - limit - 1)
    const r = await fetchImpl(`${base}/d/${encodeURIComponent(deviceId)}/session/follow`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ sessionId, sinceSeq: from, clientId }),
    })
    const payload = await r.json().catch(() => null)
    if (!r.ok || payload?.ok !== true) {
      const code = payload?.error?.code ?? `HTTP_${r.status}`
      throw Object.assign(new Error(`补读失败：${code}`), { code, status: r.status })
    }
    const events = (payload.data?.events ?? [])
      .filter((ev) => Number.isInteger(ev?.seq) && ev.seq < beforeSeq)
      .slice(-limit)
    return {
      events,
      hasMoreEarlier: events.length > 0 && events[0].seq > 0,
      via: 'follow',
    }
  }

  /**
   * 首屏窗口：让 Host 按**字节预算**裁「最近一页」，而不是客户端拍脑袋数 50 条。
   * 固定条数管不住体积（50 条 × 40 KB = 2 MB），固定字节才能同时管带宽和阅读量。
   * 返回 null 表示「不知道 lastSeq」，调用方退回 follow(-1) 全量/引导补齐。
   */
  const openWindow = async ({ sessionId, lastSeq, limit = 200, bytes = 96 * 1024 } = {}) => {
    if (!sessionId) throw Object.assign(new Error('开窗缺 sessionId'), { code: 'INVALID_ARGUMENT' })
    if (!Number.isInteger(lastSeq) || lastSeq < 0) return null
    // 首屏窗口要两份页预算（96 KiB）：一次开屏，多给点内容比多跑一次往返值。
    // 真正的上限在 Host 侧（≤4× 页预算），这里传大也只是被夹住。
    const data = await backfill({ sessionId, beforeSeq: lastSeq + 1, limit, bytes })
    const events = Array.isArray(data.events) ? data.events : []
    return {
      events,
      toSeq: events.length ? events[events.length - 1].seq : null,
      hasMoreEarlier: data.hasMoreEarlier === true,
      via: data.via ?? 'backfill',
    }
  }

  /**
   * 拉某个会话的产物索引。只回元数据（路径 / 描述 / seq），文件字节不经 Relay。
   * 走的是既有 `session/*` 下行通道，不需要新协议帧。
   */
  const getArtifacts = async ({ sessionId } = {}) => {
    if (!sessionId) throw Object.assign(new Error('拉产物缺 sessionId'), { code: 'INVALID_ARGUMENT' })
    const r = await fetchImpl(`${base}/d/${encodeURIComponent(deviceId)}/session/artifacts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ sessionId, clientId }),
    })
    const payload = await r.json().catch(() => null)
    if (!r.ok || payload?.ok !== true) {
      const code = payload?.error?.code ?? `HTTP_${r.status}`
      throw Object.assign(new Error(`拉取产物失败：${code}`), { code, status: r.status })
    }
    return Array.isArray(payload.data?.rows) ? payload.data.rows : []
  }

  /**
   * 产物下载（ADR-011）：分两步——先换一次性票据（只回元数据），再用票据取字节。
   * Host 只放行「该会话已显式交付、且在工作区内」的文件；Relay 内存票据 60s/单次。
   */
  const createArtifactTicket = async ({ sessionId, path, format } = {}) => {
    if (!sessionId || typeof path !== 'string' || !path.trim()) {
      throw Object.assign(new Error('下载缺 sessionId / path'), { code: 'INVALID_ARGUMENT' })
    }
    const r = await fetchImpl(`${base}/api/artifacts/ticket`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      // format 只允许 'pdf'（宿主只做 Office→PDF），别的值直接不发，别让服务端去猜
      body: JSON.stringify({ deviceId, sessionId, path, ...(format === 'pdf' ? { format } : {}) }),
    })
    const payload = await r.json().catch(() => null)
    if (!r.ok || payload?.ok !== true) {
      const code = payload?.error?.code ?? `HTTP_${r.status}`
      const detail = typeof payload?.error?.message === 'string' ? payload.error.message : ''
      throw Object.assign(new Error(detail || `换票失败：${code}`), { code })
    }
    return payload.data
  }

  /** 换票取字节：返回 Blob 交给页面落盘，客户端不碰 DOM。 */
  const fetchArtifactBlob = async ({ ticketId } = {}) => {
    if (!ticketId) throw Object.assign(new Error('缺 ticketId'), { code: 'INVALID_ARGUMENT' })
    const r = await fetchImpl(`${base}/api/artifacts/download/${encodeURIComponent(ticketId)}`, {
      headers: authHeaders(),
    })
    if (!r.ok) {
      const payload = await r.json().catch(() => null)
      const code = payload?.error?.code ?? `HTTP_${r.status}`
      throw Object.assign(new Error(`下载失败：${code}`), { code })
    }
    return r.blob()
  }

  /** 拉取待审批清单：推送只是「更快」，拉取才是「不漏」（断线期间错过的靠这条补）。 */
  const listApprovals = async () => {
    const r = await fetchImpl(`${base}/api/approvals?deviceId=${encodeURIComponent(deviceId)}`, {
      headers: authHeaders(),
    })
    const payload = await r.json().catch(() => null)
    if (!r.ok || payload?.ok !== true) {
      const code = payload?.error?.code ?? `HTTP_${r.status}`
      throw Object.assign(new Error(`拉取审批失败：${code}`), { code, status: r.status })
    }
    return Array.isArray(payload.data?.rows) ? payload.data.rows : []
  }

  /** 应答一条审批。outcome 只允许 allowed-once / rejected（cancel 由宿主/超时决定）。 */
  const answerApproval = async ({ approvalId, outcome } = {}) => {
    if (!approvalId) throw Object.assign(new Error('应答审批缺 approvalId'), { code: 'INVALID_ARGUMENT' })
    if (outcome !== 'allowed-once' && outcome !== 'rejected') {
      throw Object.assign(new Error('outcome 只能是 allowed-once 或 rejected'), { code: 'INVALID_ARGUMENT' })
    }
    // 注意 `$events` 在模板串里要转义成 \$events，否则会被当成变量插值成空串（会变成 //result）
    const r = await fetchImpl(`${base}/d/${encodeURIComponent(deviceId)}/\$events/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ approvalId, outcome, clientId }),
    })
    const payload = await r.json().catch(() => null)
    if (!r.ok || payload?.ok !== true) {
      const code = payload?.error?.code ?? `HTTP_${r.status}`
      throw Object.assign(new Error(`应答失败：${code}`), { code, status: r.status })
    }
    return payload.data
  }

  const uploadAttachment = async ({ sessionId, file, name } = {}) => {
    if (!sessionId || !file) {
      throw Object.assign(new Error('上传缺 sessionId / file'), { code: 'INVALID_ARGUMENT' })
    }
    const r = await fetchImpl(`${base}/d/${encodeURIComponent(deviceId)}/fileUploads/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({
        clientId, sessionId,
        data: await fileToBase64(file),
        name: name ?? file.name ?? null,
      }),
    })
    const payload = await r.json().catch(() => null)
    if (!r.ok || payload?.ok !== true) {
      const code = payload?.error?.code ?? `HTTP_${r.status}`
      const detail = typeof payload?.error?.message === 'string' ? payload.error.message : ''
      throw Object.assign(
        new Error(`上传失败：${code}${detail && detail !== code ? ` · ${detail}` : ''}`),
        { code, detail },
      )
    }
    return payload.data
  }

  const snapshot = () => ({
    deviceId,
    // r22：当前执行位置（TC-4.6 顶部常驻）；写操作路径段就是这个值。
    hostId: activeHostId,
    host: { ...hostStatus },
    hostMismatch,
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

  return {
    refreshSessions, createSession, cancelTurn, setPinned, setArchived, getArchivedSessions, submitPrompt, uploadAttachment,
    getHostStatus: () => ({ ...hostStatus }),
    listApprovals, answerApproval, getArtifacts, createArtifactTicket, fetchArtifactBlob, backfill, openWindow,
    listSchedules, createSchedule, runSchedule, renameSession,
    follow, unfollow, stop, snapshot, getSession: (id) => sessions.get(id) ?? null,
  }
}
