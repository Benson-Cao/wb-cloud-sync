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
export function createReplayAdapter({ openSession, pageSize = DEFAULT_PAGE_SIZE } = {}) {
  if (typeof openSession !== 'function') {
    throw new TypeError('createReplayAdapter 需要 openSession(sessionId)')
  }
  const limit = Math.min(Math.max(1, Number(pageSize) || DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE)

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
      // 多读的那一条只用来判断「后面还有没有」，不发给手机：单页严格不超过 limit。
      const events = contiguous.slice(0, limit)
      const truncated = contiguous.length > limit
      const gapped = !truncated && expectedSeq !== null
      const last = events.length ? events[events.length - 1].seq : from

      return {
        ok: true,
        value: {
          sessionId,
          events,
          count: events.length,
          fromSeq: events.length ? events[0].seq : null,
          toSeq: last,
          complete: !truncated && !gapped,
          expectedSeq: truncated ? last + 1 : (gapped ? expectedSeq : null),
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
