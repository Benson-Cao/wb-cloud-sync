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
    const plugin = apply(ctx, {
      relayUrl: base, deviceId: 'pc-1', autoConnect: true,
      submitPrompt: async (args) => { received.push(args); return { ok: true, value: { accepted: true } } },
    })
    await waitFor(() => relay.isOnline('pc-1'), 'Relay 判定 Host 在线')
    await waitFor(() => plugin.state.connected, '插件侧已连接')

    // 5. 手机侧 HTTP 投递 → 帧 → 适配器 → 响应回程
    const deliver = await post('/d/pc-1/session/prompt', { sessionId: 'session-9', text: '远程跑' }, {
      Authorization: `Bearer ${deviceToken}`,
    })
    assert.equal(deliver.status, 200)
    assert.equal(deliver.json.ok, true)
    assert.deepEqual(deliver.json.data, { accepted: true })
    assert.deepEqual(received, [{ sessionId: 'session-9', text: '远程跑', clientMsgId: undefined }])

    // 6. 本地配对路由代理真实 Relay 的 /pair/generate
    const bridged = await callRoute(ctx, '/__wbsync/pair', { method: 'POST' })
    assert.equal(bridged.status, 200)
    assert.match(String(bridged.json.data.code), /^\d{6}$/)

    // 7. 非 POST 的配对路由拒绝
    const notPost = await callRoute(ctx, '/__wbsync/pair', { method: 'GET' })
    assert.equal(notPost.status, 405)

    ctx.dispose()
    await waitFor(() => !relay.isOnline('pc-1'), '卸载后 Relay 判定离线')
  } finally {
    ctx.dispose()
    await relay.stop()
  }
})
