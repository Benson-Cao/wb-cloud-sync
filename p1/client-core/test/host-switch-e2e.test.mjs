/**
 * p1/client-core · 主机切换器 × 真 Relay 端到端（r22 / S-6.9 FE）
 * ---------------------------------------------------------------
 * 纯替身单测只能证明「逻辑自洽」；这里用真实 createRelay 证明客户端半边与
 * r19（select / mismatch）r20（/api/hosts 手机视角 bound 标记）真的对得上。
 * src 保持零依赖；跨包引用只发生在测试侧（与 pwa/test/pwa.test.mjs 同款）。
 */
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { after, before, test } from 'node:test'

import { createRelay } from '../../relay/src/server.js'
import { createHostSwitcher } from '../src/index.js'

let relay, port, base

const call = async (path, { method = 'GET', body, token } = {}) => {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await r.text()
  let json = {}
  try { json = JSON.parse(text) } catch { /* 非 JSON 交给断言 */ }
  return { status: r.status, json, text }
}

const pairPhone = async (deviceId, phoneId) => {
  const g = await call('/pair/generate', { method: 'POST', body: { deviceId } })
  assert.equal(g.status, 200)
  const c = await call('/pair', { method: 'POST', body: { code: g.json.data.code } })
  const { challenge, pairSecret } = c.json.data
  const sig = createHmac('sha256', pairSecret).update(challenge).digest('hex')
  const v = await call('/pair/verify', { method: 'POST', body: { challenge, sig, phoneId } })
  assert.equal(v.status, 200)
  return v.json.data.deviceToken
}

const registerHost = async (deviceId, extra = {}) => {
  const r = await call('/host/register', {
    method: 'POST',
    body: { deviceId, hostId: deviceId, deviceName: `档案-${deviceId}`, platform: 'win32', ...extra },
  })
  assert.equal(r.status, 200, r.text)
}

before(async () => {
  relay = createRelay({})
  port = await relay.start(0)
  base = `http://127.0.0.1:${port}`
})
after(async () => { await relay?.stop() })

test('E2E-1 listHosts 拿到真 /api/hosts 的 bound 标记，执行位置由 bound 行确定', async () => {
  await registerHost('e2e-a')
  await registerHost('e2e-b')
  const token = await pairPhone('e2e-a', 'e2e-phone-1')
  const sw = createHostSwitcher({ baseUrl: base, deviceToken: token })
  const r = await sw.listHosts()
  assert.equal(r.ok, true, JSON.stringify(r))
  const rows = r.data.rows
  assert.ok(rows.length >= 2)
  const a = rows.find((x) => x.hostId === 'e2e-a')
  const b = rows.find((x) => x.hostId === 'e2e-b')
  assert.equal(a.bound, true)
  assert.equal(b.bound, false)
  assert.equal(rows.some((x) => Array.isArray(x.phones)), false, '手机视角不收 phones[]')
  assert.equal(r.data.boundHostId, 'e2e-a')
  assert.equal(sw.snapshot().hostId, 'e2e-a')
})

test('E2E-2 selectHost 真切换：CP 绑定改变、旧 hostId 请求 409 HOST_MISMATCH、bound 翻转', async () => {
  const token = await pairPhone('e2e-a', 'e2e-phone-2')
  const changed = []
  const sw = createHostSwitcher({
    baseUrl: base, deviceToken: token, currentHostId: 'e2e-a',
    onHostChanged: (e) => changed.push(e),
  })
  // 先证明不带确认时被客户端本地拦下、绑定不动
  const denied = await sw.selectHost({ hostId: 'e2e-b' })
  assert.equal(denied.error.code, 'CONFIRM_REQUIRED')
  assert.equal(relay.cp.findPhoneByToken(token).boundHostId, 'e2e-a')

  const r = await sw.selectHost({ hostId: 'e2e-b', confirmNoMigration: true })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.switched, true)
  assert.equal(relay.cp.findPhoneByToken(token).boundHostId, 'e2e-b', 'CP 真的重绑了')
  assert.equal(changed[0].clearView, true)
  assert.equal(changed[0].resetCookieJar, true)
  assert.equal(sw.snapshot().hostId, 'e2e-b')

  // 旧 hostId 携带同一令牌 → r19 的 409 HOST_MISMATCH（不是 401）
  const old = await call('/api/sessions?hostId=e2e-a', { token })
  assert.equal(old.status, 409)
  assert.equal(old.json.error.code, 'HOST_MISMATCH')

  const after = await sw.listHosts()
  assert.equal(after.data.boundHostId, 'e2e-b', 'bound 标记随重绑翻转')
  assert.equal(after.data.rows.find((x) => x.hostId === 'e2e-b').bound, true)
})

test('E2E-3 目标主机 dshCommit 与 pin 不符 → 索引不合并、只提示升级', async () => {
  await registerHost('e2e-c', { dshCommit: 'commit-OTHER' })
  const token = await pairPhone('e2e-a', 'e2e-phone-3')
  const notices = []
  const sw = createHostSwitcher({
    baseUrl: base, deviceToken: token, currentHostId: 'e2e-a',
    pinnedDshCommit: 'commit-good', onNotice: (n) => notices.push(n),
  })
  const r = await sw.selectHost({ hostId: 'e2e-c', confirmNoMigration: true })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.drift, true)
  assert.equal(r.indexMerged, false)
  assert.equal(sw.canMergeIndex('e2e-c'), false)
  assert.ok(notices.some((n) => n.type === 'upgrade-required'))
  assert.equal(relay.cp.findPhoneByToken(token).boundHostId, 'e2e-c', '切换不回滚')
})

test('E2E-4 缺确认直接打服务端仍是 400 CONFIRM_REQUIRED，绑定不动', async () => {
  const token = await pairPhone('e2e-a', 'e2e-phone-4')
  const r = await call('/api/hosts/select', {
    method: 'POST', token, body: { hostId: 'e2e-b' },
  })
  assert.equal(r.status, 400)
  assert.equal(r.json.error.code, 'CONFIRM_REQUIRED')
  assert.equal(relay.cp.findPhoneByToken(token).boundHostId, 'e2e-a')
})
