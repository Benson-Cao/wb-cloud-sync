/**
 * PWA 客户端 · 端到端测试
 * 真实 createRelay()：真配对、真 WS Host、真事件缓冲；客户端用 Node 全局
 * fetch / WebSocket 直连。覆盖：鉴权会话列表、/host/indexes 加锁、实时按序、
 * 断线重连补 dropped 窗口、gap 回 Host 补齐、补齐失败有界停止。
 */
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { after, before, test } from 'node:test'
import { createRelay } from '../../relay/src/server.js'
import { createPwaClient } from '../src/client.js'

let relay, port, base
const hosts = []   // 所有模拟 Host 的 ws，after 里统一关，避免残留句柄

const call = async (path, { method = 'GET', body, token } = {}) => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: r.status, json: await r.json() }
}

const pair = async (deviceId) => {
  const g = await call('/pair/generate', { method: 'POST', body: { deviceId } })
  const c = await call('/pair', { method: 'POST', body: { code: g.json.data.code } })
  const sig = createHmac('sha256', c.json.data.pairSecret).update(c.json.data.challenge).digest('hex')
  const v = await call('/pair/verify', { method: 'POST', body: { challenge: c.json.data.challenge, sig } })
  assert.equal(v.status, 200)
  return v.json.data.deviceToken
}

const openHostWs = () => new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/host`)
  ws.addEventListener('open', () => resolve(ws), { once: true })
  ws.addEventListener('error', () => reject(new Error('ws 连接失败')), { once: true })
})

/** 带缓冲收件箱（与 relay/ws.test.mjs 同款）。 */
const createInbox = (ws) => {
  const queue = []
  let waiter = null
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(String(e.data))
    if (waiter) { const w = waiter; waiter = null; w(msg) } else queue.push(msg)
  })
  return {
    next(timeout = 2000) {
      return new Promise((resolve, reject) => {
        if (queue.length) return resolve(queue.shift())
        const timer = setTimeout(() => { waiter = null; reject(new Error('收件箱超时')) }, timeout)
        timer.unref?.()   // 常驻循环里的长等待不吊住事件循环，否则文件级测试会超时
        waiter = (msg) => { clearTimeout(timer); resolve(msg) }
      })
    },
  }
}

/** 注册一个能应答 http/request 的模拟 Host（follow → 只读回放适配器语义）。 */
const registerHost = async (deviceId, { replayHandler = null } = {}) => {
  const ws = await openHostWs()
  hosts.push(ws)
  const inbox = createInbox(ws)
  ws.send(JSON.stringify({ t: 'host/register', deviceId, hostToken: 'host-secret', caps: [] }))
  assert.equal((await inbox.next()).t, 'host/registered')
  ;(async () => {
    for (;;) {
      const msg = await inbox.next(60_000).catch(() => null)
      if (!msg) return
      if (msg.t === 'http/request' && replayHandler) {
        const body = await replayHandler(msg.body ?? {})
        ws.send(JSON.stringify({ t: 'http/response', reqId: msg.reqId, status: 200, body }))
      }
    }
  })()
  return { ws, inbox, send: (frame) => ws.send(JSON.stringify(frame)) }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/** 轮询等待谓词满足，超时抛出已收集的内容便于定位。 */
const waitFor = async (predicate, timeout = 4000, describe = '条件') => {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`等待超时：${describe}`)
    await wait(25)
  }
}

before(async () => {
  relay = createRelay({
    hostToken: 'host-secret',
    requestTimeoutMs: 1000,
    adminToken: 'admin-secret',
  })
  port = await relay.start(0)
  base = `http://127.0.0.1:${port}`
})
after(async () => {
  for (const ws of hosts) { try { ws.close() } catch { /* 已关闭 */ } }
  await wait(50)
  await relay.stop()
})

test('A1 /api/sessions 无令牌 / 错令牌 → 401', async () => {
  const no = await call('/api/sessions?deviceId=pc-1')
  assert.equal(no.status, 401)
  const bad = await call('/api/sessions?deviceId=pc-1', { token: 'wrong-token' })
  assert.equal(bad.status, 401)
})

test('A2 配对的手机令牌能读到该设备的会话索引（CP 读）', async () => {
  const token = await pair('pc-list')
  const host = await registerHost('pc-list')
  host.send({ t: 'host/sessions', rows: [
    { sessionId: 'session-a', lastSeq: 5, state: 'running', lastActiveAt: 100 },
    { sessionId: 'session-b', lastSeq: null, state: 'stopped' },
  ] })
  assert.equal((await host.inbox.next()).t, 'host/sessions/ack')

  const r = await call('/api/sessions?deviceId=pc-list', { token })
  assert.equal(r.status, 200)
  assert.deepEqual(r.json.data.rows.map((x) => x.sessionId), ['session-a', 'session-b'])
  assert.equal(r.json.data.rows[0].lastSeq, 5)
  // pinned 过滤参数也通（索引里 pinned 初始为 false）
  const pinned = await call('/api/sessions?deviceId=pc-list&pinned=true', { token })
  assert.deepEqual(pinned.json.data.rows, [])
})

test('A3 配了 adminToken 后 /host/indexes 不再裸奔', async () => {
  const anon = await call('/host/indexes?deviceId=pc-list')
  assert.equal(anon.status, 401)
  const admin = await call('/host/indexes?deviceId=pc-list', { token: 'admin-secret' })
  assert.equal(admin.status, 200)
  assert.equal(admin.json.data.rows.length, 2)
})

test('B1 客户端：refreshSessions + 实时事件按序到达', async () => {
  const token = await pair('pc-live')
  const host = await registerHost('pc-live')
  host.send({ t: 'host/sessions', rows: [{ sessionId: 's-live', lastSeq: 0, state: 'running', lastActiveAt: 1 }] })
  await host.inbox.next()

  const events = []
  const client = createPwaClient({
    baseUrl: base, deviceId: 'pc-live', token, reconnectBaseMs: 40,
    onEvent: ({ sessionId, ev, source }) => events.push({ sessionId, seq: ev.seq, source }),
  })
  const rows = await client.refreshSessions()
  assert.deepEqual(rows.map((x) => x.sessionId), ['s-live'])
  client.follow('s-live', { sinceSeq: -1 })
  for (const seq of [0, 1, 2]) host.send({ t: 'session/event', sessionId: 's-live', ev: { seq, data: { n: seq } } })
  await waitFor(() => events.length >= 3, 3000, '实时事件 0..2')
  assert.deepEqual(events.map((e) => e.seq), [0, 1, 2])
  assert.ok(events.every((e) => e.source === 'live' && e.sessionId === 's-live'))
  const snap = client.snapshot().follows[0]
  assert.equal(snap.lastSeq, 2)
  assert.equal(snap.status, 'following')
  client.stop()
})

test('B6 冷会话：WS 握手成功但无事件时状态应为 following，不再一直 connecting', async () => {
  const states = []
  class FakeWs {
    constructor(url) {
      this.url = url
      this.listeners = new Map()
      setTimeout(() => this.fire('open', {}), 0)
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, [])
      this.listeners.get(type).push(fn)
    }
    fire(type, ev) { for (const fn of this.listeners.get(type) ?? []) fn(ev) }
    close() { this.fire('close', {}) }
  }
  const client = createPwaClient({
    baseUrl: 'http://127.0.0.1:1', deviceId: 'pc-cold', token: 't',
    WebSocketImpl: FakeWs,
    fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, data: { rows: [] } }) }),
    onStateChange: (snap) => states.push(snap.follows[0]?.status),
  })
  try {
    client.follow('s-cold', { sinceSeq: -1 })
    await waitFor(() => client.snapshot().follows[0]?.status === 'following', 1000, 'WS open 后进入 following')
    const snap = client.snapshot().follows[0]
    assert.equal(snap.status, 'following')
    assert.equal(snap.lastSeq, -1, '冷会话没有事件，位点保持初始哨兵值')
    assert.ok(states.includes('connecting') && states.includes('following'))
  } finally {
    client.stop()
  }
})

test('B2 断线重连：重连后带本地 lastSeq，补到 dropped 窗口', async () => {
  const token = await pair('pc-drop')
  const host = await registerHost('pc-drop')

  const events = []
  const client = createPwaClient({
    baseUrl: base, deviceId: 'pc-drop', token, reconnectBaseMs: 50, reconnectMaxMs: 200,
    onEvent: ({ ev }) => events.push(ev.seq),
  })
  client.follow('s-drop', { sinceSeq: -1 })
  await wait(150)
  for (const seq of [0, 1]) host.send({ t: 'session/event', sessionId: 's-drop', ev: { seq } })
  await waitFor(() => events.join(',') === '0,1', 2000, '首段事件 0..1')

  // 模拟网络闪断：只关手机侧订阅连接（本测试仅这一条订阅，Host 连接保持）
  relay.state.hub.closeAll(1000, 'test drop')
  await wait(80)

  // 断线期间 Host 继续推 2、3（Hub 有缓冲）
  for (const seq of [2, 3]) host.send({ t: 'session/event', sessionId: 's-drop', ev: { seq } })

  // 客户端应已自动重连，并按 sinceSeq=1 补到 2、3
  await waitFor(() => events.join(',') === '0,1,2,3', 3000, '重连补齐 2..3')
  const snap = client.snapshot().follows[0]
  assert.equal(snap.lastSeq, 3)
  client.stop()
})

test('B3 gap 回 Host 补齐：缓冲起点高于客户端位置时走 session/follow', async () => {
  const token = await pair('pc-gap')
  const replayCalls = []
  const host = await registerHost('pc-gap', {
    replayHandler: async ({ sessionId, sinceSeq }) => {
      replayCalls.push({ sessionId, sinceSeq })
      // Host 日志只写到 4（Relay 缓冲里的是 5..7）：从 sinceSeq+1 取连续前缀
      const from = (Number.isInteger(sinceSeq) ? sinceSeq : -1) + 1
      const events = Array.from({ length: Math.max(0, 5 - from) }, (_, i) => ({ seq: from + i, data: {} }))
      return {
        ok: true, data: {
          sessionId, events, count: events.length,
          fromSeq: events[0]?.seq ?? null, toSeq: events.at(-1)?.seq ?? sinceSeq,
          complete: true, hasMore: false,
        },
      }
    },
  })

  // Host 只上行 5、6、7（模拟 Relay 重启后事件从日志中部进入缓冲）：startedAt=5
  for (const seq of [5, 6, 7]) host.send({ t: 'session/event', sessionId: 's-gap', ev: { seq } })
  await wait(120)

  const events = []
  let refillDone = false
  const client = createPwaClient({
    baseUrl: base, deviceId: 'pc-gap', token, reconnectBaseMs: 40,
    onEvent: ({ ev, source }) => events.push({ seq: ev.seq, source }),
    onNotice: (n) => { if (n.type === 'replay' && n.complete) refillDone = true },
  })
  client.follow('s-gap', { sinceSeq: -1 })

  await waitFor(() => events.map((e) => e.seq).join(',') === '0,1,2,3,4,5,6,7', 4000, '补齐后 0..7 全序')
  // 0..4 来自 Host 回放（source=replay），5..7 来自重订阅后的实时流
  assert.equal(events.filter((e) => e.source === 'replay').length, 5)
  assert.ok(replayCalls.length >= 1)
  assert.equal(replayCalls[0].sessionId, 's-gap')
  assert.equal(replayCalls[0].sinceSeq, -1)
  assert.ok(refillDone)
  const snap = client.snapshot().follows[0]
  assert.equal(snap.lastSeq, 7)
  client.stop()
})

test('B4 Host 补不出历史（硬缺口）→ 如实停在 gap，不无限重试', async () => {
  const token = await pair('pc-hard')
  let replayHits = 0
  const host = await registerHost('pc-hard', {
    replayHandler: async () => {
      replayHits++
      return { ok: true, data: { events: [], count: 0, fromSeq: null, toSeq: null, complete: false, expectedSeq: 3, hasMore: false } }
    },
  })
  for (const seq of [3, 4]) host.send({ t: 'session/event', sessionId: 's-hard', ev: { seq } })
  await wait(120)

  const notices = []
  const client = createPwaClient({
    baseUrl: base, deviceId: 'pc-hard', token, reconnectBaseMs: 40,
    onNotice: (n) => notices.push(n),
  })
  client.follow('s-hard', { sinceSeq: -1 })
  await waitFor(() => notices.some((n) => n.type === 'refill-failed'), 2000, 'refill-failed 通知')
  const snap = client.snapshot().follows[0]
  assert.equal(snap.status, 'gap')
  assert.equal(snap.lastSeq, -1)                       // 一条都没消费：不跳跃
  const refillFailed = notices.filter((n) => n.type === 'refill-failed')
  assert.equal(refillFailed.at(-1).reason, 'HISTORY_GAP')
  // 补齐请求有界（replay+gap 背靠背至多触发一轮，refilling 守卫去重）
  await wait(300)
  assert.ok(replayHits <= 2, `补齐请求应去重，实际 ${replayHits} 次`)
  assert.equal(client.snapshot().follows[0].status, 'gap')
  client.stop()
})

test('B5 unfollow 后不再重连；stop 清理干净', async () => {
  const token = await pair('pc-stop')
  const host = await registerHost('pc-stop')
  const client = createPwaClient({ baseUrl: base, deviceId: 'pc-stop', token, reconnectBaseMs: 40 })
  client.follow('s-stop', { sinceSeq: -1 })
  await wait(150)
  client.unfollow('s-stop')
  await wait(200)
  assert.deepEqual(client.snapshot().follows, [])
  // 就算此时连接被服务端关掉，也不应有幽灵重连（follows 已空）
  relay.state.hub.closeAll(1000, 'cleanup')
  await wait(250)
  assert.deepEqual(client.snapshot().follows, [])
  client.stop()
})
