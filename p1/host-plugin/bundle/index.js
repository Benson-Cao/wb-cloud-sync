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
 * 取证（2026-11-10，DSH asar 字节级）：
 *   - 服务 `sessionController`，宿主侧通过 `ctx.inject(["sessionController"], ...)`
 *     使用；RPC endpoint 表里有 `session/create`、`session/prompt`，服务名
 *     `sessionController`。
 *   - `async create(request)`：入参 `{workspaceId?, cwd?, sessionId?, agentPreset?}`
 *     （`workspaceId` 与 `cwd` 互斥），返回 `{sessionId, agentPreset?}`；内部走
 *     `agents.createSession(...)`，由宿主持有写句柄与 Agent 生命周期。
 *   - `async prompt(request, source)` 是 **asar 内部实现**：`request = {requestId,
 *     sessionId, mode, content:[{type:'text', text}]}`，`source = {kind:'user', rpcId}`；
 *     `hasPromptRequest()` 按 `source.rpcId === request.requestId` 原生去重
 *     （P0 Spike Q2 结论：`clientMsgId` 直接映射 `requestId`）。
 *     但**公开服务入口是 `(request, signal)`**——Remote 层自己用 request.requestId
 *     铸出 durable source。真机在用的 `dsh-drawai` 就是
 *     `controller.prompt({requestId, sessionId, mode:'queue', content}, signal)`。
 *     0.1.2 误把内部签名当公开签名，已按已验证形态修正。
 *
 * 铁律不变：**不自开 `open(id,'write')`、不自己追加日志**，一律走宿主入口。
 * 服务**软探测**（`ctx[name]` / `ctx.get(name)`），绝不写进 `inject`——
 * cordis 缺服务会让整个插件 pending，连已有的上行/状态路由都注册不上。
 * 探测不到就如实回 `WRITER_UNAVAILABLE`（409），不假装成功。
 *
 * 部分成功语义：`create` 已建出会话但第一句话 `prompt` 失败时，会话已经客观
 * 存在——必须返回成功并附 `prompted:false / promptError`，否则手机会以为没建、
 * 重复点「新建」造出第二个会话。
 */

/**
 * 服务探测（真机取证 2026-11-10，0.1.2 全 false 的复盘）：
 * `dsh-drawai`（同机在跑、已验证可用）用 `ctx.get?.('sessionController')` 拿服务。
 * 0.1.2 的 bug 是把 `ctx[name]` 与 `ctx.get(name)` 放进**同一个 try**——cordis 访问
 * 未声明服务会抛错，第一步抛了就把 `get` 整段吞掉，于是 controller 永远 false。
 * 现在按已验证路径优先、每路独立 try/catch。
 */
const lookupService = (ctx, name) => {
  try {
    const got = typeof ctx?.get === 'function' ? ctx.get(name) : undefined
    if (got) return got
  } catch { /* 继续下一路 */ }
  try { if (ctx?.[name]) return ctx[name] } catch { /* 继续下一路 */ }
  try {
    const root = ctx?.root
    if (root) {
      const got = typeof root.get === 'function' ? root.get(name) : root[name]
      if (got) return got
    }
  } catch { /* 继续下一路 */ }
  return undefined
}

const fallbackId = () => {
  const uuid = globalThis.crypto?.randomUUID?.()
  return uuid ?? `wbsync-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function createHostAdapters(ctx, options = {}) {
  const controller = lookupService(ctx, 'sessionController')
  const randomId = typeof options.randomId === 'function' ? options.randomId : fallbackId

  const unavailable = (what) => ({
    ok: false,
    code: 'WRITER_UNAVAILABLE',
    message: `宿主未提供 ${what}（sessionController 未就绪）；不得自开写句柄`,
  })
  const asError = (error) => ({
    ok: false,
    code: 'HOST_ADAPTER_ERROR',
    message: error?.message ?? String(error),
  })

  const promptText = async (sessionId, text, requestId) => {
    if (typeof controller?.prompt !== 'function') return unavailable('sessionController.prompt')
    const rid = requestId || randomId()
    try {
      // 公开服务入口是 (request, signal)：Remote 层自己把 request.requestId 铸成
      // `{kind:'user', rpcId}` 的 durable source（dsh-drawai 真机在用的形态）。
      // 0.1.2 误把 asar 内部实现 `prompt(request, source)` 当成公开签名，传了对象。
      const signal = typeof AbortController === 'function' ? new AbortController().signal : undefined
      const r = await controller.prompt(
        { requestId: rid, sessionId, mode: 'queue', content: [{ type: 'text', text }] },
        signal,
      )
      return { ok: true, value: r ?? { accepted: true }, requestId: rid }
    } catch (error) {
      return asError(error)
    }
  }

  return {
    /** 给 /__wbsync/status 做真机自检：区分「服务没探测到」与「调用失败」。 */
    capabilities: () => {
      let keys = []
      try { keys = Object.keys(ctx ?? {}).filter((k) => typeof k === 'string').slice(0, 40) } catch { /* Proxy 可能拒绝 enumerate */ }
      // 逐项独立 try：cordis 的 Proxy 访问未注入的属性也会抛（0.1.2 同类坑）
      const safeType = (name) => { try { return typeof ctx?.[name] } catch { return 'blocked' } }
      const safeBool = (name) => { try { return Boolean(ctx?.[name]) } catch { return false } }
      // 拿到服务但方法名不符时，下一轮靠这份清单直接定位（Proxy 也可能拒绝枚举）
      let controllerMethods = []
      try {
        const own = Object.getOwnPropertyNames(controller ?? {})
        const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(controller ?? {}))
        controllerMethods = [...new Set([...own, ...proto])]
          .filter((k) => !k.startsWith('_') && k !== 'constructor').slice(0, 40)
      } catch { /* 保持空数组 */ }
      return {
        controller: Boolean(controller),
        create: typeof controller?.create === 'function',
        prompt: typeof controller?.prompt === 'function',
        cancel: false,   // 未取证，保持 409
        probe: {
          hasGet: safeType('get') === 'function',
          hasInject: safeType('inject') === 'function',
          hasRoot: safeBool('root'),
          keys,
          controllerMethods,
        },
      }
    },

    /** 手机向已有会话发一句话：clientMsgId → requestId（宿主原生幂等）。 */
    submitPrompt: async ({ sessionId, text, clientMsgId }) => {
      if (!sessionId || typeof text !== 'string') {
        return { ok: false, code: 'HOST_ADAPTER_ERROR', message: 'submitPrompt 缺 sessionId / text' }
      }
      const r = await promptText(sessionId, text, clientMsgId)
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
      if (typeof controller?.create !== 'function') return unavailable('sessionController.create')
      let created
      try {
        // workspaceId 与 cwd 互斥；手机只可能给 cwd，缺省让宿主用默认工作区
        created = await controller.create(cwd ? { cwd } : {})
      } catch (error) {
        return asError(error)
      }
      const sessionId = created?.sessionId
      if (typeof sessionId !== 'string' || !sessionId) {
        return { ok: false, code: 'HOST_ADAPTER_ERROR', message: '宿主 create 未返回 sessionId' }
      }
      const value = { sessionId }
      if (created.agentPreset !== undefined) value.agentPreset = created.agentPreset

      const first = typeof text === 'string' ? text.trim() : ''
      if (first) {
        if (typeof controller.prompt !== 'function') {
          value.prompted = false
          value.promptError = '宿主未提供 prompt 入口，第一句话未发送'
        } else {
          const r = await promptText(sessionId, first)
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
