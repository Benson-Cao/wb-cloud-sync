/**
 * W3 · CP 分离验证：两个 Relay 实例共享同一个 CP
 * ---------------------------------------------------------------
 * 这条测试存在的意义：以前设备表、索引、位点都在 Relay 进程内存里，`p1/relay` 的
 * 单测再绿也证明不了「状态不在 Relay」。这里起**两个** Relay、只传同一个 CP 实例，
 * 断言一边写入的东西另一边立刻可见——如果谁偷偷把状态塞回 Relay 的 `state`，
 * 这条会立刻失败。
 */
import { createHmac } from 'node:crypto'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createControlPlane } from '../../cp/src/index.js'
import { createRelay } from '../src/server.js'

const PROTOCOL = 'wbsync/2.3'

const startRelay = async (controlPlane, opts = {}) => {
  const relay = createRelay({ controlPlane, ...opts })
  const port = await relay.start(0)
  const base = `http://127.0.0.1:${port}`
  const call = async (path, { method = 'GET', body, token } = {}) => {
    const headers = {}
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (token) headers.Authorization = `Bearer ${token}`
    const r = await fetch(`${base}${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: r.status, json: await r.json().catch(() => null) }
  }
  return { relay, port, base, call, stop: () => relay.stop() }
}

const pairOn = async (call, deviceId) => {
  const g = await call('/pair/generate', { method: 'POST', body: { deviceId } })
  const c = await call('/pair', { method: 'POST', body: { code: g.json.data.code } })
  const sig = createHmac('sha256', c.json.data.pairSecret).update(c.json.data.challenge).digest('hex')
  const v = await call('/pair/verify', { method: 'POST', body: { challenge: c.json.data.challenge, sig } })
  return { token: v.json.data.deviceToken, status: v.status }
}

test('A 侧配对注册的设备，B 侧立即可见并能用同一令牌鉴权', async () => {
  const cp = createControlPlane()
  const a = await startRelay(cp)
  const b = await startRelay(cp)
  try {
    const { token, status } = await pairOn(a.call, 'pc-1')
    assert.equal(status, 200)
    await a.call('/host/register', { method: 'POST', body: { deviceId: 'pc-1', caps: ['attachments'] } })

    // B 侧完全没参与配对，但它从 CP 读到同一个设备
    assert.equal(b.relay.cp.getDevice('pc-1').deviceId, 'pc-1')
    assert.equal(b.relay.isOnline('pc-1'), true, 'CP 里的心跳时间窗对 B 也生效')

    // 有效令牌能过鉴权（403 是「端点不在白名单」，说明已过 401 那一关）
    const good = await b.call('/d/pc-1/fs/read', { method: 'POST', token, body: {} })
    assert.equal(good.status, 403)
    assert.equal(good.json.error.code, 'ENDPOINT_NOT_ALLOWED')

    const bad = await b.call('/d/pc-1/fs/read', { method: 'POST', token: 'forged', body: {} })
    assert.equal(bad.status, 401)

    // 设备状态也共享：A 侧标离线，B 侧立刻判离线并 409
    cp.markDeviceOffline('pc-1')
    const off = await b.call('/d/pc-1/session/prompt', { method: 'POST', token, body: { text: 'x' } })
    assert.equal(off.status, 409)
    assert.equal(off.json.error.code, 'HOST_OFFLINE')
  } finally {
    await a.stop()
    await b.stop()
  }
})

test('A 侧上报的会话索引，B 侧查得到（同一份视图，不分家）', async () => {
  const cp = createControlPlane()
  const a = await startRelay(cp)
  const b = await startRelay(cp)
  try {
    await a.call('/host/register', { method: 'POST', body: { deviceId: 'pc-1' } })
    const rows = [
      { sessionId: 'session-1', workspace: 'C:\\w', state: 'running', lastSeq: 7, lastActiveAt: 100 },
      { sessionId: 'session-2', workspace: 'C:\\w', state: 'stopped', lastSeq: 2, lastActiveAt: 200 },
    ]
    const posted = await a.call('/host/sessions', { method: 'POST', body: { deviceId: 'pc-1', rows } })
    assert.equal(posted.status, 200)
    assert.equal(posted.json.data.count, 2)

    const seen = await b.call('/host/indexes?deviceId=pc-1')
    // CP 的列表顺序是「置顶优先 → 置顶序 → 最近活跃倒序」，session-2 更活跃所以在前面
    assert.deepEqual(seen.json.data.rows.map((r) => r.sessionId), ['session-2', 'session-1'])

    // 全量快照语义：A 侧再报一份只含一个会话，B 侧就不该再看到另一个
    await a.call('/host/sessions', { method: 'POST', body: { deviceId: 'pc-1', rows: [rows[0]] } })
    const after = await b.call('/host/indexes?deviceId=pc-1')
    assert.deepEqual(after.json.data.rows.map((r) => r.sessionId), ['session-1'])
  } finally {
    await a.stop()
    await b.stop()
  }
})

test('CP 里吊销设备后，两个实例同时拒绝（没有本地缓存滞后）', async () => {
  const cp = createControlPlane()
  const a = await startRelay(cp)
  const b = await startRelay(cp)
  try {
    const { token } = await pairOn(a.call, 'pc-9')
    await a.call('/host/register', { method: 'POST', body: { deviceId: 'pc-9' } })

    cp.revokeDevice('pc-9')

    for (const [name, side] of [['A', a], ['B', b]]) {
      const r = await side.call('/d/pc-9/fs/read', { method: 'POST', token, body: {} })
      assert.equal(r.status, 401, `${name} 侧应立刻拒绝已吊销令牌`)
    }
    // 吊销后连注册都进不来
    const reRegister = await b.call('/host/register', { method: 'POST', body: { deviceId: 'pc-9' } })
    assert.equal(reRegister.status, 401)
    assert.equal(reRegister.json.error.code, 'UNAUTHORIZED')
  } finally {
    await a.stop()
    await b.stop()
  }
})

test('写句柄租约跨实例互斥：A 申请后 B 拿不到', async () => {
  const cp = createControlPlane()
  const a = await startRelay(cp)
  const b = await startRelay(cp)
  try {
    // 租约是 CP 的能力，不由 Relay 暴露 HTTP（P2 接真库后由 CP 服务对外）
    const lease = a.relay.cp.acquireLease({ sessionId: 'session-1', deviceId: 'pc-1' })
    assert.equal(lease.renewed, false)

    assert.throws(
      () => b.relay.cp.acquireLease({ sessionId: 'session-1', deviceId: 'pc-2' }),
      (e) => e.code === 'ROUTE_CONFLICT',
    )
    // 同设备续租是幂等续期，不是冲突
    assert.equal(a.relay.cp.acquireLease({ sessionId: 'session-1', deviceId: 'pc-1' }).leaseId, lease.leaseId)
    assert.equal(a.relay.protocol, PROTOCOL)
  } finally {
    await a.stop()
    await b.stop()
  }
})
