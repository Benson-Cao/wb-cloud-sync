/**
 * 手机侧事件订阅 + seq 连续补齐
 * 关键语义：只广播连续前缀；乱序要等缺口补齐；补不上要显式报 gap，不静默跳过。
 */
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { after, before, test } from 'node:test'
import { createRelay, PROTOCOL } from '../src/server.js'

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
  const c = await call('/pair', { method: 'POST', body: { code: g.json.data.code } })
  const sig = createHmac('sha256', c.json.data.pairSecret).update(c.json.data.challenge).digest('hex')
  const v = await call('/pair/verify', { method: 'POST', body: { challenge: c.json.data.challenge, sig, clientId: 'p' } })
  assert.equal(v.status, 200)
  return v.json.data.deviceToken
}

const openWs = (path) => new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`)
  ws.addEventListener('open', () => resolve(ws), { once: true })
  ws.addEventListener('error', () => reject(new Error('ws 连接失败')), { once: true })
})

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
      const timer = setTimeout(() => { waiter = null; reject(new Error('收件箱超时')) }, 1500)
      waiter = (msg) => { clearTimeout(timer); resolve(msg) }
    }),
    /** 断言「这段时间内没有新帧」。只能看队列长度，不能挂一个未取消的 next()—— */
    /** 否则 120ms 之后到达的帧会被那个悬挂的 Promise 吞掉，后续断言错位。 */
    pending: () => queue.length,
  }
}

const assertNoMessage = async (inbox, ms = 120) => {
  await new Promise((r) => setTimeout(r, ms))
  assert.equal(inbox.pending(), 0, '不应收到帧')
}

const waitClose = (ws) => new Promise((resolve) => {
  if (ws.readyState === WebSocket.CLOSED) return resolve()
  ws.addEventListener('close', () => resolve(), { once: true })
  ws.close()
})

const registerHost = async (deviceId) => {
  const ws = await openWs('/ws/host')
  const inbox = createInbox(ws)
  ws.send(JSON.stringify({ t: 'host/register', deviceId, caps: [] }))
  const msg = await inbox.next()
  assert.equal(msg.t, 'host/registered')
  return { ws, inbox }
}

const pushEvent = async (host, hostInbox, sessionId, seq) => {
  const ack = hostInbox.next()
  host.send(JSON.stringify({
    t: 'session/event', sessionId,
    ev: { type: 'user/message', seq, time: 1_700_000_000_000 + seq, data: { text: `m${seq}` } },
  }))
  return ack
}

before(async () => {
  relay = createRelay({ randomBytes: rand, requestTimeoutMs: 400, eventBuffer: 8 })
  port = await relay.start(0)
})
after(async () => { await relay.stop() })

test('E1 订阅后实时事件按序到达', async () => {
  const token = await pair('ev-live')
  const { ws: host, inbox: hostInbox } = await registerHost('ev-live')
  const phone = await openWs(`/d/ev-live/events/session-A?token=${token}&sinceSeq=-1`)
  const inbox = createInbox(phone)

  const replay = await inbox.next()
  assert.equal(replay.t, 'session/replay')
  assert.equal(replay.complete, true)
  assert.equal(replay.toSeq, -1)

  for (const seq of [0, 1, 2]) {
    const ack = await pushEvent(host, hostInbox, 'session-A', seq)
    assert.equal(ack.status, 'accepted')
    const msg = await inbox.next()
    assert.equal(msg.t, 'session/event')
    assert.equal(msg.ev.seq, seq)
  }

  await waitClose(phone)
  await waitClose(host)
})

test('E2 带 sinceSeq 重连只补发未消费部分', async () => {
  const token = await pair('ev-replay')
  const { ws: host, inbox: hostInbox } = await registerHost('ev-replay')
  for (const seq of [0, 1, 2]) await pushEvent(host, hostInbox, 'session-B', seq)

  const phone = await openWs(`/d/ev-replay/events/session-B?token=${token}&sinceSeq=1`)
  const inbox = createInbox(phone)
  const first = await inbox.next()
  assert.equal(first.ev.seq, 2, '只补发 2')
  const replay = await inbox.next()
  assert.equal(replay.t, 'session/replay')
  assert.equal(replay.fromSeq, 1)
  assert.equal(replay.toSeq, 2)
  assert.equal(replay.complete, true)
  await waitClose(phone)
  await waitClose(host)
})

test('E3 乱序到达：先到的 2 不广播，1 到了再按 1、2 推', async () => {
  const token = await pair('ev-order')
  const { ws: host, inbox: hostInbox } = await registerHost('ev-order')
  const phone = await openWs(`/d/ev-order/events/session-C?token=${token}&sinceSeq=-1`)
  const inbox = createInbox(phone)
  await inbox.next()  // replay

  await pushEvent(host, hostInbox, 'session-C', 0)
  assert.equal((await inbox.next()).ev.seq, 0)

  const ack2 = await pushEvent(host, hostInbox, 'session-C', 2)
  assert.equal(ack2.advanced, 0, '2 不连续，不推进')
  await assertNoMessage(inbox)

  const ack1 = await pushEvent(host, hostInbox, 'session-C', 1)
  assert.equal(ack1.advanced, 2, '1 到达后连推 1、2')
  assert.equal((await inbox.next()).ev.seq, 1)
  assert.equal((await inbox.next()).ev.seq, 2)

  await waitClose(phone)
  await waitClose(host)
})

test('E4 补不上时显式报 gap，不静默跳过', async () => {
  const token = await pair('ev-gap')
  const { ws: host, inbox: hostInbox } = await registerHost('ev-gap')
  // 首个事件就是 seq 5：起点被截断
  await pushEvent(host, hostInbox, 'session-D', 5)

  const phone = await openWs(`/d/ev-gap/events/session-D?token=${token}&sinceSeq=0`)
  const inbox = createInbox(phone)
  const replay = await inbox.next()
  assert.equal(replay.t, 'session/replay')
  assert.equal(replay.complete, false)
  const gap = await inbox.next()
  assert.equal(gap.t, 'session/gap')
  assert.equal(gap.expectedSeq, 5)

  await waitClose(phone)
  await waitClose(host)
})

test('E5 未鉴权 / 令牌错误 → 握手被拒', async () => {
  const { ws: host } = await registerHost('ev-auth')
  await assert.rejects(openWs('/d/ev-auth/events/session-E?token=deadbeef'), /ws 连接失败/)
  await assert.rejects(openWs('/d/ev-auth/events/session-E'), /ws 连接失败/)
  await waitClose(host)
})

test('E6 Host 离线时订阅 → 409 握手被拒', async () => {
  const token = await pair('ev-offline')
  const { ws: host } = await registerHost('ev-offline')
  await waitClose(host)
  await new Promise((r) => setTimeout(r, 60))
  await assert.rejects(openWs(`/d/ev-offline/events/session-F?token=${token}`), /ws 连接失败/)
})

test('E7 重复 seq 不重复入缓冲', async () => {
  const token = await pair('ev-dup')
  const { ws: host, inbox: hostInbox } = await registerHost('ev-dup')
  await pushEvent(host, hostInbox, 'session-G', 0)
  const dup = await pushEvent(host, hostInbox, 'session-G', 0)
  assert.equal(dup.status, 'DUPLICATE')

  const phone = await openWs(`/d/ev-dup/events/session-G?token=${token}&sinceSeq=-1`)
  const inbox = createInbox(phone)
  assert.equal((await inbox.next()).ev.seq, 0)
  const replay = await inbox.next()
  assert.equal(replay.toSeq, 0)
  await assertNoMessage(inbox)

  void token
  await waitClose(phone)
  await waitClose(host)
})
