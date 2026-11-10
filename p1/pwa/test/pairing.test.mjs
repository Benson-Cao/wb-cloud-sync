/**
 * 配对流程 · 端到端测试
 * 真实 createRelay()；HMAC 走 WebCrypto（globalThis.crypto.subtle，Node ≥19
 * 与浏览器同接口，即客户端在浏览器里的真实路径）。
 * 覆盖：正常配对换得可用令牌、错码、签名被篡改、challenge 复用、码一次性。
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

test('P6 重新配对作废旧令牌（单活跃令牌），新令牌可用、旧令牌失效', async () => {
  const g1 = await call('/pair/generate', { method: 'POST', body: { deviceId: 'pc-re' } })
  const old = await pairWithRelay({ baseUrl: base, code: g1.json.data.code })
  assert.ok(old.deviceToken)

  const g2 = await call('/pair/generate', { method: 'POST', body: { deviceId: 'pc-re' } })
  const fresh = await pairWithRelay({ baseUrl: base, code: g2.json.data.code })
  assert.notEqual(fresh.deviceToken, old.deviceToken)

  await wait(20)
  const withOld = await call('/api/sessions?deviceId=pc-re', { token: old.deviceToken })
  assert.equal(withOld.status, 401)
  const withNew = await call('/api/sessions?deviceId=pc-re', { token: fresh.deviceToken })
  assert.equal(withNew.status, 200)
})
