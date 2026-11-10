/**
 * 审批转发 · Relay 侧（W8）
 * ---------------------------------------------------------------
 * 分工：**Host 判、Relay 存、手机拉**。Relay 不知道自己转发的是什么工具的审批，
 * 只保证三件事：① 不丢（断线期间靠 `GET /api/approvals` 补）；② 先答先得；
 * ③ 过期就撤，别让手机界面挂着永远点不动的卡。
 */
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { after, before, test } from 'node:test'
import { createRelay, PROTOCOL } from '../src/server.js'

const HOST_TOKEN = 'host-secret'
let relay, port

const rand = (() => {
  let n = 30_000
  return (size) => Buffer.alloc(size, (++n) & 0xff)
})()

const call = async (path, { method = 'GET', body, token, hostToken } = {}) => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
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
  const v = await call('/pair/verify', { method: 'POST', body: { challenge: c.json.data.challenge, sig } })
  assert.equal(v.status, 200)
  return v.json.data.deviceToken
}

const openWs = (path) => new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`)
  const box = { ws, msgs: [] }
  ws.addEventListener('message', (e) => box.msgs.push(JSON.parse(String(e.data))))
  ws.addEventListener('open', () => resolve(box), { once: true })
  ws.addEventListener('error', () => reject(new Error('ws 连接失败')), { once: true })
})

const waitFor = async (box, pred, timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const hit = box.msgs.find(pred)
    if (hit) return hit
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`等不到期望帧；已收 ${box.msgs.map((m) => m.t).join(',') || '（空）'}`)
}

const closeWs = (ws) => new Promise((resolve) => {
  if (!ws || ws.readyState === WebSocket.CLOSED) return resolve()
  ws.addEventListener('close', () => resolve(), { once: true })
  ws.close()
})

/** 起一台 Host：注册 + 自动应答规则（approval 应答默认 200）。 */
const connectHost = async (deviceId) => {
  const box = await openWs('/ws/host')
  box.ws.send(JSON.stringify({ t: 'host/register', deviceId, hostToken: HOST_TOKEN }))
  await waitFor(box, (m) => m.t === 'host/registered')
  return box
}

const approvalFrame = (over = {}) => ({
  t: '$events/request',
  approvalId: over.approvalId ?? `ap-${Math.random().toString(16).slice(2)}`,
  sessionId: 'session-a',
  toolName: 'shell_run',
  callId: 'call-1',
  reason: '需要执行命令',
  expiresAt: Date.now() + 60_000,
  ...over,
})

before(async () => {
  relay = createRelay({ hostToken: HOST_TOKEN, requestTimeoutMs: 2000, randomBytes: rand })
  port = await relay.start(0)
})
after(async () => { await relay.stop() })

/* ------------------------------------------------------------------ R1 */

test('R1 Host 发审批 → 手机订阅端实时收到，且 GET /api/approvals 也能拉到', async () => {
  const deviceId = 'ap-live'
  const token = await pair(deviceId)
  const host = await connectHost(deviceId)
  const phone = await openWs(`/d/${deviceId}/events/session-a?token=${token}&sinceSeq=-1`)
  try {
    const frame = approvalFrame({ approvalId: 'ap-r1' })
    host.ws.send(JSON.stringify(frame))
    const ack = await waitFor(host, (m) => m.t === 'ack' && m.ref === 'ap-r1')
    assert.equal(ack.status, 'accepted')
    assert.equal(ack.delivered, 1, '该设备上的手机连接应收到推送')

    const pushed = await waitFor(phone, (m) => m.t === 'approval/request')
    assert.equal(pushed.approvalId, 'ap-r1')
    assert.equal(pushed.toolName, 'shell_run')
    assert.equal(pushed.reason, '需要执行命令')
    assert.equal(pushed.sessionId, 'session-a')

    const listed = await call(`/api/approvals?deviceId=${deviceId}`, { token })
    assert.equal(listed.status, 200)
    assert.deepEqual(listed.json.data.rows.map((r) => r.approvalId), ['ap-r1'])
  } finally {
    await closeWs(phone.ws)
    await closeWs(host.ws)
  }
})

/* ------------------------------------------------------------------ R2 */

test('R2 手机应答 → 转成 $events/result 帧给 Host；Host 200 后看板清空并广播 resolved', async () => {
  const deviceId = 'ap-answer'
  const token = await pair(deviceId)
  const host = await connectHost(deviceId)
  const phone = await openWs(`/d/${deviceId}/events/session-a?token=${token}&sinceSeq=-1`)
  try {
    host.ws.send(JSON.stringify(approvalFrame({ approvalId: 'ap-r2' })))
    await waitFor(host, (m) => m.t === 'ack' && m.ref === 'ap-r2')

    const answer = call(`/d/${deviceId}/$events/result`, {
      method: 'POST', token,
      body: { approvalId: 'ap-r2', outcome: 'allowed-once' },
    })

    const frame = await waitFor(host, (m) => m.t === 'http/request' && m.endpoint === '$events/result')
    assert.deepEqual(frame.body, { approvalId: 'ap-r2', outcome: 'allowed-once' })
    host.ws.send(JSON.stringify({
      t: 'http/response', reqId: frame.reqId, status: 200,
      body: { ok: true, data: { approvalId: 'ap-r2', outcome: 'allowed-once' }, protocol: PROTOCOL },
    }))

    const r = await answer
    assert.equal(r.status, 200, JSON.stringify(r.json))
    assert.equal(r.json.data.outcome, 'allowed-once')

    const resolved = await waitFor(phone, (m) => m.t === 'approval/resolved')
    assert.equal(resolved.approvalId, 'ap-r2')
    assert.equal(resolved.outcome, 'allowed-once')
    assert.equal(resolved.by, 'phone')

    const listed = await call(`/api/approvals?deviceId=${deviceId}`, { token })
    assert.deepEqual(listed.json.data.rows, [], '应答后必须从看板移除')
  } finally {
    await closeWs(phone.ws)
    await closeWs(host.ws)
  }
})

/* ------------------------------------------------------------------ R3 */

test('R3 两台手机抢答同一单：第二个 409 APPROVAL_GONE，且不再打扰 Host', async () => {
  const deviceId = 'ap-race'
  const token = await pair(deviceId)
  const host = await connectHost(deviceId)
  const p1 = await openWs(`/d/${deviceId}/events/session-a?token=${token}&sinceSeq=-1`)
  const p2 = await openWs(`/d/${deviceId}/events/session-a?token=${token}&sinceSeq=-1`)
  try {
    host.ws.send(JSON.stringify(approvalFrame({ approvalId: 'ap-r3' })))
    await waitFor(host, (m) => m.t === 'ack' && m.ref === 'ap-r3')

    const first = call(`/d/${deviceId}/$events/result`, {
      method: 'POST', token, body: { approvalId: 'ap-r3', outcome: 'rejected' },
    })
    const frame = await waitFor(host, (m) => m.t === 'http/request' && m.endpoint === '$events/result')
    host.ws.send(JSON.stringify({
      t: 'http/response', reqId: frame.reqId, status: 200,
      body: { ok: true, data: { outcome: 'rejected' }, protocol: PROTOCOL },
    }))
    assert.equal((await first).status, 200)

    const second = await call(`/d/${deviceId}/$events/result`, {
      method: 'POST', token, body: { approvalId: 'ap-r3', outcome: 'allowed-once' },
    })
    assert.equal(second.status, 409)
    assert.equal(second.json.error.code, 'APPROVAL_GONE')
    // 关键：第二个应答根本不该产生新的下行帧
    const extra = host.msgs.filter((m) => m.t === 'http/request' && m.endpoint === '$events/result')
    assert.equal(extra.length, 1, '抢答不许再占用 Host 一个往返')
    void p1; void p2
  } finally {
    await closeWs(p1.ws); await closeWs(p2.ws); await closeWs(host.ws)
  }
})

/* ------------------------------------------------------------------ R4 */

test('R4 过期审批：列表里看不到，且广播 resolved(by=expired)', async () => {
  const deviceId = 'ap-expire'
  const token = await pair(deviceId)
  const host = await connectHost(deviceId)
  const phone = await openWs(`/d/${deviceId}/events/session-a?token=${token}&sinceSeq=-1`)
  try {
    host.ws.send(JSON.stringify(approvalFrame({ approvalId: 'ap-old', expiresAt: Date.now() - 1000 })))
    await waitFor(host, (m) => m.t === 'ack' && m.ref === 'ap-old')

    // 推送给手机是即时发生的（Host 说是请求就推），但拉列表时已经被判过期
    const listed = await call(`/api/approvals?deviceId=${deviceId}`, { token })
    assert.deepEqual(listed.json.data.rows, [], '过期条目不该出现在列表里')

    // 过期条目被清扫后，手机上那张卡要被撤掉，否则界面停在一个永远点不动的按钮
    const resolved = await waitFor(phone, (m) => m.t === 'approval/resolved' && m.approvalId === 'ap-old')
    assert.equal(resolved.by, 'expired')
    assert.equal(resolved.outcome, 'cancelled')
  } finally {
    await closeWs(phone.ws)
    await closeWs(host.ws)
  }
})

/* ------------------------------------------------------------------ R5 */

test('R5 跨设备隔离：A 的审批不出现在 B 的列表，也不会推给 B', async () => {
  const tokenA = await pair('ap-iso-a')
  const tokenB = await pair('ap-iso-b')
  const hostA = await connectHost('ap-iso-a')
  const phoneB = await openWs(`/d/ap-iso-b/events/session-a?token=${tokenB}&sinceSeq=-1`)
  try {
    hostA.ws.send(JSON.stringify(approvalFrame({ approvalId: 'ap-iso' })))
    await waitFor(hostA, (m) => m.t === 'ack' && m.ref === 'ap-iso')

    const listedB = await call('/api/approvals?deviceId=ap-iso-b', { token: tokenB })
    assert.deepEqual(listedB.json.data.rows, [], 'B 不该看到 A 的审批')
    assert.equal(phoneB.msgs.some((m) => m.t === 'approval/request'), false, 'B 的手机不该收到 A 的推送')
    void tokenA
  } finally {
    await closeWs(phoneB.ws)
    await closeWs(hostA.ws)
  }
})

/* ------------------------------------------------------------------ R6/R7 */

test('R6 无令牌拉审批列表 → 401；别人的令牌也 401', async () => {
  const deviceId = 'ap-auth'
  const token = await pair(deviceId)
  const anon = await call(`/api/approvals?deviceId=${deviceId}`)
  assert.equal(anon.status, 401)
  const other = await call(`/api/approvals?deviceId=${deviceId}`, { token: await pair('ap-auth-other') })
  assert.equal(other.status, 401)
  const own = await call(`/api/approvals?deviceId=${deviceId}`, { token })
  assert.equal(own.status, 200)
})

test('R7 手机没订阅 WS 也能拉到审批（拉取路径不依赖长连）', async () => {
  const deviceId = 'ap-pull'
  const token = await pair(deviceId)
  const host = await connectHost(deviceId)
  try {
    host.ws.send(JSON.stringify(approvalFrame({ approvalId: 'ap-r7' })))
    const ack = await waitFor(host, (m) => m.t === 'ack' && m.ref === 'ap-r7')
    assert.equal(ack.delivered, 0, '没有订阅连接时送达数为 0，但条目仍在看板上')

    const listed = await call(`/api/approvals?deviceId=${deviceId}`, { token })
    assert.deepEqual(listed.json.data.rows.map((r) => r.approvalId), ['ap-r7'])
  } finally {
    await closeWs(host.ws)
  }
})
