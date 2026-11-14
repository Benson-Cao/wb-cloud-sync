/**
 * p1/client-core · CP REST 会话写操作测试（r22 / 命名迁移第四步客户端落地）
 * ---------------------------------------------------------------
 * 两段：`W*` 用可注入 fetch 锁 URL 形态与本地约束；`E*` 用真实 createRelay
 * 走 HTTP 降级通道（/host/poll + /host/respond）证明 r21 服务端真的接受两段路径，
 * 且切换后携带旧 hostId 会被 r19 判 409 HOST_MISMATCH。
 */
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { after, before, test } from 'node:test'

import { createRelay } from '../../relay/src/server.js'
import { createSessionWrites } from '../src/index.js'
import { ERR } from '../src/carrier.js'

const fakeRes = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body })

const recorder = (...responses) => {
  const calls = []
  let i = 0
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    const next = responses[Math.min(i++, responses.length - 1)]
    if (next instanceof Error) throw next
    return fakeRes(next.status, next.body)
  }
  return { calls, fetchImpl }
}

const okBody = (data = {}) => ({ status: 200, body: { ok: true, data } })

const mk = (fetchImpl, extra = {}) => createSessionWrites({
  baseUrl: 'http://relay.test:8787/', hostId: 'host-a', deviceToken: 'tok-secret', fetchImpl, ...extra,
})

test('W1 PATCH 走规格形态 /api/sessions/:hostId/:id，hostId 只在路径段', async () => {
  const { calls, fetchImpl } = recorder(okBody({ pinned: true }))
  const w = mk(fetchImpl)
  const r = await w.patchSession('session/with/slash', { pinned: true })
  assert.equal(r.ok, true)
  assert.equal(calls[0].url, 'http://relay.test:8787/api/sessions/host-a/session%2Fwith%2Fslash')
  assert.equal(calls[0].init.method, 'PATCH')
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tok-secret')
  assert.deepEqual(JSON.parse(calls[0].init.body), { pinned: true }, 'body 不再塞 host 字段')
})

test('W2 DELETE 是归档别名，强制不带 body 的形态也能过', async () => {
  const { calls, fetchImpl } = recorder(okBody({ archived: true }))
  const w = mk(fetchImpl)
  await w.archiveSession('s-1')
  assert.equal(calls[0].init.method, 'DELETE')
  assert.equal(calls[0].url, 'http://relay.test:8787/api/sessions/host-a/s-1')
  assert.equal(calls[0].init.body, undefined)
})

test('W3 一次只做一件事：0 个 / 多个 intent 本地拒绝，不发请求', async () => {
  const { calls, fetchImpl } = recorder(okBody())
  const w = mk(fetchImpl)
  assert.equal((await w.patchSession('s-1', {})).error.code, 'INVALID_ARGUMENT')
  assert.equal((await w.patchSession('s-1', { pinned: true, archived: false })).error.code, 'INVALID_JSON')
  assert.equal((await w.patchSession('s-1', { title: '  ' })).error.code, 'INVALID_ARGUMENT')
  assert.equal(calls.length, 0)
  const ok = await w.patchSession('s-1', { archived: false })
  assert.equal(ok.ok, true, 'archived:false（恢复）是合法 intent')
  assert.deepEqual(JSON.parse(calls[0].init.body), { archived: false })
})

test('W4 setHostId 后路径随执行位置更新（与切换器 onHostChanged 对接）', async () => {
  const { calls, fetchImpl } = recorder(okBody(), okBody())
  const w = mk(fetchImpl)
  await w.patchSession('s-1', { pinned: true })
  assert.equal(w.setHostId('host-b'), 'host-b')
  assert.equal(w.getHostId(), 'host-b')
  await w.patchSession('s-1', { title: '新名字' })
  assert.equal(calls[0].url.includes('/api/sessions/host-a/'), true)
  assert.equal(calls[1].url.includes('/api/sessions/host-b/'), true)
  assert.equal(w.pathOf('s-1'), '/api/sessions/host-b/s-1')
})

test('W5 列表查询用正式参数 hostId=（r17），令牌不进 URL', async () => {
  const { calls, fetchImpl } = recorder(okBody({ rows: [] }))
  const w = mk(fetchImpl)
  await w.listSessions({ pinned: true })
  const u = new URL(calls[0].url)
  assert.equal(u.pathname, '/api/sessions')
  assert.equal(u.searchParams.get('hostId'), 'host-a')
  assert.equal(u.searchParams.get('deviceId'), null)
  assert.equal(u.searchParams.get('pinned'), 'true')
  assert.equal(calls[0].url.includes('tok-secret'), false)
})

test('W6 错误码复用 carrier 解包：401 / 405 / 409 HOST_MISMATCH / 网络异常', async () => {
  const cases = [
    [{ status: 401, body: { ok: false, error: { code: 'UNAUTHORIZED' } } }, ERR.UNAUTHORIZED],
    [{ status: 405, body: { ok: false } }, ERR.METHOD_NOT_ALLOWED],
    [{ status: 409, body: { ok: false, error: { code: 'HOST_MISMATCH' } } }, ERR.HOST_MISMATCH],
  ]
  for (const [resp, expected] of cases) {
    const { fetchImpl } = recorder(resp)
    assert.equal((await mk(fetchImpl).patchSession('s', { pinned: true })).error.code, expected)
  }
  const { fetchImpl } = recorder(new Error('ECONNREFUSED'))
  const net = await mk(fetchImpl).patchSession('s', { pinned: true })
  assert.equal(net.error.code, ERR.NETWORK)
  assert.equal(net.error.retryable, true)
})

/* ---------------------------------------------- 真 Relay 端到端 */

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
  const c = await call('/pair', { method: 'POST', body: { code: g.json.data.code } })
  const { challenge, pairSecret } = c.json.data
  const sig = createHmac('sha256', pairSecret).update(challenge).digest('hex')
  const v = await call('/pair/verify', { method: 'POST', body: { challenge, sig, phoneId } })
  assert.equal(v.status, 200)
  return v.json.data.deviceToken
}

const waitForQueue = async (deviceId) => {
  for (let i = 0; i < 50; i++) {
    if ((relay.state.queue.get(deviceId) ?? []).length >= 1) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('队列未收到帧')
}

/** 起一个 inflight 写请求 → 取降级队列帧 → Host 应答 → 拿回结果。 */
const round = async (w, invoke, deviceId, answer = {}) => {
  const inflight = invoke()
  await waitForQueue(deviceId)
  const frame = (await call(`/host/poll?deviceId=${deviceId}`)).json.data.frames[0]
  await call('/host/respond', {
    method: 'POST',
    body: {
      reqId: frame.reqId, status: 200,
      body: {
        ok: true,
        data: {
          pinned: answer.pinned ?? null,
          archived: answer.archived ?? true,
          archivedSessionIds: answer.archivedSessionIds ?? [],
          pinnedSessionIds: answer.pinnedSessionIds ?? [],
        },
      },
    },
  })
  return { r: await inflight, frame }
}

before(async () => {
  relay = createRelay({})
  port = await relay.start(0)
  base = `http://127.0.0.1:${port}`
})
after(async () => { await relay?.stop() })

test('E1 真 Relay 接受两段 PATCH：CP 置顶落库、帧的 sessionId 解析正确', async () => {
  const token = await pairPhone('wr-host', 'wr-phone-1')
  await call('/host/register', { method: 'POST', body: { deviceId: 'wr-host', hostId: 'wr-host' } })
  relay.cp.putSession('wr-host', { sessionId: 's-1', state: 'stopped', lastSeq: 1 })
  const w = createSessionWrites({ baseUrl: base, hostId: 'wr-host', deviceToken: token })
  const { r, frame } = await round(
    w, () => w.patchSession('s-1', { pinned: true }), 'wr-host',
    { pinned: true, pinnedSessionIds: ['s-1'] },
  )
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(frame.endpoint, 'session/pin')
  assert.equal(frame.body.sessionId, 's-1', '第一段是 hostId，第二段才是 sessionId')
  assert.equal(relay.cp.getSession('wr-host', 's-1').pinned, true)
})

test('E2 DELETE 新形态 = 归档（软移除），CP archived 置位', async () => {
  const token = await pairPhone('wr-host', 'wr-phone-2')
  const w = createSessionWrites({ baseUrl: base, hostId: 'wr-host', deviceToken: token })
  const { r, frame } = await round(
    w, () => w.archiveSession('s-1'), 'wr-host',
    { archived: true, archivedSessionIds: ['s-1'] },
  )
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(frame.endpoint, 'session/archive')
  assert.equal(frame.body.archived, true)
  assert.equal(relay.cp.getSession('wr-host', 's-1').archived, true)
})

test('E3 切换后未同步 hostId → 旧主机路径被判 409 HOST_MISMATCH', async () => {
  await call('/host/register', { method: 'POST', body: { deviceId: 'wr-host-b', hostId: 'wr-host-b' } })
  const token = await pairPhone('wr-host', 'wr-phone-3')
  const sel = await call('/api/hosts/select', {
    method: 'POST', token, body: { hostId: 'wr-host-b', confirmNoMigration: true },
  })
  assert.equal(sel.status, 200, sel.text)
  const w = createSessionWrites({ baseUrl: base, hostId: 'wr-host', deviceToken: token })
  const r = await w.patchSession('s-1', { pinned: false })
  assert.equal(r.error.code, ERR.HOST_MISMATCH)
})

test('E4 同步新 hostId 后路径可用（旧形态兼容期仍然保留）', async () => {
  const token = await pairPhone('wr-host-b', 'wr-phone-4')
  relay.cp.putSession('wr-host-b', { sessionId: 's-2', state: 'stopped', lastSeq: 1 })
  const w = createSessionWrites({ baseUrl: base, hostId: 'wr-host-b', deviceToken: token })
  const { r } = await round(
    w, () => w.patchSession('s-2', { pinned: true }), 'wr-host-b',
    { pinned: true, pinnedSessionIds: ['s-2'] },
  )
  assert.equal(r.ok, true, JSON.stringify(r))
  // 旧参数名 deviceId= 也仍被接受（r17 兼容期）——客户端只用正式的 hostId=，
  // 但不破旧端；用 GET 判据，避免再起一次需要 Host 应答的 bridge 往返。
  const legacy = await call('/api/sessions?deviceId=wr-host-b', { token })
  assert.equal(legacy.status, 200, '旧参数名兼容期未破')
  assert.equal(legacy.json.data.hostId, 'wr-host-b')
})
