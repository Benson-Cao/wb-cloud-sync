/**
 * Host 主动 WebSocket 长连 · 确定性测试
 * 用 Node 24 全局 WebSocket 作客户端；服务端是 p1/relay/src/ws.js 的零依赖实现。
 */
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { after, before, test } from 'node:test'
import { createRelay, PROTOCOL } from '../src/server.js'

let relay, port
const rand = (() => {
  let n = 5000
  return (size) => Buffer.alloc(size, (++n) & 0xff)
})()

const call = async (path, { method = 'GET', body, token, hostToken } = {}) => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      // 降级通道的 /host/* 与 /ws/host 同级受 HOST_TOKEN 保护（渗透用例 S11–S14）
      ...(hostToken ? { Authorization: `Bearer ${hostToken}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: r.status, json: await r.json() }
}

const pair = async (deviceId) => {
  const g = await call('/pair/generate', { method: 'POST', body: { deviceId } })
  const c = await call('/pair', { method: 'POST', body: { code: g.json.data.code } })
  const sig = createHmac('sha256', c.json.data.pairSecret).update(c.json.data.challenge).digest('hex')
  const v = await call('/pair/verify', { method: 'POST', body: { challenge: c.json.data.challenge, sig, clientId: 'p' } })
  assert.equal(v.status, 200)
  return v.json.data.deviceToken
}

const openWs = () => new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/host`)
  ws.addEventListener('open', () => resolve(ws), { once: true })
  ws.addEventListener('error', () => reject(new Error('ws 连接失败')), { once: true })
})

/** 带缓冲的收件箱：连续多帧到达也不会丢。 */
const createInbox = (ws) => {
  const queue = []
  let waiter = null
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(String(e.data))
    if (waiter) { const w = waiter; waiter = null; w(msg) } else queue.push(msg)
  })
  return {
    next: () => new Promise((resolve, reject) => {
      if (queue.length) return resolve(queue.shift())
      const timer = setTimeout(() => { waiter = null; reject(new Error('收件箱超时')) }, 2000)
      waiter = (msg) => { clearTimeout(timer); resolve(msg) }
    }),
  }
}

const register = async (ws, inbox, deviceId, hostToken = 'host-secret') => {
  ws.send(JSON.stringify({ t: 'host/register', deviceId, hostToken, caps: ['approval'] }))
  const msg = await inbox.next()
  assert.equal(msg.t, 'host/registered')
  return msg
}

const waitClose = (ws) => new Promise((resolve) => {
  if (ws.readyState === WebSocket.CLOSED) return resolve()
  ws.addEventListener('close', () => resolve(), { once: true })
  ws.close()
})

before(async () => {
  relay = createRelay({
    hostToken: 'host-secret',
    requestTimeoutMs: 400,
    randomBytes: rand,
  })
  port = await relay.start(0)
})
after(async () => { await relay.stop() })

test('W1 握手 + host/register → host/registered；/health 能看到 ws 连接', async () => {
  const ws = await openWs()
  const inbox = createInbox(ws)
  const msg = await register(ws, inbox, 'ws-a')
  assert.equal(msg.deviceId, 'ws-a')
  assert.equal(msg.protocol, PROTOCOL)
  assert.equal(relay.isOnline('ws-a'), true)
  const health = await call('/health')
  assert.equal(health.json.data.sockets >= 1, true)
  await waitClose(ws)
})

test('W2 错误 HOST_TOKEN → 连接被关闭', async () => {
  const ws = await openWs()
  const inbox = createInbox(ws)
  ws.send(JSON.stringify({ t: 'host/register', deviceId: 'ws-bad', hostToken: 'wrong' }))
  let closed = false
  ws.addEventListener('close', () => { closed = true }, { once: true })
  await new Promise((r) => setTimeout(r, 120))
  assert.equal(closed, true)
  assert.equal(relay.state.sockets.has('ws-bad'), false)
  void inbox
})

test('W3 心跳 ack；host/sessions 索引上报可被查询', async () => {
  const ws = await openWs()
  const inbox = createInbox(ws)
  await register(ws, inbox, 'ws-idx')

  ws.send(JSON.stringify({ t: 'host/heartbeat' }))
  const hb = await inbox.next()
  assert.equal(hb.t, 'host/heartbeat/ack')

  ws.send(JSON.stringify({
    t: 'host/sessions',
    rows: [{ sessionId: 'session-1', lastSeq: 3, state: 'running' }],
  }))
  const ack = await inbox.next()
  assert.equal(ack.t, 'host/sessions/ack')
  assert.equal(ack.count, 1)

  const idx = await call('/host/indexes?deviceId=ws-idx')
  assert.equal(idx.json.data.rows[0].sessionId, 'session-1')
  await waitClose(ws)
})

test('W4 手机 HTTP 请求经 WS 帧往返闭环（正式通道）', async () => {
  const token = await pair('ws-live')
  const ws = await openWs()
  const inbox = createInbox(ws)
  await register(ws, inbox, 'ws-live')

  const inflight = call('/d/ws-live/session/prompt', {
    method: 'POST', token, body: { text: 'via-ws', clientMsgId: 'c1' },
  })
  const frame = await inbox.next()
  assert.equal(frame.t, 'http/request')
  assert.equal(frame.endpoint, 'session/prompt')
  assert.equal(frame.body.text, 'via-ws')

  ws.send(JSON.stringify({
    t: 'http/response', reqId: frame.reqId, status: 200,
    body: { ok: true, data: { accepted: true }, protocol: PROTOCOL },
  }))
  const ack = await inbox.next()
  assert.equal(ack.status, 'accepted')

  const done = await inflight
  assert.equal(done.status, 200)
  assert.equal(done.json.data.accepted, true)
  await waitClose(ws)
})

test('W5 同一连接多帧保序：先发的先到', async () => {
  const token = await pair('ws-order')
  const ws = await openWs()
  const inbox = createInbox(ws)
  await register(ws, inbox, 'ws-order')

  const a = call('/d/ws-order/session/prompt', { method: 'POST', token, body: { text: 'first' } })
  const b = call('/d/ws-order/session/prompt', { method: 'POST', token, body: { text: 'second' } })
  const f1 = await inbox.next()
  const f2 = await inbox.next()
  assert.equal(f1.body.text, 'first')
  assert.equal(f2.body.text, 'second')

  for (const f of [f1, f2]) {
    ws.send(JSON.stringify({
      t: 'http/response', reqId: f.reqId, status: 200,
      body: { ok: true, data: { echo: f.body.text }, protocol: PROTOCOL },
    }))
    await inbox.next()
  }
  assert.equal((await a).json.data.echo, 'first')
  assert.equal((await b).json.data.echo, 'second')
  await waitClose(ws)
})

test('W6 WS 断开 → 立即判离线，手机请求 409（不等 45s 心跳）', async () => {
  const token = await pair('ws-drop')
  const ws = await openWs()
  const inbox = createInbox(ws)
  await register(ws, inbox, 'ws-drop')
  assert.equal(relay.isOnline('ws-drop'), true)

  await waitClose(ws)
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(relay.isOnline('ws-drop'), false, 'WS 关闭应立即离线')

  const off = await call('/d/ws-drop/session/prompt', { method: 'POST', token, body: { text: 'x' } })
  assert.equal(off.status, 409)
  assert.equal(off.json.error.code, 'HOST_OFFLINE')
})

test('W7 降级通道仍可用：无 WS 时走轮询桥', async () => {
  const token = await pair('http-only')
  const reg = await call('/host/register', { method: 'POST', body: { deviceId: 'http-only', hostToken: 'host-secret' } })
  assert.equal(reg.status, 200)

  const inflight = call('/d/http-only/session/prompt', { method: 'POST', token, body: { text: 'poll' } })
  await new Promise((r) => setTimeout(r, 30))
  const polled = await call('/host/poll?deviceId=http-only', { hostToken: 'host-secret' })
  const frame = polled.json.data.frames[0]
  assert.equal(frame.body.text, 'poll')
  await call('/host/respond', {
    method: 'POST', hostToken: 'host-secret',
    body: { reqId: frame.reqId, status: 200, body: { ok: true, data: { via: 'poll' }, protocol: PROTOCOL } },
  })
  assert.equal((await inflight).json.data.via, 'poll')
})

test('W8 配对先于 WS 注册：积压下行帧转交新 WS，不 504', async () => {
  const token = await pair('late-ws')
  // 配对已把 CP 标成在线，但 Host 还没连 WS：isOnline=true，bridge 只能投降级队列
  const inflight = call('/d/late-ws/session/prompt', { method: 'POST', token, body: { text: 'early' } })
  for (let i = 0; i < 50; i++) {
    if ((relay.state.queue.get('late-ws') ?? []).length) break
    await new Promise((r) => setTimeout(r, 5))
  }
  assert.equal((relay.state.queue.get('late-ws') ?? []).length, 1, '帧应先落在降级队列')

  const ws = await openWs()
  const inbox = createInbox(ws)
  try {
    await register(ws, inbox, 'late-ws')
    const frame = await inbox.next()
    assert.equal(frame.t, 'http/request', 'WS 注册后应收到被转交的积压帧')
    assert.equal(frame.endpoint, 'session/prompt')
    assert.equal(frame.body.text, 'early')
    assert.equal((relay.state.queue.get('late-ws') ?? []).length, 0, '队列应已清空')
    ws.send(JSON.stringify({
      t: 'http/response', reqId: frame.reqId, status: 200,
      body: { ok: true, data: { via: 'flushed' }, protocol: PROTOCOL },
    }))
    const r = await inflight
    assert.equal(r.status, 200, JSON.stringify(r.json))
    assert.equal(r.json.data.via, 'flushed')
  } finally {
    await waitClose(ws)
  }
})

test('W9 host/sessions diff 帧：只应用变化，不误删未提及行', async () => {
  await pair('ws-diff')
  const ws = await openWs()
  const inbox = createInbox(ws)
  try {
    await register(ws, inbox, 'ws-diff')
    ws.send(JSON.stringify({ t: 'host/sessions', mode: 'full', rows: [
      { sessionId: 'd1', state: 'stopped', lastSeq: 1 },
      { sessionId: 'd2', state: 'stopped', lastSeq: 2 },
    ] }))
    assert.equal((await inbox.next()).mode, 'full')

    ws.send(JSON.stringify({
      t: 'host/sessions', mode: 'diff', removedIds: [],
      rows: [{ sessionId: 'd2', state: 'stopped', lastSeq: 5 }],
    }))
    assert.equal((await inbox.next()).mode, 'diff')
    let rows = (await call('/host/indexes?deviceId=ws-diff')).json.data.rows
    assert.equal(rows.length, 2, '未提及的 d1 不能被删')
    assert.equal(rows.find((r) => r.sessionId === 'd1').lastSeq, 1)
    assert.equal(rows.find((r) => r.sessionId === 'd2').lastSeq, 5)

    ws.send(JSON.stringify({ t: 'host/sessions', mode: 'diff', rows: [], removedIds: ['d1'] }))
    await inbox.next()
    rows = (await call('/host/indexes?deviceId=ws-diff')).json.data.rows
    assert.deepEqual(rows.map((r) => r.sessionId), ['d2'])
  } finally {
    await waitClose(ws)
  }
})
