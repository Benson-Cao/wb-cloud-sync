/**
 * dsh-wb-cloud-sync-host · P1 W3 Host 插件可安装 bundle（**自动生成，勿手改**）
 * ---------------------------------------------------------------
 * 由 p1/host-plugin/build-bundle.mjs 从 src/{index,replay,sessions,host-adapters}.js 合成：
 * 改源码后运行 `node p1/host-plugin/build-bundle.mjs` 重新生成（CI 有 --check 同步校验）。
 * 外层 wrapper 负责默认配置：代码默认 ← ~/.dsh/wbsync-host.json ← WBSYNC_* 环境变量 ← apply 的 config。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

// ===== 内联自 src/replay.js（重启后历史补齐，只读回放） =====
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

const DEFAULT_PAGE_SIZE = 500
const MAX_PAGE_SIZE = 5000
/**
 * 单帧字节预算。真机取证（2026-11-11，胎教Agent 会话）：74 条事件就有 454 KiB，
 * 平均 6.1 KiB/条，按旧版 500 条一页推算约 3 MiB —— 超过 Relay WS 的
 * MAX_PAYLOAD(1 MiB) 会被 1009 断连，在途补齐请求只能熬到 504 NO_PROGRESS。
 * 协议 §5.3 更要求 ≤64KiB，这里留 16 KiB 给帧封装与外层字段，取 48 KiB。
 */
const DEFAULT_REPLAY_MAX_BYTES = 48 * 1024
/**
 * 硬安全网：单条事件本身超过这个数就不发了。否则 Relay WS 会以 1009 断连，
 * 手机只看到 10s 后的 504，根本不知道是哪条事件把连接撑爆的。
 * 宁可回一个明确的 FRAME_TOO_LARGE，也不要静默断连。
 */
const HARD_FRAME_LIMIT_BYTES = 768 * 1024

const encoder = new TextEncoder()
/** 单条事件序列化后的字节数（用 UTF-8 实算，不按字符数猜）。 */
const eventBytes = (ev) => encoder.encode(JSON.stringify(ev)).length

/**
 * 纯函数：按字节预算裁一页，保证「至少给一条」——单条就超预算时若一条都不给，
 * 客户端的 sinceSeq 永远推不动，会变成无限重试。
 * 返回 oversized 让调用方知道这一页是硬塞过去的，不是预算内正常页。
 */
function pickWithinBudget(events, maxBytes = DEFAULT_REPLAY_MAX_BYTES) {
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
function contiguousPrefix(events, sinceSeq) {
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
function createReplayAdapter({ openSession, pageSize = DEFAULT_PAGE_SIZE, maxBytes = DEFAULT_REPLAY_MAX_BYTES } = {}) {
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
function createBackfillReader({ openSession, maxBytes = DEFAULT_REPLAY_MAX_BYTES, maxRows = 200 } = {}) {
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
// ===== 内联自 src/sessions.js（会话索引上报） =====
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

const STATES = ['running', 'awaiting', 'completed', 'stopped', 'failed', 'unreadable']
const DEFAULT_LIMIT = 50
const DEFAULT_MAX_DECODE_BYTES = 8 * 1024 * 1024

const pick = (obj, key, fallback = null) => (obj?.[key] === undefined ? fallback : obj[key])

/** headerRef 只挑契约里列出的字段，不把整个 header 塞进索引（ADR-010：索引不放正文）。 */
const toHeaderRef = (header) => ({
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
function createSessionIndexReporter({
  listSessions,
  openSession = null,
  resolveState = null,
  // 可选：() => string[]，宿主 workspaces 的全局置顶集合（最近置顶在前）。
  // 没有就都当未置顶——**不猜**：置顶是 PC 侧状态，猜出来的比空着更糟。
  pinnedIds = null,
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

  /** 增量上报基线：id -> 行指纹。首轮（或重连后）必须发 full 建立 CP 基线。 */
  const lastSent = new Map()
  let bootstrapped = false

  const collectFn = async function collect(options = {}) {
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

    // 置顶集合：宿主口径是「最近置顶在前」，索引就按它给 pinnedOrder（0 = 最近）
    const pinIndex = new Map()
    try {
      const ids = typeof pinnedIds === 'function' ? pinnedIds() : null
      if (Array.isArray(ids)) ids.forEach((id, i) => pinIndex.set(id, i))
    } catch { /* 读不到就当没置顶，不影响列表 */ }

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
        // 置顶来自宿主 workspaces 的全局集合（r11）：日志里没有这份状态，问宿主要
        pinned: pinIndex.has(header.id),
        pinnedOrder: pinIndex.get(header.id) ?? 0,
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

  /**
   * 增量快照：只返回新增 / 变化的行与消失的 id。
   * 行不多（默认上限 50），用整行 JSON 作指纹，避免逐字段 diff 漏判。
   * `mode:'full'` 表示首轮或重连后重建基线，Relay 应走全量替换；
   * `mode:'diff'` 只应用 upserts 与 removedIds，绝不误删未提及的行。
   */
  collectFn.collectDiff = async (options = {}) => {
    const snap = await collectFn(options)
    if (snap.error) return { ...snap, rows: [], removedIds: [], unchanged: 0, mode: 'full' }
    const next = new Map()
    const rows = []
    let unchanged = 0
    for (const row of snap.rows) {
      const fp = JSON.stringify(row)
      next.set(row.sessionId, fp)
      if (lastSent.get(row.sessionId) === fp) unchanged++
      else rows.push(row)
    }
    const removedIds = [...lastSent.keys()].filter((id) => !next.has(id))
    const mode = bootstrapped ? 'diff' : 'full'
    lastSent.clear()
    for (const [id, fp] of next) lastSent.set(id, fp)
    bootstrapped = true
    return { ...snap, rows, removedIds, unchanged, mode, total: snap.rows.length }
  }

  /** 重连后 CP 可能已重建：清空基线，下一轮重新发 full。 */
  collectFn.resetBaseline = () => { lastSent.clear(); bootstrapped = false }

  return collectFn
}
// ===== 内联自 src/host-adapters.js（宿主真实入口：create / prompt 软探测） =====
/**
 * P1 W3 · 宿主真实入口适配器（bundle 与源码共用）
 * ---------------------------------------------------------------
 * 真机取证四轮（2026-11-10），结论以第 4 轮 DSH asar 为准：
 *   - 0.1.2：`lookupService` 共用一个 try，cordis 访问未注入属性抛错 →
 *     `ctx.get` 被吞，writer 全 false。已修（每路独立 try）。
 *   - 0.1.3：枚举 **client 侧** `reflect.provide` 得出「没有 sessionController
 *     服务」——**误判**。host 侧确有 `SessionController extends Service`，
 *     构造里 `super(ctx, "sessionController", { namespace: "session" })`，
 *     只是它 `static inject` 了 13 个依赖、注册晚于本插件 apply。
 *   - 0.1.4：一次探测整张候选表，但用的是 **apply 时的静态快照**，且把
 *     `sessions.create` 排在首位。真机 status 显示 `sessionController:false`、
 *     `sessions:true` → 选中 `sessions.create({cwd})` → `HOST_ADAPTER_ERROR`。
 *   - 0.1.5：asar 官方实现证明新建会话的完整链路是
 *       `SessionController.create(request) → this.commands.create(request)`
 *         → `SessionCommandController.create` → `this.agents.createSession({cwd, reusable})`
 *         → `ApiSessionAgentController.createMinted` → `ctx.agents.create({
 *              sessionId: 'session-<uuid>', meta: { cwd }, agentOptions, setup })`
 *       返回 `{ sessionId }`。`session/prompt` 的 required 是
 *       `requestId / sessionId / mode / content`，第二参是 signal。
 *     `sessions` 是 host 侧 **SessionRegistry**（store / enter / announce /
 *     liveEntryFor / fork），`create` 只建 entry，**不是**新建会话入口。
 *     `agents` 是 **AgentRegistry**（`super(ctx,"agents")`），公开
 *     `create(options)` 的注释即「constructs the agent and its session」。
 *
 * 因此 0.1.5：
 *   1) **每次调用惰性重探**服务，不再用 apply 时的静态快照（依赖晚到也能接上）；
 *   2) 候选按「官方完整语义 → 内部同义 → 底层兜底」排序，`sessions.create`
 *      降为末位（真机已证实它会抛错，仅在别无选择时如实尝试）；
 *   3) status 同时报 boot 快照 / 当前 / lateBound，下一轮不用再猜。
 *
 * 铁律（ADR-008 / 03 §3.1）不变：**绝不 `open(id,'write')`、不自己追加日志**；
 * 服务软探测，绝不写进顶层 `inject`（缺服务会让整个插件 pending）。探测不到
 * 如实 409 `WRITER_UNAVAILABLE`。
 *
 * 部分成功语义：create 已建出会话但第一句话发送失败时，会话已经客观存在，
 * 必须返回成功并附 `prompted:false / promptError`，否则手机会重复创建。
 */

const SERVICE_CANDIDATES = [
  'sessionController', 'sessions', 'agents', 'connection', 'gateway',
  'workspaceRegistry', 'sessionPersistence', 'typert',
  // 置顶/归档：WorkspaceController，cordis 名 'workspaces'（r11）
  'workspaces',
  // 附件上行：`fileUploads`（super(ctx,"fileUploads")）与它依赖的 `attachments`
  'fileUploads', 'attachments',
]

/**
 * 每路独立 try：cordis 的 Proxy 访问未注入属性会抛（0.1.2 同类坑）。
 * 同时记录命中路径与各路异常，供 /__wbsync/status 做真机诊断。
 */
const resolveService = (ctx, name) => {
  const errors = []
  try {
    const got = typeof ctx?.get === 'function' ? ctx.get(name) : undefined
    if (got) return { svc: got, via: 'ctx.get', errors }
  } catch (error) { errors.push(`ctx.get: ${error?.message ?? String(error)}`) }
  try {
    if (ctx?.[name]) return { svc: ctx[name], via: `ctx[${name}]`, errors }
  } catch (error) { errors.push(`ctx[${name}]: ${error?.message ?? String(error)}`) }
  try {
    const root = ctx?.root
    if (root) {
      const got = typeof root.get === 'function' ? root.get(name) : root[name]
      if (got) return { svc: got, via: 'root', errors }
    }
  } catch (error) { errors.push(`root: ${error?.message ?? String(error)}`) }
  return { svc: undefined, via: null, errors }
}

/** 惰性快照：每次调用都重新解析，宿主晚注册的服务会自动接上。 */
const probeServices = (ctx) => {
  const services = {}
  const resolved = {}
  for (const name of SERVICE_CANDIDATES) {
    const r = resolveService(ctx, name)
    if (r.svc) services[name] = r.svc
    resolved[name] = { present: Boolean(r.svc), via: r.via, errors: r.errors }
  }
  return { services, resolved }
}

const methodsOf = (obj) => {
  try {
    const names = new Set()
    let cur = obj
    for (let depth = 0; depth < 4 && cur; depth++, cur = Object.getPrototypeOf(cur)) {
      for (const k of Object.getOwnPropertyNames(cur)) names.add(k)
    }
    return [...names].filter((k) => !k.startsWith('_') && k !== 'constructor').slice(0, 60)
  } catch { return [] }
}

const sessionIdOf = (r) => {
  if (typeof r === 'string') return r
  const id = r?.sessionId ?? r?.agent?.id ?? r?.id
  return typeof id === 'string' && id ? id : null
}

/** 真机「未返回 sessionId」时把返回结构带回来，避免再猜一轮。 */
const shapeOf = (v) => {
  if (v === null || v === undefined) return String(v)
  if (typeof v !== 'object') return typeof v
  try { return JSON.stringify(Object.keys(v).slice(0, 12)) } catch { return 'object' }
}

const fallbackId = () => {
  const uuid = globalThis.crypto?.randomUUID?.()
  return uuid ?? `wbsync-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/** 官方 `SessionController.create` 优先；`sessions.create` 只作末位兜底。 */
const createEntry = (services) => {
  const c = services.sessionController
  if (c) {
    if (typeof c.create === 'function') return { svc: c, name: 'sessionController', kind: 'create' }
    if (typeof c.commands?.create === 'function') return { svc: c.commands, name: 'sessionController.commands', kind: 'create' }
    if (typeof c.agents?.createSession === 'function') return { svc: c.agents, name: 'sessionController.agents', kind: 'createSession' }
  }
  if (typeof services.agents?.createSession === 'function') {
    return { svc: services.agents, name: 'agents', kind: 'createSession' }
  }
  if (typeof services.agents?.create === 'function') {
    return { svc: services.agents, name: 'agents', kind: 'create' }
  }
  // 低层 SessionRegistry：真机 0.1.4 已证实会抛错，仅别无选择时如实尝试
  if (typeof services.sessions?.create === 'function') {
    return { svc: services.sessions, name: 'sessions', kind: 'create' }
  }
  return null
}

/** 官方 `sessionController.prompt(request, signal)` 优先，agents.followup 次之。 */
const promptEntry = (services) => {
  const c = services.sessionController
  if (typeof c?.prompt === 'function') return { svc: c, name: 'sessionController', kind: 'prompt' }
  if (typeof c?.commands?.prompt === 'function') return { svc: c.commands, name: 'sessionController.commands', kind: 'prompt' }
  if (typeof services.sessions?.prompt === 'function') {
    return { svc: services.sessions, name: 'sessions', kind: 'prompt' }
  }
  if (typeof services.agents?.get === 'function') {
    return { svc: services.agents, name: 'agents', kind: 'followup' }
  }
  return null
}

/**
 * 置顶/取消置顶（r11）：宿主 `WorkspaceController`（cordis 名 `workspaces`）。
 * 方法签名（asar 取证）：`pinSession(sessionId) / unpinSession(sessionId)`，
 * 返回 Remote 风格 `{ ok, value: { pinnedSessionIds } }`（最近置顶在前的全局集合）。
 * 找不到就如实报「没有这个入口」，绝不自己改索引假装成功。
 */
const workspaceEntry = (services) => {
  // 真机 status 取证：插件在主进程里看到的是 **workspaceRegistry**（lateBound，
  // 带 pinSession/unpinSession/pinnedSessionIds/archiveSession/delete）；
  // 渲染进程的 `workspaces` 服务在这边不可见，保留它只作兼容。
  const candidates = [services.workspaceRegistry, services.workspaces]
  for (const w of candidates) {
    if (!w) continue
    if (typeof w.pinSession === 'function' && typeof w.unpinSession === 'function') return w
    const inner = w.workspace ?? w.model
    if (inner && typeof inner.pinSession === 'function' && typeof inner.unpinSession === 'function') return inner
  }
  return null
}

/**
 * 官方 `session/cancel`（asar 取证）：required 只有 sessionId，
 * `SessionController.cancel(request) → commands.cancel(request)` →
 * `agent.cancel({ kind: "user" }, { keepInbox: true })`，返回 `{ accepted: true }`。
 * 只取消当前轮次、保留待处理收件箱，不自行中断进程或删事件。
 */
const cancelEntry = (services) => {
  const c = services.sessionController
  if (typeof c?.cancel === 'function') return { svc: c, name: 'sessionController', kind: 'cancel' }
  if (typeof c?.commands?.cancel === 'function') return { svc: c.commands, name: 'sessionController.commands', kind: 'cancel' }
  if (typeof services.agents?.get === 'function') {
    return { svc: services.agents, name: 'agents', kind: 'agentCancel' }
  }
  return null
}

/**
 * 附件上行入口（asar 取证）：`fileUploads` 是 cordis 服务，
 *   `upload(agent, request, signal)` —— 第一参是 **Agent 对象**（@Remote 由 Typert 解析），
 *     request = `{ data: base64, name? }`，返回 `{ receiptId, file:{attachmentId,name,bytes} }`；
 *   `uploadStream({ sessionId, data: AsyncIterable<Uint8Array>, name? })` —— 接受 sessionId。
 * `receiptId` 只在接收 Agent 作用域内有效，必须与同一 session 的 prompt 一起用。
 */
const uploadEntry = (services) => {
  const f = services.fileUploads
  // 优先 uploadStream：它吃 sessionId，内部用 SessionController 注册的 resolver 解析**冷会话**；
  // upload(agent, …) 要求调用方自己给出已挂载的 live Agent，空会话 `agents.get()` 会是 undefined
  // （真机 0.1.9 实测：新建的空会话上传报 `会话未挂载`）。
  if (typeof f?.uploadStream === 'function') {
    return { svc: f, name: 'fileUploads', kind: 'uploadStream' }
  }
  if (typeof f?.upload === 'function' && typeof services.agents?.get === 'function') {
    return { svc: f, name: 'fileUploads', kind: 'upload' }
  }
  return null
}

function createHostAdapters(ctx, options = {}) {
  // 只留作「服务注册晚于插件」的对照，不参与实际调用（0.1.4 的教训）。
  const boot = probeServices(ctx)
  const randomId = typeof options.randomId === 'function' ? options.randomId : fallbackId
  const current = () => probeServices(ctx).services

  const unavailable = (what, services) => ({
    ok: false,
    code: 'WRITER_UNAVAILABLE',
    message: `宿主未提供 ${what}；可见服务：${Object.keys(services).join(', ') || '(无)'}。不得自开写句柄`,
  })
  const asError = (error, entry) => ({
    ok: false,
    code: 'HOST_ADAPTER_ERROR',
    message: `${entry ? `${entry.name}.${entry.kind}: ` : ''}${error?.message ?? String(error)}`,
  })

  /**
   * 「排队期间」的幂等补丁（见 submitPrompt 的说明）：
   * 同 (sessionId, clientMsgId) 10 分钟内只放行一次。表有上界，超了就淘汰最老的一半。
   */
  const recentPrompts = new Map()          // `${sessionId}|${clientMsgId}` -> ts
  const PROMPT_DEDUPE_TTL_MS = 10 * 60_000
  const PROMPT_DEDUPE_MAX = 200
  const isDuplicatePrompt = (sessionId, clientMsgId) => {
    if (!sessionId || !clientMsgId) return false          // 没有幂等键就别假装有
    const key = `${sessionId}|${clientMsgId}`
    const now = Date.now()
    const prev = recentPrompts.get(key)
    if (typeof prev === 'number' && now - prev < PROMPT_DEDUPE_TTL_MS) return true
    recentPrompts.set(key, now)
    if (recentPrompts.size > PROMPT_DEDUPE_MAX) {
      const byAge = [...recentPrompts.entries()].sort((a, b) => a[1] - b[1])
      for (const [k] of byAge.slice(0, Math.max(1, Math.floor(byAge.length / 2)))) recentPrompts.delete(k)
    }
    return false
  }

  /**
   * 提交一条消息。`extra` 是附加内容段（如 `{type:'file', receiptId}`），
   * 与文本一起按 session/prompt 的 content 顺序下发；文本为空时只发附件。
   */
  const promptText = async (sessionId, text, requestId, services, extra = []) => {
    const entry = promptEntry(services)
    if (!entry) return unavailable('可用的消息提交入口（prompt / followup）', services)
    const trimmed = typeof text === 'string' ? text.trim() : ''
    const content = [...(trimmed ? [{ type: 'text', text }] : []), ...extra]
    if (!content.length) {
      return { ok: false, code: 'HOST_ADAPTER_ERROR', message: '消息内容为空（无文本也无附件）' }
    }
    const rid = requestId || randomId()
    try {
      if (entry.kind === 'followup') {
        const agent = entry.svc.get(sessionId)
        if (typeof agent?.followup !== 'function') {
          return { ok: false, code: 'HOST_ADAPTER_ERROR', message: `agents.get(${sessionId}) 无 followup` }
        }
        await agent.followup({
          id: rid, role: 'user',
          content,
          source: { kind: 'plugin:wbsync' },
        })
        return { ok: true, value: { accepted: true }, requestId: rid }
      }
      // 官方 (request, signal)：required = requestId / sessionId / mode / content
      const signal = typeof AbortController === 'function' ? new AbortController().signal : undefined
      const r = await entry.svc.prompt(
        { requestId: rid, sessionId, mode: 'queue', content },
        signal,
      )
      return { ok: true, value: r ?? { accepted: true }, requestId: rid }
    } catch (error) {
      return asError(error, entry)
    }
  }

  return {
    /** 给 /__wbsync/status 做真机自检：动态服务清单 + 实际选中的写入通道。 */
    capabilities: () => {
      let keys = []
      try { keys = Object.keys(ctx ?? {}).filter((k) => typeof k === 'string').slice(0, 40) } catch { /* Proxy 可能拒绝 enumerate */ }
      const safeType = (name) => { try { return typeof ctx?.[name] } catch { return 'blocked' } }
      const safeBool = (name) => { try { return Boolean(ctx?.[name]) } catch { return false } }
      const now = probeServices(ctx)
      const c = createEntry(now.services)
      const p = promptEntry(now.services)
      const x = cancelEntry(now.services)
      const u = uploadEntry(now.services)
      const serviceReport = {}
      for (const name of SERVICE_CANDIDATES) {
        const r = now.resolved[name]
        serviceReport[name] = r.present
          ? { present: true, via: r.via, methods: methodsOf(now.services[name]) }
          : { present: false, errors: r.errors }
      }
      return {
        controller: Boolean(c),
        create: Boolean(c),
        prompt: Boolean(p),
        cancel: Boolean(x),
        upload: Boolean(u),
        writer: c ? `${c.name}.${c.kind}` : null,
        messenger: p ? `${p.name}.${p.kind}` : null,
        canceller: x ? `${x.name}.${x.kind}` : null,
        uploader: u ? `${u.name}.${u.kind}` : null,
        probe: {
          hasGet: safeType('get') === 'function',
          hasInject: safeType('inject') === 'function',
          hasRoot: safeBool('root'),
          keys,
          // apply 时缺席、现在可见的服务 → 证明惰性探测确实接上了晚到依赖
          boot: Object.fromEntries(SERVICE_CANDIDATES.map((n) => [n, boot.resolved[n].present])),
          lateBound: SERVICE_CANDIDATES.filter((n) => !boot.resolved[n].present && now.resolved[n].present),
          services: serviceReport,
        },
      }
    },

    /**
     * 手机向已有会话发一句话：clientMsgId → requestId。
     *
     * **补一层短期去重**（真机取证 2026-11-11）：宿主的 requestId 去重只覆盖
     * 「已经落成 user/message 的消息」，管不住还挂在 `mode:'queue'` 里的那份 ——
     * 同一个 clientMsgId 连发 5 次，实测落了 **2 条** user/message（M1-4 因此不达标），
     * 手机上表现为同一句话被回答两次。
     *
     * 所以这里按 (sessionId, clientMsgId) 记 10 分钟：重复的直接回
     * `{ accepted: true, duplicate: true }`，**不再转发给宿主**。
     * 这一层不替代宿主幂等，只是把「排队期间」这个空隙补上；TTL 与条数都设上界，
     * 免得长跑进程把这张表养成内存泄漏。
     */
    submitPrompt: async ({ sessionId, text, clientMsgId, attachments }) => {
      if (!sessionId) {
        return { ok: false, code: 'HOST_ADAPTER_ERROR', message: 'submitPrompt 缺 sessionId' }
      }
      // attachments 允许传 receiptId 字符串或 {type:'file',receiptId} 对象
      const extra = (Array.isArray(attachments) ? attachments : [])
        .map((a) => (typeof a === 'string' ? { type: 'file', receiptId: a } : a))
        .filter((a) => a && a.type === 'file' && typeof a.receiptId === 'string' && a.receiptId)
      if (typeof text !== 'string' && !extra.length) {
        return { ok: false, code: 'HOST_ADAPTER_ERROR', message: 'submitPrompt 缺 text / attachments' }
      }
      if (isDuplicatePrompt(sessionId, clientMsgId)) {
        return { ok: true, value: { accepted: true, duplicate: true } }
      }
      const r = await promptText(sessionId, text ?? '', clientMsgId, current(), extra)
      return r.requestId ? { ok: r.ok, code: r.code, message: r.message, value: r.value } : r
    },

    /**
     * 置顶 / 取消置顶（r11）。委托宿主 `workspaces.pinSession / unpinSession`，
     * 返回宿主给的**完整**置顶集合（最近置顶在前）——调用方拿它刷新索引，
     * 不要用「翻转本地布尔」去猜：置顶集合是全局的，别的端也可能改。
     */
    setPinned: async ({ sessionId, pinned = true } = {}) => {
      if (!sessionId) {
        return { ok: false, code: 'HOST_ADAPTER_ERROR', message: 'setPinned 缺 sessionId' }
      }
      const services = current()
      const w = workspaceEntry(services)
      if (!w) return unavailable('workspaces.pinSession/unpinSession', services)
      try {
        const r = pinned ? await w.pinSession(sessionId) : await w.unpinSession(sessionId)
        let ids = r?.value?.pinnedSessionIds ?? (Array.isArray(r) ? r : null)
        if (!Array.isArray(ids)) {
          // workspaceRegistry 的 command 方法成功时不返回值（失败才抛），
          // 但服务本身带实时集合——读它，别让调用方退化成「猜一个布尔」。
          let live = w.pinnedSessionIds
          if (typeof live === 'function') live = live()
          if (Array.isArray(live)) ids = live
        }
        return { ok: r?.ok !== false, value: { pinned: Boolean(pinned), pinnedSessionIds: Array.isArray(ids) ? ids : [] } }
      } catch (error) {
        return asError(error, { name: 'workspaces', kind: pinned ? 'pinSession' : 'unpinSession' })
      }
    },

    /** 取消当前轮次：官方 session/cancel 只吃 { sessionId }，保留 pending inbox。 */
    cancelTurn: async ({ sessionId } = {}) => {
      const services = current()
      const entry = cancelEntry(services)
      if (!entry) return unavailable('可用的取消轮次入口（cancel）', services)
      if (!sessionId) {
        return { ok: false, code: 'HOST_ADAPTER_ERROR', message: 'cancelTurn 缺 sessionId' }
      }
      try {
        if (entry.kind === 'agentCancel') {
          const agent = entry.svc.get(sessionId)
          if (typeof agent?.cancel !== 'function') {
            return { ok: false, code: 'HOST_ADAPTER_ERROR', message: `agents.get(${sessionId}) 无 cancel` }
          }
          agent.cancel({ kind: 'user' }, { keepInbox: true })
          return { ok: true, value: { cancelled: true } }
        }
        const r = await entry.svc.cancel({ sessionId })
        return { ok: true, value: r ?? { cancelled: true } }
      } catch (error) {
        return asError(error, entry)
      }
    },

    /**
     * 附件上行：base64 → 宿主 `fileUploads`，返回 `receiptId` 供同一 session 的 prompt 引用。
     * 本插件不落任何文件内容，只做透传；体积上限由调用方（Relay，1 MiB body）先行拒绝。
     */
    uploadAttachment: async ({ sessionId, data, name } = {}) => {
      const services = current()
      const entry = uploadEntry(services)
      if (!entry) return unavailable('可用的附件上传入口（fileUploads）', services)
      if (!sessionId || typeof data !== 'string' || !data) {
        return { ok: false, code: 'HOST_ADAPTER_ERROR', message: 'uploadAttachment 缺 sessionId / data' }
      }
      const signal = typeof AbortController === 'function' ? new AbortController().signal : undefined
      try {
        if (entry.kind === 'upload') {
          const agent = services.agents.get(sessionId)
          if (!agent) {
            return { ok: false, code: 'HOST_ADAPTER_ERROR', message: `会话未挂载，无法上传：${sessionId}` }
          }
          const r = await entry.svc.upload(agent, { data, ...(name ? { name } : {}) }, signal)
          return { ok: true, value: { receiptId: r?.receiptId ?? null, file: r?.file ?? null } }
        }
        // uploadStream 形态：把 base64 还原成一帧字节流，交给服务自己 resolveAgent
        async function* chunks() { yield Uint8Array.from(Buffer.from(data, 'base64')) }
        const r = await entry.svc.uploadStream({ sessionId, data: chunks(), ...(name ? { name } : {}) })
        return { ok: true, value: { receiptId: r?.receiptId ?? null, file: r?.file ?? null } }
      } catch (error) {
        return asError(error, entry)
      }
    },

    /** 新建会话（+ 可选第一句话）。 */
    createSession: async ({ text, cwd } = {}) => {
      const services = current()
      const entry = createEntry(services)
      if (!entry) return unavailable('可用的新建会话入口（create / createSession）', services)
      let created
      try {
        if (entry.kind === 'createSession') {
          // ApiSessionAgentController 形态：cwd + reusable 回调
          created = await entry.svc.createSession({ ...(cwd ? { cwd } : {}), reusable: () => false })
        } else if (entry.name === 'agents') {
          // AgentRegistry 底层兜底：复刻官方 createMinted，自铸 session-<uuid>
          created = await entry.svc.create({
            sessionId: `session-${randomId()}`,
            meta: { cwd: cwd || globalThis.process?.cwd?.() || '.' },
            agentOptions: {},
          })
        } else {
          // 官方 SessionController.create / commands.create / sessions.create
          // workspaceId 与 cwd 互斥；缺省不传，让宿主用 defaultCwd (process.cwd())
          created = await entry.svc.create(cwd ? { cwd } : {})
        }
      } catch (error) {
        return asError(error, entry)
      }
      const sessionId = sessionIdOf(created)
      if (!sessionId) {
        return {
          ok: false,
          code: 'HOST_ADAPTER_ERROR',
          message: `宿主 ${entry.name}.${entry.kind} 未返回 sessionId（结构 ${shapeOf(created)}）`,
        }
      }
      const value = { sessionId }
      if (created && typeof created === 'object' && created.agentPreset !== undefined) {
        value.agentPreset = created.agentPreset
      }

      const first = typeof text === 'string' ? text.trim() : ''
      if (first) {
        if (!promptEntry(services)) {
          value.prompted = false
          value.promptError = '宿主未提供消息提交入口，第一句话未发送'
        } else {
          const r = await promptText(sessionId, first, undefined, services)
          value.prompted = r.ok === true
          if (!r.ok) value.promptError = r.message ?? '第一句话发送失败'
        }
      }
      return { ok: true, value }
    },
  }
}
// ===== 内联自 src/approvals.js（审批瀑布 → 手机，先答先得） =====
/**
 * 审批转发桥（W8）· 把宿主的 `approval/request` 瀑布接到手机上
 * ---------------------------------------------------------------
 * 宿主实测契约（app.asar `interface ApprovalRequest` / `type ApprovalOutcome`）：
 *
 *   ctx.on('approval/request', (request, next) => Promise<ApprovalOutcome>)
 *   request: { agent, toolName, callId?, reason?, displayReason?, signal? }
 *   ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
 *   next(): 交棒给下一个应答方（桌面端自己的弹窗）。同步/异步调用均可。
 *
 * 三条不变量，改这块前先读：
 *   1. **手机不在线时必须 `next()`**。桌面端不能因为手机没连上就卡住审批——
 *      这是「手机是遥控器，不是闸门」的底线。
 *   2. **先答先得**。`signal` 被 abort（桌面端先答了、轮次取消、会话关掉）时，
 *      立刻把这一单从账本上摘掉并通知手机撤卡，不许两头都能改结果。
 *   3. **超时也 `next()`**，不返回 `unavailable`：`unavailable` 会让整次工具调用
 *      直接被拒（宿主语义是「无人可审批」），而超时只是「手机没来得及答」，
 *      桌面端还有机会接。
 */

const OUTCOMES = new Set(['allowed-once', 'rejected', 'cancelled'])

/** 把宿主给的 displayReason 收敛成一个字符串：优先中文，其次 en，最后退回 reason。 */
const pickReason = (request) => {
  const d = request?.displayReason
  if (d && typeof d === 'object') {
    const zh = d.zh ?? d['zh-CN'] ?? d['zh-Hans'] ?? d.zh_CN
    if (typeof zh === 'string' && zh.trim()) return zh.trim()
    if (typeof d.en === 'string' && d.en.trim()) return d.en.trim()
  }
  if (typeof request?.reason === 'string' && request.reason.trim()) return request.reason.trim()
  return null
}

/**
 * @param send          (frame) => boolean  上行帧发送器；返回 false 表示没连上
 * @param timeoutMs     手机应答窗口；超时后交棒给桌面端
 * @param now           注入时钟（测试用）
 * @param log           注入日志（默认不输出）
 */
function createApprovalBridge({ send, timeoutMs = 120_000, now = Date.now, log = () => {} } = {}) {
  const pending = new Map()   // approvalId -> { sessionId, toolName, resolve, timer, detach, expireAt }
  const stats = { requested: 0, answeredByPhone: 0, delegatedOffline: 0, delegatedTimeout: 0, aborted: 0, staleAnswers: 0 }

  const drop = (approvalId) => {
    const entry = pending.get(approvalId)
    if (!entry) return null
    pending.delete(approvalId)
    if (entry.timer) clearTimeout(entry.timer)
    if (entry.detach) { try { entry.detach() } catch { /* 已 detach */ } }
    return entry
  }

  /** 通知手机把卡片撤掉（不管是谁先答的）。 */
  const notifyResolved = (entry, outcome, by) => {
    try {
      send({ t: '$events/resolved', approvalId: entry.approvalId, outcome, by })
    } catch { /* 手机已断开：它下次拉列表时自然拿不到这条 */ }
  }

  /**
   * 注册到 ctx.on('approval/request', ...)。
   * 返回 ApprovalOutcome 或 next() 的结果。
   */
  const onRequest = async (request, next) => {
    const sessionId = request?.agent?.session?.id
    const callId = request?.callId
    // 拿不到会话就无从对应手机上的哪个会话，直接交棒，不试图猜
    if (!sessionId) return next()

    const approvalId = randomUUID()
    const frame = {
      t: '$events/request',
      approvalId,
      sessionId,
      toolName: typeof request.toolName === 'string' ? request.toolName : 'unknown',
      callId: callId ?? null,
      reason: pickReason(request),
      expiresAt: now() + timeoutMs,
    }
    stats.requested++
    if (!send(frame)) {
      // 手机不在线：不占着这单，让桌面端照常问
      stats.delegatedOffline++
      return next()
    }

    return new Promise((resolve) => {
      const settle = (outcome) => {
        const entry = drop(approvalId)
        if (!entry) return
        if (outcome === 'timeout') {
          stats.delegatedTimeout++
          notifyResolved(entry, 'cancelled', 'timeout')
          resolve(next())
          return
        }
        notifyResolved(entry, outcome, 'phone')
        resolve(outcome)
      }

      const timer = setTimeout(() => settle('timeout'), Math.max(1, timeoutMs))
      // 故意**不** unref：这单必须真的等到时间到才能交棒给桌面端。
      // unref 会让「只剩等待器」的场景直接退出事件循环，await 永远不落地。

      // 宿主 abort = 别人先答了 / 轮次没了：撤卡并交棒（下一次瀑布由宿主自己收尾）
      let onAbort = null
      const signal = request.signal
      if (signal && typeof signal.addEventListener === 'function') {
        onAbort = () => {
          const entry = drop(approvalId)
          if (!entry) return
          stats.aborted++
          notifyResolved(entry, 'cancelled', 'host')
          // 已经被别人答掉，交棒即可（宿主不会再等我们）
          resolve(next())
        }
        if (signal.aborted) { onAbort(); return }
        signal.addEventListener('abort', onAbort, { once: true })
      }

      pending.set(approvalId, {
        approvalId, sessionId, toolName: frame.toolName, expireAt: frame.expiresAt,
        resolve, timer,
        detach: () => { if (onAbort && signal?.removeEventListener) signal.removeEventListener('abort', onAbort) },
      })
    })
  }

  /** 手机点「允许 / 拒绝」→ 落到这里。返回是否被接受（先答先得）。 */
  const answer = ({ approvalId, outcome }) => {
    if (!OUTCOMES.has(outcome)) return { ok: false, code: 'INVALID_OUTCOME' }
    const entry = pending.get(approvalId)
    if (!entry) {
      stats.staleAnswers++
      return { ok: false, code: 'APPROVAL_GONE' }
    }
    drop(approvalId)
    stats.answeredByPhone++
    notifyResolved(entry, outcome, 'phone')
    try { entry.resolve(outcome) } catch { /* 宿主已放弃等待 */ }
    return { ok: true, outcome }
  }

  /** 手机上线后拉取未决清单。 */
  const list = () => [...pending.values()].map((e) => ({
    approvalId: e.approvalId, sessionId: e.sessionId, toolName: e.toolName, expireAt: e.expireAt,
  }))

  const dispose = () => {
    for (const id of [...pending.keys()]) {
      const e = drop(id)
      if (!e) continue
      notifyResolved(e, 'cancelled', 'shutdown')
      try { e.resolve('cancelled') } catch { /* 忽略 */ }
    }
  }

  return { onRequest, answer, list, dispose, stats, pending }
}
// ===== 内联自 src/artifacts.js（产物索引，只读日志扫描） =====
/**
 * W8 · 产物索引（Host 侧，只读）
 * ---------------------------------------------------------------
 * 宿主实测契约（app.asar 的 `isPresentedData` / `isPresentedFile`）：
 *
 *   { type: 'deliverables/presented', seq, data: {
 *       turn: number(≥1), callId: string,
 *       files: [{ path: string, description?: string }],
 *       host?: {...}
 *   }}
 *
 * 这条事件本来就在 `session/event` 流里（插件已原样上行），所以**不需要新协议帧**：
 * 手机点开会话时用既有的 `session/*` 下行通道问一次，Host 从 append-only 会话日志里
 * 只读扫一遍，把显式「呈现」过的文件列出来。这样即便手机晚连、Relay 缓冲被裁掉，
 * 也不会看不到早期产物。
 *
 * 边界（ADR-010 / docs/04 §5.4）：**只过元数据（路径 / 描述 / seq），绝不过文件字节**。
 * 工作区文件不经 Relay / CP。卡片能做的事是「看到有什么」和「复制路径」，
 * 打开文件由桌面端自己的文件动作负责。
 */
const MAX_ARTIFACT_ROWS = 200

/** 斜杠 / 反斜杠都算分隔符：Host 在 Windows 上给的路径常带反斜杠。 */
const basename = (path) => {
  const at = Math.max(String(path).lastIndexOf('/'), String(path).lastIndexOf('\\'))
  return at === -1 ? String(path) : String(path).slice(at + 1)
}

const isPresentedData = (data) =>
  data !== null && typeof data === 'object' && !Array.isArray(data)
  && typeof data.turn === 'number' && Number.isSafeInteger(data.turn) && data.turn >= 1
  && typeof data.callId === 'string' && data.callId.length > 0
  && Array.isArray(data.files)

const isPresentedFile = (file) =>
  file !== null && typeof file === 'object' && !Array.isArray(file)
  && typeof file.path === 'string' && file.path.trim().length > 0
  && (file.description === undefined || typeof file.description === 'string')

/** 纯函数：把一批事件折成产物行。去重键是 (seq, index)——同一事件重放不会重复出卡。 */
function scanArtifacts(events = []) {
  const rows = []
  const seen = new Set()
  for (const ev of Array.isArray(events) ? events : []) {
    if (ev?.type !== 'deliverables/presented' || !isPresentedData(ev.data)) continue
    if (!Number.isInteger(ev.seq) || ev.seq < 0) continue
    const { turn, callId, files } = ev.data
    for (let index = 0; index < files.length; index++) {
      const file = files[index]
      if (!isPresentedFile(file)) continue
      const key = `${ev.seq}:${index}`
      if (seen.has(key)) continue
      seen.add(key)
      rows.push({
        seq: ev.seq,
        turn,
        callId,
        index,
        path: file.path,
        name: basename(file.path.trim()),
        description: typeof file.description === 'string' ? file.description : null,
      })
    }
    if (rows.length >= MAX_ARTIFACT_ROWS) break
  }
  return rows.sort((a, b) => a.seq - b.seq || a.index - b.index)
}

/**
 * 从会话日志只读扫产物。
 * `handle.read(offset, length)` 的 offset 是**首条逻辑 seq**（见 replay.js 取证），
 * 一页一页往后翻，页数与行数都有硬上限——长会话不许把内存和帧大小吃光。
 */
function createArtifactIndex({ openSession, pageSize = 500, maxPages = 20 } = {}) {
  const limit = Math.min(Math.max(1, Number(pageSize) || 500), 5000)
  const pages = Math.min(Math.max(1, Number(maxPages) || 20), 100)

  return async function listArtifacts({ sessionId } = {}) {
    if (!sessionId) {
      return { ok: false, code: 'SESSION_UNREADABLE', message: '缺少 sessionId' }
    }
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
      const all = []
      let offset = 0
      let scanned = 0
      let truncated = false
      for (let page = 0; page < pages; page++) {
        const r = await handle.read(offset, limit)
        const batch = Array.isArray(r?.events) ? r.events : []
        if (!batch.length) break
        all.push(...scanArtifacts(batch))
        const lastSeq = batch[batch.length - 1]?.seq
        // seq 不是连续整数（或根本没带）时没法安全翻页：停在这里并如实报截断
        if (!Number.isInteger(lastSeq) || lastSeq < offset) { truncated = true; break }
        offset = lastSeq + 1
        scanned += batch.length
        if (batch.length < limit) break
        if (page === pages - 1 || all.length >= MAX_ARTIFACT_ROWS) truncated = true
      }
      const unique = []
      const keys = new Set()
      for (const r of all) {
        const k = `${r.seq}:${r.index}`
        if (keys.has(k)) continue
        keys.add(k)
        unique.push(r)
        if (unique.length >= MAX_ARTIFACT_ROWS) break
      }
      unique.sort((a, b) => a.seq - b.seq || a.index - b.index)
      return {
        ok: true,
        value: {
          sessionId,
          rows: unique,
          count: unique.length,
          scanned,
          truncated: truncated || unique.length >= MAX_ARTIFACT_ROWS,
        },
      }
    } catch (error) {
      return {
        ok: false, code: 'SESSION_UNREADABLE',
        message: `产物扫描失败：${error?.message ?? 'unknown'}`,
      }
    } finally {
      try { await handle.close?.() } catch { /* 已关闭 */ }
    }
  }
}

// ===== 主模块 src/index.js =====
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
 *   createSession({text, cwd, clientId})        -> 同上（新建会话；value 含
 *                                                  sessionId，可附 index 行）
 */

export const name = 'wbsync-host-dev'
export const inject = ['webServer', 'sessionPersistence']

const PROTOCOL = 'wbsync/1'
const DEFAULTS = {
  relayUrl: '',
  hostToken: '',
  deviceId: '',
  deviceName: '',      // 电脑名（给手机端的电脑切换用）；空则由 bundle 用 hostname() 填
  platform: '',        // 'win32' | 'darwin' | 'linux'
  autoConnect: true,
  reconnectBaseMs: 500,
  reconnectMaxMs: 15_000,
  heartbeatMs: 15_000,
  indexRefreshMs: 60_000,
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
  FRAME_TOO_LARGE: 413,
  WRITER_UNAVAILABLE: 409,
}

/**
 * 单帧软上限：超过就降级转发。
 * 取值依据：真机 874 条事件实测最大 421 KiB、p99 97 KiB，留约 2.4 倍余量到 1 MiB。
 * 再大就让手机只收元数据 + 正文前缀，绝不把连接撑爆（1009 断连会伪装成 504）。
 */
export const EVENT_FRAME_SOFT_LIMIT = 1024 * 1024
// 名字别叫 encoder：replay.js 里也有一个，bundle 内联到同一作用域会撞名（打包器会拦）
const frameEncoder = new TextEncoder()
const byteLen = (text) => frameEncoder.encode(text).length

/**
 * 降级：保留 `seq` / `type` / `time` 等顶层元数据（客户端游标与渲染都靠它），只摘正文。
 * 丢 `seq` 会让客户端判缺口，反而卡进补齐循环——所以「降级」而不是「丢弃」。
 */
export const degradeEvent = (ev, bytes) => ({
  ...ev,
  data: {
    truncated: true,
    reason: 'EVENT_TOO_LARGE',
    bytes,
    head: (() => {
      try { return JSON.stringify(ev?.data ?? null).slice(0, 1500) } catch { return null }
    })(),
  },
})
const unwrap = (r, fallback = {}) => (r?.ok === false
  ? {
    status: STATUS_BY_CODE[r.code] ?? 409,
    body: errBody(r.code ?? 'SESSION_BUSY', r.message ?? '适配器拒绝', false),
  }
  : { status: 200, body: okBody(r?.value ?? fallback) })

function __apply(ctx, config = {}) {
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
    oversized: 0,   // 超过单帧软上限、被降级转发的事件数（正文摘成 head 预览）
    lastSeq: new Map(),
    reconnectTimer: null,
    heartbeatTimer: null,
    indexTimer: null,
    indexCount: 0,
    indexSentAt: null,
    indexError: null,
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

  /**
   * 宿主真实入口（bundle 真机形态）：软探测 `sessionController`，缺服务时各适配器
   * 如实回 409，不影响上行与状态路由。测试可用 `cfg.hostAdapters` / 单个适配器覆盖。
   */
  const hostAdapters = cfg.hostAdapters ?? createHostAdapters(ctx, { randomId: cfg.randomId })

  const adapters = {
    submitPrompt: cfg.submitPrompt ?? hostAdapters.submitPrompt,
    // 置顶（r11）：同样要在这个包装层逐个转发，漏了下行分派就拿到 undefined
    setPinned: cfg.setPinned ?? hostAdapters.setPinned,
    cancelTurn: cfg.cancelTurn ?? hostAdapters.cancelTurn,
    createSession: cfg.createSession ?? hostAdapters.createSession,
    // 适配器返回对象上的方法必须在包装层逐个转发，否则下行分派拿到 undefined
    uploadAttachment: cfg.uploadAttachment ?? hostAdapters.uploadAttachment,
    // 反向补读：手机首屏只看最近 N 条，往上翻时取紧邻窗口的那一段
    backfill: cfg.backfill ?? (openSession
      ? createBackfillReader({ openSession, maxBytes: cfg.replayMaxBytes })
      : async () => ({
        ok: false, code: 'NOT_AVAILABLE',
        message: '没有可用的只读句柄（未注入 sessionPersistence / openSession）',
      })),
    // 产物索引：与 replay 共用同一个只读句柄，扫 append-only 日志里的显式呈现事件
    listArtifacts: cfg.listArtifacts ?? (openSession
      ? createArtifactIndex({ openSession, pageSize: cfg.artifactPageSize, maxPages: cfg.artifactMaxPages })
      : async () => ({
        ok: false, code: 'NOT_AVAILABLE',
        message: '没有可用的只读句柄（未注入 sessionPersistence / openSession）',
      })),
    replay: cfg.replay ?? (openSession
      ? createReplayAdapter({
        openSession,
        pageSize: cfg.replayPageSize,
        maxBytes: cfg.replayMaxBytes,
      })
      : async () => ({
        ok: false, code: 'NOT_AVAILABLE',
        message: '没有可用的只读句柄（未注入 sessionPersistence / openSession）',
      })),
  }

  /**
   * 会话索引：`sessionPersistence.list()` 是唯一来源。拿不到就不上报（status 里
   * `indexReady:false`），而不是发一份空表骗手机「你没有会话」。
   * `lastSeq` 需要解码日志才知道，交给 sessions.js 按 `revision` 缓存。
   */
  const listSessions = typeof cfg.listSessions === 'function'
    ? cfg.listSessions
    : (typeof ctx.sessionPersistence?.list === 'function'
      ? (options) => ctx.sessionPersistence.list(options)
      : null)

  // 置顶集合（r11）：问宿主 workspaces 的全局 pinnedSessionIds（最近置顶在前）。
  // 读不到就返回空——置顶是 PC 侧状态，**猜出来的比空着更糟**。
  const readPinnedIds = () => {
    try {
      const get = (name) => {
        try { return typeof ctx.get === 'function' ? ctx.get(name) : ctx[name] } catch { return null }
      }
      // 主进程是 workspaceRegistry（lateBound）；渲染进程的 workspaces 作兜底
      for (const w of [get('workspaceRegistry'), get('workspaces')]) {
        if (!w) continue
        for (const holder of [w, w.model, w.list]) {
          if (!holder) continue
          let ids = holder.pinnedSessionIds
          if (typeof ids === 'function') ids = ids()
          if (Array.isArray(ids)) return ids
        }
      }
      return []
    } catch { return [] }
  }

  const collectIndex = listSessions
    ? createSessionIndexReporter({
      listSessions,
      pinnedIds: readPinnedIds,
      openSession,
      deviceId: cfg.deviceId,
      limit: cfg.indexLimit,
      maxDecodeBytes: cfg.indexMaxDecodeBytes,
      resolveState: cfg.resolveSessionState,
    })
    : null

  const send = (frame) => {
    if (state.ws?.readyState !== 1) return false
    state.ws.send(JSON.stringify(frame))
    return true
  }

  /**
   * 审批桥：宿主 `approval/request` 瀑布 → 手机。
   * 手机不在线/超时一律交棒给桌面端（next()），手机只是遥控器不是闸门。
   */
  const approvals = createApprovalBridge({
    send,
    timeoutMs: cfg.approvalTimeoutMs ?? 120_000,
    log: (...a) => console.log('[wbsync] approval', ...a),
  })

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
    // 单条事件太大就先降级：真机实测最大 421 KiB，但长回复/大文件正文可以更大。
    // 硬发会让 Relay 以 1009 断连（在途请求熬成 504），且手机端收到几 MB 帧也卡。
    // seq 必须保留——丢了 seq 客户端会判缺口，反而卡在补齐循环里。
    let payload = ev
    let frame = { t: 'session/event', sessionId, ev }
    const bytes = byteLen(JSON.stringify(frame))
    if (bytes > EVENT_FRAME_SOFT_LIMIT) {
      state.oversized++
      payload = degradeEvent(ev, bytes)
      frame = { t: 'session/event', sessionId, ev: payload }
    }
    if (send(frame)) state.forwarded++
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
          // 无附件时不带该字段，保持适配器收到的参数形状与旧版一致
          ...(body?.attachments === undefined ? {} : { attachments: body.attachments }),
        })
        const { status, body: payload } = unwrap(r, { accepted: true })
        return send({ t: 'http/response', reqId, status, body: payload })
      }
      if (endpoint === 'session/pin') {
        // 置顶/取消置顶（r11）：转发给宿主 workspaces，成功后由索引刷新把新集合带下去
        const r = await adapters.setPinned({ sessionId: body?.sessionId, pinned: body?.pinned !== false })
        const { status, body: payload } = unwrap(r, { pinned: body?.pinned !== false })
        return send({ t: 'http/response', reqId, status, body: payload })
      }
      if (endpoint === 'session/cancel') {
        const r = await adapters.cancelTurn({ sessionId: body?.sessionId })
        const { status, body: payload } = unwrap(r, { cancelled: true })
        return send({ t: 'http/response', reqId, status, body: payload })
      }
      if (endpoint === 'session/create') {
        const r = await adapters.createSession({
          text: body?.text ?? '', cwd: body?.cwd ?? null, clientId: body?.clientId ?? null,
        })
        const { status, body: payload } = unwrap(r, { created: true })
        return send({ t: 'http/response', reqId, status, body: payload })
      }
      if (endpoint === 'session/follow') {
        const r = await adapters.replay({ sessionId: body?.sessionId, sinceSeq: body?.sinceSeq })
        const { status, body: payload } = unwrap(r, { events: [] })
        return send({ t: 'http/response', reqId, status, body: payload })
      }
      if (endpoint === 'fileUploads/upload') {
        const r = await adapters.uploadAttachment({
          sessionId: body?.sessionId, data: body?.data, name: body?.name,
        })
        const { status, body: payload } = unwrap(r, { receiptId: null })
        return send({ t: 'http/response', reqId, status, body: payload })
      }
      if (endpoint === 'session/backfill') {
        const r = await adapters.backfill({
          sessionId: body?.sessionId, beforeSeq: body?.beforeSeq, limit: body?.limit,
          // 首屏窗口可以要得比一页大；适配器会把上限锁在 4× 页预算。
          // 只在客户端显式给时带上，避免把 bytes: undefined 透给适配器（参数形状保持旧样）。
          ...(body?.bytes === undefined ? {} : { bytes: body.bytes }),
        })
        const { status, body: payload } = unwrap(r, {
          sessionId: body?.sessionId ?? null, events: [], hasMoreEarlier: false,
        })
        return send({ t: 'http/response', reqId, status, body: payload })
      }
      if (endpoint === 'session/artifacts') {
        // 只回元数据（路径 / 描述 / seq），文件字节绝不经过 Relay（ADR-010）
        const r = await adapters.listArtifacts({ sessionId: body?.sessionId })
        const { status, body: payload } = unwrap(r, {
          sessionId: body?.sessionId ?? null, rows: [], count: 0, truncated: true,
        })
        return send({ t: 'http/response', reqId, status, body: payload })
      }
      if (endpoint === '$events/result') {
        // 手机点了「允许 / 拒绝」：先答先得，第二个人点会被这里挡掉（409 APPROVAL_GONE）
        const r = approvals.answer({ approvalId: body?.approvalId, outcome: body?.outcome })
        if (!r.ok) {
          const status = r.code === 'INVALID_OUTCOME' ? 400 : 409
          const code = r.code === 'INVALID_OUTCOME' ? 'INVALID_JSON' : 'APPROVAL_GONE'
          const msg = r.code === 'INVALID_OUTCOME'
            ? 'outcome 必须是 allowed-once / rejected / cancelled'
            : '该审批已被应答或已过期'
          return send({ t: 'http/response', reqId, status, body: errBody(code, msg, r.code === 'APPROVAL_GONE') })
        }
        return send({
          t: 'http/response', reqId, status: 200,
          body: { ok: true, data: { approvalId: body?.approvalId, outcome: r.outcome }, protocol: PROTOCOL },
        })
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

  const stopIndexRefresh = () => {
    if (state.indexTimer) { clearInterval(state.indexTimer); state.indexTimer = null }
  }
  const startIndexRefresh = () => {
    stopIndexRefresh()
    if (!collectIndex || !(cfg.indexRefreshMs > 0)) return
    state.indexTimer = setInterval(() => { void sendIndexes() }, cfg.indexRefreshMs)
  }

  /** 上报会话索引；`connected` 为假或没有 list() 时直接跳过，不制造空表。 */
  const sendIndexes = async () => {
    if (!collectIndex || !state.connected) return null
    // 有 collectDiff 就走增量；注入的 mock 没有该方法时退回全量（保持兼容）。
    const snap = typeof collectIndex.collectDiff === 'function'
      ? await collectIndex.collectDiff()
      : { ...(await collectIndex()), removedIds: [], mode: 'full' }
    const { rows, error, stats, removedIds = [], mode = 'full' } = snap
    if (error) { state.indexError = error; return null }
    state.indexError = null
    if (!send({ t: 'host/sessions', rows, removedIds, mode })) return null
    state.indexCount = snap.total ?? rows.length
    state.indexSentAt = Date.now()
    state.indexStats = { ...stats, mode, unchanged: snap.unchanged ?? 0, removed: removedIds.length }
    return { count: rows.length, stats: state.indexStats }
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
        // 设备名只给手机端显示（切换电脑时要认得出来），不参与任何判定
        ...(cfg.deviceName ? { deviceName: cfg.deviceName } : {}),
        ...(cfg.platform ? { platform: cfg.platform } : {}),
        caps: cfg.caps, hostToken: cfg.hostToken,
      })
    })
    ws.addEventListener('message', (event) => {
      let msg
      try { msg = JSON.parse(String(event.data)) } catch { return }
      if (msg.t === 'host/registered') {
        state.connected = true
        // 重连后 Relay/CP 可能已重建：清空增量基线，重新发一份 full 快照
        collectIndex?.resetBaseline?.()
        startHeartbeat()
        startIndexRefresh()
        void sendIndexes()          // 注册成功即推一份索引，手机不必等下一个刷新周期
        return
      }
      if (msg.t === 'http/request') { void handleDownlink(msg); return }
    })
    ws.addEventListener('close', () => {
      state.connected = false
      stopHeartbeat()
      stopIndexRefresh()
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
          oversized: state.oversized,
          replayReady: Boolean(openSession),
          indexReady: Boolean(collectIndex),
          indexCount: state.indexCount,
          indexSentAt: state.indexSentAt,
          indexError: state.indexError,
          // 增量上报明细：mode=full/diff、unchanged 跳过数、removed 删除数
          indexStats: state.indexStats ?? null,
          lastSeq: Object.fromEntries(state.lastSeq),
          writer: hostAdapters.capabilities?.() ?? { injected: true },
          protocol: PROTOCOL,
        }))
      },
    }))
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/__wbsync/pair',
      handler: async (req, res) => {
        // GET 与 POST 都出码：GET 供 PC 浏览器地址栏直接打开（真机联调主路径），POST 供脚本/页面调用。
        const method = req.method ?? 'GET'
        if (method !== 'GET' && method !== 'POST') {
          return json(res, 405, errBody('ENDPOINT_NOT_ALLOWED', '仅支持 GET / POST'))
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
    // 审批瀑布：第二个参数 next() 是把「接下来谁来答」交还给宿主自己的弹窗
    const offApproval = ctx.on('approval/request', (request, next) => approvals.onRequest(request, next))
    const disposeRoutes = registerRoutes()
    if (cfg.autoConnect) connect()

    return () => {
      state.stopped = true
      if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null }
      stopHeartbeat()
      stopIndexRefresh()
      try { state.ws?.close(1000, 'plugin disposed') } catch { /* 已关闭 */ }
      state.ws = null
      state.connected = false
      try { approvals.dispose() } catch { /* 已释放 */ }
      offApproval?.()
      offEvent?.()
      for (const dispose of disposeRoutes) dispose?.()
    }
  }, 'wbsync-host: uplink + local routes')

  return { state, adapters, approvals, connect, collectIndex, sendIndexes }
}

// ===== bundle wrapper：稳定 deviceId + 默认配置解析 =====
const HOST_CONFIG_PATH = () =>
  process.env.WBSYNC_HOST_CONFIG || join(homedir(), '.dsh', 'wbsync-host.json')

const loadFileConfig = () => {
  try { return JSON.parse(readFileSync(HOST_CONFIG_PATH(), 'utf8')) } catch { return {} }
}

/**
 * deviceId 必须跨重启稳定：手机侧令牌按 deviceId 登记，Host 每次换 ID 会让
 * 旧令牌失效、会话索引串到另一台设备名下。
 * 优先读配置文件；缺失则生成 host-<uuid> 并以 0600 落盘；落盘失败退回主机名。
 */
const resolveStableDeviceId = (cfg) => {
  const file = HOST_CONFIG_PATH()
  if (typeof cfg.deviceId === 'string' && cfg.deviceId.trim()) return cfg.deviceId.trim()
  cfg.deviceId = 'host-' + randomUUID()
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(cfg, null, 2), { mode: 0o600 })
  } catch { cfg.deviceId = hostname() }
  return cfg.deviceId
}

const envConfig = () => Object.fromEntries(Object.entries({
  relayUrl: process.env.WBSYNC_RELAY_URL,
  deviceId: process.env.WBSYNC_DEVICE_ID,
  hostToken: process.env.WBSYNC_HOST_TOKEN,
  deviceName: process.env.WBSYNC_DEVICE_NAME,
}).filter(([, v]) => v !== undefined))

export function apply(ctx, config = {}) {
  const fileCfg = loadFileConfig()
  const env = envConfig()
  // 显式 deviceId（apply config > 环境变量）优先；否则用持久化的稳定 ID
  const explicit = config.deviceId ?? env.deviceId ?? fileCfg.deviceId
  const deviceId = (typeof explicit === 'string' && explicit.trim())
    ? explicit.trim()
    : resolveStableDeviceId(fileCfg)
  return __apply(ctx, {
    relayUrl: 'http://127.0.0.1:8787',
    hostToken: '',
    deviceName: hostname(),   // 默认就用这台机器的名字，手机端下拉才认得出是哪台
    platform: process.platform,
    ...fileCfg, ...env, ...config,
    deviceId,
  })
}
