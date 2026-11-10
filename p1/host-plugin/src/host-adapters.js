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

export function createHostAdapters(ctx, options = {}) {
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
      const x = cancelEntry(now.services)
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
        writer: c ? `${c.name}.${c.kind}` : null,
        messenger: p ? `${p.name}.${p.kind}` : null,
        canceller: x ? `${x.name}.${x.kind}` : null,
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
