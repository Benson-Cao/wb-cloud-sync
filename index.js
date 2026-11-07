/**
 * dsh-wb-cloud-sync-spike · W1 Spike 探针（可安装 bundle，非 P1 产品代码）
 * ---------------------------------------------------------------
 * 装进 DSH 后做三件只读取证，用来回答 09 风险登记册 R-02 的三问：
 *   1. session/event 是否可订阅、事件是否带连续 seq
 *   2. sessionPersistence 是否被注入、暴露哪些方法
 *   3. webServer 具名路由能否注册并在卸载后撤回
 *
 * 硬约束（对齐 06 §3.3 / 08 §8）：
 *   - 绝不 open(id,'write')、绝不 append()、绝不改 ~/.dsh 日志
 *   - 所有注册经 ctx.effect，返回 disposer，卸载即撤回
 *   - 事件回调只记录 { type, seq, subjectId }，绝不落 data 正文
 *   - 不声明 dsh.client，不需要设置页；验证靠 /__wbsync/spike 与 probe.json
 *
 * 本文件是 spike/probe-plugin.mjs 的**自包含可安装副本**（npm 包不含 spike/）。
 * 修改探针逻辑时两处需同步；`npm run verify` 会用离线 mock 校验本地副本。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'dsh-wb-cloud-sync-spike'
export const inject = ['webServer', 'sessionPersistence']

export function apply(ctx, config) {
  const probe = {
    schema: 'wbsync-spike-probe/1',
    capturedAt: new Date().toISOString(),
    pluginName: name,
    injected: [...inject],
    nodeVersion: process.versions.node,
    platform: process.platform,
    dshHome: process.env.DSH_HOME ?? join(homedir(), '.dsh'),
    services: {},
    eventShapes: [],
    routeRegistered: null,
    errors: [],
  }

  // ---- 只读取证：宿主注入了哪些服务 ----
  const persistence = ctx.sessionPersistence ?? ctx.get?.('sessionPersistence') ?? null
  probe.services.sessionPersistence = {
    present: Boolean(persistence),
    methods: ['list', 'open', 'append', 'create', 'flush', 'read']
      .filter((key) => typeof persistence?.[key] === 'function'),
  }
  probe.services.webServer = {
    present: Boolean(ctx.webServer),
    register: typeof ctx.webServer?.register === 'function',
  }
  probe.services.effect = typeof ctx.effect === 'function'
  probe.services.on = typeof ctx.on === 'function'

  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const evidencePath = config?.evidencePath ??
    process.env.WBSYNC_SPIKE_OUT ??
    join(home, 'wbsync-spike', 'probe.json')

  // ---- 所有副作用经 ctx.effect，返回 disposer ----
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => {
      const disposers = []

      if (typeof ctx.on === 'function') {
        const off = ctx.on('session/event', (session, event) => {
          // 首参实测是 session 对象（不是 sessionId 字符串），取 header.id
          probe.eventShapes.push({
            subjectType: typeof session,
            subjectId: session?.header?.id ?? null,
            eventKeys: event && typeof event === 'object' ? Object.keys(event).sort() : [],
            type: event?.type ?? null,
            seq: typeof event?.seq === 'number' ? event.seq : null,
          })
          if (probe.eventShapes.length > 32) probe.eventShapes.length = 32
          // 证据随事件增量刷新，但节流由宿主事件频率决定，不做定时器（避免残留）
        })
        if (typeof off === 'function') disposers.push(off)
      }

      const route = {
        kind: 'exact',
        path: '/__wbsync/spike',
        handler: (req, res) => {
          const body = JSON.stringify({ ok: true, data: probe })
          try {
            res.writeHead(200, {
              'Content-Type': 'application/json; charset=utf-8',
              'Content-Length': Buffer.byteLength(body),
              'Cache-Control': 'no-store',
            })
            res.end(body)
          } catch (error) {
            probe.errors.push(`handler: ${String(error?.message ?? error)}`)
          }
        },
      }
      if (typeof ctx.webServer?.register === 'function') {
        const disposeRoute = ctx.webServer.register(route)
        probe.routeRegistered = `${route.kind}:${route.path}`
        if (typeof disposeRoute === 'function') disposers.push(disposeRoute)
      }

      return () => { for (const dispose of disposers.reverse()) dispose() }
    }, 'wbsync-spike: probe registrations')
  }

  // ---- 落盘证据（只含结构元数据，不含事件正文 / 文件内容） ----
  try {
    mkdirSync(dirname(evidencePath), { recursive: true })
    writeFileSync(evidencePath, JSON.stringify(probe, null, 2), 'utf8')
    probe.evidencePath = evidencePath
  } catch (error) {
    probe.errors.push(`evidence write: ${String(error?.message ?? error)}`)
  }

  try {
    ctx.logger?.info?.(`[wbsync-spike] loaded; evidence=${evidencePath}; persistence=${probe.services.sessionPersistence.present}`)
  } catch { /* logger 不可用不影响探针 */ }

  return probe
}
