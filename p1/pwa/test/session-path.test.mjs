/**
 * PWA 客户端 · 命名迁移第四步（r22）路径形态测试
 * ---------------------------------------------------------------
 * r21 服务端落地 `PATCH|DELETE /api/sessions/:hostId/:id` 后一直没有客户端使用；
 * 本文件锁 PWA 现网客户端的落地形态：查询参数用正式名 hostId=、写操作走两段
 * 路径、列表响应里的权威 hostId 同步到 snapshot（TC-4.6 执行位置常驻）。
 *
 * 用可注入 fetch（不依赖浏览器 / 真 Relay），形状与 fetch Response 一致。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createPwaClient } from '../src/client.js'

const fakeRes = (body, status = 200) => ({
  ok: status >= 200 && status < 300, status, json: async () => body,
})

const recorder = (handler) => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return handler(url, init)
  }
  return { calls, fetchImpl }
}

const listBody = (hostId = 'pc-a', rows = []) => ({
  ok: true, data: { deviceId: hostId, hostId, host: { deviceId: hostId, online: true }, rows },
})
const writeBody = { ok: true, data: { sessionId: 's-1' } }

const mk = (fetchImpl, extra = {}) => createPwaClient({
  baseUrl: 'http://relay.test:8787/', deviceId: 'pc-a', token: 'tok-secret',
  WebSocketImpl: class { }, fetchImpl, ...extra,
})

test('P1 refreshSessions 用正式参数 hostId=，并把服务端权威 hostId 同步进 snapshot', async () => {
  const { calls, fetchImpl } = recorder(() => fakeRes(listBody('pc-REAL')))
  const c = mk(fetchImpl)
  await c.refreshSessions()
  assert.equal(calls[0].url, 'http://relay.test:8787/api/sessions?hostId=pc-a', '首次用构造参数（值兼容 deviceId）')
  assert.equal(c.snapshot().hostId, 'pc-REAL', '服务端回的 hostId 是权威值')

  const c2 = mk(fetchImpl, { hostId: 'pc-EXPLICIT' })
  await c2.refreshSessions()
  assert.equal(c2.snapshot().hostId, 'pc-REAL', '响应值覆盖显式构造值')
})

test('P2 三个写操作都走 /api/sessions/:hostId/:id，且用同步后的 hostId', async () => {
  const { calls, fetchImpl } = recorder((url) => {
    if (url.includes('archived=true')) return fakeRes(listBody('pc-REAL'))
    if (url.includes('/api/sessions?')) return fakeRes(listBody('pc-REAL'))
    return fakeRes(writeBody)
  })
  const c = mk(fetchImpl)
  await c.refreshSessions()   // 同步到 pc-REAL
  await c.setPinned({ sessionId: 's/1', pinned: true })
  await c.setArchived({ sessionId: 's-1', archived: true })
  await c.renameSession({ sessionId: 's-1', title: '新标题' })

  const writes = calls.slice(1)
  assert.deepEqual(writes.map((x) => x.init.method), ['PATCH', 'PATCH', 'PATCH'])
  assert.deepEqual(writes.map((x) => x.url), [
    'http://relay.test:8787/api/sessions/pc-REAL/s%2F1',
    'http://relay.test:8787/api/sessions/pc-REAL/s-1',
    'http://relay.test:8787/api/sessions/pc-REAL/s-1',
  ], 'sessionId 里的斜杠必须编码，不能撑出额外路径段')
  assert.equal(writes[0].url.includes('deviceId='), false, 'hostId 不再走 query')
  assert.deepEqual(JSON.parse(writes[0].init.body), { deviceId: 'pc-a', pinned: true })
  assert.deepEqual(JSON.parse(writes[2].init.body), { deviceId: 'pc-a', title: '新标题' })
})

test('P3 getArchivedSessions 也用正式参数 hostId=', async () => {
  const { calls, fetchImpl } = recorder(() => fakeRes(listBody('pc-a')))
  const c = mk(fetchImpl)
  await c.getArchivedSessions()
  assert.equal(calls[0].url, 'http://relay.test:8787/api/sessions?hostId=pc-a&archived=true')
})

test('P4 显式 hostId 构造参数直接决定写操作路径段（无需先刷新列表）', async () => {
  const { calls, fetchImpl } = recorder(() => fakeRes(writeBody))
  const c = mk(fetchImpl, { hostId: 'pc-B' })
  await c.setPinned({ sessionId: 's-1', pinned: false })
  assert.equal(calls[0].url, 'http://relay.test:8787/api/sessions/pc-B/s-1')
  assert.equal(c.snapshot().hostId, 'pc-B')
})

test('P5 写失败仍抛带 code/detail 的 Error（沿用既有真机排障口径）', async () => {
  const { fetchImpl } = recorder(() => fakeRes({
    ok: false, error: { code: 'HOST_MISMATCH', message: '绑定已换主机' },
  }, 409))
  const c = mk(fetchImpl)
  await assert.rejects(
    () => c.setPinned({ sessionId: 's-1', pinned: true }),
    (e) => e.code === 'HOST_MISMATCH' && e.detail.includes('绑定已换主机'),
  )
})
