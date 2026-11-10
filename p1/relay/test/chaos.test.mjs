/**
 * P3 W10 · 混沌测试（docs/07 §W10、docs/05 W10「随机断连 200 次、重试风暴、乱序帧、Host 崩溃恢复」）
 * ---------------------------------------------------------------
 * 目标不是「跑通」而是**压出退化路径**：连接抖动、并发风暴、帧乱序、对端猝死。
 * 每条用例只断言可观测的外部行为（状态码 / 响应体 / 计时），不读实现内部变量
 * 凑答案——除了 sockets/pending 这类**泄漏**判据，那本身就是外部可观测的资源量。
 */
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { after, before, test } from 'node:test'
import { createRelay, PROTOCOL } from '../src/server.js'

// 超时设 3s：足够长到能把「快速失败」和「熬到超时」区分开，又不会拖慢套件
const TIMEOUT_MS = 3000
let relay, port

const rand = (() => {
  let n = 9000
  return (size) => Buffer.alloc(size, (++n) & 0xff)
})()

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
  assert.equal(g.status, 200, JSON.stringify(g.json))
  const c = await call('/pair', { method: 'POST', body: { code: g.json.data.code } })
  const sig = createHmac('sha256', c.json.data.pairSecret).update(c.json.data.challenge).digest('hex')
  const v = await call('/pair/verify', { method: 'POST', body: { challenge: c.json.data.challenge, sig, clientId: 'chaos' } })
  assert.equal(v.status, 200)
  return v.json.data.deviceToken
}

const openWs = (path = '/ws/host') => new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`)
  ws.addEventListener('open', () => resolve(ws), { once: true })
  ws.addEventListener('error', () => reject(new Error('ws 连接失败')), { once: true })
})

const createInbox = (ws) => {
  const queue = []
  const waiters = []
  let closed = false
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(String(e.data))
    const w = waiters.shift()
    if (w) w(msg); else queue.push(msg)
  })
  ws.addEventListener('close', () => { closed = true }, { once: true })
  return {
    raw: queue,
    get isClosed() { return closed },
    /** 取下一帧；只看指定类型时不会把无关帧吞掉（放回队首）。 */
    next: (want = null) => new Promise((resolve, reject) => {
      const scan = () => {
        if (want === null) return queue.length ? queue.shift() : undefined
        const i = queue.findIndex((m) => m.t === want)
        return i < 0 ? undefined : queue.splice(i, 1)[0]
      }
      const hit = scan()
      if (hit) return resolve(hit)
      const timer = setTimeout(() => {
        const idx = waiters.indexOf(waiter)
        if (idx >= 0) waiters.splice(idx, 1)
        reject(new Error(`收件箱超时（等 ${want ?? '任意帧'}，已收 ${queue.length} 帧）`))
      }, 3000)
      const waiter = (msg) => {
        if (want !== null && msg.t !== want) { queue.push(msg); waiters.unshift(waiter); return }
        clearTimeout(timer)
        resolve(msg)
      }
      waiters.push(waiter)
    }),
    /** 等指定类型的帧，期间其它帧全部丢弃。 */
    drainUntil: async (want) => {
      const deadline = Date.now() + 3000
      while (Date.now() < deadline) {
        const m = await this.next()
        if (m.t === want) return m
      }
      throw new Error(`3s 内没等到 ${want}`)
    },
  }
}

const register = async (ws, inbox, deviceId, hostToken = 'host-secret') => {
  ws.send(JSON.stringify({ t: 'host/register', deviceId, hostToken, caps: ['approval'] }))
  const msg = await inbox.next('host/registered')
  assert.equal(msg.t, 'host/registered')
  return msg
}

/** 连上 → 注册 → 交回连接；调用方负责关闭。 */
const connectHost = async (deviceId) => {
  const ws = await openWs()
  const inbox = createInbox(ws)
  await register(ws, inbox, deviceId)
  return { ws, inbox }
}

const closeWs = (ws) => new Promise((resolve) => {
  if (ws.readyState === WebSocket.CLOSED) return resolve()
  ws.addEventListener('close', () => resolve(), { once: true })
  ws.close()
})

/** 应答一帧 http/request。 */
const answer = (ws, frame, data, status = 200) => ws.send(JSON.stringify({
  t: 'http/response', reqId: frame.reqId, status, body: { ok: true, data, protocol: PROTOCOL },
}))

/** 泄漏判据：把内部 Map 当外部资源量读，任何残留都算退化的证据。 */
const leaks = () => ({
  sockets: relay.state.sockets.size,
  pending: relay.state.pending.size,
  queue: [...relay.state.queue.values()].reduce((n, f) => n + f.length, 0),
})

before(async () => {
  relay = createRelay({ hostToken: 'host-secret', requestTimeoutMs: TIMEOUT_MS, randomBytes: rand })
  port = await relay.start(0)
})
after(async () => { await relay.stop() })

/* ---------------------------------------------------------------- C1 */

test('C1 随机断连 200 次：无连接/请求/队列残留，Relay 仍可正常服务', async () => {
  const rounds = 200
  const errors = []
  // 不做配对：只练握手与注册路径，避免撞上配对限速（5 次/分）
  for (let i = 0; i < rounds; i++) {
    let ws
    try {
      ws = await openWs()
      const inbox = createInbox(ws)
      await register(ws, inbox, `flap-${i}`)
      if (i % 3 === 0) {
        // 三分之一顺手发一帧再断：在途请求也要被回收
        ws.send(JSON.stringify({ t: 'host/heartbeat' }))
      }
      await closeWs(ws)
    } catch (e) {
      errors.push(`round ${i}: ${e.message}`)
      try { ws?.close() } catch { /* 已关 */ }
    }
  }

  assert.deepEqual(errors, [], `第 ${errors.length} 轮握手失败，首条：${errors[0] ?? ''}`)

  // 关连接是异步收尾：给事件循环一轮机会再判泄漏
  for (let i = 0; i < 40; i++) {
    const l = leaks()
    if (l.sockets === 0 && l.pending === 0 && l.queue === 0) break
    await new Promise((r) => setTimeout(r, 25))
  }
  const l = leaks()
  assert.equal(l.sockets, 0, `断连后仍有 ${l.sockets} 个 socket 残留`)
  assert.equal(l.pending, 0, `断连后仍有 ${l.pending} 个在途请求残留`)
  assert.equal(l.queue, 0, `断连后仍有 ${l.queue} 个积压帧残留`)

  // 抖动 200 次后 Relay 仍可用：握手、心跳、索引上报、请求往返全通
  const token = await pair('flap-survivor')
  const { ws, inbox } = await connectHost('flap-survivor')
  try {
    ws.send(JSON.stringify({ t: 'host/heartbeat' }))
    await inbox.next('host/heartbeat/ack')
    const inflight = call('/d/flap-survivor/session/prompt', { method: 'POST', token, body: { text: 'after-chaos' } })
    answer(ws, await inbox.next('http/request'), { alive: true })
    const r = await inflight
    assert.equal(r.status, 200)
    assert.equal(r.json.data.alive, true)
  } finally {
    await closeWs(ws)
  }
})

/* ---------------------------------------------------------------- C2 */

test('C2 Host 猝死：在途请求立即失败，不熬满超时窗口', async () => {
  const deviceId = 'crash-inflight'
  const token = await pair(deviceId)
  const { ws, inbox } = await connectHost(deviceId)

  const started = Date.now()
  const inflight = call(`/d/${deviceId}/session/prompt`, { method: 'POST', token, body: { text: 'doomed' } })
  const frame = await inbox.next('http/request')
  assert.equal(frame.body.text, 'doomed')

  // 帧已被 Host 收走但还没回，此刻对端猝死：响应永远回不来
  await closeWs(ws)
  const r = await inflight
  const elapsed = Date.now() - started

  assert.equal(r.status, 409, `应回 409，实际 ${r.status} ${JSON.stringify(r.json)}`)
  assert.equal(r.json.error.code, 'HOST_OFFLINE')
  assert.equal(r.json.error.retryable, true, '断连属可重试，不能报成不可重试')
  assert.ok(
    elapsed < TIMEOUT_MS / 2,
    `应在超时窗口一半内失败，实际 ${elapsed}ms（超时 ${TIMEOUT_MS}ms）——说明请求在空等`,
  )
  assert.equal(leaks().pending, 0, '失败后不许把 pending 条目留在表里')
})

/* ---------------------------------------------------------------- C3 */

test('C3 重试风暴·在线：50 并发各自拿到自己的响应，不串号', async () => {
  const deviceId = 'storm-online'
  const token = await pair(deviceId)
  const { ws, inbox } = await connectHost(deviceId)

  try {
    const N = 50
    const reqs = Array.from({ length: N }, (_, i) =>
      call(`/d/${deviceId}/session/prompt`, { method: 'POST', token, body: { text: `m${i}`, clientMsgId: `c${i}` } }))

    const frames = []
    for (let i = 0; i < N; i++) frames.push(await inbox.next('http/request'))
    // 乱序应答：每个请求都必须按 reqId 对上自己的 m<i>，不能靠到达顺序凑
    for (const f of [...frames].reverse()) answer(ws, f, { echo: f.body.text })

    const done = await Promise.all(reqs)
    done.forEach((r, i) => {
      assert.equal(r.status, 200, `第 ${i} 个请求状态异常`)
      assert.equal(r.json.data.echo, `m${i}`, `第 ${i} 个请求拿到了别人的响应`)
    })
    assert.equal(leaks().pending, 0)
  } finally {
    await closeWs(ws)
  }
})

/* ---------------------------------------------------------------- C4 */

test('C4 重试风暴·离线：50 并发全部 409 且不排队、不悬挂', async () => {
  const deviceId = 'storm-offline'
  const token = await pair(deviceId)
  // 已配对（CP 认为在线）但 Host 从未连 WS，且先把它标离线
  relay.cp.markDeviceOffline(deviceId)
  assert.equal(relay.isOnline(deviceId), false)

  const began = Date.now()
  const N = 50
  const results = await Promise.all(Array.from({ length: N }, () =>
    call(`/d/${deviceId}/session/prompt`, { method: 'POST', token, body: { text: 'x' } })))
  const elapsed = Date.now() - began

  for (const r of results) {
    assert.equal(r.status, 409)
    assert.equal(r.json.error.code, 'HOST_OFFLINE')
  }
  assert.ok(elapsed < 2000, `50 并发离线请求耗时 ${elapsed}ms，太慢`)
  assert.equal(leaks().pending, 0, '离线请求不许进 pending')
  assert.equal(leaks().queue, 0, '离线请求不许进降级队列（否则重连后一次性灌给 Host）')
})

/* ---------------------------------------------------------------- C5 */

test('C5 乱序帧：响应逆序到达时按 reqId 匹配，先到的后到的都不串', async () => {
  const deviceId = 'ooo-resp'
  const token = await pair(deviceId)
  const { ws, inbox } = await connectHost(deviceId)

  try {
    const a = call(`/d/${deviceId}/session/prompt`, { method: 'POST', token, body: { text: 'A' } })
    const fa = await inbox.next('http/request')
    const b = call(`/d/${deviceId}/session/prompt`, { method: 'POST', token, body: { text: 'B' } })
    const fb = await inbox.next('http/request')

    // B 先回、A 后回
    answer(ws, fb, { who: 'B' })
    await inbox.next('ack')
    answer(ws, fa, { who: 'A' })
    await inbox.next('ack')

    assert.equal((await a).json.data.who, 'A')
    assert.equal((await b).json.data.who, 'B')
    assert.equal(leaks().pending, 0)
  } finally {
    await closeWs(ws)
  }
})

/* ---------------------------------------------------------------- C6 */

test('C6 重复响应帧：第二次被拒，不覆盖首次结果、不炸连接', async () => {
  const deviceId = 'dup-resp'
  const token = await pair(deviceId)
  const { ws, inbox } = await connectHost(deviceId)

  try {
    const inflight = call(`/d/${deviceId}/session/prompt`, { method: 'POST', token, body: { text: 'once' } })
    const frame = await inbox.next('http/request')

    answer(ws, frame, { attempt: 1 })
    const first = await inbox.next('ack')
    assert.equal(first.status, 'accepted')

    answer(ws, frame, { attempt: 2 })
    const second = await inbox.next('ack')
    assert.equal(second.status, 'rejected', '重复 reqId 必须被拒，否则等于允许 Host 二次改写结果')

    const r = await inflight
    assert.equal(r.json.data.attempt, 1, '结果必须是首次那个，不能被重放覆盖')
    assert.equal(relay.isOnline(deviceId), true, '重复帧不许把连接搞断')
  } finally {
    await closeWs(ws)
  }
})

/* ---------------------------------------------------------------- C7 */

test('C7 乱序事件：0/2/1 到达时先补 1 再补 2；重复 seq 判 DUPLICATE', async () => {
  const deviceId = 'ooo-ev'
  const token = await pair(deviceId)
  const { ws, inbox } = await connectHost(deviceId)

  const sub = await openWs(`/d/${deviceId}/events/session-ooo?token=${token}&sinceSeq=-1`)
  const subInbox = createInbox(sub)

  try {
    // 先到 0，再跳号发 2（应被扣住），最后补 1（应把 1、2 一起放出来）
    ws.send(JSON.stringify({ t: 'session/event', sessionId: 'session-ooo', ev: { seq: 0, kind: 'turn/start' } }))
    await inbox.next('ack')
    assert.equal((await subInbox.next('session/event')).ev.seq, 0)

    ws.send(JSON.stringify({ t: 'session/event', sessionId: 'session-ooo', ev: { seq: 2, kind: 'text/delta' } }))
    const heldAck = await inbox.next('ack')
    assert.equal(heldAck.advanced, 0, 'seq 2 先到不能推进游标')

    ws.send(JSON.stringify({ t: 'session/event', sessionId: 'session-ooo', ev: { seq: 1, kind: 'text/delta' } }))
    await inbox.next('ack')

    assert.equal((await subInbox.next('session/event')).ev.seq, 1, '补孔后必须先到 1')
    assert.equal((await subInbox.next('session/event')).ev.seq, 2, '再到 2')

    // 重复 seq：明确拒绝，不静默吞（ack.status 直接给出拒因，不是笼统 rejected）
    ws.send(JSON.stringify({ t: 'session/event', sessionId: 'session-ooo', ev: { seq: 1, kind: 'text/delta' } }))
    const dup = await inbox.next('ack')
    assert.equal(dup.status, 'DUPLICATE')

    const snap = relay.state.hub.snapshot('session-ooo')
    assert.equal(snap.delivered, 2, '游标必须停在 2，重复帧不许让它回退或前进')
  } finally {
    await closeWs(sub)
    await closeWs(ws)
  }
})

/* ---------------------------------------------------------------- C8 */

test('C8 Host 崩溃恢复：在途请求快速失败；断连期积压帧在重连后转交', async () => {
  const deviceId = 'recover'
  const token = await pair(deviceId)
  const first = await connectHost(deviceId)

  // 崩溃：带一帧在途
  const doomed = call(`/d/${deviceId}/session/prompt`, { method: 'POST', token, body: { text: 'lost' } })
  await first.inbox.next('http/request')
  await closeWs(first.ws)
  const d = await doomed
  assert.equal(d.status, 409, '崩溃瞬间的在途请求应快速失败')
  assert.equal(relay.isOnline(deviceId), false)

  // 真机形态：WS 断了但 Host 进程还活着，HTTP 心跳仍在上报 → CP 被拉回 online，
  // 此刻的请求只能落降级队列，等 WS 重新注册时一次性转交（W8 的同一条路径）
  const hb = await call('/host/heartbeat', { method: 'POST', body: { deviceId } })
  assert.equal(hb.status, 200)
  assert.equal(relay.isOnline(deviceId), true, 'HTTP 心跳应能把设备拉回在线')

  const queued = call(`/d/${deviceId}/session/prompt`, { method: 'POST', token, body: { text: 'queued-during-outage' } })
  for (let i = 0; i < 60; i++) {
    if ((relay.state.queue.get(deviceId) ?? []).length) break
    await new Promise((r) => setTimeout(r, 5))
  }
  assert.equal((relay.state.queue.get(deviceId) ?? []).length, 1, '断连期的帧应落降级队列')

  // 重连：注册后积压帧先被转交
  const second = await connectHost(deviceId)
  try {
    assert.equal(relay.isOnline(deviceId), true)
    const flushed = await second.inbox.next('http/request')
    assert.equal(flushed.body.text, 'queued-during-outage', '注册后应先收到积压帧')
    answer(second.ws, flushed, { via: 'flushed' })
    const qr = await queued
    assert.equal(qr.status, 200, `积压帧应在重连后跑通，实际 ${qr.status} ${JSON.stringify(qr.json)}`)
    assert.equal(qr.json.data.via, 'flushed')
    assert.equal(leaks().queue, 0, '转交后队列必须清空，否则重连会重复投递')
    const ok1 = call(`/d/${deviceId}/session/prompt`, { method: 'POST', token, body: { text: 'back' } })
    const f1 = await second.inbox.next('http/request')
    assert.equal(f1.body.text, 'back')
    answer(second.ws, f1, { recovered: true })
    const r = await ok1
    assert.equal(r.status, 200)
    assert.equal(r.json.data.recovered, true)

    // 索引在重连后按 full 重建：不能让断连期间的旧行残留
    second.ws.send(JSON.stringify({ t: 'host/sessions', mode: 'full', rows: [{ sessionId: 'session-x', state: 'running', lastSeq: 9 }] }))
    await second.inbox.next('host/sessions/ack')
    const idx = await call(`/host/indexes?deviceId=${deviceId}`)
    assert.deepEqual(idx.json.data.rows.map((r) => r.sessionId), ['session-x'])
  } finally {
    await closeWs(second.ws)
  }
})
