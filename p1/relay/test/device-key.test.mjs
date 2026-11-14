/**
 * v2.3 · S-8.5 设备公钥 pin（Relay 端点）· TC-9 新增指纹用例
 * 真 createRelay + 真配对链：钉住、变更阻断、旧客户端兼容、收回后重新接纳。
 */
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { after, before, test } from 'node:test'
import { createRelay } from '../src/server.js'

const HOST_TOKEN = 'host-secret'
const ADMIN_TOKEN = 'admin-secret'
const KEY_A = 'a'.repeat(64)
const KEY_B = 'b'.repeat(64)
let relay, port

const call = async (path, { method = 'GET', body, token, admin = false } = {}) => {
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  if (admin) headers.Authorization = `Bearer ${ADMIN_TOKEN}`
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await r.text()
  let json = {}
  try { json = JSON.parse(text) } catch { /* 非 JSON 交给断言 */ }
  return { status: r.status, json, text }
}

const pair = async (deviceId, extra = {}) => {
  const g = await call('/pair/generate', { method: 'POST', body: { deviceId } })
  assert.equal(g.status, 200, `生成配对码失败：${g.text}`)
  const c = await call('/pair', { method: 'POST', body: { code: g.json.data.code } })
  assert.equal(c.status, 200, `换挑战失败：${c.text}`)
  const sig = createHmac('sha256', c.json.data.pairSecret).update(c.json.data.challenge).digest('hex')
  return call('/pair/verify', {
    method: 'POST',
    body: { challenge: c.json.data.challenge, sig, ...extra },
  })
}

before(async () => {
  relay = createRelay({ hostToken: HOST_TOKEN, adminToken: ADMIN_TOKEN, requestTimeoutMs: 3000 })
  port = await relay.start(0)
})
after(async () => { await relay.stop() })

test('R1 首次配对带指纹 → 200，令牌可访问主机清单', async () => {
  const v = await pair('dk-host-1', { phoneId: 'phone-dk-1', devicePubKey: KEY_A })
  assert.equal(v.status, 200, v.text)
  const hosts = await call('/api/hosts', { token: v.json.data.deviceToken })
  assert.equal(hosts.status, 200)
})

test('R2 同一手机用相同指纹续配 → 200，旧令牌失效', async () => {
  const first = await pair('dk-host-2', { phoneId: 'phone-dk-2', devicePubKey: KEY_A })
  assert.equal(first.status, 200, first.text)
  const second = await pair('dk-host-2', { phoneId: 'phone-dk-2', devicePubKey: KEY_A })
  assert.equal(second.status, 200, second.text)
  assert.notEqual(second.json.data.deviceToken, first.json.data.deviceToken)
  assert.equal((await call('/api/hosts', { token: first.json.data.deviceToken })).status, 401)
  assert.equal((await call('/api/hosts', { token: second.json.data.deviceToken })).status, 200)
})

test('R3 指纹变化 → 409 DEVICE_KEY_MISMATCH，已签发的令牌仍可用', async () => {
  const good = await pair('dk-host-3', { phoneId: 'phone-dk-3', devicePubKey: KEY_A })
  assert.equal(good.status, 200, good.text)
  const bad = await pair('dk-host-3', { phoneId: 'phone-dk-3', devicePubKey: KEY_B })
  assert.equal(bad.status, 409)
  assert.match(bad.text, /DEVICE_KEY_MISMATCH/)
  assert.equal((await call('/api/hosts', { token: good.json.data.deviceToken })).status, 200)
})

test('R4 不带指纹的旧客户端续配 → 200，钉住值不被清空', async () => {
  const first = await pair('dk-host-4', { phoneId: 'phone-dk-4', devicePubKey: KEY_A })
  assert.equal(first.status, 200, first.text)
  const legacy = await pair('dk-host-4', { phoneId: 'phone-dk-4' })
  assert.equal(legacy.status, 200, legacy.text)
  const bad = await pair('dk-host-4', { phoneId: 'phone-dk-4', devicePubKey: KEY_B })
  assert.equal(bad.status, 409, '钉住值必须仍在')
})

test('R5 管理员收回设备后，可用新指纹重新配对', async () => {
  const first = await pair('dk-host-5', { phoneId: 'phone-dk-5', devicePubKey: KEY_A })
  assert.equal(first.status, 200, first.text)
  const revoked = await call('/admin/revoke-client', {
    method: 'POST',
    admin: true,
    body: { deviceId: 'dk-host-5', clientId: 'phone-dk-5' },
  })
  assert.equal(revoked.status, 200, revoked.text)
  assert.equal(revoked.json.data.tombstone, true)
  assert.equal((await call('/api/hosts', { token: first.json.data.deviceToken })).status, 401)
  const again = await pair('dk-host-5', { phoneId: 'phone-dk-5', devicePubKey: KEY_B })
  assert.equal(again.status, 200, again.text)
  assert.equal((await call('/api/hosts', { token: again.json.data.deviceToken })).status, 200)
})

test('R6 非法格式指纹按「未携带」处理，配对仍成功', async () => {
  const v = await pair('dk-host-6', { phoneId: 'phone-dk-6', devicePubKey: 'not-a-key' })
  assert.equal(v.status, 200, v.text)
})
