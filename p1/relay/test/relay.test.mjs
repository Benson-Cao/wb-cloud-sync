/**
 * W3 Relay 骨架 · 确定性冒烟测试（node --test，零依赖）
 * 注入 now() / randomBytes()，把时间与随机性变成可控输入；规则判定不靠运行时猜测。
 */
import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { after, before, test } from 'node:test'
import { createRelay, PROTOCOL } from '../src/server.js'

let relay, port, clock, advance

const rand = (() => {
  let n = 0
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
  return { status: r.status, protocol: r.headers.get('x-protocol-version'), json: await r.json() }
}

const pair = async (deviceId = 'dev-1') => {
  const g = await call('/pair/generate', { method: 'POST', body: { deviceId } })
  assert.equal(g.status, 200)
  assert.match(g.json.data.code, /^\d{6}$/)
  const c = await call('/pair', { method: 'POST', body: { code: g.json.data.code } })
  assert.equal(c.status, 200)
  const { challenge, pairSecret } = c.json.data
  const sig = createHmac('sha256', pairSecret).update(challenge).digest('hex')
  const v = await call('/pair/verify', { method: 'POST', body: { challenge, sig, clientId: 'phone-1' } })
  return { token: v.json.data?.deviceToken, verify: v, generate: g, challenge: c }
}

const waitForQueue = async (deviceId, count = 1) => {
  for (let i = 0; i < 50; i++) {
    if ((relay.state.queue.get(deviceId) ?? []).length >= count) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('队列未收到帧')
}

before(async () => {
  clock = 1_700_000_000_000
  advance = (ms) => { clock += ms }
  relay = createRelay({
    now: () => clock,
    randomBytes: rand,
    requestTimeoutMs: 300,
    adminToken: 'admin-secret',
  })
  port = await relay.start(0)
})
after(async () => { await relay.stop() })

test('T1 /health 返回协议版本，无鉴权', async () => {
  const r = await call('/health')
  assert.equal(r.status, 200)
  assert.equal(r.protocol, PROTOCOL)
  assert.equal(r.json.data.protocol, PROTOCOL)
})

test('T2 配对码 6 位 / 10min TTL，设备+IP 限速 5 次/分', async () => {
  const results = []
  for (let i = 0; i < 6; i++) {
    results.push(await call('/pair/generate', { method: 'POST', body: { deviceId: 'rate-dev' } }))
  }
  assert.deepEqual(results.map((r) => r.status), [200, 200, 200, 200, 200, 400], '第 6 次被限速')
  assert.equal(results[0].json.data.ttl, 600)
  assert.match(results[0].json.data.code, /^\d{6}$/)
  assert.equal(results[5].json.error.code, 'PAIR_CODE_INVALID')
  advance(60_001)
  const afterWindow = await call('/pair/generate', { method: 'POST', body: { deviceId: 'rate-dev' } })
  assert.equal(afterWindow.status, 200, '窗口过后恢复')
})

test('T3 配对码一次性；challenge 60s 过期', async () => {
  const g = await call('/pair/generate', { method: 'POST', body: { deviceId: 'ttl-dev' } })
  const c = await call('/pair', { method: 'POST', body: { code: g.json.data.code } })
  assert.equal(c.json.data.expiresIn, 60)
  const reuse = await call('/pair', { method: 'POST', body: { code: g.json.data.code } })
  assert.equal(reuse.status, 400)
  assert.equal(reuse.json.error.code, 'PAIR_CODE_INVALID')

  const { challenge, pairSecret } = c.json.data
  const sig = createHmac('sha256', pairSecret).update(challenge).digest('hex')
  advance(60_001)
  const expired = await call('/pair/verify', { method: 'POST', body: { challenge, sig, clientId: 'p' } })
  assert.equal(expired.status, 400)
  assert.equal(expired.json.error.code, 'CHALLENGE_EXPIRED')
})

test('T4 HMAC 正确签发令牌，只落 SHA-256 摘要；错误签名 401', async () => {
  const g = await call('/pair/generate', { method: 'POST', body: { deviceId: 'hmac-dev' } })
  const c = await call('/pair', { method: 'POST', body: { code: g.json.data.code } })
  const { challenge, pairSecret } = c.json.data
  const bad = await call('/pair/verify', { method: 'POST', body: { challenge, sig: 'deadbeef', clientId: 'p' } })
  assert.equal(bad.status, 401)
  assert.equal(bad.json.error.code, 'UNAUTHORIZED')
  // 挑战一次性：错误签名已核销，重新取一次
  const g2 = await call('/pair/generate', { method: 'POST', body: { deviceId: 'hmac-dev' } })
  const c2 = await call('/pair', { method: 'POST', body: { code: g2.json.data.code } })
  const sig = createHmac('sha256', c2.json.data.pairSecret).update(c2.json.data.challenge).digest('hex')
  const v = await call('/pair/verify', {
    method: 'POST', body: { challenge: c2.json.data.challenge, sig, clientId: 'p' },
  })
  assert.equal(v.status, 200)
  const d = relay.state.devices.get('hmac-dev')
  assert.equal(d.tokenDigest, createHash('sha256').update(v.json.data.deviceToken).digest('hex'))
  assert.ok(!JSON.stringify(relay.state).includes(v.json.data.deviceToken), '明文令牌不落盘')
})

test('T5 单活跃令牌：重新配对作废旧令牌', async () => {
  const a = await pair('rotate-dev')
  assert.equal(a.verify.status, 200)
  const b = await pair('rotate-dev')
  assert.equal(b.verify.status, 200)
  const old = await call('/d/rotate-dev/session/prompt', { method: 'POST', token: a.token, body: { text: 'x' } })
  assert.equal(old.status, 401)
})

test('T6 白名单外端点 403；在线桥闭环；HOST_OFFLINE 409；心跳 45s 超时', async () => {
  const p = await pair('online-dev')
  const denied = await call('/d/online-dev/artifacts/list', { method: 'POST', token: p.token, body: {} })
  assert.equal(denied.status, 403)
  assert.equal(denied.json.error.code, 'ENDPOINT_NOT_ALLOWED')

  const reg = await call('/host/register', { method: 'POST', body: { deviceId: 'online-dev', caps: ['approval'] } })
  assert.equal(reg.status, 200)
  assert.equal(relay.isOnline('online-dev'), true)

  const inflight = call('/d/online-dev/session/prompt', {
    method: 'POST', token: p.token, body: { text: 'hello', clientMsgId: 'm-1' },
  })
  await waitForQueue('online-dev')
  const polled = await call('/host/poll?deviceId=online-dev')
  const frame = polled.json.data.frames[0]
  assert.equal(frame.t, 'http/request')
  assert.equal(frame.endpoint, 'session/prompt')
  assert.equal(frame.body.text, 'hello')
  const answered = await call('/host/respond', {
    method: 'POST',
    body: { reqId: frame.reqId, status: 200, body: { ok: true, data: { accepted: true }, protocol: PROTOCOL } },
  })
  assert.equal(answered.status, 200)
  const done = await inflight
  assert.equal(done.status, 200)
  assert.equal(done.json.data.accepted, true)

  advance(45_001)
  assert.equal(relay.isOnline('online-dev'), false)
  const off = await call('/d/online-dev/session/prompt', { method: 'POST', token: p.token, body: { text: 'y' } })
  assert.equal(off.status, 409)
  assert.equal(off.json.error.code, 'HOST_OFFLINE')
})

test('T7 10s 无进度防悬挂：Host 不回响应 → 504 NO_PROGRESS', async () => {
  const p = await pair('timeout-dev')
  await call('/host/register', { method: 'POST', body: { deviceId: 'timeout-dev' } })
  const inflight = await call('/d/timeout-dev/session/prompt', {
    method: 'POST', token: p.token, body: { text: 'z' },
  })
  assert.equal(inflight.status, 504)
  assert.equal(inflight.json.error.code, 'NO_PROGRESS')
})

test('T8 #5b 客户端 sinceSeq 只作观测记录，不参与补齐决策', async () => {
  const p = await pair('cursor-dev')
  await call('/host/register', { method: 'POST', body: { deviceId: 'cursor-dev' } })
  const inflight = call('/d/cursor-dev/session/follow', {
    method: 'POST', token: p.token, body: { sinceSeq: 42, clientId: 'phone-9' },
  })
  await waitForQueue('cursor-dev')
  assert.equal(relay.state.cursors.get('phone-9|cursor-dev'), 42)
  const polled = await call('/host/poll?deviceId=cursor-dev')
  const frame = polled.json.data.frames[0]
  assert.equal(frame.body.sinceSeq, 42)
  await call('/host/respond', {
    method: 'POST', body: { reqId: frame.reqId, status: 200, body: { ok: true, data: {}, protocol: PROTOCOL } },
  })
  assert.equal((await inflight).status, 200)
})

test('T9 /admin 需鉴权，返回设备状态与令牌指纹', async () => {
  const noAuth = await call('/admin')
  assert.equal(noAuth.status, 401)
  const r = await fetch(`http://127.0.0.1:${port}/admin`, { headers: { Authorization: 'Bearer admin-secret' } })
  const body = await r.json()
  assert.equal(r.status, 200)
  assert.ok(Array.isArray(body.data.rows))
  for (const row of body.data.rows) {
    assert.ok(['online', 'offline'].includes(row.state))
    assert.ok(!('deviceToken' in row), '管理台只显示指纹，不返回明文令牌')
  }
})
