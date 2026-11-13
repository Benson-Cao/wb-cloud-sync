/**
 * p1/client-core · DshMux（S-2.4：重连 / generation / watch 重同步，全部与传输无关）
 * ---------------------------------------------------------------
 * 上层（App 壳 / PWA / 单测）只和 Mux 打交道：
 *   - watch(sessionId, { sinceSeq, onEvent, onState, onGap, onLost })
 *       订阅一个会话；断线按指数退避重连，重连时带**本地最后一条 seq**（唯一游标），
 *       每次重连 generation+1，旧连接迟到的帧按 generation 丢弃。
 *   - call(endpoint, args)
 *       统一注入 `clientMsgId`（幂等键，服务端 24h 去重）；先过 carrier 能力声明，
 *       拒绝不落到网络层；`unauthorized` 状态**不傻重试**（等显式 reconnect()）。
 *   - reconnect()
 *       显式重连（unauthorized / 用户点恢复时用）。
 *
 * 设计铁律（与 PWA client 的 follow 逻辑同源，但这里只做协议骨架，不供 UI）：
 *   - 连续 seq 是唯一游标；`seq <= lastSeq` 幂等丢弃；
 *   - 实时流跳帧（seq > lastSeq+1）不冒险继续，报 `gap` 并由上层决定补齐；
 *   - 主动关闭（close/unwatch）不触发重连——`closing` 标记先于 close 帧置位。
 */

import { assertCarrier, ERR, rpcError } from './carrier.js'

export function createDshMux(carrier, {
  now = () => Date.now(),
  setTimeoutImpl = globalThis.setTimeout,
  clearTimeoutImpl = globalThis.clearTimeout,
  reconnectBaseMs = 500,
  reconnectMaxMs = 15_000,
  maxAttempts = 10,
  makeClientMsgId = () => globalThis.crypto?.randomUUID?.()
    ?? `c-${Date.now()}-${Math.random().toString(36).slice(2)}`,
} = {}) {
  assertCarrier(carrier, 'DshMux.carrier')

  const links = new Map()   // sessionId -> 连接记录
  let generation = 0        // 全局连接代数：每次成功建立新连 +1
  let stopped = false

  const emit = (rec) => {
    try {
      rec.onState?.({
        sessionId: rec.sessionId,
        status: rec.status,
        lastSeq: rec.lastSeq,
        attempts: rec.attempts,
        generation: rec.generation,
        expectedSeq: rec.expectedSeq,
      })
    } catch { /* 回调异常不影响 mux */ }
  }

  const scheduleReconnect = (rec) => {
    if (stopped || rec.status === 'closed' || rec.unAuthorized) return
    if (rec.attempts >= maxAttempts) {
      rec.status = 'failed'
      emit(rec)
      try { rec.onLost?.({ sessionId: rec.sessionId, reason: 'max-attempts' }) } catch { /* 忽略 */ }
      return
    }
    const delay = Math.min(reconnectMaxMs, reconnectBaseMs * 2 ** Math.min(rec.attempts, 6))
    rec.attempts++
    rec.status = 'reconnecting'
    emit(rec)
    rec.timer = setTimeoutImpl(() => {
      rec.timer = null
      connect(rec)
    }, delay)
    rec.timer?.unref?.()   // 单测常驻循环：不吊住事件循环
  }

  const connect = (rec) => {
    if (stopped || rec.status === 'closed') return
    generation++
    const gen = generation
    let link
    try {
      link = carrier.openLink({ sessionId: rec.sessionId, sinceSeq: rec.lastSeq, generation: gen })
    } catch (error) {
      rec.status = 'reconnecting'
      emit(rec)
      scheduleReconnect(rec)
      return
    }
    rec.link = link
    rec.generation = gen
    rec.status = 'following'
    emit(rec)

    link.onEvent((ev) => {
      // generation 守卫：旧连接的迟到帧一律丢弃（重连后的新连接是唯一权威）
      if (rec.link !== link || gen !== generation) return
      if (!Number.isInteger(ev?.seq) || ev.seq <= rec.lastSeq) return
      // 初始 sinceSeq=-1 表示「从头」，协议事件 seq 从 1 开始——期望位是 1 而非 0
      const nextSeq = rec.lastSeq < 0 ? 1 : rec.lastSeq + 1
      if (ev.seq > nextSeq) {
        rec.expectedSeq = nextSeq
        rec.status = 'gap'
        emit(rec)
        try { rec.onGap?.({ sessionId: rec.sessionId, expectedSeq: rec.expectedSeq }) } catch { /* 忽略 */ }
        return
      }
      rec.lastSeq = ev.seq
      rec.attempts = 0
      rec.expectedSeq = null
      try { rec.onEvent?.({ sessionId: rec.sessionId, ev, source: 'live' }) } catch { /* 忽略 */ }
    })

    link.onEnd(() => {
      if (rec.link !== link) return
      rec.link = null
      rec.status = 'closed'
      emit(rec)
    })

    link.onError((error) => {
      if (rec.link !== link) return
      rec.link = null
      const code = String(error?.code ?? '')
      if (code === ERR.UNAUTHORIZED) {
        // 凭证失效不是瞬时故障：停住等显式 reconnect()，否则退避重连只是空转打点
        rec.unAuthorized = true
        rec.status = 'unauthorized'
        emit(rec)
        return
      }
      rec.status = 'reconnecting'
      emit(rec)
      scheduleReconnect(rec)
    })

    link.onLost(() => {
      if (rec.link !== link) return
      rec.link = null
      try { rec.onLost?.({ sessionId: rec.sessionId, reason: 'connection-lost' }) } catch { /* 忽略 */ }
      rec.status = 'reconnecting'
      emit(rec)
      scheduleReconnect(rec)
    })
  }

  const unwatch = (sessionId) => {
    const rec = links.get(sessionId)
    if (!rec) return
    links.delete(sessionId)
    rec.status = 'closed'
    rec.closed = true
    if (rec.timer) { clearTimeoutImpl(rec.timer); rec.timer = null }
    try { rec.link?.close() } catch { /* 已关闭 */ }
    rec.link = null
    emit(rec)
  }

  const watch = (sessionId, {
    sinceSeq = -1, onEvent = null, onState = null, onGap = null, onLost = null,
  } = {}) => {
    if (!sessionId) throw new TypeError('watch 需要 sessionId')
    if (links.has(sessionId)) unwatch(sessionId)
    const rec = {
      sessionId,
      lastSeq: Number.isSafeInteger(sinceSeq) ? sinceSeq : -1,
      status: 'connecting',
      attempts: 0,
      expectedSeq: null,
      generation: 0,
      link: null,
      timer: null,
      unAuthorized: false,
      closed: false,
      onEvent, onState, onGap, onLost,
    }
    links.set(sessionId, rec)
    emit(rec)
    connect(rec)
    return {
      sessionId,
      close: () => unwatch(sessionId),
      state: () => ({ ...rec, link: undefined, onEvent: undefined }),
    }
  }

  /** 显式重连（unauthorized 或用户点恢复时）：清退避计数重新开链。 */
  const reconnect = (sessionId = null) => {
    const targets = sessionId ? [links.get(sessionId)] : [...links.values()]
    for (const rec of targets) {
      if (!rec || rec.status === 'closed') continue
      if (rec.timer) { clearTimeoutImpl(rec.timer); rec.timer = null }
      rec.attempts = 0
      rec.unAuthorized = false
      rec.status = 'connecting'
      emit(rec)
      connect(rec)
    }
  }

  /**
   * 统一 RPC：能力声明 → 注入幂等键 → carrier.call。
   * 被拒端点**不发网络请求**（能力声明下沉，S-2.5）。
   */
  const call = async (endpoint, args = {}) => {
    if (stopped) return rpcError(ERR.INTERNAL, 'mux 已停止')
    if (!carrier.allowsEndpoint(endpoint)) {
      return rpcError(ERR.ENDPOINT_NOT_ALLOWED, `能力声明拒绝端点：${endpoint}`)
    }
    const payload = args && typeof args === 'object' ? args : {}
    const withId = payload.clientMsgId ? payload : { ...payload, clientMsgId: makeClientMsgId() }
    try {
      const r = await carrier.call(endpoint, withId)
      if (r && r.ok === false && r.error?.code === ERR.UNAUTHORIZED) {
        // 与订阅侧的 unauthorized 同口径：显式重连前不再自动动作
        for (const rec of links.values()) {
          if (rec.status === 'closed') continue
          rec.unAuthorized = true
          rec.status = 'unauthorized'
          emit(rec)
        }
      }
      return r
    } catch (error) {
      return rpcError(ERR.NETWORK, String(error?.message ?? error), { retryable: true })
    }
  }

  /** 上层状态快照（不含回调和内部句柄）。 */
  const snapshot = () => ({
    generation,
    stopped,
    links: [...links.values()].map((rec) => ({
      sessionId: rec.sessionId,
      status: rec.status,
      lastSeq: rec.lastSeq,
      attempts: rec.attempts,
      generation: rec.generation,
      expectedSeq: rec.expectedSeq,
    })),
  })

  const close = () => {
    stopped = true
    for (const sessionId of [...links.keys()]) unwatch(sessionId)
  }

  return { watch, unwatch, reconnect, call, snapshot, close, carrier }
}