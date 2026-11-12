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
import { createBackfillReader, createReplayAdapter } from './replay.js'
import { createSessionIndexReporter } from './sessions.js'
import { createHostAdapters, resolveService } from './host-adapters.js'
import { createApprovalBridge } from './approvals.js'
import { createArtifactIndex, createArtifactExporter } from './artifacts.js'
import { listMirrorSessions, readSessionChunk } from './mirror.js'
import { createRoutes, notAllowed } from './routes.js'
import { pullSessionFile, upsertMirrorWorkspace, removeMirrorWorkspace, clearMirrored, writeProjectionStub, clearProjectionStubs } from './mirror-sync.js'

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
  artifactMaxBytes: 512 * 1024,   // ADR-011：WS 帧 1 MiB - base64 膨胀后的安全上限
}

/** 读 JSON 请求体：超限直接拒，不做流式处理（这些路由只收小对象）。 */
const readJson = (req, maxBytes = 256 * 1024) => new Promise((resolve, reject) => {
  const chunks = []
  let size = 0
  req.on('data', (chunk) => {
    size += chunk.length
    if (size > maxBytes) { reject(new Error('请求体过大')); try { req.destroy() } catch { /* 忽略 */ } return }
    chunks.push(chunk)
  })
  req.on('end', () => {
    try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) }
    catch (error) { reject(error) }
  })
  req.on('error', (error) => reject(error))
})

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

export function apply(ctx, config = {}) {
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

  /**
   * 按 sessionId 取 typert `workspaceFileScope`（宿主自己注册的 lookup）。
   * `workspaceFiles` / `officeToPdf` 的首参都是它，**不是** sessionId 字符串：
   * 上一轮直接传 sessionId 调 list，形状不对，所以真机上产物恒为 0 条——
   * 不是「没产物」，是「我们问法错了」。
   */
  const resolveFileScope = async (sessionId) => {
    try {
      const typert = resolveService(ctx, 'typert').svc
      const provider = typert?.lookups?.get?.('workspaceFileScope')
      if (!provider || typeof provider.resolve !== 'function') return null
      return (await provider.resolve(sessionId)) ?? null
    } catch { return null }
  }

  /**
   * W8 第二数据源：宿主 `workspaceFiles.list(scope, path)`（权威文件服务，非文本猜测）。
   * 返回 `{ path, entries:[{name,type,size}] }`；子项只有 `name`，路径要自己按 `/` 拼。
   * **拿不到就保持空**，绝不拿异常当产物。
   */
  const listWorkspaceFiles = async (sessionId) => {
    let svc = null
    try { svc = resolveService(ctx, 'workspaceFiles').svc } catch { svc = null }
    if (!svc || typeof svc.list !== 'function') return { rows: [], error: 'workspaceFiles 服务不可用' }
    const scope = await resolveFileScope(sessionId)
    if (!scope) return { rows: [], error: 'workspaceFileScope 解析失败' }
    const errors = []
    for (const dir of ['', '.']) {
      try {
        const r = await svc.list(scope, dir)
        const entries = Array.isArray(r?.entries) ? r.entries : null
        if (!entries) { errors.push(`${JSON.stringify(dir)}: 返回无 entries`); continue }
        const base = typeof r.path === 'string' ? r.path : ''
        return {
          rows: entries
            .filter((e) => e && e.type === 'file' && typeof e.name === 'string' && e.name)
            .map((e) => ({
              path: base ? `${base}/${e.name}` : e.name,
              name: e.name,
              description: null,
            })),
          error: null,
        }
      } catch (error) {
        errors.push(`${JSON.stringify(dir)}: ${error?.message ?? String(error)}`)
      }
    }
    return { rows: [], error: errors.join(' | ') }
  }

  const adapters = {
    submitPrompt: cfg.submitPrompt ?? hostAdapters.submitPrompt,
    // 置顶（r11）：同样要在这个包装层逐个转发，漏了下行分派就拿到 undefined
    setPinned: cfg.setPinned ?? hostAdapters.setPinned,
    // 归档（r12）：同样要逐个转发，漏了下行就拿到 undefined
    setArchived: cfg.setArchived ?? hostAdapters.setArchived,
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
      ? createArtifactIndex({
        openSession, pageSize: cfg.artifactPageSize, maxPages: cfg.artifactMaxPages,
        listWorkspaceFiles,
      })
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
   * Office → PDF（r13）：宿主 `officeToPdf.render(scope, path, 'foreground')`。
   * `scope` 由 typert 的 `workspaceFileScope` lookup 按 sessionId 解析（与 workspaceFiles
   * 同一份授权），所以转换用的是**会话自身的文件系统权限**，不是我们自己拼路径再读。
   *
   * 为什么不「先读字节再转」：Office 产物常几 MB，而下载上限只有 512 KiB，
   * 先读就一定被自家上限卡死。让宿主按它的 `maxInputBytes` 从磁盘读，
   * 我们只对**输出 PDF** 卡上限——判据落在真正过网的那一段。
   */
  const convertToPdf = async ({ sessionId, relPath }) => {
    let office = null
    try { office = resolveService(ctx, 'officeToPdf').svc } catch { office = null }
    if (!office || typeof office.render !== 'function') {
      return { ok: false, code: 'CAPABILITY_UNAVAILABLE', message: '宿主未加载 officeToPdf 转换服务' }
    }
    let scope = null
    try { scope = await resolveFileScope(sessionId) } catch { scope = null }
    if (!scope) {
      return { ok: false, code: 'CAPABILITY_UNAVAILABLE', message: '拿不到会话的工作区授权，无法转换' }
    }
    try {
      // 宿主内部是 `AbortSignal.any([signal, remoteLifetime])`：signal 不能是 undefined，
      // 否则直接抛 "signals[0] is not of type AbortSignal"。所以自己给一个带超时的。
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), Math.max(1000, Number(cfg.artifactConvertTimeoutMs) || 120000))
      let out
      try {
        out = await office.render(scope, relPath, 'foreground', ctrl.signal)
      } finally {
        clearTimeout(timer)
      }
      if (out?.eof === false) {
        return { ok: false, code: 'ARTIFACT_TOO_LARGE', message: '转换结果超出单次传输窗口，请在电脑上打开' }
      }
      const data = out?.data
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data ?? [])
      if (!buf.length) return { ok: false, code: 'CONVERT_FAILED', message: '转换器返回空文件' }
      return { ok: true, value: { bytes: buf, missingFonts: out?.missingFonts ?? [] } }
    } catch (error) {
      const aborted = error?.name === 'AbortError'
      return {
        ok: false, code: 'CONVERT_FAILED',
        message: aborted ? 'PDF 转换超时（文件可能太大或转换器忙）' : `PDF 转换失败：${error?.message ?? 'unknown'}`,
      }
    }
  }

  const artifactExporter = createArtifactExporter({
    listArtifacts: (args) => adapters.listArtifacts(args),
    resolveWorkspace: async (sessionId) => {
      if (typeof listSessions !== 'function') return null
      const snaps = await listSessions({})
      const hit = (Array.isArray(snaps) ? snaps : []).find((s) => s?.header?.id === sessionId)
      return typeof hit?.header?.cwd === 'string' ? hit.header.cwd : null
    },
    convertToPdf,
    maxBytes: cfg.artifactMaxBytes,
  })

  // 一条下行、一条票据：`format:'pdf'` 也走这里，不另开端点（否则就是绕过票据的旁路）
  adapters.createArtifactTicket = cfg.createArtifactTicket ?? ((args) => artifactExporter.readBytes(args))
  // W9：定时任务 + 会话改名，同样逐个转发
  adapters.listSchedules = cfg.listSchedules ?? hostAdapters.listSchedules
  adapters.createSchedule = cfg.createSchedule ?? hostAdapters.createSchedule
  adapters.runSchedule = cfg.runSchedule ?? hostAdapters.runSchedule
  adapters.renameSession = cfg.renameSession ?? hostAdapters.renameSession

  /**
   * 会话镜像（ADR-012）：把电脑上的**原始会话文件字节**分块导出给手机。
   * 只读、只走 sessions/ 目录、只认真实存在的文件——手机不能自报任意路径。
   * 分块是因为 WS 帧 1 MiB 硬限，而会话文件常是几十 MB。
   */
  const mirrorRoot = () => join(homedir(), '.dsh', 'sessions')
  adapters.mirrorList = cfg.mirrorList ?? (async () => {
    try {
      const rows = await listMirrorSessions(mirrorRoot())
      return { ok: true, value: { rows } }
    } catch (error) {
      return { ok: false, code: 'HOST_ADAPTER_ERROR', message: `镜像清单失败：${error?.message ?? error}` }
    }
  })
  adapters.mirrorFile = cfg.mirrorFile ?? (async (args) => {
    try {
      return { ok: true, value: await readSessionChunk(mirrorRoot(), args) }
    } catch (error) {
      return { ok: false, code: error?.code ?? 'HOST_ADAPTER_ERROR', message: error?.message ?? '镜像读取失败' }
    }
  })

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

  // 宿主 workspaceRegistry 上的集合（r11 置顶 / r12 归档）：问不到就返回空，
  // **猜出来的比空着更糟**。主进程服务 lateBound，所以每次读都重新探。
  const readRegistryIds = (key) => {
    try {
      const get = (name) => {
        try { return typeof ctx.get === 'function' ? ctx.get(name) : ctx[name] } catch { return null }
      }
      // 主进程是 workspaceRegistry（lateBound）；渲染进程的 workspaces 作兜底
      for (const w of [get('workspaceRegistry'), get('workspaces')]) {
        if (!w) continue
        for (const holder of [w, w.model, w.list]) {
          if (!holder) continue
          let ids = holder[key]
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
      pinnedIds: () => readRegistryIds('pinnedSessionIds'),
      archivedIds: () => readRegistryIds('archivedSessionIds'),
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

  // 协议名 → 处理逻辑，唯一落点（见 routes.js 顶部说明）
  const routes = createRoutes({ adapters, approvals, unwrap, errBody, protocol: PROTOCOL })

  const handleDownlink = async (frame) => {
    state.downlinks++
    const { reqId, endpoint, body } = frame
    if (!reqId) return
    try {
      const route = routes[endpoint]
      const result = route ? await route(body) : notAllowed(endpoint, errBody)
      return send({ t: 'http/response', reqId, status: result.status, body: result.body })
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
    /**
     * 镜像同步（ADR-012）：客户端在同一个 web 页面里调这条同源路由，
     * 由**宿主**去拉远端、写本地文件、登记侧栏。
     *
     * 为什么必须走宿主：WebView 里的 JS 没有文件系统权限，
     * 而镜像的最后一步是「把字节写进本机会话目录 + 改 workspace.json」。
     *
     * 安全：这条路由在本机回环上，任何人都能 POST。所以要求 body 带 Relay 令牌
     * （配对得到的 deviceToken）——它既是访问电脑的凭据，也证明调用方是已配对的客户端。
     * 路由本身**不接受任意路径**：目标工作区由 hostName 推导，不接受客户端指定。
     */
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/__wbsync/mirror-sync',
      handler: async (req, res) => {
        if ((req.method ?? 'GET') !== 'POST') {
          return json(res, 405, errBody('ENDPOINT_NOT_ALLOWED', '仅支持 POST'))
        }
        let body
        try { body = await readJson(req, 256 * 1024) } catch (error) {
          return json(res, 400, errBody('INVALID_JSON', error?.message ?? '请求体不是 JSON'))
        }
        const relayUrl = String(body?.relayUrl ?? '').replace(/\/+$/, '')
        const hostDeviceId = String(body?.hostDeviceId ?? '')
        const token = String(body?.token ?? '')
        const hostName = String(body?.hostName ?? '').trim() || '我的电脑'
        if (!relayUrl || !hostDeviceId || !token) {
          return json(res, 400, errBody('INVALID_ARGUMENT', '需要 relayUrl / hostDeviceId / token'))
        }

        const post = async (endpoint, payload) => {
          const r = await fetch(`${relayUrl}/d/${encodeURIComponent(hostDeviceId)}/${endpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify(payload),
          })
          const out = await r.json().catch(() => null)
          if (out?.ok !== true) {
            throw Object.assign(new Error(out?.error?.message ?? `HTTP ${r.status}`), { code: out?.error?.code ?? `HTTP_${r.status}` })
          }
          return out.data
        }

        const base = join(homedir(), '.dsh')
        const workspacePath = join(base, 'mirror', hostName.replace(/[\\/:*?"<>|]/g, '_'))
        const sessionsRoot = join(base, 'sessions')
        try {
          await mkdirSync(workspacePath, { recursive: true })
          const list = await post('session/mirror-list', {})
          const rows = Array.isArray(list?.rows) ? list.rows : []
          const cap = Math.max(1, Number(cfg.mirrorMaxSessions) || 20)
          const picked = rows.slice(0, cap)

          let files = 0
          let bytes = 0
          for (const row of picked) {
            for (const f of row.files ?? []) {
              const out = await pullSessionFile({
                sessionsRoot, cwdPath: workspacePath, sid: row.sid, name: f.name,
                fetchChunk: ({ offset, maxBytes }) => post('session/mirror-file', {
                  sid: `${row.dir}/${row.sid}`, name: f.name, offset, maxBytes,
                }),
              })
              files++
              bytes += out.bytes
              if (bytes > (Number(cfg.mirrorMaxTotalBytes) || 64 * 1024 * 1024)) {
                throw Object.assign(new Error('单次镜像超过总量上限'), { code: 'MIRROR_TOO_LARGE' })
              }
            }
          }

          const reg = await upsertMirrorWorkspace({
            registryPath: join(base, 'storages', 'workspace.json'),
            workspacePath, title: hostName,
            sids: picked.map((r) => r.sid),
          })

          /*
           * 只搬 sessions/ 时侧栏不列会话：宿主靠 projcache 的 identity.cwd 判断归属。
           * 这里补一条**最小**投影缓存（只 identity，不伪造 rows）。
           * 被跳过（已归属别的工作区）的会话**不写**——那是本机的条目，不碰。
           */
          const skipped = new Set(Array.isArray(reg.skipped) ? reg.skipped : [])
          const projRoot = join(base, 'storages', 'session_projcache', 'sessions')
          let stubs = 0
          for (const row of picked) {
            if (skipped.has(row.sid)) continue
            const r = await writeProjectionStub({ projRoot, sid: row.sid, cwd: workspacePath })
            if (r.written) stubs++
          }
          return json(res, 200, okBody({
            workspaceId: reg.id, workspaceTitle: hostName, created: reg.created,
            sessions: picked.length, truncated: rows.length > picked.length,
            files, bytes, totalInWorkspace: reg.total,
            skipped: Array.isArray(reg.skipped) ? reg.skipped.length : 0,
            stubs,
          }))
        } catch (error) {
          return json(res, 409, errBody(error?.code ?? 'MIRROR_FAILED', `镜像失败：${error?.message ?? error}`, true))
        }
      },
    }))

    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/__wbsync/mirror-clear',
      handler: async (req, res) => {
        if ((req.method ?? 'GET') !== 'POST') {
          return json(res, 405, errBody('ENDPOINT_NOT_ALLOWED', '仅支持 POST'))
        }
        let body
        try { body = await readJson(req, 256 * 1024) } catch {
          return json(res, 400, errBody('INVALID_JSON', '请求体不是 JSON'))
        }
        const hostName = String(body?.hostName ?? '').trim() || '我的电脑'
        const base = join(homedir(), '.dsh')
        const workspacePath = join(base, 'mirror', hostName.replace(/[\\/:*?"<>|]/g, '_'))
        try {
          const reg = await removeMirrorWorkspace({ registryPath: join(base, 'storages', 'workspace.json'), workspacePath })
          const dir = await clearMirrored({ sessionsRoot: join(base, 'sessions'), cwdPath: workspacePath })
          // 只删「cwd 指向镜像目录」的投影缓存：sid 万一撞上本机会话，不能连带删人家的
          const proj = await clearProjectionStubs({
            projRoot: join(base, 'storages', 'session_projcache', 'sessions'),
            sids: reg.sids ?? [], cwd: workspacePath,
          })
          return json(res, 200, okBody({
            registry: reg.removed, files: dir.removed, stubs: proj.removed, workspaceTitle: hostName,
          }))
        } catch (error) {
          return json(res, 409, errBody('MIRROR_FAILED', `清理失败：${error?.message ?? error}`, true))
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
