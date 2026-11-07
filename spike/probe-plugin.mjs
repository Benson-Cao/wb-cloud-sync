/**
 * W1 Spike · 最小探针插件（**不是 P1 产品代码**）
 * ---------------------------------------------------------------
 * 目的：在真实 DSH 进程里以「插件身份」确认 09/R-02 三问涉及的服务确实被注入，
 * 并把运行时结构写成证据。设计上严格遵守 06 §3.3 的可逆副作用铁律。
 *
 * 硬约束：
 *   - 绝不 open(id, 'write')、绝不 append()、绝不改 ~/.dsh 日志
 *   - 所有注册放进 ctx.effect，卸载即撤回（TC-4.10）
 *   - 事件回调只记录 { type, seq, subjectId }，绝不记录事件正文
 *   - 探针不声明 Config（零依赖复跑）；P1 产品插件必须补 Schema.object 配置
 *
 * 运行证据默认写到 WBSYNC_SPIKE_OUT；未设置时写 DSH_HOME/wbsync-spike/probe.json。
 * check-plugin.mjs 会把 WBSYNC_SPIKE_OUT 指到 evidence/，不碰真实 DSH_HOME。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const name = 'wbsync-spike-probe'
export const inject = ['webServer', 'sessionPersistence']

export function apply(ctx, config) {
  const probe = {
    schema: 'wbsync-spike-probe/1',
    capturedAt: new Date().toISOString(),
    pluginName: name,
    injected: [...inject],
    nodeVersion: process.versions.node,
    dshHome: process.env.DSH_HOME ?? null,
    services: {},
    eventShapes: [],
    routeRegistered: null,
    listCalled: false,
    errors: [],
  }

  // ---- 1. 只读取证：宿主注入了什么服务 ----
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

  // ---- 2. 可选：调用只读 list() 验证「能否枚举」（默认关闭，避免扫盘） ----
  // 只记录返回形状，不 await：apply() 必须保持同步，避免异步结果晚于证据落盘。
  if (config?.runList === true && typeof persistence?.list === 'function') {
    try {
      const rows = persistence.list()
      probe.listCalled = true
      probe.listReturnShape = rows && typeof rows.then === 'function' ? 'promise' : typeof rows
    } catch (error) {
      probe.errors.push(`list() threw: ${String(error?.message ?? error)}`)
    }
  }

  // ---- 3. 所有副作用经 ctx.effect，返回 disposer ----
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => {
      const disposers = []

      if (typeof ctx.on === 'function') {
        const off = ctx.on('session/event', (subject, event) => {
          // 只记录结构，绝不落 data 正文（08 §8 日志白名单）
          probe.eventShapes.push({
            subjectType: typeof subject,
            subjectHasHeader: Boolean(subject?.header),
            subjectId: subject?.header?.id ?? null,
            eventKeys: event && typeof event === 'object' ? Object.keys(event).sort() : [],
            type: event?.type ?? null,
            seq: typeof event?.seq === 'number' ? event.seq : null,
          })
          if (probe.eventShapes.length > 32) probe.eventShapes.length = 32
        })
        if (typeof off === 'function') disposers.push(off)
      }

      const route = { kind: 'exact', path: '/__wbsync/spike', handler: () => ({ ok: true, data: probe }) }
      if (typeof ctx.webServer?.register === 'function') {
        const disposeRoute = ctx.webServer.register(route)
        probe.routeRegistered = `${route.kind}:${route.path}`
        if (typeof disposeRoute === 'function') disposers.push(disposeRoute)
      }

      return () => { for (const dispose of disposers.reverse()) dispose() }
    }, 'wbsync-spike: probe registrations')
  }

  // ---- 4. 落盘证据 ----
  const out = process.env.WBSYNC_SPIKE_OUT ?? join(process.env.DSH_HOME ?? '.', 'wbsync-spike', 'probe.json')
  try {
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, JSON.stringify(probe, null, 2), 'utf8')
    probe.evidencePath = out
  } catch (error) {
    probe.errors.push(`evidence write: ${String(error?.message ?? error)}`)
  }
  return probe
}
