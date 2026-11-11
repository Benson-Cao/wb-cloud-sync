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

const pair = async (deviceId = 'dev-1', extra = {}) => {
  const g = await call('/pair/generate', { method: 'POST', body: { deviceId } })
  assert.equal(g.status, 200)
  assert.match(g.json.data.code, /^\d{6}$/)
  const c = await call('/pair', { method: 'POST', body: { code: g.json.data.code } })
  assert.equal(c.status, 200)
  const { challenge, pairSecret } = c.json.data
  const sig = createHmac('sha256', pairSecret).update(challenge).digest('hex')
  // r9：手机自报 phoneId（稳定身份），不报就由服务端生成
  const v = await call('/pair/verify', { method: 'POST', body: { challenge, sig, ...extra } })
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
  // r9：令牌落在**手机自己的设备行**上，不再写进 Host 行
  const phones = relay.cp.listPhones('hmac-dev')
  assert.equal(phones.length, 1, '配对一次就多一台手机')
  assert.equal(phones[0].deviceId, v.json.data.deviceId, '回给手机的是它自己的 deviceId')
  assert.equal(v.json.data.hostDeviceId, 'hmac-dev', 'Host 的 deviceId 单独回，URL 里用它')
  assert.equal(phones[0].tokenDigest, createHash('sha256').update(v.json.data.deviceToken).digest('hex'))
  // 明文令牌不落盘：Relay 的传输状态与 CP 的设备行里都不该出现
  assert.ok(!JSON.stringify(relay.state).includes(v.json.data.deviceToken), '明文令牌不落盘（Relay 侧）')
  assert.ok(!JSON.stringify(relay.cp.listDevices()).includes(v.json.data.deviceToken), '明文令牌不落盘（CP 侧）')
})

test('T5 多台手机并存：互不作废；同一台手机重配只轮换自己那枚令牌', async () => {
  const A = 'phone-aaaa1111'
  const B = 'phone-bbbb2222'
  const a = await pair('multi-dev', { phoneId: A, clientName: 'Pixel' })
  assert.equal(a.verify.status, 200)
  const b = await pair('multi-dev', { phoneId: B })
  assert.equal(b.verify.status, 200)

  const read = (token) => call(`/api/sessions?deviceId=multi-dev`, { token })
  assert.equal((await read(a.token)).status, 200, '第二台手机配对不该顶掉第一台')
  assert.equal((await read(b.token)).status, 200)

  // 同一台手机重配：只有它自己那枚失效（TC-5.6 逐台成立）
  const a2 = await pair('multi-dev', { phoneId: A })
  assert.equal((await read(a.token)).status, 401, '旧令牌必须失效')
  assert.equal((await read(a2.token)).status, 200)
  assert.equal((await read(b.token)).status, 200, '另一台手机不受牵连')

  // 单独收回一台：电脑与另一台手机照旧
  const rc = await call('/admin/revoke-client', {
    method: 'POST', token: 'admin-secret', body: { deviceId: 'multi-dev', clientId: A },
  })
  assert.equal(rc.status, 200)
  assert.equal((await read(a2.token)).status, 401, '被收回的手机立刻失效')
  assert.equal((await read(b.token)).status, 200)
  assert.equal(relay.cp.getDevice('multi-dev').tombstone, false, '电脑不受影响')

  // 收回整台电脑：名下手机连坐
  const rd = await call('/admin/revoke', { method: 'POST', token: 'admin-secret', body: { deviceId: 'multi-dev' } })
  assert.equal(rd.status, 200)
  assert.equal((await read(b.token)).status, 401, 'Host 被吊销，手机令牌同时失效')
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
  // r9：Cursor 的 clientId 取**鉴权结果**（这台手机），不是 body 里自报的那个
  const p = await pair('cursor-dev', { phoneId: 'phone-0009' })
  await call('/host/register', { method: 'POST', body: { deviceId: 'cursor-dev' } })
  const inflight = call('/d/cursor-dev/session/follow', {
    method: 'POST', token: p.token, body: { sinceSeq: 42, clientId: 'i-am-someone-else', sessionId: 'session-1' },
  })
  await waitForQueue('cursor-dev')
  // CP 的 Cursor 主键是 (clientId, sessionId)，不是 deviceId
  assert.equal(relay.cp.getCursor({ clientId: 'phone-0009', sessionId: 'session-1' }).sinceSeq, 42)
  assert.equal(relay.cp.getCursor({ clientId: 'i-am-someone-else', sessionId: 'session-1' }), null,
    'body.clientId 不能用来改写别人的位点')
  const polled = await call('/host/poll?deviceId=cursor-dev')
  const frame = polled.json.data.frames[0]
  assert.equal(frame.body.sinceSeq, 42)
  await call('/host/respond', {
    method: 'POST', body: { reqId: frame.reqId, status: 200, body: { ok: true, data: {}, protocol: PROTOCOL } },
  })
  assert.equal((await inflight).status, 200)
})

test('T11 白名单：r3 加入 fileUploads/*，其它高危前缀仍未开放', async () => {
  const list = relay.allowedEndpoints
  assert.ok(list.includes('fileUploads/*'), 'r3 附件上行必须开放')
  assert.ok(list.includes('session/*'))
  for (const bad of ['attachments/*', 'config/*', 'permission/*', 'remote-desktop/*']) {
    assert.ok(!list.includes(bad), `${bad} 不得默认开放`)
  }
})

test('T10 PC 侧主动吊销：写操作需 adminToken，吊销后令牌失效且墓碑不复活', async () => {
  // 共享实例未配置 adminToken：页面可取，写操作必须拒绝
  const ui = await fetch(`http://127.0.0.1:${port}/admin/ui`)
  assert.equal(ui.status, 200)
  const html = await ui.text()
  assert.match(html, /设备管理/)
  assert.match(html, /\/admin\/revoke/)
  // 共享实例配置了 adminToken：缺 token 必须 401
  const noToken = await call('/admin/revoke', { method: 'POST', body: { deviceId: 'dev-1' } })
  assert.equal(noToken.status, 401)
  assert.equal(noToken.json.error.code, 'UNAUTHORIZED')

  // 未配置 adminToken 的实例：写操作明确 409 拒绝，不接受裸奔
  const bare = createRelay()
  const pBare = await bare.start(0)
  try {
    const r = await fetch(`http://127.0.0.1:${pBare}/admin/revoke`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'dev-1' }),
    })
    assert.equal(r.status, 409)
    assert.equal((await r.json()).error.code, 'ENDPOINT_NOT_ALLOWED')
  } finally { await bare.stop() }

  // 独立实例配置 adminToken，走完整吊销链路
  const admin = createRelay({ adminToken: 'adm-1', hostToken: 'host-secret' })
  const p2 = await admin.start(0)
  const base2 = `http://127.0.0.1:${p2}`
  const post2 = async (path, body, headers = {}) => {
    const r = await fetch(base2 + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
    return { status: r.status, json: await r.json() }
  }
  try {
    const g = await post2('/pair/generate', { deviceId: 'pc-revoke' })
    const c = await post2('/pair', { code: g.json.data.code })
    const sig = createHmac('sha256', c.json.data.pairSecret).update(c.json.data.challenge).digest('hex')
    const v = await post2('/pair/verify', { challenge: c.json.data.challenge, sig })
    const token = v.json.data.deviceToken

    const before = await fetch(`${base2}/api/sessions?deviceId=pc-revoke`, { headers: { Authorization: `Bearer ${token}` } })
    assert.equal(before.status, 200)
    assert.equal((await post2('/admin/revoke', { deviceId: 'pc-revoke' })).status, 401)
    const done = await post2('/admin/revoke', { deviceId: 'pc-revoke' }, { Authorization: 'Bearer adm-1' })
    assert.equal(done.status, 200, JSON.stringify(done.json))
    assert.equal(done.json.data.tombstone, true)

    const after = await fetch(`${base2}/api/sessions?deviceId=pc-revoke`, { headers: { Authorization: `Bearer ${token}` } })
    assert.equal(after.status, 401, '吊销后旧令牌立即失效')
    const reg = await post2('/host/register', { deviceId: 'pc-revoke', hostToken: 'host-secret' })
    assert.equal(reg.status, 401, '墓碑设备不复活')
    const list = await (await fetch(`${base2}/admin`, { headers: { Authorization: 'Bearer adm-1' } })).json()
    assert.equal(list.data.rows.find((r) => r.deviceId === 'pc-revoke').tombstone, true)
  } finally {
    await admin.stop()
  }
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
