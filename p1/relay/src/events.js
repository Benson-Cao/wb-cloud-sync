/**
 * 会话事件缓冲与订阅广播（W3）
 * ---------------------------------------------------------------
 * 语义（docs/04 §3 / §5.3、ADR-004）：
 *   - 会话内 `seq` 从 0 起连续单调，**连续 `seq` 是唯一游标**，不用时间戳；
 *   - 上行事件按 `seq` 落缓冲，只广播**连续前缀**：收到 0、2、1 时，2 先到
 *     不广播，等 1 到达后按 1、2 顺序补推；
 *   - 手机订阅带 `sinceSeq`，从 `sinceSeq+1` 起补发连续前缀；补不上就发
 *     `session/gap` 让客户端决定重拉还是降级，**不静默跳过**；
 *   - 每个会话最多留 `capacity` 条，只裁掉 `delivered` 之前的老条目。
 *
 * 只存**转发缓冲**，不写盘、不解析 `ev` 内部结构（ADR-010 / 04 §5.4）。
 */
export function createEventHub({ capacity = 1000, maxBytes = 32 * 1024 * 1024 } = {}) {
  const sessions = new Map()   // sessionId -> { bySeq, sizeOf, bytes, delivered, maxSeq, startedAt }
  const subs = new Map()       // sessionId -> Set<conn>
  // 下限只用来挡明显写错的配置；设 4 KiB 而不是 64 KiB，否则小预算测试/调参会静默失效
  const byteBudget = Math.max(4 * 1024, Number(maxBytes) || 32 * 1024 * 1024)

  const sessionOf = (id) => {
    let s = sessions.get(id)
    if (!s) {
      s = { bySeq: new Map(), sizeOf: new Map(), bytes: 0, delivered: -1, maxSeq: -1, startedAt: 0 }
      sessions.set(id, s)
    }
    return s
  }

  const broadcast = (sessionId, ev) => {
    const set = subs.get(sessionId)
    if (!set) return 0
    let reached = 0
    for (const conn of [...set]) {
      if (conn.isOpen()) { conn.sendJson({ t: 'session/event', sessionId, ev }); reached++ }
      else set.delete(conn)
    }
    return reached
  }

  /**
   * 按条数与**字节**双重裁剪，只裁 `delivered` 之前的旧条目。
   * 只按条数裁是不够的：真机取证单条事件最大 421 KiB（p99 97 KiB），
   * 1000 条 × 400 KiB 就是 400 MB，长会话能把 Relay 内存吃穿。
   */
  const trim = (s) => {
    if (s.bySeq.size <= capacity && s.bytes <= byteBudget) return
    for (const seq of [...s.bySeq.keys()]) {
      if (s.bySeq.size <= capacity && s.bytes <= byteBudget) break
      if (seq > s.delivered) break          // 未广播的连续前缀一律保留
      s.bySeq.delete(seq)
      s.bytes -= s.sizeOf.get(seq) ?? 0
      s.sizeOf.delete(seq)
    }
  }

  const byteSize = (ev) => {
    try { return Buffer.byteLength(JSON.stringify(ev), 'utf8') } catch { return 0 }
  }

  return {
    /** 收入一条上行事件；只有连续前缀会被推进并广播。 */
    ingest(sessionId, ev) {
      if (!sessionId || !Number.isInteger(ev?.seq) || ev.seq < 0) return { rejected: 'BAD_EVENT' }
      const s = sessionOf(sessionId)
      // 首个事件不是 seq 0：说明该会话起点被截断，记下真实起点，补齐时如实报 gap
      if (s.maxSeq === -1 && ev.seq > 0) {
        s.startedAt = ev.seq
        s.delivered = ev.seq - 1
      }
      if (s.bySeq.has(ev.seq)) return { rejected: 'DUPLICATE', delivered: s.delivered }
      s.bySeq.set(ev.seq, ev)
      const size = byteSize(ev)
      s.sizeOf.set(ev.seq, size)
      s.bytes += size
      if (ev.seq > s.maxSeq) s.maxSeq = ev.seq

      let advanced = 0
      while (s.bySeq.has(s.delivered + 1)) {
        s.delivered += 1
        broadcast(sessionId, s.bySeq.get(s.delivered))
        advanced++
      }
      trim(s)
      return { advanced, delivered: s.delivered, maxSeq: s.maxSeq }
    },

    /** 订阅：先按连续前缀补发，再挂到实时广播集合。 */
    subscribe(sessionId, sinceSeq, conn) {
      const s = sessions.get(sessionId)
      const since = Number.isInteger(sinceSeq) ? sinceSeq : -1
      const startedAt = s?.startedAt ?? 0
      let replayed = 0
      let gapAt = null

      if (since + 1 < startedAt) {
        // 客户端要的位置早于缓冲起点：一条都不补，直接报缺口，避免跳跃式补发
        gapAt = startedAt
        conn.sendJson({ t: 'session/replay', sessionId, fromSeq: since, toSeq: since, complete: false })
        conn.sendJson({ t: 'session/gap', sessionId, expectedSeq: startedAt })
      } else {
        let cursor = since + 1
        if (s) {
          while (cursor <= s.delivered) {
            const ev = s.bySeq.get(cursor)
            if (!ev) { gapAt = cursor; break }
            if (conn.isOpen()) conn.sendJson({ t: 'session/event', sessionId, ev })
            cursor++
            replayed++
          }
        }
        conn.sendJson({
          t: 'session/replay', sessionId,
          fromSeq: since, toSeq: cursor - 1, complete: gapAt === null,
        })
        if (gapAt !== null) conn.sendJson({ t: 'session/gap', sessionId, expectedSeq: gapAt })
      }

      const set = subs.get(sessionId) ?? new Set()
      set.add(conn)
      subs.set(sessionId, set)
      return { replayed, gapAt }
    },

    unsubscribe(conn) {
      for (const set of subs.values()) set.delete(conn)
    },

    /** 关停时关闭所有订阅连接，否则 server.close() 会一直等它们。 */
    closeAll(code = 1001, reason = 'server stopping') {
      for (const set of subs.values()) {
        for (const conn of set) conn.close(code, reason)
      }
      subs.clear()
    },

    stats() {
      let buffered = 0
      let bufferedBytes = 0
      for (const s of sessions.values()) { buffered += s.bySeq.size; bufferedBytes += s.bytes }
      let subscribers = 0
      for (const set of subs.values()) subscribers += set.size
      return { sessions: sessions.size, buffered, bufferedBytes, subscribers }
    },

    /** 测试用：读某会话的游标状态。 */
    snapshot(sessionId) {
      const s = sessions.get(sessionId)
      return s
        ? { delivered: s.delivered, maxSeq: s.maxSeq, startedAt: s.startedAt, buffered: s.bySeq.size, bytes: s.bytes }
        : null
    },
  }
}
