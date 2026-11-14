/**
 * p1/client-core · 主机切换器协议半边测试（r22 / S-6.9 FE）
 * ---------------------------------------------------------------
 * 验收依据：v2.3 04 §6 主机切换协议、07 测试计划 TC-1.11 / TC-4.2 / TC-4.3 /
 * TC-4.6、12 号手册 S-6.9。服务端半边（r19/r20）已在 relay/test/host-switch.test.mjs
 * 锁死；这里锁客户端半边：确认强制、视图重建、索引不合并、执行位置常驻。
 *
 * 全部用可注入 fetch，零网络依赖；所有 I/O 形状与真实 CP REST 一致。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createHostSwitcher, SWITCH_ERR } from '../src/index.js'

const fakeRes = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
})

/** 造一个记录所有请求的 fetch 替身；responses 按调用顺序出队。 */
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

const okBody = (data) => ({ status: 200, body: { ok: true, data } })
const errBody = (status, code, message = code) => ({ status, body: { ok: false, error: { code, message } } })

const HOST_A = {
  hostId: 'host-a', kind: 'relay', name: 'A', platform: 'win32',
  dshCommit: 'commit-good', engineState: 'running', online: true, bound: true,
}
const HOST_B = {
  hostId: 'host-b', kind: 'relay', name: 'B', platform: 'linux',
  dshCommit: 'commit-good', engineState: 'running', online: false, bound: false,
}

const selectResponse = (overrides = {}) => okBody({
  switched: true, from: 'host-a', hostId: 'host-b', kind: 'relay',
  dshCommit: 'commit-good', endpoint: 'http://relay.test:8787',
  capabilities: [], notice: '切换主机不会带走会话、文件与插件',
  name: 'B', platform: 'linux', online: false, engineState: 'running',
  uiAvailable: false, sessionCount: 3,
  ...overrides,
})

test('HS1 listHosts：URL 与 Bearer 鉴权；bound 行决定当前执行位置', async () => {
  const { calls, fetchImpl } = recorder(okBody({ rows: [HOST_A, HOST_B] }))
  const sw = createHostSwitcher({
    baseUrl: 'http://relay.test:8787/', deviceToken: 'tok-secret', fetchImpl,
  })
  const r = await sw.listHosts()
  assert.equal(r.ok, true)
  assert.equal(calls[0].url, 'http://relay.test:8787/api/hosts')
  assert.equal(calls[0].init.method, 'GET')
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tok-secret')
  assert.equal(r.data.rows.length, 2)
  assert.equal(r.data.boundHostId, 'host-a')
  assert.equal(sw.snapshot().hostId, 'host-a', '执行位置以服务端 bound 行为准')
})

test('HS2 令牌只进 Authorization 头，绝不进 URL 或 body', async () => {
  const { calls, fetchImpl } = recorder(okBody({ rows: [HOST_A] }), selectResponse())
  const sw = createHostSwitcher({
    baseUrl: 'http://relay.test:8787', deviceToken: 'tok-secret', fetchImpl,
  })
  await sw.listHosts()
  await sw.selectHost({ hostId: 'host-b', confirmNoMigration: true })
  for (const c of calls) {
    assert.equal(String(c.url).includes('tok-secret'), false)
    assert.equal(String(c.init.body ?? '').includes('tok-secret'), false)
  }
})

test('HS3 TC-4.2 确认强制：未确认不发任何请求，字符串 true / 1 都不算', async () => {
  for (const bad of [undefined, false, 'true', 1, null]) {
    const { calls, fetchImpl } = recorder(selectResponse())
    const sw = createHostSwitcher({
      baseUrl: 'http://r.test', deviceToken: 't', fetchImpl,
      currentHostId: 'host-a',
    })
    const r = await sw.selectHost({ hostId: 'host-b', confirmNoMigration: bad })
    assert.equal(r.ok, false)
    assert.equal(r.error.code, SWITCH_ERR.CONFIRM_REQUIRED)
    assert.equal(calls.length, 0, '本地强制点：不发网络请求')
  }
})

test('HS4 缺 hostId → INVALID_ARGUMENT，同样不发请求', async () => {
  const { calls, fetchImpl } = recorder(selectResponse())
  const sw = createHostSwitcher({
    baseUrl: 'http://r.test', deviceToken: 't', fetchImpl,
    currentHostId: 'host-a',
  })
  const r = await sw.selectHost({ confirmNoMigration: true })
  assert.equal(r.error.code, SWITCH_ERR.INVALID_ARGUMENT)
  assert.equal(calls.length, 0)
})

test('HS5 切换成功：请求体带显式 confirm，onHostChanged 四动作齐发，viewEpoch 递增', async () => {
  const { calls, fetchImpl } = recorder(selectResponse())
  const changed = []
  const notices = []
  const sw = createHostSwitcher({
    baseUrl: 'http://r.test', deviceToken: 't', currentHostId: 'host-a',
    fetchImpl, onHostChanged: (e) => changed.push(e), onNotice: (n) => notices.push(n),
  })
  const r = await sw.selectHost({ hostId: 'host-b', confirmNoMigration: true })
  assert.equal(r.ok, true)
  const body = JSON.parse(calls[0].init.body)
  assert.deepEqual(body, { hostId: 'host-b', confirmNoMigration: true })
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(r.switched, true)
  assert.equal(r.indexMerged, true)
  assert.equal(changed.length, 1)
  assert.equal(changed[0].clearView, true, 'TC-4.3 清空旧会话视图')
  assert.equal(changed[0].resetCookieJar, true, 'S-6.9 独立 cookie jar，挡 R-22')
  assert.equal(changed[0].rebuildIndex, true, '按新 hostId 重建索引')
  assert.equal(changed[0].viewEpoch, 1)
  assert.equal(notices[0].type, 'host-changed')
  assert.equal(sw.snapshot().hostId, 'host-b', 'TC-4.6 执行位置常驻且与实际链路一致')
  assert.equal(sw.snapshot().online, false, '离线目标也如实报在线状态（S-6.8）')
})

test('HS6 TC-1.11 COMMIT_DRIFT：索引不合并、只提示升级，但切换本身不回滚', async () => {
  const { fetchImpl } = recorder(selectResponse({ dshCommit: 'commit-OTHER' }))
  const notices = []
  const changed = []
  const sw = createHostSwitcher({
    baseUrl: 'http://r.test', deviceToken: 't', currentHostId: 'host-a',
    pinnedDshCommit: 'commit-good', fetchImpl,
    onNotice: (n) => notices.push(n), onHostChanged: (e) => changed.push(e),
  })
  const r = await sw.selectHost({ hostId: 'host-b', confirmNoMigration: true })
  assert.equal(r.ok, true, '服务端已重绑，客户端不假装没切换')
  assert.equal(r.drift, true)
  assert.equal(r.indexMerged, false, '索引不合并')
  assert.equal(changed[0].rebuildIndex, false)
  assert.equal(sw.canMergeIndex('host-b'), false, 'drift 期间任何主机索引都不合并')
  assert.equal(sw.canMergeIndex('host-a'), false, '旧主机索引更不能并进来')
  assert.ok(notices.some((n) => n.type === 'upgrade-required'), '只提示升级')
  assert.equal(sw.snapshot().hostId, 'host-b', '执行位置仍更新为新主机')
})

test('HS7 未配置 pinned 基线时不启用比对（与 r16 服务端空串口径一致）', async () => {
  const { fetchImpl } = recorder(selectResponse({ dshCommit: 'commit-OTHER' }))
  const sw = createHostSwitcher({
    baseUrl: 'http://r.test', deviceToken: 't', currentHostId: 'host-a', fetchImpl,
  })
  const r = await sw.selectHost({ hostId: 'host-b', confirmNoMigration: true })
  assert.equal(r.drift, false)
  assert.equal(r.indexMerged, true)
  assert.equal(sw.canMergeIndex('host-b'), true)
  assert.equal(sw.canMergeIndex('host-a'), false, '旧主机索引仍不许合并（R-22）')
})

test('HS8 同主机 select = no-op：无需确认、不重建视图、viewEpoch 不动', async () => {
  const { calls, fetchImpl } = recorder(
    selectResponse({ switched: false, hostId: 'host-a', from: 'host-a' }),
  )
  const changed = []
  const sw = createHostSwitcher({
    baseUrl: 'http://r.test', deviceToken: 't', currentHostId: 'host-a', fetchImpl,
    onHostChanged: (e) => changed.push(e),
  })
  const r = await sw.selectHost({ hostId: 'host-a' })
  assert.equal(r.ok, true)
  assert.equal(r.switched, false)
  assert.equal(calls.length, 1, 'no-op 仍走服务端校验，但不需要 confirm')
  assert.equal(JSON.parse(calls[0].init.body).confirmNoMigration, undefined)
  assert.equal(changed[0].clearView, false)
  assert.equal(changed[0].resetCookieJar, false)
  assert.equal(sw.snapshot().viewEpoch, 0)
})

test('HS9 错误码映射：400 确认 / 404 离线 / 409 上限 / 409 mismatch / 401', async () => {
  const cases = [
    [errBody(400, 'CONFIRM_REQUIRED'), SWITCH_ERR.CONFIRM_REQUIRED],
    [errBody(400, 'INVALID_ARGUMENT'), SWITCH_ERR.INVALID_ARGUMENT],
    [errBody(404, 'HOST_OFFLINE'), SWITCH_ERR.HOST_OFFLINE],
    [errBody(409, 'CLIENT_LIMIT'), SWITCH_ERR.CLIENT_LIMIT],
    [errBody(409, 'HOST_MISMATCH'), SWITCH_ERR.HOST_MISMATCH],
    [errBody(401, 'UNAUTHORIZED'), SWITCH_ERR.UNAUTHORIZED],
  ]
  for (const [resp, expected] of cases) {
    const { fetchImpl } = recorder(resp)
    const sw = createHostSwitcher({
      baseUrl: 'http://r.test', deviceToken: 't', currentHostId: 'host-a', fetchImpl,
    })
    const r = await sw.selectHost({ hostId: 'host-b', confirmNoMigration: true })
    assert.equal(r.error.code, expected)
  }
  // mismatch 发 host-mismatch 通知（与 r20 PWA 兜底同世界观）
  const notices = []
  const { fetchImpl } = recorder(errBody(409, 'HOST_MISMATCH'))
  const sw = createHostSwitcher({
    baseUrl: 'http://r.test', deviceToken: 't', currentHostId: 'host-a', fetchImpl,
    onNotice: (n) => notices.push(n),
  })
  await sw.selectHost({ hostId: 'host-b', confirmNoMigration: true })
  assert.ok(notices.some((n) => n.type === 'host-mismatch'))
})

test('HS10 网络异常 → NETWORK（可重试），失败不触发视图重建', async () => {
  const changed = []
  const { fetchImpl } = recorder(new Error('ECONNREFUSED'))
  const sw = createHostSwitcher({
    baseUrl: 'http://r.test', deviceToken: 't', currentHostId: 'host-a', fetchImpl,
    onHostChanged: (e) => changed.push(e),
  })
  const r = await sw.selectHost({ hostId: 'host-b', confirmNoMigration: true })
  assert.equal(r.error.code, SWITCH_ERR.NETWORK)
  assert.equal(r.error.retryable, true)
  assert.equal(changed.length, 0)
  assert.equal(sw.snapshot().hostId, 'host-a', '失败不改变执行位置')
})

test('HS11 401 不傻重试：一次请求即停，不自动重发', async () => {
  const { calls, fetchImpl } = recorder(errBody(401, 'UNAUTHORIZED'))
  const sw = createHostSwitcher({
    baseUrl: 'http://r.test', deviceToken: 't', fetchImpl,
  })
  await sw.listHosts()
  assert.equal(calls.length, 1)
})

test('HS12 非 JSON 响应兜底 INTERNAL，不抛异常', async () => {
  const fetchImpl = async () => ({
    ok: true, status: 200, json: async () => { throw new Error('not json') },
  })
  const sw = createHostSwitcher({
    baseUrl: 'http://r.test', deviceToken: 't', fetchImpl,
  })
  const r = await sw.listHosts()
  assert.equal(r.ok, false)
  assert.equal(r.error.code, SWITCH_ERR.INTERNAL)
})
