/**
 * P1 W6/W7 前置 · 多手机（r9）端到端
 * ---------------------------------------------------------------
 * 背景：r8 之前令牌直接落在 **Host 的设备行**上，一台电脑只有「一枚活跃令牌」。
 * 于是第二台手机一配对，第一台就被顶成 401——两台手机不能同时看同一台电脑，
 * 而「丢了其中一台」又没法只收回那一台。r9 把手机拆成独立设备行（`boundHostId`），
 * URL 里的 `deviceId` 仍然是**目标 Host**，令牌却属于某台手机。
 *
 * 这里只钉一件事：**两台手机是两件事**。
 *   - 各自有效、互不作废；
 *   - 只看得到自己配对的那台电脑；
 *   - 收回一台不影响另一台与电脑本身；
 *   - 收回后连它的长连一起断（只挡新请求等于没收干净）。
 */
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { after, before, test } from 'node:test'
import { createRelay, PROTOCOL } from '../src/server.js'

const HOST_TOKEN = 'host-secret'
const ADMIN = 'admin-secret'
const MAX_PHONES = 3          // 测上限时不想真配 8 台
let relay, port

const rand = (() => {
  let n = 9000
  return (size) => Buffer.alloc(size, (++n) & 0xff)
})()

const call = async (path, { method = 'GET', body, token } = {}) => {
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
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

/** 走完整配对流程，返回 verify 的响应。 */
const pair = async (hostDeviceId, phoneId, label) => {
  const g = await call('/pair/generate', { method: 'POST', body: { deviceId: hostDeviceId } })
  assert.equal(g.status, 200, g.text)
  const c = await call('/pair', { method: 'POST', body: { code: g.json.data.code } })
  assert.equal(c.status, 200, c.text)
  const sig = createHmac('sha256', c.json.data.pairSecret).update(c.json.data.challenge).digest('hex')
  return call('/pair/verify', {
    method: 'POST',
    body: { challenge: c.json.data.challenge, sig, phoneId, clientName: label },
  })
}

const hostOnline = async (deviceId) => {
  const r = await call('/host/register', { method: 'POST', token: HOST_TOKEN, body: { deviceId, caps: ['approval'] } })
  assert.equal(r.status, 200, r.text)
}

const waitClose = (ws, timeoutMs = 3000) => new Promise((resolve) => {
  const timer = setTimeout(() => resolve(null), timeoutMs)
  ws.addEventListener('close', (e) => { clearTimeout(timer); resolve(e.code ?? 1006) }, { once: true })
})
const waitOpen = (ws) => new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true })
  ws.addEventListener('error', reject, { once: true })
})

before(async () => {
  relay = createRelay({
    hostToken: HOST_TOKEN,
    adminToken: ADMIN,
    requestTimeoutMs: 300,
    maxPhonesPerHost: MAX_PHONES,
    randomBytes: rand,
  })
  port = await relay.start(0)
})
after(async () => { await relay.stop() })

test('M1 两台手机同时在线：各自能读会话、发提示词，互不作废', async () => {
  const host = 'pc-multi-1'
  const a = await pair(host, 'phone-alpha1', 'Pixel')
  const b = await pair(host, 'phone-beta22', 'iPad')
  assert.equal(a.status, 200, a.text)
  assert.equal(b.status, 200, b.text)
  assert.equal(a.json.data.hostDeviceId, host, 'URL 里用的目标 Host 单独回')
  assert.notEqual(a.json.data.deviceId, b.json.data.deviceId, '两台手机是不同的身份')
  await hostOnline(host)

  for (const [name, tok] of [['A', a.json.data.deviceToken], ['B', b.json.data.deviceToken]]) {
    const list = await call(`/api/sessions?deviceId=${host}`, { token: tok })
    assert.equal(list.status, 200, `${name} 应能读会话列表：${list.text}`)
    const prompt = await call(`/d/${host}/session/prompt`, { method: 'POST', token: tok, body: { text: 'hi' } })
    // Host 没连 WS → 桥接会排队超时；这里只关心它**不是 401**
    assert.notEqual(prompt.status, 401, `${name} 不该被当成未授权：${prompt.text}`)
  }
  assert.equal(relay.cp.listPhones(host).length, 2)
})

test('M2 越界：一台手机的令牌读不到另一台电脑', async () => {
  const hostA = 'pc-multi-2a'
  const hostB = 'pc-multi-2b'
  const a = await pair(hostA, 'phone-gamma33')
  assert.equal(a.status, 200, a.text)
  const tok = a.json.data.deviceToken
  await hostOnline(hostB)

  const cross = await call(`/api/sessions?deviceId=${hostB}`, { token: tok })
  assert.equal(cross.status, 401, '同一枚令牌不能读另一台电脑的索引')
  const prompt = await call(`/d/${hostB}/session/prompt`, { method: 'POST', token: tok, body: { text: 'x' } })
  assert.equal(prompt.status, 401)
})

test('M3 上限：超过 maxPhonesPerHost 拒绝配对，返回 CLIENT_LIMIT', async () => {
  const host = 'pc-multi-3'
  await hostOnline(host)
  for (let i = 0; i < MAX_PHONES; i++) {
    const r = await pair(host, `phone-limit-${String(i).padStart(2, '0')}`)
    assert.equal(r.status, 200, `第 ${i + 1} 台应能配对：${r.text}`)
  }
  const over = await pair(host, 'phone-limit-99')
  assert.equal(over.status, 409)
  assert.equal(over.json.error.code, 'CLIENT_LIMIT')
})

test('M4 收回一台手机：只断它自己（含长连），电脑与另一台照旧', async () => {
  const host = 'pc-multi-4'
  const session = 'session-multi-4'
  const a = await pair(host, 'phone-delta44', 'Pixel')
  const b = await pair(host, 'phone-epsil55', 'iPad')
  await hostOnline(host)

  const wsA = new WebSocket(`ws://127.0.0.1:${port}/d/${host}/events/${session}?token=${a.json.data.deviceToken}&sinceSeq=-1`)
  const wsB = new WebSocket(`ws://127.0.0.1:${port}/d/${host}/events/${session}?token=${b.json.data.deviceToken}&sinceSeq=-1`)
  await Promise.all([waitOpen(wsA), waitOpen(wsB)])

  const admin = await call('/admin', { token: ADMIN })
  const row = admin.json.data.rows.find((r) => r.deviceId === host)
  assert.equal(row.phones.length, 2, '管理台要列出这台电脑名下的手机')
  assert.deepEqual(row.phones.map((p) => p.deviceId).sort(), ['phone-delta44', 'phone-epsil55'])
  assert.equal(row.phones.find((p) => p.deviceId === 'phone-delta44').label, 'Pixel')

  const rc = await call('/admin/revoke-client', {
    method: 'POST', token: ADMIN, body: { deviceId: host, clientId: 'phone-delta44' },
  })
  assert.equal(rc.status, 200, rc.text)

  assert.equal(await waitClose(wsA), 1008, '被收回的手机长连必须断开，不能只挡新请求')
  assert.equal(wsB.readyState, WebSocket.OPEN, '另一台手机的长连不该被牵连')

  const da = await call(`/api/sessions?deviceId=${host}`, { token: a.json.data.deviceToken })
  assert.equal(da.status, 401, '被收回的令牌立刻失效')
  const db = await call(`/api/sessions?deviceId=${host}`, { token: b.json.data.deviceToken })
  assert.equal(db.status, 200, '另一台手机不受影响')
  assert.equal(relay.cp.getDevice(host).tombstone, false, '电脑本身不受影响')

  // 越权收回：拿另一台电脑的 deviceId 收回这台手机会 404，且不误伤
  const wrong = await call('/admin/revoke-client', {
    method: 'POST', token: ADMIN, body: { deviceId: 'pc-multi-2a', clientId: 'phone-epsil55' },
  })
  assert.equal(wrong.status, 404)
  assert.equal((await call(`/api/sessions?deviceId=${host}`, { token: b.json.data.deviceToken })).status, 200)

  wsB.close()
})

test('M5 同一台手机重配：旧令牌作废，重配不新增一台手机', async () => {
  const host = 'pc-multi-5'
  const first = await pair(host, 'phone-zeta666')
  await hostOnline(host)
  assert.equal((await call(`/api/sessions?deviceId=${host}`, { token: first.json.data.deviceToken })).status, 200)

  const again = await pair(host, 'phone-zeta666')
  assert.equal(again.status, 200, again.text)
  assert.equal((await call(`/api/sessions?deviceId=${host}`, { token: first.json.data.deviceToken })).status, 401,
    '同 phoneId 重配必须轮换掉旧令牌')
  assert.equal((await call(`/api/sessions?deviceId=${host}`, { token: again.json.data.deviceToken })).status, 200)
  assert.equal(relay.cp.listPhones(host).length, 1, '重配不新增一台手机')
  assert.equal(again.json.data.protocol, PROTOCOL)
})

test('M6 收回之后，同一台手机拿新配对码可以回来（墓碑不是永久黑名单）', async () => {
  const host = 'pc-multi-6'
  const phoneId = 'phone-revive01'
  const first = await pair(host, phoneId, 'Pixel')
  await hostOnline(host)
  assert.equal((await call(`/api/sessions?deviceId=${host}`, { token: first.json.data.deviceToken })).status, 200)

  await call('/admin/revoke-client', { method: 'POST', token: ADMIN, body: { deviceId: host, clientId: phoneId } })
  assert.equal((await call(`/api/sessions?deviceId=${host}`, { token: first.json.data.deviceToken })).status, 401,
    '收回后旧令牌立刻失效')

  // 真机踩过的坑：手机本地还留着这个 phoneId，被收回后**再也配不回去**，
  // 界面上还只显示「配对码错误或过期」（第二次点，码已被第一次消费）
  const again = await pair(host, phoneId, 'Pixel')
  assert.equal(again.status, 200, `收回后应允许重新配对：${again.text}`)
  assert.equal(relay.cp.listPhones(host).length, 1, '重配不新增一台手机')
  assert.equal((await call(`/api/sessions?deviceId=${host}`, { token: again.json.data.deviceToken })).status, 200)
  assert.equal((await call(`/api/sessions?deviceId=${host}`, { token: first.json.data.deviceToken })).status, 401,
    '新令牌发出后，旧令牌依然无效')
})
