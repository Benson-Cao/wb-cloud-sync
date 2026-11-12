/**
 * 配对流程 · 端到端测试
 * 真实 createRelay()；签名走 WebCrypto（安全上下文）或纯 JS 回退
 * （`subtle: null` 模拟真机的 HTTP 局域网非安全上下文）。
 * 覆盖：正常配对换得可用令牌、错码、签名被篡改、challenge 复用、码一次性、
 * 无 WebCrypto 也能配对、两条路径等价。
 */
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { after, before, test } from 'node:test'
import { createRelay } from '../../relay/src/server.js'
import { pairWithRelay } from '../src/pairing.js'

let relay, port, base

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

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

before(async () => {
  relay = createRelay({ hostToken: 'host-secret', requestTimeoutMs: 1000 })
  port = await relay.start(0)
  base = `http://127.0.0.1:${port}`
})
after(async () => { await relay.stop() })

test('P1 正常配对：换得 deviceToken 且能通过 /api/sessions 鉴权', async () => {
  const g = await call('/pair/generate', { method: 'POST', body: { deviceId: 'pc-pair' } })
  assert.equal(g.status, 200)

  const r = await pairWithRelay({ baseUrl: base, code: g.json.data.code })
  assert.equal(r.deviceId, 'pc-pair')
  assert.ok(/^[0-9a-f]{64}$/.test(r.deviceToken))          // 32 字节 hex

  // 配对返回的令牌立即可用：读该设备会话索引（此时 Host 未上报 → 空列表）
  const list = await call(`/api/sessions?deviceId=${r.deviceId}`, { token: r.deviceToken })
  assert.equal(list.status, 200)
  assert.deepEqual(list.json.data.rows, [])
})

test('P2 错误配对码 → PAIR_CODE_INVALID，且不产生令牌', async () => {
  await assert.rejects(
    () => pairWithRelay({ baseUrl: base, code: '000000' }),
    (e) => e.code === 'PAIR_CODE_INVALID',
  )
})

test('P3 签名被篡改 → 401 UNAUTHORIZED', async () => {
  const g = await call('/pair/generate', { method: 'POST', body: { deviceId: 'pc-tamper' } })
  const c = await call('/pair', { method: 'POST', body: { code: g.json.data.code } })
  const v = await call('/pair/verify', {
    method: 'POST',
    body: { challenge: c.json.data.challenge, sig: 'ab'.repeat(32) },
  })
  assert.equal(v.status, 401)
  assert.equal(v.json.error.code, 'UNAUTHORIZED')
})

test('P4 challenge 复用 → 第二次 CHALLENGE_EXPIRED（一次性挑战）', async () => {
  const g = await call('/pair/generate', { method: 'POST', body: { deviceId: 'pc-reuse' } })
  const c = await call('/pair', { method: 'POST', body: { code: g.json.data.code } })
  const { pairSecret, challenge } = c.json.data
  const sig = createHmac('sha256', pairSecret).update(challenge).digest('hex')

  const first = await call('/pair/verify', { method: 'POST', body: { challenge, sig } })
  assert.equal(first.status, 200)
  const second = await call('/pair/verify', { method: 'POST', body: { challenge, sig } })
  assert.equal(second.status, 400)
  assert.equal(second.json.error.code, 'CHALLENGE_EXPIRED')
})

test('P5 配对码一次性：/pair 消费后重放同一码 → PAIR_CODE_INVALID', async () => {
  const g = await call('/pair/generate', { method: 'POST', body: { deviceId: 'pc-once' } })
  const first = await pairWithRelay({ baseUrl: base, code: g.json.data.code })
  assert.ok(first.deviceToken)
  await assert.rejects(
    () => pairWithRelay({ baseUrl: base, code: g.json.data.code }),
    (e) => e.code === 'PAIR_CODE_INVALID',
  )
})

test('P6 无 WebCrypto（真机 HTTP 局域网）→ 纯 JS 回退仍能配对成功', async () => {
  const g = await call('/pair/generate', { method: 'POST', body: { deviceId: 'pc-http' } })
  const r = await pairWithRelay({ baseUrl: base, code: g.json.data.code, subtle: null })
  assert.equal(r.deviceId, 'pc-http')
  assert.ok(/^[0-9a-f]{64}$/.test(r.deviceToken))
  const list = await call(`/api/sessions?deviceId=${r.deviceId}`, { token: r.deviceToken })
  assert.equal(list.status, 200)
})

test('P7 回退路径签名与 node:crypto 等价（Relay 侧算法一致）', async () => {
  // 走一遍无 subtle 的 /pair 拿 challenge，手工用纯 JS 签名后交给 Relay 验
  const { hmacSha256Hex } = await import('../src/hmac-sha256.js')
  const g = await call('/pair/generate', { method: 'POST', body: { deviceId: 'pc-equiv' } })
  const c = await call('/pair', { method: 'POST', body: { code: g.json.data.code } })
  const { pairSecret, challenge } = c.json.data
  const sig = hmacSha256Hex(pairSecret, challenge)
  assert.equal(sig, createHmac('sha256', pairSecret).update(challenge).digest('hex'))
  const v = await call('/pair/verify', { method: 'POST', body: { challenge, sig } })
  assert.equal(v.status, 200)
  assert.ok(/^[0-9a-f]{64}$/.test(v.json.data.deviceToken))
  const bound = await call('/api/sessions?deviceId=pc-equiv', { token: v.json.data.deviceToken })
  assert.equal(bound.status, 200, '纯 JS 签名换得的令牌应绑定配对码登记的设备')
})

test('P8 重配轮换：带上 phoneId 只作废本机旧令牌，不带就是另一台新手机（r9）', async () => {
  const g1 = await call('/pair/generate', { method: 'POST', body: { deviceId: 'pc-re' } })
  const old = await pairWithRelay({ baseUrl: base, code: g1.json.data.code, phoneId: 'phone-re0001' })
  assert.ok(old.deviceToken)
  assert.equal(old.deviceId, 'pc-re', 'deviceId 始终是目标 Host')
  assert.equal(old.phoneId, 'phone-re0001', '回给本机的身份就是带上来的那个')

  // 同一台手机重配：旧令牌失效（TC-5.6 逐台成立）
  const g2 = await call('/pair/generate', { method: 'POST', body: { deviceId: 'pc-re' } })
  const fresh = await pairWithRelay({ baseUrl: base, code: g2.json.data.code, phoneId: 'phone-re0001' })
  assert.notEqual(fresh.deviceToken, old.deviceToken)
  await wait(20)
  assert.equal((await call('/api/sessions?deviceId=pc-re', { token: old.deviceToken })).status, 401)
  assert.equal((await call('/api/sessions?deviceId=pc-re', { token: fresh.deviceToken })).status, 200)

  // 不带 phoneId = 另一台手机：两枚令牌同时有效（这正是两台手机并存的前提）
  const g3 = await call('/pair/generate', { method: 'POST', body: { deviceId: 'pc-re' } })
  const other = await pairWithRelay({ baseUrl: base, code: g3.json.data.code })
  assert.ok(other.phoneId && other.phoneId !== fresh.phoneId, '服务端会分配一个新身份')
  assert.equal((await call('/api/sessions?deviceId=pc-re', { token: fresh.deviceToken })).status, 200,
    '第二台手机配对不该顶掉第一台')
  assert.equal((await call('/api/sessions?deviceId=pc-re', { token: other.deviceToken })).status, 200)
})

test('P10 两段式配对：换地址重配仍认同一台手机（不再产生僵尸行）', async () => {
  const g = await call('/pair/generate', { method: 'POST', body: { deviceId: 'pc-move' } })
  const first = await pairWithRelay({ baseUrl: base, code: g.json.data.code, phoneId: 'phone-move001' })
  assert.equal(first.phoneId, 'phone-move001')
  assert.equal(relay.cp.listPhones('pc-move').length, 1)

  // 同一台 relay 的另一个地址 —— 真机踩过的坑就是这么来的：
  // 192.168.x 换到 100.x（Tailscale）重配，按 base 找不到旧档案，被当成一台新手机
  const altBase = base.replace('127.0.0.1', 'localhost')
  const g2 = await call('/pair/generate', { method: 'POST', body: { deviceId: 'pc-move' } })
  const second = await pairWithRelay({
    baseUrl: altBase,
    code: g2.json.data.code,
    phoneIdFor: (hostId) => (hostId === 'pc-move' ? 'phone-move001' : null),
  })
  assert.equal(second.phoneId, 'phone-move001', '换地址也要认回旧身份')
  assert.equal(relay.cp.listPhones('pc-move').length, 1, '不该多出一台手机')

  // 认回身份的代价是轮换：旧令牌作废，新令牌可用
  assert.equal((await call('/api/sessions?deviceId=pc-move', { token: first.deviceToken })).status, 401)
  assert.equal((await call('/api/sessions?deviceId=pc-move', { token: second.deviceToken })).status, 200)
})
