/**
 * W3 · 重启后历史补齐（Host 侧只读回放）
 * ---------------------------------------------------------------
 * 动机：Relay 的事件缓冲在内存里，进程一重启就空。手机断线重连后要补的那段历史，
 * 唯一真源是宿主 `~/.dsh` 里的 append-only 日志。所以补齐必须回 Host 读，不能靠 Relay。
 *
 * 宿主 API（从 `dsh-session-persistence-jsonl` 的实现取证，不是猜的）：
 *   open(id, 'read')            -> handle（`read` 是无所有权句柄，不含写权限）
 *   handle.read(offset, length) -> { eventState, events }
 *   handle.close()              -> 释放句柄
 * `offset` 按宿主 seam 契约是「**首条要包含的逻辑 seq**」（不是字节偏移）；实现上是
 * `events.slice(offset, offset+length)`，因为同会话内 `seq` 从 0 连续、等于数组下标。
 * 所以快路径直接传 `sinceSeq + 1`；万一首条事件的 `seq` 对不上（逻辑视图与下标不一致），
 * 退化为从 0 读一次再过滤——有界兜底，不是常态路径。
 *
 * 铁律：**只读**。这里不 `open(id,'write')`、不 `append`、不 `flush`。
 *
 * 语义（与 04 ADR-004 一致）：
 *   - 只返回 **`sinceSeq + 1` 起的连续前缀**，遇缺口立刻停，绝不返回撕裂尾部；
 *   - `seq <= sinceSeq` 的重复帧幂等丢弃（手机重试不会拿到重复事件）；
 *   - 缺口显式报 `complete:false` + `expectedSeq`，由调用方决定重试还是报 `session/gap`；
 *   - 单次最多 `pageSize` 条，更多则 `hasMore:true`，让手机分页拉，不一次打爆帧上限。
 */

export const DEFAULT_PAGE_SIZE = 500
const MAX_PAGE_SIZE = 5000
/**
 * 单帧字节预算。真机取证（2026-11-11，胎教Agent 会话）：74 条事件就有 454 KiB，
 * 平均 6.1 KiB/条，按旧版 500 条一页推算约 3 MiB —— 超过 Relay WS 的
 * MAX_PAYLOAD(1 MiB) 会被 1009 断连，在途补齐请求只能熬到 504 NO_PROGRESS。
 * 协议 §5.3 更要求 ≤64KiB，这里留 16 KiB 给帧封装与外层字段，取 48 KiB。
 */
export const DEFAULT_REPLAY_MAX_BYTES = 48 * 1024
/**
 * 硬安全网：单条事件本身超过这个数就不发了。否则 Relay WS 会以 1009 断连，
 * 手机只看到 10s 后的 504，根本不知道是哪条事件把连接撑爆的。
 * 宁可回一个明确的 FRAME_TOO_LARGE，也不要静默断连。
 */
export const HARD_FRAME_LIMIT_BYTES = 768 * 1024

const encoder = new TextEncoder()
/** 单条事件序列化后的字节数（用 UTF-8 实算，不按字符数猜）。 */
export const eventBytes = (ev) => encoder.encode(JSON.stringify(ev)).length

/**
 * 纯函数：按字节预算裁一页，保证「至少给一条」——单条就超预算时若一条都不给，
 * 客户端的 sinceSeq 永远推不动，会变成无限重试。
 * 返回 oversized 让调用方知道这一页是硬塞过去的，不是预算内正常页。
 */
export function pickWithinBudget(events, maxBytes = DEFAULT_REPLAY_MAX_BYTES) {
  const budget = Math.max(1, Number(maxBytes) || DEFAULT_REPLAY_MAX_BYTES)
  const picked = []
  let bytes = 0
  for (const ev of events ?? []) {
    const size = eventBytes(ev)
    if (picked.length && bytes + size > budget) break
    picked.push(ev)
    bytes += size
  }
  return {
    events: picked,
    bytes,
    oversized: picked.length === 1 && bytes > budget,
    truncatedByBytes: picked.length < (events?.length ?? 0),
  }
}

const isSeq = (v) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0

/**
 * 纯函数：从 `events` 里取 `sinceSeq + 1` 起的连续前缀。
 * 返回 `{ events, expectedSeq }`；`expectedSeq` 非 null 表示中途遇到了缺口。
 */
export function contiguousPrefix(events, sinceSeq) {
  const out = []
  let expected = sinceSeq + 1
  for (const ev of events ?? []) {
    if (!isSeq(ev?.seq)) continue
    if (ev.seq < expected) continue      // 重复或更旧：幂等丢弃
    if (ev.seq !== expected) return { events: out, expectedSeq: expected }
    out.push(ev)
    expected++
  }
  return { events: out, expectedSeq: null }
}

/**
 * 创建 `replay` 适配器。
 * @param openSession (sessionId) => Promise<handle>，正式版绑 `ctx.sessionPersistence.open(id,'read')`
 */
export function createReplayAdapter({ openSession, pageSize = DEFAULT_PAGE_SIZE, maxBytes = DEFAULT_REPLAY_MAX_BYTES } = {}) {
  if (typeof openSession !== 'function') {
    throw new TypeError('createReplayAdapter 需要 openSession(sessionId)')
  }
  const limit = Math.min(Math.max(1, Number(pageSize) || DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE)
  const budget = Math.max(1, Number(maxBytes) || DEFAULT_REPLAY_MAX_BYTES)

  /** 多读一条：用它判断「后面还有没有」，避免为了 hasMore 再打一次句柄。 */
  const readPage = async (handle, offset) => {
    const r = await handle.read(offset, limit + 1)
    return {
      events: Array.isArray(r?.events) ? r.events : [],
      eventState: r?.eventState ?? 'unknown',
    }
  }

  return async function replay({ sessionId, sinceSeq = -1 } = {}) {
    if (!sessionId) {
      return { ok: false, code: 'SESSION_UNREADABLE', message: '缺少 sessionId' }
    }
    const from = Number.isSafeInteger(sinceSeq) && sinceSeq >= -1 ? sinceSeq : -1

    let handle
    try {
      handle = await openSession(sessionId)
    } catch (error) {
      return {
        ok: false, code: 'SESSION_UNREADABLE',
        message: `会话不可读：${error?.message ?? 'unknown'}`,
      }
    }

    try {
      let page = await readPage(handle, from + 1)
      // 下标与 seq 不相等时（首条对不上目标 seq），退化为从 0 读一次再过滤。
      if (page.events.length && page.events[0]?.seq !== from + 1 && from + 1 !== 0) {
        page = await readPage(handle, 0)
      }

      const { events: contiguous, expectedSeq } = contiguousPrefix(page.events, from)
      // 先按条数封顶，再按**字节预算**裁：真机会话正文可能一条就几十 KB，
      // 只数条数会让 http/response 帧超过 Relay WS 的 1 MiB 上限而被 1009 断连。
      const pageSlice = contiguous.slice(0, limit)
      const picked = pickWithinBudget(pageSlice, budget)
      if (picked.oversized && picked.bytes > HARD_FRAME_LIMIT_BYTES) {
        return {
          ok: false, code: 'FRAME_TOO_LARGE',
          message: `单条事件 ${picked.bytes} 字节超过 ${HARD_FRAME_LIMIT_BYTES} 上限，补齐无法继续（seq ${pageSlice[0]?.seq ?? '?'}）`,
        }
      }
      const events = picked.events
      const truncatedByCount = contiguous.length > limit
      const truncated = truncatedByCount || picked.truncatedByBytes
      // 字节截断不能掩盖真缺口：只被条数截断时才把 expectedSeq 当「还有更多」。
      const gapped = expectedSeq !== null && !truncatedByCount
      const last = events.length ? events[events.length - 1].seq : from

      return {
        ok: true,
        value: {
          sessionId,
          events,
          count: events.length,
          bytes: picked.bytes,
          ...(picked.oversized ? { oversized: true } : {}),
          fromSeq: events.length ? events[0].seq : null,
          toSeq: last,
          complete: !truncated && !gapped,
          expectedSeq: gapped ? expectedSeq : (truncated ? last + 1 : null),
          hasMore: truncated,
          eventState: page.eventState,
        },
      }
    } catch (error) {
      return {
        ok: false, code: 'SESSION_UNREADABLE',
        message: `回放失败：${error?.message ?? 'unknown'}`,
      }
    } finally {
      // 句柄必须释放，否则宿主的 read 句柄会一直占着 tracker
      try { await handle.close?.() } catch { /* 已关闭 */ }
    }
  }
}

/**
 * 反向补读：取「窗口前面那一小段」。
 * ---------------------------------------------------------------
 * `session/follow` 只能从 `sinceSeq+1` 往后拉，用来补“更早”会一路把后面的也重发一遍。
 * 手机首屏只看最近 50 条，往上翻时才需要紧邻的那 50 条——这正是反向读。
 *
 * 读窗口 `[beforeSeq-limit, beforeSeq)`，再按**字节预算从后往前**挑：
 * 越靠近窗口的越该留下，所以超预算时砍掉的是更早的那些，而不是最新的。
 */
export function createBackfillReader({ openSession, maxBytes = DEFAULT_REPLAY_MAX_BYTES, maxRows = 200 } = {}) {
  if (typeof openSession !== 'function') {
    throw new TypeError('createBackfillReader 需要 openSession(sessionId)')
  }
  const budget = Math.max(1, Number(maxBytes) || DEFAULT_REPLAY_MAX_BYTES)
  const cap = Math.min(Math.max(1, Number(maxRows) || 200), 1000)

  return async function backfill({ sessionId, beforeSeq, limit, bytes } = {}) {
    if (!sessionId) return { ok: false, code: 'SESSION_UNREADABLE', message: '缺少 sessionId' }
    const before = Number.isInteger(beforeSeq) ? beforeSeq : null
    if (before === null || before <= 0) {
      return { ok: true, value: { sessionId, events: [], fromSeq: null, toSeq: null, hasMoreEarlier: false, bytes: 0 } }
    }
    const want = Math.min(Math.max(1, Number(limit) || 50), cap)
    // 首屏窗口可以比翻页大（一次开屏 vs 反复滚动），但预算由**调用方只能调小不能调大**：
    // 上限锁在 4× 页预算，客户端传 8 MiB 也只给到 192 KiB。
    const effectiveBudget = Math.min(
      Math.max(4 * 1024, Number(bytes) || budget),
      budget * 4,
    )
    const from = Math.max(0, before - want)

    let handle
    try {
      handle = await openSession(sessionId)
    } catch (error) {
      return {
        ok: false, code: 'SESSION_UNREADABLE',
        message: `会话不可读：${error?.message ?? 'unknown'}`,
      }
    }
    try {
      const page = await handle.read(from, before - from)
      const batch = (Array.isArray(page?.events) ? page.events : [])
        .filter((ev) => Number.isInteger(ev?.seq) && ev.seq < before)
        .sort((a, b) => a.seq - b.seq)

      const picked = []
      let bytes = 0
      // 字节预算之外还有**条数下限**：如果最新那几条都是几十 KB 的巨型事件，
      // 光按预算只能拿到 1~2 条，手机上一屏都撑不满、上下文全没了。
      // 所以不足 8 条时允许超预算，但不超过 4×（防 8 条 × 1 MiB 把帧撑爆）。
      const minRows = Math.min(8, batch.length)
      const hardCap = effectiveBudget * 4
      for (let i = batch.length - 1; i >= 0; i--) {
        const size = eventBytes(batch[i])
        const overBudget = picked.length > 0 && bytes + size > effectiveBudget
        if (overBudget && (picked.length >= minRows || bytes + size > hardCap)) break
        picked.unshift(batch[i])
        bytes += size
      }
      const first = picked.length ? picked[0].seq : null
      return {
        ok: true,
        value: {
          sessionId,
          events: picked,
          bytes,
          fromSeq: first,
          toSeq: picked.length ? picked[picked.length - 1].seq : null,
          // 最早那条不是 0，说明前面还有，界面该保留「加载更早」
          hasMoreEarlier: first !== null && first > 0,
        },
      }
    } catch (error) {
      return { ok: false, code: 'SESSION_UNREADABLE', message: `反向补读失败：${error?.message ?? 'unknown'}` }
    } finally {
      try { await handle.close?.() } catch { /* 已关闭 */ }
    }
  }
}
