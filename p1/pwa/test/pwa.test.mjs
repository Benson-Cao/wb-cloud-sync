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

/* ------------------------------------------- 真机 2026-11-11：小页补齐 */

test('C1 字节预算下每页只有 1 条：能连翻 20+ 页补齐，不再被旧的 8 页上限卡住', async () => {
  const token = await pair('pc-manypages')
  const replayCalls = []
  const host = await registerHost('pc-manypages', {
    replayHandler: async ({ sessionId, sinceSeq }) => {
      const from = (Number.isInteger(sinceSeq) ? sinceSeq : -1) + 1
      replayCalls.push(from)
      const events = from <= 25 ? [{ seq: from, data: {} }] : []
      return {
        ok: true, data: {
          sessionId, events, count: events.length,
          fromSeq: events[0]?.seq ?? null, toSeq: events.at(-1)?.seq ?? sinceSeq,
          complete: !events.length || from >= 25,
          hasMore: from < 25,
        },
      }
    },
  })
  // 让 Relay 的缓冲起点落在 5，客户端 sinceSeq=-1 订阅时必然收到 gap → 触发补齐
  for (const seq of [5, 6, 7]) host.send({ t: 'session/event', sessionId: 's-many', ev: { seq } })
  await wait(120)

  const replayed = []
  const client = createPwaClient({
    baseUrl: base, deviceId: 'pc-manypages', token, reconnectBaseMs: 40,
    onEvent: ({ ev, source }) => { if (source === 'replay') replayed.push(ev.seq) },
  })
  client.follow('s-many', { sinceSeq: -1 })
  await waitFor(() => replayed.length >= 26, 6000, '26 条分 26 页补齐')
  assert.deepEqual(replayed, Array.from({ length: 26 }, (_, i) => i))
  assert.ok(replayCalls.length > 8, `旧上限 8 页会卡住，实际翻了 ${replayCalls.length} 页`)
  client.stop()
})

test('C2 Host 说 hasMore 但一页都没推进：立刻停，不打满 200 次空转', async () => {
  const token = await pair('pc-noprogress')
  let hits = 0
  const host = await registerHost('pc-noprogress', {
    replayHandler: async ({ sessionId, sinceSeq }) => {
      hits++
      return {
        ok: true, data: {
          sessionId, events: [], count: 0, fromSeq: null, toSeq: sinceSeq,
          complete: true, hasMore: true,
        },
      }
    },
  })
  for (const seq of [5]) host.send({ t: 'session/event', sessionId: 's-nop', ev: { seq } })
  await wait(120)

  const notices = []
  const client = createPwaClient({
    baseUrl: base, deviceId: 'pc-noprogress', token, reconnectBaseMs: 40,
    onNotice: (n) => notices.push(n),
  })
  client.follow('s-nop', { sinceSeq: -1 })
  await waitFor(() => notices.some((n) => n.type === 'refill-failed'), 2000, '无进展通知')
  await wait(200)
  assert.ok(hits <= 2, `应立刻停下，实际打了 ${hits} 次`)
  assert.equal(notices.filter((n) => n.type === 'refill-failed').at(-1).reason, 'NO_PROGRESS')
  client.stop()
})

/* ------------------------------------------- 真机 2026-11-11：打开老会话白屏 */

test('D1 打开老会话时 Relay 缓冲为空：自动去 Host 补历史，而不是白屏', async () => {
  const token = await pair('pc-open')
  let calls = 0
  const host = await registerHost('pc-open', {
    replayHandler: async ({ sessionId }) => {
      calls++
      const events = [0, 1, 2].map((i) => ({ seq: i, type: 'assistant/message', data: { text: `第${i}条` } }))
      return {
        ok: true, data: {
          sessionId, events, count: events.length,
          fromSeq: 0, toSeq: 2, complete: true, hasMore: false,
        },
      }
    },
  })
  void host   // 故意不发任何 session/event：Relay 缓冲为空，正是重启后的真实状态

  const got = []
  const client = createPwaClient({
    baseUrl: base, deviceId: 'pc-open', token, reconnectBaseMs: 40,
    onEvent: ({ ev, source }) => got.push({ seq: ev.seq, source }),
  })
  client.follow('s-open', { sinceSeq: -1 })
  await waitFor(() => got.length >= 3, 4000, '从 Host 补出 3 条历史')
  assert.deepEqual(got.map((g) => g.seq), [0, 1, 2])
  assert.equal(got[0].source, 'replay')
  assert.equal(calls, 1, '只补一次：补齐后重订阅不该再触发')
  client.stop()
})

test('D2 Host 也没有历史：补一次就停，不卡在补齐循环里', async () => {
  const token = await pair('pc-empty')
  let calls = 0
  const host = await registerHost('pc-empty', {
    replayHandler: async ({ sessionId, sinceSeq }) => {
      calls++
      return {
        ok: true, data: {
          sessionId, events: [], count: 0, fromSeq: null, toSeq: sinceSeq,
          complete: true, hasMore: false,
        },
      }
    },
  })
  void host
  const client = createPwaClient({ baseUrl: base, deviceId: 'pc-empty', token, reconnectBaseMs: 40 })
  client.follow('s-empty', { sinceSeq: -1 })
  await wait(700)
  assert.ok(calls <= 1, `空会话只应补一次，实际 ${calls} 次`)
  const snap = client.snapshot().follows[0]
  assert.equal(snap.status, 'following')
  assert.equal(snap.lastSeq, -1, '没有事件就别假装有')
  client.stop()
})

test('D3 旧 Host 不认 session/backfill：退回 follow 取一页，不把「加载更早」变成砖', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null
    const tail = String(url).split('/').pop()
    calls.push(tail)
    if (tail === 'backfill') {
      return {
        ok: false, status: 403,
        json: async () => ({ ok: false, error: { code: 'ENDPOINT_NOT_ALLOWED' } }),
      }
    }
    if (tail === 'follow') {
      const from = (Number.isInteger(body?.sinceSeq) ? body.sinceSeq : -1) + 1
      const events = Array.from({ length: 5 }, (_, i) => ({ seq: from + i, data: {} }))
      return {
        ok: true, status: 200,
        json: async () => ({ ok: true, data: { events, hasMore: false, complete: true } }),
      }
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, data: { rows: [] } }) }
  }
  const client = createPwaClient({ baseUrl: 'http://x', deviceId: 'd', token: 't', fetchImpl })
  const data = await client.backfill({ sessionId: 's', beforeSeq: 10, limit: 5 })
  assert.equal(data.via, 'follow', '要明确告诉上层这是降级路径')
  assert.deepEqual(data.events.map((e) => e.seq), [5, 6, 7, 8, 9], '只保留窗口前面那段')
  assert.equal(calls.filter((c) => c === 'backfill').length, 1)
  assert.equal(calls.filter((c) => c === 'follow').length, 1)
})
