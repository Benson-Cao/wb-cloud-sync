/**
 * P1 W3 · Host 插件骨架单测
 * ---------------------------------------------------------------
 * 两类宿主替身：
 *   1. `createMockCtx()` —— 只实现插件用到的三个能力（`on` / `webServer.register`
 *      / `effect`），并记录装载与拆除，用于验证「卸载即撤回」。
 *   2. `startFakeRelay()` —— 复用手写的 `upgradeToWebSocket`，能逐帧观察插件
 *      发了什么、并主动下发帧，用于验证上行与下行分派。
 *
 * 另有 1 个用**真 Relay** 的端到端用例：配对 → Host WS 注册 → 手机 HTTP 投递
 * → 适配器 → 响应回程，覆盖「不自己开写句柄、只走宿主提交入口」的链路形状。
 */
import { createHmac } from 'node:crypto'
import { createServer } from 'node:http'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createRelay } from '../../relay/src/server.js'
import { upgradeToWebSocket } from '../../relay/src/ws.js'
import { apply, name as pluginName, inject } from '../src/index.js'

const PROTOCOL = 'wbsync/1'

/* ------------------------------------------------------------------ 替身 */

function createMockCtx() {
  const routes = new Map()
  const listeners = new Map()
  const effects = []
  const calls = { registered: [], unregistered: [], effectLabels: [] }

  const ctx = {
    routes,
    listeners,
    calls,
    webServer: {
      register(spec) {
        routes.set(spec.path, spec.handler)
        calls.registered.push(spec.path)
        return () => {
          routes.delete(spec.path)
          calls.unregistered.push(spec.path)
        }
      },
    },
    on(event, fn) {
      const arr = listeners.get(event) ?? []
      arr.push(fn)
      listeners.set(event, arr)
      return () => listeners.set(event, (listeners.get(event) ?? []).filter((f) => f !== fn))
    },
    effect(fn, label) {
      const dispose = fn()
      effects.push({ label, dispose })
      calls.effectLabels.push(label)
      return dispose
    },
    emit(event, ...args) {
      for (const fn of listeners.get(event) ?? []) fn(...args)
    },
    listenerCount(event) { return (listeners.get(event) ?? []).length },
    dispose() { for (const e of effects.splice(0)) e.dispose?.() },
  }
  return ctx
}

const parseJson = (text) => { try { return JSON.parse(text) } catch { return null } }

/** 直接调用 mock 路由的 handler，返回 {status, headers, json}。 */
function callRoute(ctx, path, { method = 'GET', body = null } = {}) {
  const handler = ctx.routes.get(path)
  if (!handler) return Promise.resolve({ status: 0, json: null, missing: true })
  return new Promise((resolve) => {
    let settled = false
    const done = (v) => { if (!settled) { settled = true; resolve(v) } }
    const res = {
      status: 0,
      headers: null,
      writeHead(status, headers) { this.status = status; this.headers = headers; return this },
      end(payload) { done({ status: this.status, headers: this.headers, json: parseJson(payload) }) },
    }
    const req = { method, headers: {}, url: path, body }
    try { handler(req, res) } catch (error) { done({ status: -1, error }) }
    setTimeout(() => done({ status: -2, timeout: true }), 2000)
  })
}

async function startFakeRelay() {
  const frames = []
  const host = { conn: null, closes: 0, registers: 0, registerFrame: null }
  const server = createServer((req, res) => { res.writeHead(404); res.end() })
  server.on('upgrade', (req, socket, head) => {
    const conn = upgradeToWebSocket(req, socket, head, {
      onMessage(text) {
        const msg = parseJson(text)
        if (!msg) return
        frames.push(msg)
        if (msg.t !== 'host/register') return
        host.registers++
        host.registerFrame = msg
        // 与真 Relay 保持一致：注册成功才回 host/registered
        conn.sendJson({ t: 'host/registered', deviceId: msg.deviceId, protocol: PROTOCOL })
      },
      onClose() { host.closes++ },
    })
    if (conn) host.conn = conn
  })
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
  return {
    frames,
    host,
    port,
    url: `http://127.0.0.1:${port}`,
    send: (obj) => host.conn?.sendJson(obj),
    closeHost: () => host.conn?.close(1001, 'test close'),
    stop: () => new Promise((resolve) => {
      host.conn?.close()
      server.closeAllConnections?.()
      server.close(() => resolve())
    }),
  }
}

const waitFor = async (predicate, label, timeout = 4000) => {
  const started = Date.now()
  for (;;) {
    if (predicate()) return
    if (Date.now() - started > timeout) throw new Error(`等待超时：${label}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

const framesOf = (relay, type) => relay.frames.filter((f) => f.t === type)

/* ------------------------------------------------------- 插件契约（静态） */

test('插件声明：名字、inject 与协议版本', () => {
  assert.equal(pluginName, 'wbsync-host-dev')
  // 只 inject 宿主已有的两个服务；未注入也不应让整个插件 pending
  assert.deepEqual(inject, ['webServer', 'sessionPersistence'])
  assert.equal(PROTOCOL, 'wbsync/1')
})

/* ---------------------------------------------------------- 未配置 Relay */

test('未配置 relayUrl：不发起连接，状态路由如实说明', async () => {
  const ctx = createMockCtx()
  const plugin = apply(ctx, { autoConnect: true, deviceId: 'pc-1' })
  await new Promise((r) => setTimeout(r, 120))

  assert.equal(plugin.state.connected, false)
  assert.equal(plugin.state.reconnects, 0)   // 不空转重连

  const res = await callRoute(ctx, '/__wbsync/status')
  assert.equal(res.status, 200)
  assert.equal(res.json.ok, true)
  assert.equal(res.json.protocol, PROTOCOL)
  assert.equal(res.json.data.relayConfigured, false)
  assert.equal(res.json.data.connected, false)
  assert.equal(res.json.data.deviceId, 'pc-1')

  ctx.dispose()
})

/* ------------------------------------------------------------ 注册与上行 */

test('注册帧带上 deviceId / caps / hostToken，收到 host/registered 才算连接', async () => {
  const relay = await startFakeRelay()
  const ctx = createMockCtx()
  try {
    const plugin = apply(ctx, {
      relayUrl: relay.url, deviceId: 'pc-1', hostToken: 'tok-abc',
      caps: ['attachments'], autoConnect: true,
    })
    assert.equal(plugin.state.connected, false)   // 握手完成前不算连接

    await waitFor(() => relay.host.registers === 1, 'host/register 到达')
    const reg = relay.host.registerFrame
    assert.equal(reg.t, 'host/register')
    assert.equal(reg.deviceId, 'pc-1')
    assert.equal(reg.protocol, PROTOCOL)
    assert.equal(reg.hostToken, 'tok-abc')
    assert.deepEqual(reg.caps, ['attachments'])
    // 设备名与平台只给手机端显示（切换电脑时认得出是哪台），不参与判定
    assert.equal(reg.deviceName, undefined, '没配置就别发空字段，免得 CP 里出现空名字')

    await waitFor(() => plugin.state.connected, 'host/registered 后置 connected')

    const res = await callRoute(ctx, '/__wbsync/status')
    assert.equal(res.json.data.connected, true)
    assert.equal(res.json.data.relayConfigured, true)
  } finally {
    ctx.dispose()
    await relay.stop()
  }
})

test('session/event 原样上行：sessionId 取 session.header.id，seq 不改不重排', async () => {
  const relay = await startFakeRelay()
  const ctx = createMockCtx()
  try {
    const plugin = apply(ctx, { relayUrl: relay.url, deviceId: 'pc-1', autoConnect: true })
    await waitFor(() => plugin.state.connected, '已连接')

    const events = [
      { seq: 0, type: 'turn/start', payload: { text: '你好' } },
      { seq: 1, type: 'message/delta', payload: { text: '在' } },
    ]
    for (const ev of events) ctx.emit('session/event', { header: { id: 'session-9' } }, ev)

    await waitFor(() => framesOf(relay, 'session/event').length === 2, '两帧上行')
    const up = framesOf(relay, 'session/event')
    assert.deepEqual(up.map((f) => f.sessionId), ['session-9', 'session-9'])
    assert.deepEqual(up.map((f) => f.ev), events)      // 事件体不被改写

    const res = await callRoute(ctx, '/__wbsync/status')
    assert.equal(res.json.data.forwarded, 2)
    assert.equal(res.json.data.dropped, 0)
    assert.equal(res.json.data.lastSeq['session-9'], 1)
  } finally {
    ctx.dispose()
    await relay.stop()
  }
})

test('缺 session.header.id 的事件不计账也不发帧', async () => {
  const relay = await startFakeRelay()
  const ctx = createMockCtx()
  try {
    const plugin = apply(ctx, { relayUrl: relay.url, deviceId: 'pc-1', autoConnect: true })
    await waitFor(() => plugin.state.connected, '已连接')

    ctx.emit('session/event', {}, { seq: 0 })
    ctx.emit('session/event', { header: {} }, { seq: 1 })
    await new Promise((r) => setTimeout(r, 80))

    assert.equal(framesOf(relay, 'session/event').length, 0)
    assert.equal(plugin.state.forwarded, 0)
    assert.equal(plugin.state.dropped, 0)
  } finally {
    ctx.dispose()
    await relay.stop()
  }
})


/* ------------------------------------------------------------ 下行分派 */

test('session/create 分派到注入的 createSession 适配器；未注入则 409 WRITER_UNAVAILABLE', async () => {
  const relay = await startFakeRelay()
  const ctx = createMockCtx()
  const seen = []
  try {
    const plugin = apply(ctx, {
      relayUrl: relay.url, deviceId: 'pc-1', autoConnect: true,
      createSession: async (args) => {
        seen.push(args)
        return { ok: true, value: { sessionId: 'session-new', index: { sessionId: 'session-new', state: 'awaiting' } } }
      },
    })
    await waitFor(() => plugin.state.connected, '已连接')

    relay.send({ t: 'http/request', reqId: 'r-9', method: 'POST', endpoint: 'session/create', body: { text: '第一句话', clientId: 'pwa' } })
    await waitFor(() => framesOf(relay, 'http/response').length === 1, '回响应')
    const resp = framesOf(relay, 'http/response')[0]
    assert.equal(resp.reqId, 'r-9')
    assert.equal(resp.status, 200)
    assert.deepEqual(resp.body.data, { sessionId: 'session-new', index: { sessionId: 'session-new', state: 'awaiting' } })
    assert.deepEqual(seen, [{ text: '第一句话', cwd: null, clientId: 'pwa' }])

    // 卸载重装（不带适配器）：同端点 → 409 WRITER_UNAVAILABLE
    ctx.dispose()
    const ctx2 = createMockCtx()
    const plugin2 = apply(ctx2, { relayUrl: relay.url, deviceId: 'pc-1', autoConnect: true })
    await waitFor(() => plugin2.state.connected, '重连成功')
    relay.send({ t: 'http/request', reqId: 'r-10', method: 'POST', endpoint: 'session/create', body: { text: '' } })
    await waitFor(() => framesOf(relay, 'http/response').length === 2, '第二条回响应')
    const resp2 = framesOf(relay, 'http/response')[1]
    assert.equal(resp2.status, 409)
    assert.equal(resp2.body.error.code, 'WRITER_UNAVAILABLE')
    ctx2.dispose()
  } finally {
    ctx.dispose()
    await relay.stop()
  }
})

test('session/prompt 走注入的 submitPrompt 适配器并回 http/response', async () => {
  const relay = await startFakeRelay()
  const ctx = createMockCtx()
  const seen = []
  try {
    const plugin = apply(ctx, {
      relayUrl: relay.url, deviceId: 'pc-1', autoConnect: true,
      submitPrompt: async (args) => { seen.push(args); return { ok: true, value: { accepted: true, turnId: 't-1' } } },
    })
    await waitFor(() => plugin.state.connected, '已连接')

    relay.send({ t: 'http/request', reqId: 'r-1', method: 'POST', endpoint: 'session/prompt', body: { sessionId: 'session-9', text: '帮我跑一下', clientMsgId: 'c-1' } })

    await waitFor(() => framesOf(relay, 'http/response').length === 1, '回响应')
    const resp = framesOf(relay, 'http/response')[0]
    assert.equal(resp.reqId, 'r-1')
    assert.equal(resp.status, 200)
    assert.equal(resp.body.ok, true)
    assert.equal(resp.body.protocol, PROTOCOL)
    assert.deepEqual(resp.body.data, { accepted: true, turnId: 't-1' })
    assert.deepEqual(seen, [{ sessionId: 'session-9', text: '帮我跑一下', clientMsgId: 'c-1' }])
  } finally {
    ctx.dispose()
    await relay.stop()
  }
})

test('未注入适配器：回 409 WRITER_UNAVAILABLE，绝不自己追加日志', async () => {
  const relay = await startFakeRelay()
  const ctx = createMockCtx()
  try {
    const plugin = apply(ctx, { relayUrl: relay.url, deviceId: 'pc-1', autoConnect: true })
    await waitFor(() => plugin.state.connected, '已连接')

    relay.send({ t: 'http/request', reqId: 'r-2', method: 'POST', endpoint: 'session/prompt', body: { sessionId: 's', text: 'x' } })
    await waitFor(() => framesOf(relay, 'http/response').length === 1, '回响应')

    const resp = framesOf(relay, 'http/response')[0]
    assert.equal(resp.status, 409)
    assert.equal(resp.body.ok, false)
    assert.equal(resp.body.error.code, 'WRITER_UNAVAILABLE')
    assert.equal(resp.body.error.retryable, false)
  } finally {
    ctx.dispose()
    await relay.stop()
  }
})

test('fileUploads/upload 分派到 uploadAttachment 适配器并回 http/response', async () => {
  const relay = await startFakeRelay()
  const ctx = createMockCtx()
  const calls = []
  try {
    const plugin = apply(ctx, {
      relayUrl: relay.url, deviceId: 'pc-1', autoConnect: true,
      uploadAttachment: async (args) => { calls.push(args); return { ok: true, value: { receiptId: 'rc-1' } } },
    })
    await waitFor(() => plugin.state.connected, '已连接')

    relay.send({
      t: 'http/request', reqId: 'r-up', method: 'POST',
      endpoint: 'fileUploads/upload', body: { sessionId: 's-1', data: 'YWJj', name: 'a.txt' },
    })
    await waitFor(() => framesOf(relay, 'http/response').length === 1, '一条回响应')
    const f = framesOf(relay, 'http/response')[0]
    assert.deepEqual(f.body.data, { receiptId: 'rc-1' })
    assert.deepEqual(calls, [{ sessionId: 's-1', data: 'YWJj', name: 'a.txt' }])
  } finally {
    ctx.dispose()
    await relay.stop()
  }
})

test('session/follow 与 session/cancel 分派到各自适配器', async () => {
  const relay = await startFakeRelay()
  const ctx = createMockCtx()
  const calls = []
  try {
    const plugin = apply(ctx, {
      relayUrl: relay.url, deviceId: 'pc-1', autoConnect: true,
      cancelTurn: async (args) => { calls.push(['cancel', args]); return { ok: true, value: { cancelled: true } } },
      replay: async (args) => { calls.push(['replay', args]); return { ok: true, value: { events: [{ seq: 2 }] } } },
    })
    await waitFor(() => plugin.state.connected, '已连接')

    relay.send({ t: 'http/request', reqId: 'r-3', method: 'POST', endpoint: 'session/cancel', body: { sessionId: 'session-9' } })
    relay.send({ t: 'http/request', reqId: 'r-4', method: 'POST', endpoint: 'session/follow', body: { sessionId: 'session-9', sinceSeq: 2 } })

    await waitFor(() => framesOf(relay, 'http/response').length === 2, '两条回响应')
    const byReq = Object.fromEntries(framesOf(relay, 'http/response').map((f) => [f.reqId, f]))
    assert.deepEqual(byReq['r-3'].body.data, { cancelled: true })
    assert.deepEqual(byReq['r-4'].body.data, { events: [{ seq: 2 }] })
    assert.deepEqual(calls, [
      ['cancel', { sessionId: 'session-9' }],
      ['replay', { sessionId: 'session-9', sinceSeq: 2 }],
    ])
  } finally {
    ctx.dispose()
    await relay.stop()
  }
})

test('白名单外的端点一律 403，适配器不被调用', async () => {
  const relay = await startFakeRelay()
  const ctx = createMockCtx()
  let called = 0
  try {
    const plugin = apply(ctx, {
      relayUrl: relay.url, deviceId: 'pc-1', autoConnect: true,
      submitPrompt: async () => { called++; return { ok: true } },
    })
    await waitFor(() => plugin.state.connected, '已连接')

    relay.send({ t: 'http/request', reqId: 'r-5', method: 'POST', endpoint: 'fs/read', body: { path: '/etc/passwd' } })
    await waitFor(() => framesOf(relay, 'http/response').length === 1, '回响应')

    const resp = framesOf(relay, 'http/response')[0]
    assert.equal(resp.status, 403)
    assert.equal(resp.body.error.code, 'ENDPOINT_NOT_ALLOWED')
    assert.equal(called, 0)
  } finally {
    ctx.dispose()
    await relay.stop()
  }
})

test('适配器抛异常：500 NO_PROGRESS 且 retryable，异常不逃逸', async () => {
  const relay = await startFakeRelay()
  const ctx = createMockCtx()
  try {
    const plugin = apply(ctx, {
      relayUrl: relay.url, deviceId: 'pc-1', autoConnect: true,
      submitPrompt: async () => { throw new Error('宿主拒绝：SessionAlreadyOwnedError') },
    })
    await waitFor(() => plugin.state.connected, '已连接')

    relay.send({ t: 'http/request', reqId: 'r-6', method: 'POST', endpoint: 'session/prompt', body: { sessionId: 's', text: 'x' } })
    await waitFor(() => framesOf(relay, 'http/response').length === 1, '回响应')

    const resp = framesOf(relay, 'http/response')[0]
    assert.equal(resp.status, 500)
    assert.equal(resp.body.error.code, 'NO_PROGRESS')
    assert.equal(resp.body.error.retryable, true)
    assert.match(resp.body.error.message, /SessionAlreadyOwnedError/)
    assert.equal(plugin.state.connected, true)   // 连接没被异常带崩
  } finally {
    ctx.dispose()
    await relay.stop()
  }
})

/* ------------------------------------------------------------ 断线与卸载 */

test('连接断开后按退避重连并重新注册', async () => {
  const relay = await startFakeRelay()
  const ctx = createMockCtx()
  try {
    const plugin = apply(ctx, {
      relayUrl: relay.url, deviceId: 'pc-1', autoConnect: true,
      reconnectBaseMs: 40, reconnectMaxMs: 200,
    })
    await waitFor(() => relay.host.registers === 1, '首次注册')

    relay.closeHost()
    await waitFor(() => relay.host.registers === 2, '重连后再次注册', 5000)
    await waitFor(() => plugin.state.connected, '重连后已连接')
    assert.ok(plugin.state.reconnects >= 1)
  } finally {
    ctx.dispose()
    await relay.stop()
  }
})

test('卸载即撤回：路由注销、监听移除、不再上行也不再重连', async () => {
  const relay = await startFakeRelay()
  const ctx = createMockCtx()
  try {
    const plugin = apply(ctx, {
      relayUrl: relay.url, deviceId: 'pc-1', autoConnect: true,
      reconnectBaseMs: 40, reconnectMaxMs: 80,
    })
    await waitFor(() => plugin.state.connected, '已连接')
    assert.deepEqual(ctx.calls.registered.sort(), ['/__wbsync/pair', '/__wbsync/status'])

    ctx.dispose()
    assert.deepEqual(ctx.calls.unregistered.sort(), ['/__wbsync/pair', '/__wbsync/status'])
    assert.equal(ctx.listenerCount('session/event'), 0)
    assert.equal(ctx.routes.size, 0)
    assert.equal(plugin.state.connected, false)

    const before = framesOf(relay, 'session/event').length
    ctx.emit('session/event', { header: { id: 'session-9' } }, { seq: 5 })
    await waitFor(() => relay.host.closes >= 1, '服务端看到连接关闭')

    const registersAfterDispose = relay.host.registers
    await new Promise((r) => setTimeout(r, 200))
    assert.equal(framesOf(relay, 'session/event').length, before)
    assert.equal(relay.host.registers, registersAfterDispose)   // 没有在背后重连
  } finally {
    ctx.dispose()
    await relay.stop()
  }
})

/* ------------------------------------------------- 历史补齐（只读句柄） */

const fakePersistence = (total) => {
  const opened = []
  const closes = { n: 0 }
  return {
    opened,
    closes,
    service: {
      async open(id, access) {
        opened.push({ id, access })
        const events = Array.from({ length: total }, (_, i) => ({ seq: i, type: 'message/delta' }))
        return {
          read: async (offset, length) => ({ eventState: 'prepared', events: events.slice(offset, offset + length) }),
          close: async () => { closes.n++ },
        }
      },
    },
  }
}

test('session/follow 绑宿主 sessionPersistence 的只读句柄，真正补齐历史', async () => {
  const relay = await startFakeRelay()
  const ctx = createMockCtx()
  const persistence = fakePersistence(5)
  ctx.sessionPersistence = persistence.service
  try {
    const plugin = apply(ctx, { relayUrl: relay.url, deviceId: 'pc-1', autoConnect: true })
    await waitFor(() => plugin.state.connected, '已连接')

    relay.send({
      t: 'http/request', reqId: 'r-7', method: 'POST', endpoint: 'session/follow',
      body: { sessionId: 'session-1', sinceSeq: 1 },
    })
    await waitFor(() => framesOf(relay, 'http/response').length === 1, '回响应')

    const resp = framesOf(relay, 'http/response')[0]
    assert.equal(resp.status, 200)
    assert.deepEqual(resp.body.data.events.map((e) => e.seq), [2, 3, 4])
    assert.equal(resp.body.data.complete, true)
    // 句柄是 open(id, 'read')：绝不自开写句柄（ADR-008）
    assert.deepEqual(persistence.opened, [{ id: 'session-1', access: 'read' }])
    assert.equal(persistence.closes.n, 1, '句柄用后即释放')

    const status = await callRoute(ctx, '/__wbsync/status')
    assert.equal(status.json.data.replayReady, true)
  } finally {
    ctx.dispose()
    await relay.stop()
  }
})

test('没有只读句柄时如实回 501 NOT_AVAILABLE，不假装补齐成功', async () => {
  const relay = await startFakeRelay()
  const ctx = createMockCtx()      // 故意不给 sessionPersistence
  try {
    const plugin = apply(ctx, { relayUrl: relay.url, deviceId: 'pc-1', autoConnect: true })
    await waitFor(() => plugin.state.connected, '已连接')

    relay.send({
      t: 'http/request', reqId: 'r-8', method: 'POST', endpoint: 'session/follow',
      body: { sessionId: 'session-1', sinceSeq: 0 },
    })
    await waitFor(() => framesOf(relay, 'http/response').length === 1, '回响应')

    const resp = framesOf(relay, 'http/response')[0]
    assert.equal(resp.status, 501)
    assert.equal(resp.body.error.code, 'NOT_AVAILABLE')

    const status = await callRoute(ctx, '/__wbsync/status')
    assert.equal(status.json.data.replayReady, false)
  } finally {
    ctx.dispose()
    await relay.stop()
  }
})

/* ------------------------------------------------------- 会话索引上报 */

const indexPersistence = (rows, openSession = null) => ({
  list: async () => rows,
  ...(openSession ? { open: openSession } : {}),
})

const row = (id, extra = {}) => ({
  header: {
    type: 'session', version: 4, id, createdAt: 1_700_000_000_000,
    cwd: 'C:\\work\\demo', isSeeded: false, delegationDepth: 0, agentPreset: 'standard',
  },
  formatStatus: 'ok', revision: 'rev-1', sizeBytes: 256,
  ...extra,
})

test('注册成功后自动推一份 host/sessions 索引', async () => {
  const relay = await startFakeRelay()
  const ctx = createMockCtx()
  ctx.sessionPersistence = indexPersistence([row('session-1'), row('session-2')])
  try {
    const plugin = apply(ctx, { relayUrl: relay.url, deviceId: 'pc-1', autoConnect: true })
    await waitFor(() => framesOf(relay, 'host/sessions').length === 1, '收到索引帧')

    const frame = framesOf(relay, 'host/sessions')[0]
    assert.deepEqual(frame.rows.map((r) => r.sessionId), ['session-1', 'session-2'])
    assert.equal(frame.rows[0].ownerDeviceId, 'pc-1')
    assert.equal(frame.rows[0].state, 'stopped')
    // 没有可读句柄 → lastSeq 未知，但不能是 0（0 会被手机当成「没有新事件」）
    assert.equal(frame.rows[0].lastSeq, null)

    await waitFor(() => plugin.state.indexCount === 2, '状态里记下条数')
    const status = await callRoute(ctx, '/__wbsync/status')
    assert.equal(status.json.data.indexReady, true)
    assert.equal(status.json.data.indexCount, 2)
    assert.equal(status.json.data.indexError, null)
    assert.ok(status.json.data.indexSentAt > 0)
  } finally {
    ctx.dispose()
    await relay.stop()
  }
})

test('没有 list() 就不发索引帧，也不谎报空表', async () => {
  const relay = await startFakeRelay()
  const ctx = createMockCtx()
  try {
    const plugin = apply(ctx, { relayUrl: relay.url, deviceId: 'pc-1', autoConnect: true })
    await waitFor(() => plugin.state.connected, '已连接')
    await new Promise((r) => setTimeout(r, 120))

    assert.equal(framesOf(relay, 'host/sessions').length, 0)
    const status = await callRoute(ctx, '/__wbsync/status')
    assert.equal(status.json.data.indexReady, false)
    assert.equal(status.json.data.indexCount, 0)
  } finally {
    ctx.dispose()
    await relay.stop()
  }
})

test('按 indexRefreshMs 周期刷新索引，重连后重新推一次', async () => {
  const relay = await startFakeRelay()
  const ctx = createMockCtx()
  ctx.sessionPersistence = indexPersistence([row('session-1')])
  try {
    const plugin = apply(ctx, {
      relayUrl: relay.url, deviceId: 'pc-1', autoConnect: true,
      indexRefreshMs: 50, reconnectBaseMs: 20, reconnectMaxMs: 80,
    })
    await waitFor(() => framesOf(relay, 'host/sessions').length >= 2, '定时刷新至少一次')

    relay.closeHost()
    await waitFor(() => relay.host.registers === 2, '重连注册')
    const before = framesOf(relay, 'host/sessions').length
    await waitFor(() => framesOf(relay, 'host/sessions').length > before, '重连后再推一次')
  } finally {
    ctx.dispose()
    await relay.stop()
  }
})

/* ------------------------------------------------------- 真 Relay 端到端 */

const hmac = (secret, msg) => createHmac('sha256', secret).update(msg).digest('hex')

test('端到端：配对 → Host WS 注册 → 手机 HTTP 投递 → 宿主提交入口 → 响应回程', async () => {
  const relay = createRelay()
  const port = await relay.start(0)
  const base = `http://127.0.0.1:${port}`
  const ctx = createMockCtx()
  const received = []

  const post = async (path, body, headers = {}) => {
    const r = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
    return { status: r.status, json: await r.json() }
  }

  try {
    // 1. PC 侧登记配对码
    const gen = await post('/pair/generate', { deviceId: 'pc-1' })
    assert.equal(gen.status, 200)
    assert.match(String(gen.json.data.code), /^\d{6}$/)

    // 2. 手机输码换一次性挑战
    const pair = await post('/pair', { code: gen.json.data.code })
    assert.equal(pair.status, 200)
    const { challenge, pairSecret } = pair.json.data

    // 3. 手机证明自己拿到了 pairSecret（per-challenge，不落盘）
    const verify = await post('/pair/verify', { challenge, sig: hmac(pairSecret, challenge) })
    assert.equal(verify.status, 200)
    const deviceToken = verify.json.data.deviceToken

    // 4. Host 插件外连 Relay 并注册
    ctx.sessionPersistence = indexPersistence([row('session-1'), row('session-2')])
    const plugin = apply(ctx, {
      relayUrl: base, deviceId: 'pc-1', autoConnect: true,
      submitPrompt: async (args) => { received.push(args); return { ok: true, value: { accepted: true } } },
    })
    await waitFor(() => relay.isOnline('pc-1'), 'Relay 判定 Host 在线')
    await waitFor(() => plugin.state.connected, '插件侧已连接')

    // 4b. 索引帧经真实 Relay 落进 state.indexes，可被查询
    let indexes = null
    for (let i = 0; i < 100; i++) {
      const r = await fetch(`${base}/host/indexes?deviceId=pc-1`)
      indexes = (await r.json()).data
      if (indexes.rows.length === 2) break
      await new Promise((res) => setTimeout(res, 20))
    }
    assert.deepEqual(indexes.rows.map((r) => r.sessionId), ['session-1', 'session-2'])

    // 5. 手机侧 HTTP 投递 → 帧 → 适配器 → 响应回程
    const deliver = await post('/d/pc-1/session/prompt', { sessionId: 'session-9', text: '远程跑' }, {
      Authorization: `Bearer ${deviceToken}`,
    })
    assert.equal(deliver.status, 200)
    assert.equal(deliver.json.ok, true)
    assert.deepEqual(deliver.json.data, { accepted: true })
    assert.deepEqual(received, [{ sessionId: 'session-9', text: '远程跑', clientMsgId: undefined }])

    // 6. 本地配对路由代理真实 Relay 的 /pair/generate（POST）
    const bridged = await callRoute(ctx, '/__wbsync/pair', { method: 'POST' })
    assert.equal(bridged.status, 200)
    assert.match(String(bridged.json.data.code), /^\d{6}$/)

    // 6b. GET 同样出码（PC 浏览器地址栏直开的真机联调路径）
    const viaGet = await callRoute(ctx, '/__wbsync/pair', { method: 'GET' })
    assert.equal(viaGet.status, 200)
    assert.match(String(viaGet.json.data.code), /^\d{6}$/)

    // 7. 其他方法仍拒绝
    const notAllowed = await callRoute(ctx, '/__wbsync/pair', { method: 'DELETE' })
    assert.equal(notAllowed.status, 405)

    ctx.dispose()
    await waitFor(() => !relay.isOnline('pc-1'), '卸载后 Relay 判定离线')
  } finally {
    ctx.dispose()
    await relay.stop()
  }
})

/* ------------------------------------------------------------ W8 审批转发 */

test('P-AP1 宿主审批瀑布 → 插件上行 $events/request；手机应答帧回来 → 返回 allowed-once', async () => {
  const relay = await startFakeRelay()
  const ctx = createMockCtx()
  try {
    const plugin = apply(ctx, { relayUrl: relay.url, deviceId: 'pc-ap', autoConnect: true })
    await waitFor(() => plugin.state.connected, '已连接')

    let nextCalled = 0
    const next = async () => { nextCalled++; return 'unavailable' }
    // 直接取注册的监听器：mock 的 emit 会丢掉返回值，而瀑布的返回值就是审批结果
    const handler = (ctx.listeners.get('approval/request') ?? [])[0]
    assert.equal(typeof handler, 'function', '插件必须注册 approval/request 瀑布')

    const outcomePromise = handler(
      { agent: { session: { id: 'session-ap' } }, toolName: 'shell_run', callId: 'call-1', reason: '需要执行命令' },
      next,
    )

    await waitFor(() => framesOf(relay, '$events/request').length === 1, '上行审批帧')
    const frame = framesOf(relay, '$events/request')[0]
    assert.equal(frame.sessionId, 'session-ap')
    assert.equal(frame.toolName, 'shell_run')
    assert.equal(frame.reason, '需要执行命令')
    assert.equal(nextCalled, 0, '手机在线时不该交棒')

    relay.send({
      t: 'http/request', reqId: 'r-ap', method: 'POST',
      endpoint: '$events/result',
      body: { approvalId: frame.approvalId, outcome: 'allowed-once' },
    })
    await waitFor(() => framesOf(relay, 'http/response').length === 1, '应答回响应')
    const resp = framesOf(relay, 'http/response')[0]
    assert.equal(resp.status, 200)
    assert.equal(resp.body.data.outcome, 'allowed-once')

    assert.equal(await outcomePromise, 'allowed-once', '瀑布最终要返回宿主要的 ApprovalOutcome')
    assert.equal(nextCalled, 0)
  } finally {
    ctx.dispose()
    await relay.stop()
  }
})

test('P-AP2 未知/已应答的审批 id → 409 APPROVAL_GONE；非法 outcome → 400', async () => {
  const relay = await startFakeRelay()
  const ctx = createMockCtx()
  try {
    const plugin = apply(ctx, { relayUrl: relay.url, deviceId: 'pc-ap2', autoConnect: true })
    await waitFor(() => plugin.state.connected, '已连接')

    relay.send({
      t: 'http/request', reqId: 'r-bad1', method: 'POST',
      endpoint: '$events/result', body: { approvalId: 'nope', outcome: 'allowed-once' },
    })
    await waitFor(() => framesOf(relay, 'http/response').length === 1, '第一个响应')
    const gone = framesOf(relay, 'http/response')[0]
    assert.equal(gone.status, 409)
    assert.equal(gone.body.error.code, 'APPROVAL_GONE')

    relay.send({
      t: 'http/request', reqId: 'r-bad2', method: 'POST',
      endpoint: '$events/result', body: { approvalId: 'nope', outcome: 'allow-everything' },
    })
    await waitFor(() => framesOf(relay, 'http/response').length === 2, '第二个响应')
    const invalid = framesOf(relay, 'http/response')[1]
    assert.equal(invalid.status, 400, '不许把手机传来的任意串透给宿主')
    assert.equal(invalid.body.error.code, 'INVALID_JSON')
  } finally {
    ctx.dispose()
    await relay.stop()
  }
})

/* ------------------------------------------------------------ W8 产物索引 */

test('P-AF1 session/artifacts 下行分派：只回元数据，不夹带文件字节', async () => {
  const relay = await startFakeRelay()
  const ctx = createMockCtx()
  const seen = []
  try {
    const plugin = apply(ctx, {
      relayUrl: relay.url, deviceId: 'pc-af', autoConnect: true,
      listArtifacts: async (args) => {
        seen.push(args)
        return {
          ok: true,
          value: {
            sessionId: args.sessionId, count: 1, truncated: false,
            rows: [{ seq: 3, turn: 1, callId: 'c', index: 0, path: 'out/a.pdf', name: 'a.pdf', description: '成品' }],
          },
        }
      },
    })
    await waitFor(() => plugin.state.connected, '已连接')
    relay.send({
      t: 'http/request', reqId: 'r-af', method: 'POST',
      endpoint: 'session/artifacts', body: { sessionId: 'session-af' },
    })
    await waitFor(() => framesOf(relay, 'http/response').length === 1, '产物响应')
    const resp = framesOf(relay, 'http/response')[0]
    assert.equal(resp.status, 200)
    assert.equal(resp.body.data.rows.length, 1)
    assert.equal(resp.body.data.rows[0].name, 'a.pdf')
    assert.equal(JSON.stringify(resp.body).includes('base64'), false, '不许带任何文件内容')
    assert.deepEqual(seen, [{ sessionId: 'session-af' }])
  } finally {
    ctx.dispose()
    await relay.stop()
  }
})

test('P-AF2 会话不可读：如实回 404 SESSION_UNREADABLE，不谎报空产物表', async () => {
  const relay = await startFakeRelay()
  const ctx = createMockCtx()
  try {
    const plugin = apply(ctx, {
      relayUrl: relay.url, deviceId: 'pc-af2', autoConnect: true,
      listArtifacts: async () => ({ ok: false, code: 'SESSION_UNREADABLE', message: '会话不可读' }),
    })
    await waitFor(() => plugin.state.connected, '已连接')
    relay.send({
      t: 'http/request', reqId: 'r-af2', method: 'POST',
      endpoint: 'session/artifacts', body: { sessionId: 'gone' },
    })
    await waitFor(() => framesOf(relay, 'http/response').length === 1, '错误响应')
    const resp = framesOf(relay, 'http/response')[0]
    assert.equal(resp.status, 404, 'SESSION_UNREADABLE 在 STATUS_BY_CODE 里映射成 404')
    assert.equal(resp.body.error.code, 'SESSION_UNREADABLE')
    assert.equal(resp.body.data, undefined, '失败时不许夹带一个空 rows 假装成功')
  } finally {
    ctx.dispose()
    await relay.stop()
  }
})

/* ------------------------------------------------ 真机 2026-11-11：大事件降级 */

test('P-EV1 超过单帧软上限的事件降级转发：保留 seq/type，正文摘成 head，帧远小于上限', async () => {
  const relay = await startFakeRelay()
  const ctx = createMockCtx()
  try {
    const plugin = apply(ctx, { relayUrl: relay.url, deviceId: 'pc-ev', autoConnect: true })
    await waitFor(() => plugin.state.connected, '已连接')

    const huge = { seq: 7, type: 'assistant/message', time: 1, data: { text: 'x'.repeat(1_300_000) } }
    ctx.emit('session/event', { header: { id: 's-big' } }, huge)
    await waitFor(() => framesOf(relay, 'session/event').length === 1, '事件帧')

    const frame = framesOf(relay, 'session/event')[0]
    assert.equal(frame.sessionId, 's-big')
    assert.equal(frame.ev.seq, 7, 'seq 必须保留：丢了客户端会判缺口，卡进补齐循环')
    assert.equal(frame.ev.type, 'assistant/message')
    assert.equal(frame.ev.time, 1)
    assert.equal(frame.ev.data.truncated, true)
    assert.equal(frame.ev.data.reason, 'EVENT_TOO_LARGE')
    assert.ok(frame.ev.data.bytes > 1024 * 1024, `记录原始字节，实际 ${frame.ev.data.bytes}`)
    assert.ok(frame.ev.data.head.length > 0, '要留一小段正文前缀供人辨认')
    assert.ok(Buffer.byteLength(JSON.stringify(frame)) < 64 * 1024, '降级后的帧要小到能安全过任何 WS')
    assert.equal(plugin.state.oversized, 1)
  } finally {
    ctx.dispose()
    await relay.stop()
  }
})

test('P-EV2 正常大小的事件原样转发，一个字都不许改', async () => {
  const relay = await startFakeRelay()
  const ctx = createMockCtx()
  try {
    const plugin = apply(ctx, { relayUrl: relay.url, deviceId: 'pc-ev2', autoConnect: true })
    await waitFor(() => plugin.state.connected, '已连接')
    const small = { seq: 1, type: 'assistant/message', data: { text: '你好' } }
    ctx.emit('session/event', { header: { id: 's-small' } }, small)
    await waitFor(() => framesOf(relay, 'session/event').length === 1, '事件帧')
    const frame = framesOf(relay, 'session/event')[0]
    assert.deepEqual(frame.ev, small, '未超限的事件必须原样透传')
    assert.equal(plugin.state.oversized, 0)
  } finally {
    ctx.dispose()
    await relay.stop()
  }
})

/* ------------------------------------------------ 首屏窗口：反向补读分派 */

test('P-BF1 session/backfill 下行分派：参数原样传给适配器，结果原样回帧', async () => {
  const relay = await startFakeRelay()
  const ctx = createMockCtx()
  const seen = []
  try {
    const plugin = apply(ctx, {
      relayUrl: relay.url, deviceId: 'pc-bf', autoConnect: true,
      backfill: async (args) => {
        seen.push(args)
        return {
          ok: true,
          value: {
            sessionId: args.sessionId, bytes: 128, fromSeq: 30, toSeq: 79, hasMoreEarlier: true,
            events: [{ seq: 79, type: 'assistant/message', data: { text: '最近一条' } }],
          },
        }
      },
    })
    await waitFor(() => plugin.state.connected, '已连接')
    relay.send({
      t: 'http/request', reqId: 'r-bf', method: 'POST',
      endpoint: 'session/backfill',
      body: { sessionId: 's-bf', beforeSeq: 80, limit: 50 },
    })
    await waitFor(() => framesOf(relay, 'http/response').length === 1, '补读响应')
    const resp = framesOf(relay, 'http/response')[0]
    assert.equal(resp.status, 200)
    assert.equal(resp.body.data.events[0].seq, 79)
    assert.equal(resp.body.data.hasMoreEarlier, true)
    assert.deepEqual(seen, [{ sessionId: 's-bf', beforeSeq: 80, limit: 50 }])
  } finally {
    ctx.dispose()
    await relay.stop()
  }
})

test('配置了 deviceName / platform 时，注册帧把它们带给 Relay（手机端电脑切换用）', async () => {
  const relay = await startFakeRelay()
  const ctx = createMockCtx()
  try {
    apply(ctx, {
      relayUrl: relay.url, deviceId: 'pc-named', autoConnect: true,
      deviceName: '工作台-PC', platform: 'win32',
    })
    await waitFor(() => relay.host.registers === 1, 'host/register 到达')
    const reg = relay.host.registerFrame
    assert.equal(reg.deviceName, '工作台-PC')
    assert.equal(reg.platform, 'win32')
  } finally {
    ctx.dispose()
    await relay.stop()
  }
})

test('下行端点用到的适配器方法都在包装层转发了（漏一个就是运行时 undefined）', () => {
  const ctx = createMockCtx()
  try {
    const plugin = apply(ctx, { relayUrl: 'http://127.0.0.1:1', autoConnect: false })
    // 这里的清单对应 handleDownlink 里所有 `adapters.xxx(...)` 调用。
    // 真机踩过：setPinned 加在 createHostAdapters 上却忘了转发，下行报 "not a function"。
    for (const name of [
      'submitPrompt', 'setPinned', 'setArchived', 'cancelTurn', 'createSession',
      'uploadAttachment', 'backfill', 'listArtifacts', 'replay',
    ]) {
      assert.equal(typeof plugin.adapters[name], 'function', `${name} 忘了在 adapters 包装层转发`)
    }
  } finally {
    ctx.dispose()
  }
})

test('session/pin 下行：调到 setPinned 并原样回响应（r11）', async () => {
  const relay = await startFakeRelay()
  const ctx = createMockCtx()
  const seen = []
  try {
    const plugin = apply(ctx, {
      relayUrl: relay.url, deviceId: 'pc-1', autoConnect: true,
      setPinned: async (args) => {
        seen.push(args)
        return { ok: true, value: { pinned: true, pinnedSessionIds: ['session-9'] } }
      },
    })
    await waitFor(() => plugin.state.connected, '已连接')
    relay.send({ t: 'http/request', reqId: 'r-pin', method: 'PATCH', endpoint: 'session/pin', body: { sessionId: 'session-9', pinned: true } })
    await waitFor(() => framesOf(relay, 'http/response').length === 1, '回响应')
    const resp = framesOf(relay, 'http/response')[0]
    assert.equal(resp.status, 200)
    assert.equal(resp.body.ok, true)
    assert.deepEqual(resp.body.data, { pinned: true, pinnedSessionIds: ['session-9'] })
    assert.deepEqual(seen, [{ sessionId: 'session-9', pinned: true }])
  } finally {
    ctx.dispose()
    await relay.stop()
  }
})

test('session/archive 下行：软移除调到 setArchived 并原样回响应（r12）', async () => {
  const relay = await startFakeRelay()
  const ctx = createMockCtx()
  const seen = []
  try {
    const plugin = apply(ctx, {
      relayUrl: relay.url, deviceId: 'pc-1', autoConnect: true,
      setArchived: async (args) => {
        seen.push(args)
        return { ok: true, value: { archived: true, archivedSessionIds: ['session-9'] } }
      },
    })
    await waitFor(() => plugin.state.connected, '已连接')
    relay.send({ t: 'http/request', reqId: 'r-arc', method: 'PATCH', endpoint: 'session/archive', body: { sessionId: 'session-9', archived: true } })
    await waitFor(() => framesOf(relay, 'http/response').length === 1, '回响应')
    const resp = framesOf(relay, 'http/response')[0]
    assert.equal(resp.status, 200)
    assert.deepEqual(resp.body.data, { archived: true, archivedSessionIds: ['session-9'] })
    assert.deepEqual(seen, [{ sessionId: 'session-9', archived: true }])
  } finally {
    ctx.dispose()
    await relay.stop()
  }
})
