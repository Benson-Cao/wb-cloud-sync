/**
 * P1 W3 · 宿主真实入口适配器（bundle 与源码共用）
 * ---------------------------------------------------------------
 * 真机取证三轮（2026-11-10）：
 *   - 0.1.2：`lookupService` 把 `ctx[name]` 与 `ctx.get(name)` 放同一 try，cordis
 *     访问未注入属性抛错 → get 被吞，writer 全 false。已修（每路独立 try）。
 *   - 0.1.3：修好后仍全 false。`reflect.provide` 枚举显示宿主注册的服务名里
 *     **没有 `sessionController`**——它只是 RPC endpoint 表里的路由名
 *     （`service: "sessionController"`），不是 cordis 服务；`super(ctx,
 *     "sessionController")` 零命中。`dsh-drawai` 的 `ctx.get('sessionController')`
 *     其实是一条未走通的 fallback，之前误当成「已验证可用」。
 *   - 真正注册在 host 侧的是 `agents`（`AgentRegistry extends Service`,
 *     `super(ctx,"agents")`）；client 侧是 `sessions`（`session-controller.client`）。
 *     `session/create` 的 RPC 实现内部走 `this.agents.createSession(...)`。
 *
 * 因此 0.1.4 不再赌一个服务名：**一次探测整张候选服务表**，谁有
 * `create` / `createSession` 就用谁，`/api` status 里把每个服务的存在性与
 * 方法名全列出来（下一轮不用再猜）。返回形态兼容：
 *   `create(request)` → 字符串 sessionId 或 `{sessionId}`；
 *   `createSession(options)` → `{agent:{id}}` / `{sessionId}` / 字符串。
 *
 * 铁律不变：**不自开 `open(id,'write')`、不自己追加日志**；服务软探测，
 * 绝不写进顶层 `inject`（缺服务会让整个插件 pending）。探测不到如实 409。
 *
 * 部分成功语义：`create` 已建出会话但第一句话发送失败时，会话已经客观存在，
 * 必须返回成功并附 `prompted:false / promptError`，否则手机会重复创建。
 */

const SERVICE_CANDIDATES = [
  'sessionController', 'sessions', 'agents', 'connection', 'gateway',
  'workspaceRegistry', 'sessionPersistence', 'typert',
]

/** 每路独立 try：cordis 的 Proxy 访问未注入属性会抛（0.1.2 同类坑）。 */
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
  const id = r?.sessionId ?? r?.agent?.id
  return typeof id === 'string' && id ? id : null
}

const fallbackId = () => {
  const uuid = globalThis.crypto?.randomUUID?.()
  return uuid ?? `wbsync-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function createHostAdapters(ctx, options = {}) {
  // 一次探测整张表；运行时也可能通过 ctx.inject 晚到，但当前形态下先静态快照
  const services = {}
  for (const name of SERVICE_CANDIDATES) {
    const svc = lookupService(ctx, name)
    if (svc) services[name] = svc
  }
  const randomId = typeof options.randomId === 'function' ? options.randomId : fallbackId

  /** 优先 RPC 风格的 create()，其次 host 侧 agents.createSession()。 */
  const createEntry = () => {
    for (const name of ['sessionController', 'sessions']) {
      if (typeof services[name]?.create === 'function') return { svc: services[name], name, kind: 'create' }
    }
    if (typeof services.agents?.createSession === 'function') {
      return { svc: services.agents, name: 'agents', kind: 'createSession' }
    }
    return null
  }

  /** 优先 RPC 风格 prompt()，其次 agents.get(id).followup()（dsh-drawai 形态）。 */
  const promptEntry = () => {
    for (const name of ['sessionController', 'sessions']) {
      if (typeof services[name]?.prompt === 'function') return { svc: services[name], name, kind: 'prompt' }
    }
    if (typeof services.agents?.get === 'function') {
      return { svc: services.agents, name: 'agents', kind: 'followup' }
    }
    return null
  }

  const unavailable = (what) => ({
    ok: false,
    code: 'WRITER_UNAVAILABLE',
    message: `宿主未提供 ${what}；可见服务：${Object.keys(services).join(', ') || '(无)'}。不得自开写句柄`,
  })
  const asError = (error) => ({
    ok: false,
    code: 'HOST_ADAPTER_ERROR',
    message: error?.message ?? String(error),
  })

  const promptText = async (sessionId, text, requestId) => {
    const entry = promptEntry()
    if (!entry) return unavailable('可用的消息提交入口（prompt / followup）')
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
      // 公开 RPC 入口是 (request, signal)：Remote 层自铸 durable source
      const signal = typeof AbortController === 'function' ? new AbortController().signal : undefined
      const r = await entry.svc.prompt(
        { requestId: rid, sessionId, mode: 'queue', content: [{ type: 'text', text }] },
        signal,
      )
      return { ok: true, value: r ?? { accepted: true }, requestId: rid }
    } catch (error) {
      return asError(error)
    }
  }

  return {
    /** 给 /__wbsync/status 做真机自检：服务清单 + 实际选中的写入通道。 */
    capabilities: () => {
      let keys = []
      try { keys = Object.keys(ctx ?? {}).filter((k) => typeof k === 'string').slice(0, 40) } catch { /* Proxy 可能拒绝 enumerate */ }
      const safeType = (name) => { try { return typeof ctx?.[name] } catch { return 'blocked' } }
      const safeBool = (name) => { try { return Boolean(ctx?.[name]) } catch { return false } }
      const serviceReport = {}
      for (const name of SERVICE_CANDIDATES) {
        serviceReport[name] = services[name]
          ? { present: true, methods: methodsOf(services[name]) }
          : { present: false }
      }
      const c = createEntry()
      const p = promptEntry()
      return {
        controller: Boolean(c),
        create: Boolean(c),
        prompt: Boolean(p),
        cancel: false,   // 未取证，保持 409
        writer: c ? `${c.name}.${c.kind === 'create' ? 'create' : 'createSession'}` : null,
        messenger: p ? `${p.name}.${p.kind}` : null,
        probe: {
          hasGet: safeType('get') === 'function',
          hasInject: safeType('inject') === 'function',
          hasRoot: safeBool('root'),
          keys,
          services: serviceReport,
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
      const entry = createEntry()
      if (!entry) return unavailable('可用的新建会话入口（create / createSession）')
      let created
      try {
        if (entry.kind === 'createSession') {
          // AgentRegistry 形态：cwd + reusable 回调（不复用任何 blank session）
          created = await entry.svc.createSession({ ...(cwd ? { cwd } : {}), reusable: () => false })
        } else {
          // workspaceId 与 cwd 互斥；手机只可能给 cwd，缺省让宿主用默认工作区
          created = await entry.svc.create(cwd ? { cwd } : {})
        }
      } catch (error) {
        return asError(error)
      }
      const sessionId = sessionIdOf(created)
      if (!sessionId) {
        return { ok: false, code: 'HOST_ADAPTER_ERROR', message: `宿主 ${entry.name} 未返回 sessionId` }
      }
      const value = { sessionId }
      if (created && typeof created === 'object' && created.agentPreset !== undefined) {
        value.agentPreset = created.agentPreset
      }

      const first = typeof text === 'string' ? text.trim() : ''
      if (first) {
        if (!promptEntry()) {
          value.prompted = false
          value.promptError = '宿主未提供消息提交入口，第一句话未发送'
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
