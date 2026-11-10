/**
 * dsh-wb-cloud-sync-host · P1 W3 Host 插件可安装 bundle（**自动生成，勿手改**）
 * ---------------------------------------------------------------
 * 由 p1/host-plugin/build-bundle.mjs 从 src/{index,replay,sessions,host-adapters}.js 合成：
 * 改源码后运行 `node p1/host-plugin/build-bundle.mjs` 重新生成（CI 有 --check 同步校验）。
 * 外层 wrapper 负责默认配置：代码默认 ← ~/.dsh/wbsync-host.json ← WBSYNC_* 环境变量 ← apply 的 config。
 */
import { readFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'

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
function createReplayAdapter({ openSession, pageSize = DEFAULT_PAGE_SIZE } = {}) {
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

  const promptText = async (sessionId, text, requestId, services) => {
    const entry = promptEntry(services)
    if (!entry) return unavailable('可用的消息提交入口（prompt / followup）', services)
    const rid = requestId || randomId()
    try {
      if (entry.kind === 'followup') {
        const agent = entry.svc.get(sessionId)
        if (typeof agent?.followup !== 'function') {
          return { ok: false, code: 'HOST_ADAPTER_ERROR', message: `agents.get(${sessionId}) 无 followup` }
        }
        await agent.followup({
          id: rid, role: 'user',
          content: [{ type: 'text', text }],
          source: { kind: 'plugin:wbsync' },
        })
        return { ok: true, value: { accepted: true }, requestId: rid }
      }
      // 官方 (request, signal)：required = requestId / sessionId / mode / content
      const signal = typeof AbortController === 'function' ? new AbortController().signal : undefined
      const r = await entry.svc.prompt(
        { requestId: rid, sessionId, mode: 'queue', content: [{ type: 'text', text }] },
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
        cancel: false,   // 未取证，保持 409
        writer: c ? `${c.name}.${c.kind}` : null,
        messenger: p ? `${p.name}.${p.kind}` : null,
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

    /** 手机向已有会话发一句话：clientMsgId → requestId（宿主原生幂等）。 */
    submitPrompt: async ({ sessionId, text, clientMsgId }) => {
      if (!sessionId || typeof text !== 'string') {
        return { ok: false, code: 'HOST_ADAPTER_ERROR', message: 'submitPrompt 缺 sessionId / text' }
      }
      const r = await promptText(sessionId, text, clientMsgId, current())
      return r.requestId ? { ok: r.ok, code: r.code, message: r.message, value: r.value } : r
    },

    /** 取消入口尚未取证到可靠方法名，保持显式 409（不猜 API）。 */
    cancelTurn: async () => ({
      ok: false,
      code: 'WRITER_UNAVAILABLE',
      message: '宿主取消入口未取证，暂不接入；不得自行中断轮次',
    }),

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
  WRITER_UNAVAILABLE: 409,
}
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
    cancelTurn: cfg.cancelTurn ?? hostAdapters.cancelTurn,
    createSession: cfg.createSession ?? hostAdapters.createSession,
    replay: cfg.replay ?? (openSession
      ? createReplayAdapter({ openSession, pageSize: cfg.replayPageSize })
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

  const collectIndex = listSessions
    ? createSessionIndexReporter({
      listSessions,
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
    const { rows, error, stats } = await collectIndex()
    if (error) { state.indexError = error; return null }
    state.indexError = null
    if (!send({ t: 'host/sessions', rows })) return null
    state.indexCount = rows.length
    state.indexSentAt = Date.now()
    state.indexStats = stats
    return { count: rows.length, stats }
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
      if (msg.t === 'host/registered') {
        state.connected = true
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
          replayReady: Boolean(openSession),
          indexReady: Boolean(collectIndex),
          indexCount: state.indexCount,
          indexSentAt: state.indexSentAt,
          indexError: state.indexError,
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
      offEvent?.()
      for (const dispose of disposeRoutes) dispose?.()
    }
  }, 'wbsync-host: uplink + local routes')

  return { state, adapters, connect, collectIndex, sendIndexes }
}

// ===== bundle wrapper：默认配置解析（真机零配置试跑：本机 Relay + 主机名当 deviceId） =====
const BUNDLE_DEFAULTS = () => ({
  relayUrl: 'http://127.0.0.1:8787',
  deviceId: hostname(),          // 试跑期 deviceId = PC 主机名；正式部署从配置文件 / 环境变量给稳定 ID
  hostToken: '',
})
const loadFileConfig = () => {
  try { return JSON.parse(readFileSync(join(homedir(), '.dsh', 'wbsync-host.json'), 'utf8')) } catch { return {} }
}
const envConfig = () => Object.fromEntries(Object.entries({
  relayUrl: process.env.WBSYNC_RELAY_URL,
  deviceId: process.env.WBSYNC_DEVICE_ID,
  hostToken: process.env.WBSYNC_HOST_TOKEN,
}).filter(([, v]) => v !== undefined))

export function apply(ctx, config = {}) {
  return __apply(ctx, { ...BUNDLE_DEFAULTS(), ...loadFileConfig(), ...envConfig(), ...config })
}
