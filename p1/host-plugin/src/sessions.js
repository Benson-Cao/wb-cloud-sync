/**
 * W3 · 会话索引上报（Host → Relay 的 `host/sessions` 帧）
 * ---------------------------------------------------------------
 * 手机的会话列表需要一份「有哪些会话、各自什么状态、最新 seq 到哪」的快照。
 * 唯一真源仍是宿主日志，本模块把它整理成协议里的 `SessionIndex` 行（PROTOCOL.md §4）。
 *
 * 宿主 API（取证自 `dsh-session-persistence-jsonl` 的实现）：
 *   sessionPersistence.list(options)
 *     -> [{ header, formatStatus, revision, sizeBytes, location }]
 *   header = { type, version, id, createdAt, cwd, isSeeded, delegationDepth, agentPreset,
 *              (可选) title / parentSession / origin }
 *   sessionPersistence.open(id, 'read') -> handle.read(0, n) -> { eventState, events }
 *
 * 两个工程取舍（都写在这里，免得后面有人以为是漏做）：
 *
 * 1. **`lastSeq` 要解码整份日志才知道**：宿主没有「给我日志条数」的接口，
 *    `read()` 内部是整文件解码（按 path memoize）。所以按 `revision` 缓存：
 *    文件没变就直接复用上次结果，只有真的追加过才重新解码。
 * 2. **超过 `maxDecodeBytes` 就放弃探测**：不能为了列表上一个数字，在每次刷新时
 *    把几十个大日志全解一遍。放弃时 `lastSeq: null`（**未知**，不是 0），
 *    手机端据此显示「未探测」而不是假装「没有新事件」。
 *
 * `state` 的口径：协议六态由 `turn/end.reason` 单向下发（`wbsync/1 r2`）。本模块给的是
 * **启动时的引导值**——`resolveState()` 能问到运行态就用，问不到就是 `stopped`
 * （日志已落盘、当前没有正在跑的 turn），落盘格式坏掉则是 `unreadable`。
 */

export const STATES = ['running', 'awaiting', 'completed', 'stopped', 'failed', 'unreadable']
export const DEFAULT_LIMIT = 50
export const DEFAULT_MAX_DECODE_BYTES = 8 * 1024 * 1024

const pick = (obj, key, fallback = null) => (obj?.[key] === undefined ? fallback : obj[key])

/** headerRef 只挑契约里列出的字段，不把整个 header 塞进索引（ADR-010：索引不放正文）。 */
export const toHeaderRef = (header) => ({
  version: pick(header, 'version'),
  parentSession: pick(header, 'parentSession'),
  delegationDepth: pick(header, 'delegationDepth'),
  agentPreset: pick(header, 'agentPreset'),
  isSeeded: pick(header, 'isSeeded'),
  origin: pick(header, 'origin'),
})

/** 落盘格式坏掉 / 读不出来 → 会话仍然要出现在列表里，但标成「不可读」。 */
const isUnreadable = (formatStatus) => {
  const s = String(formatStatus ?? '').toLowerCase()
  return s === 'unreadable' || s === 'corrupt' || s === 'invalid'
}

/**
 * @param listSessions 正式版绑 `ctx.sessionPersistence.list`
 * @param openSession  正式版绑 `(id) => ctx.sessionPersistence.open(id, 'read')`
 * @param resolveState 可选：问宿主会话运行态，返回六态之一
 */
export function createSessionIndexReporter({
  listSessions,
  openSession = null,
  resolveState = null,
  deviceId = null,
  limit = DEFAULT_LIMIT,
  maxDecodeBytes = DEFAULT_MAX_DECODE_BYTES,
} = {}) {
  if (typeof listSessions !== 'function') {
    throw new TypeError('createSessionIndexReporter 需要 listSessions(options)')
  }
  const cap = Math.max(1, Number(limit) || DEFAULT_LIMIT)
  const budget = Number(maxDecodeBytes) > 0 ? Number(maxDecodeBytes) : DEFAULT_MAX_DECODE_BYTES

  /** id -> { revision, lastSeq, lastActiveAt }；只在 revision 变化时失效。 */
  const cache = new Map()

  const probe = async (snapshot) => {
    const id = snapshot?.header?.id
    const revision = String(snapshot?.revision ?? '')
    const hit = cache.get(id)
    if (hit && hit.revision === revision) return { ...hit, from: 'cache' }
    if (!openSession) return { lastSeq: null, lastActiveAt: null, from: 'no-reader' }
    if (Number(snapshot?.sizeBytes ?? 0) > budget) {
      // 不解码，但要把缓存里过期的条目清掉，避免下次误命中旧值
      cache.delete(id)
      return { lastSeq: null, lastActiveAt: null, from: 'over-budget' }
    }

    let handle
    try {
      handle = await openSession(id)
    } catch {
      cache.delete(id)
      return { lastSeq: null, lastActiveAt: null, from: 'open-failed' }
    }
    try {
      // read(0, 全部)：宿主没有条数接口，只能解码后取长度（同 revision 会被缓存）
      const r = await handle.read(0, Number.MAX_SAFE_INTEGER)
      const events = Array.isArray(r?.events) ? r.events : []
      const last = events[events.length - 1]
      const entry = {
        revision,
        lastSeq: typeof last?.seq === 'number' ? last.seq : null,
        lastActiveAt: typeof last?.time === 'number' ? last.time : null,
      }
      cache.set(id, entry)
      return { ...entry, from: 'decoded' }
    } catch {
      cache.delete(id)
      return { lastSeq: null, lastActiveAt: null, from: 'read-failed' }
    } finally {
      try { await handle.close?.() } catch { /* 已关闭 */ }
    }
  }

  const stateOf = (header, unreadable) => {
    if (unreadable) return 'unreadable'
    const hinted = typeof resolveState === 'function' ? resolveState(header.id) : null
    return STATES.includes(hinted) ? hinted : 'stopped'
  }

  return async function collect(options = {}) {
    let snapshots
    try {
      snapshots = await listSessions(options.listOptions ?? {})
    } catch (error) {
      return { rows: [], error: `list 失败：${error?.message ?? 'unknown'}`, stats: { total: 0 } }
    }
    const list = Array.isArray(snapshots) ? snapshots : []
    // 新会话优先；超出 cap 的不丢逻辑，只是本轮不上报（手机仍能按需 follow）
    const sorted = [...list]
      .filter((s) => s?.header?.id)
      .sort((a, b) => (b.header.createdAt ?? 0) - (a.header.createdAt ?? 0))
      .slice(0, cap)

    const stats = { total: list.length, reported: sorted.length, decoded: 0, cache: 0, skipped: 0 }
    const sources = {}
    const rows = []
    for (const snapshot of sorted) {
      const header = snapshot.header ?? {}
      const unreadable = isUnreadable(snapshot.formatStatus)
      const p = unreadable
        ? { lastSeq: null, lastActiveAt: null, from: 'unreadable' }
        : await probe(snapshot)
      if (p.from === 'decoded') stats.decoded++
      else if (p.from === 'cache') stats.cache++
      else if (!unreadable) stats.skipped++

      rows.push({
        sessionId: header.id,
        ownerDeviceId: deviceId,
        workspace: pick(header, 'cwd'),
        title: pick(header, 'title'),
        // 置顶与排序是 PC 侧状态（协议规定手机只读），Host 日志里没有，默认不置顶
        pinned: false,
        pinnedOrder: 0,
        state: stateOf(header, unreadable),
        lastSeq: p.lastSeq,
        lastActiveAt: p.lastActiveAt ?? pick(header, 'createdAt'),
        headerRef: toHeaderRef(header),
      })
      // 「为什么 lastSeq 是空的」不进契约行，放在 stats.sources 里给日志与状态路由用
      sources[p.from] = (sources[p.from] ?? 0) + 1
    }
    return { rows, error: null, stats: { ...stats, sources } }
  }
}
