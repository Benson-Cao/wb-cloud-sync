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
  // CP 的 Cursor 主键是 (clientId, hostId, sessionId)，不是 body 里自报的 clientId
  assert.equal(relay.cp.getCursor({ clientId: 'phone-0009', hostId: 'cursor-dev', sessionId: 'session-1' }).sinceSeq, 42)
  assert.equal(relay.cp.getCursor({ clientId: 'i-am-someone-else', hostId: 'cursor-dev', sessionId: 'session-1' }), null,
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

test('T12 配对的 relayUrl 回显「你刚才用的是哪个地址」，不写死 127.0.0.1', async () => {
  const p = await pair('lan-url-dev')
  assert.equal(p.verify.status, 200)
  // 手机上把 127.0.0.1 理解成「手机自己」→ ERR_CONNECTION_REFUSED。
  // 所以这里必须是**客户端刚刚访问成功的那个地址**（Host 头），而不是常量。
  assert.equal(p.verify.json.data.relayUrl, `http://127.0.0.1:${port}`)
})

test('T12b 配了 publicBaseUrl 时以配置为准（反代 / 公网域名场景）', async () => {
  const r2 = createRelay({ publicBaseUrl: 'https://sync.example.com', requestTimeoutMs: 300 })
  const p2 = await r2.start(0)
  try {
    const base2 = `http://127.0.0.1:${p2}`
    const g = await fetch(`${base2}/pair/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'base-url-dev' }),
    }).then((r) => r.json())
    const c = await fetch(`${base2}/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: g.data.code }),
    }).then((r) => r.json())
    const sig = createHmac('sha256', c.data.pairSecret).update(c.data.challenge).digest('hex')
    const v = await fetch(`${base2}/pair/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challenge: c.data.challenge, sig }),
    }).then((r) => r.json())
    assert.equal(v.data.relayUrl, 'https://sync.example.com', '显式配置优先于回显')
  } finally {
    await r2.stop()
  }
})

test('T13 PATCH 置顶：转发 session/pin，CP 按宿主回的全局集合刷新 pinnedOrder（r11）', async () => {
  const p = await pair('pin-dev')
  await call('/host/register', { method: 'POST', body: { deviceId: 'pin-dev' } })
  relay.cp.putSession('pin-dev', { sessionId: 'session-pin', state: 'stopped', lastSeq: 1 })

  const inflight = call('/api/sessions/session-pin?deviceId=pin-dev', {
    method: 'PATCH', token: p.token, body: { deviceId: 'pin-dev', pinned: true },
  })
  await waitForQueue('pin-dev')
  const polled = await call('/host/poll?deviceId=pin-dev')
  const frame = polled.json.data.frames[0]
  assert.equal(frame.endpoint, 'session/pin', '走白名单里的 session/* 通道')
  assert.equal(frame.body.sessionId, 'session-pin')
  assert.equal(frame.body.pinned, true)

  await call('/host/respond', {
    method: 'POST', body: {
      reqId: frame.reqId, status: 200,
      body: { ok: true, data: { pinned: true, pinnedSessionIds: ['session-pin'] }, protocol: PROTOCOL },
    },
  })
  const r = await inflight
  assert.equal(r.status, 200)
  assert.equal(relay.cp.getSession('pin-dev', 'session-pin').pinned, true)
  assert.equal(relay.cp.getSession('pin-dev', 'session-pin').pinnedOrder, 0, '照宿主的集合定序，不自己猜')

  // 缺 pinned 字段：400，不白跑一趟宿主
  const bad = await call('/api/sessions/session-pin?deviceId=pin-dev', {
    method: 'PATCH', token: p.token, body: { deviceId: 'pin-dev' },
  })
  assert.equal(bad.status, 400)
  assert.equal(bad.json.error.code, 'INVALID_JSON')
})

test('T14 归档（r12）：DELETE 是软移除别名，列表默认看不到、显式查得到、可恢复', async () => {
  const p = await pair('arc-dev')
  await call('/host/register', { method: 'POST', body: { deviceId: 'arc-dev' } })
  relay.cp.putSession('arc-dev', { sessionId: 'session-arc', state: 'stopped', lastSeq: 1 })

  const archiveOnce = async (method, body) => {
    const inflight = call('/api/sessions/session-arc?deviceId=arc-dev', { method, token: p.token, body })
    await waitForQueue('arc-dev')
    const polled = await call('/host/poll?deviceId=arc-dev')
    const frame = polled.json.data.frames[0]
    await call('/host/respond', {
      method: 'POST', body: {
        reqId: frame.reqId, status: 200,
        body: { ok: true, data: { archived: true, archivedSessionIds: ['session-arc'] }, protocol: PROTOCOL },
      },
    })
    return { r: await inflight, frame }
  }

  // PATCH { archived: true }
  const viaPatch = await archiveOnce('PATCH', { deviceId: 'arc-dev', archived: true })
  assert.equal(viaPatch.r.status, 200)
  assert.equal(viaPatch.frame.endpoint, 'session/archive')
  assert.equal(viaPatch.frame.body.archived, true)

  // 默认列表不该出现，archived=true 才看得到
  const normal = await call('/api/sessions?deviceId=arc-dev', { token: p.token })
  assert.equal(normal.json.data.rows.some((r) => r.sessionId === 'session-arc'), false)
  const hidden = await call('/api/sessions?deviceId=arc-dev&archived=true', { token: p.token })
  assert.equal(hidden.json.data.rows.some((r) => r.sessionId === 'session-arc'), true)
  assert.equal(relay.cp.getSession('arc-dev', 'session-arc').archived, true)

  // DELETE = 归档别名（强制 archived=true，body 里写什么都盖掉）
  const viaDelete = await archiveOnce('DELETE', { deviceId: 'arc-dev', archived: false })
  assert.equal(viaDelete.r.status, 200)
  assert.equal(viaDelete.frame.body.archived, true, 'DELETE 永远是归档，不能被 body 反转')

  // 两个字段同时给：一次只做一件事
  const both = await call('/api/sessions/session-arc?deviceId=arc-dev', {
    method: 'PATCH', token: p.token, body: { deviceId: 'arc-dev', pinned: true, archived: true },
  })
  assert.equal(both.status, 400)
  assert.equal(both.json.error.code, 'INVALID_JSON')
})

test('T15 产物下载票（ADR-011）：手机只见元数据，票据单次/绑手机/TTL', async () => {
  const p = await pair('art-dev')
  const p2 = await pair('art-dev')
  await call('/host/register', { method: 'POST', body: { deviceId: 'art-dev' } })
  const bytes = Buffer.from('hello 产物', 'utf8').toString('base64')

  const issue = async (token) => {
    const inflight = call('/api/artifacts/ticket', {
      method: 'POST', token,
      body: { deviceId: 'art-dev', sessionId: 's-1', path: 'out/a.md' },
    })
    await waitForQueue('art-dev')
    const polled = await call('/host/poll?deviceId=art-dev')
    const frame = polled.json.data.frames[0]
    assert.equal(frame.endpoint, 'session/artifact-ticket')
    await call('/host/respond', {
      method: 'POST', body: {
        reqId: frame.reqId, status: 200,
        body: { ok: true, data: { name: 'a.md', mime: 'text/markdown; charset=utf-8', size: bytes.length, bytes }, protocol: PROTOCOL },
      },
    })
    return inflight
  }

  const r = await issue(p.token)
  assert.equal(r.status, 200)
  assert.equal(r.json.data.bytes, undefined, '手机响应里不许带文件字节')
  assert.equal(r.json.data.name, 'a.md')
  assert.equal(r.json.data.expiresIn, 60)
  const url = `http://127.0.0.1:${port}/api/artifacts/download/${r.json.data.ticketId}`

  const d1 = await fetch(url, { headers: { Authorization: `Bearer ${p.token}` } })
  assert.equal(d1.status, 200)
  assert.equal(await d1.text(), 'hello 产物')
  assert.match(d1.headers.get('content-disposition') ?? '', /a\.md/)

  const again = await fetch(url, { headers: { Authorization: `Bearer ${p.token}` } })
  assert.equal(again.status, 410, '票据只能用一次')

  // 另一台手机的令牌不能换票
  const r2 = await issue(p.token)
  const denied = await fetch(`http://127.0.0.1:${port}/api/artifacts/download/${r2.json.data.ticketId}`, {
    headers: { Authorization: `Bearer ${p2.token}` },
  })
  assert.equal(denied.status, 401)

  // Host 明确拒绝时原样透传，不伪造票据
  const bad = call('/api/artifacts/ticket', {
    method: 'POST', token: p.token,
    body: { deviceId: 'art-dev', sessionId: 's-1', path: '../../etc/passwd' },
  })
  await waitForQueue('art-dev')
  const polled2 = await call('/host/poll?deviceId=art-dev')
  const f2 = polled2.json.data.frames[0]
  await call('/host/respond', {
    method: 'POST', body: {
      reqId: f2.reqId, status: 403,
      body: { ok: false, error: { code: 'ARTIFACT_NOT_PRESENTED', message: '不是交付产物' }, protocol: PROTOCOL },
    },
  })
  assert.equal((await bad).status, 403)
})

test('T16 W9 定时任务 + 改名：Relay 只转发，Host 响应回手机（写操作不代造）', async () => {
  const p = await pair('w9-dev')
  await call('/host/register', { method: 'POST', body: { deviceId: 'w9-dev' } })

  const round = async (method, path, body, responseData) => {
    const inflight = call(path, { method, token: p.token, body })
    await waitForQueue('w9-dev')
    const frame = (await call('/host/poll?deviceId=w9-dev')).json.data.frames[0]
    await call('/host/respond', {
      method: 'POST', body: {
        reqId: frame.reqId, status: 200,
        body: { ok: true, data: responseData, protocol: PROTOCOL },
      },
    })
    return { r: await inflight, frame }
  }

  const list = await round('GET', '/api/schedules?deviceId=w9-dev', undefined,
    { rows: [{ id: 't1', title: '提醒' }], count: 1 })
  assert.equal(list.r.status, 200)
  assert.equal(list.frame.endpoint, 'session/schedule-list')
  assert.equal(list.r.json.data.rows[0].title, '提醒')

  const made = await round('POST', '/api/schedules',
    { deviceId: 'w9-dev', title: '买菜', prompt: '列清单', afterSeconds: 600 },
    { task: { id: 't2', title: '买菜' } })
  assert.equal(made.frame.endpoint, 'session/schedule-create')
  assert.equal(made.frame.body.target ?? null, null, 'Relay 不替手机决定投递目标')
  assert.equal(made.r.json.data.task.id, 't2')

  const run = await round('POST', '/api/schedules/t2/run', { deviceId: 'w9-dev' }, { id: 't2' })
  assert.equal(run.frame.endpoint, 'session/schedule-run')
  assert.equal(run.frame.body.id, 't2')

  // 改名：PATCH {title} 走第三条支路，CP 标题按宿主回传更新
  relay.cp.putSession('w9-dev', { sessionId: 's-ren', state: 'stopped', lastSeq: 1, title: '旧名' })
  const ren = await round('PATCH', '/api/sessions/s-ren?deviceId=w9-dev',
    { deviceId: 'w9-dev', title: '新名' }, { title: '新名', seq: 9 })
  assert.equal(ren.frame.endpoint, 'session/rename')
  assert.equal(relay.cp.getSession('w9-dev', 's-ren').title, '新名')

  // 一次只做一件事
  const both = await call('/api/sessions/s-ren?deviceId=w9-dev', {
    method: 'PATCH', token: p.token, body: { deviceId: 'w9-dev', title: 'x', pinned: true },
  })
  assert.equal(both.status, 400)
})

test('T17 转 PDF 也走同一张票：format 透传 Host，convertedFrom 回手机，非法 format 直接 400', async () => {
  const p = await pair('pdf-dev')
  await call('/host/register', { method: 'POST', body: { deviceId: 'pdf-dev' } })
  const bytes = Buffer.from('%PDF-1.7 转出来的', 'utf8').toString('base64')

  const inflight = call('/api/artifacts/ticket', {
    method: 'POST', token: p.token,
    body: { deviceId: 'pdf-dev', sessionId: 's-1', path: 'out/a.docx', format: 'pdf' },
  })
  await waitForQueue('pdf-dev')
  const frame = (await call('/host/poll?deviceId=pdf-dev')).json.data.frames[0]
  assert.equal(frame.endpoint, 'session/artifact-ticket')
  assert.equal(frame.body.format, 'pdf', 'format 必须到 Host，否则会静默变原样下载')
  await call('/host/respond', {
    method: 'POST', body: {
      reqId: frame.reqId, status: 200,
      body: {
        ok: true,
        data: {
          name: 'a.pdf', mime: 'application/pdf', size: bytes.length,
          bytes, convertedFrom: 'a.docx',
        },
        protocol: PROTOCOL,
      },
    },
  })

  const r = await inflight
  assert.equal(r.status, 200)
  assert.equal(r.json.data.name, 'a.pdf')
  assert.equal(r.json.data.convertedFrom, 'a.docx', '得让手机说得出「这是转的」')
  assert.equal(r.json.data.bytes, undefined)

  const d = await fetch(`http://127.0.0.1:${port}/api/artifacts/download/${r.json.data.ticketId}`, {
    headers: { Authorization: `Bearer ${p.token}` },
  })
  assert.equal(d.status, 200)
  assert.equal(d.headers.get('content-type')?.startsWith('application/pdf'), true)

  // 不支持的目标格式不许被「将就」成原样下载
  const bad = await call('/api/artifacts/ticket', {
    method: 'POST', token: p.token,
    body: { deviceId: 'pdf-dev', sessionId: 's-1', path: 'out/a.docx', format: 'docx' },
  })
  assert.equal(bad.status, 400)
  assert.equal(bad.json.error.code, 'INVALID_ARGUMENT')
})

test('T18 跨域：只回显本机源（WebView 场景），不对任意站点开放', async () => {
  const pre = await fetch(`http://127.0.0.1:${port}/api/sessions?deviceId=x`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'http://127.0.0.1:3080',
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'authorization',
    },
  })
  assert.equal(pre.status, 204)
  assert.equal(pre.headers.get('access-control-allow-origin'), 'http://127.0.0.1:3080')
  assert.match(pre.headers.get('access-control-allow-headers') ?? '', /authorization/i)
  assert.equal(pre.headers.get('vary'), 'Origin')

  // 真实请求也要带 ACAO，否则浏览器读不到响应体
  const real = await fetch(`http://127.0.0.1:${port}/health`, {
    headers: { Origin: 'http://localhost:5173' },
  })
  assert.equal(real.status, 200)
  assert.equal(real.headers.get('access-control-allow-origin'), 'http://localhost:5173')

  // 陌生站点：不发放 ACAO（浏览器侧会被拦）
  const evil = await fetch(`http://127.0.0.1:${port}/health`, {
    headers: { Origin: 'https://evil.example' },
  })
  assert.equal(evil.status, 200)
  assert.equal(evil.headers.get('access-control-allow-origin'), null, '不能对任意站点放开')

  const evilPre = await fetch(`http://127.0.0.1:${port}/api/artifacts/ticket`, {
    method: 'OPTIONS', headers: { Origin: 'https://evil.example' },
  })
  assert.equal(evilPre.status, 204)
  assert.equal(evilPre.headers.get('access-control-allow-origin'), null)
})

test('H-1 /api/hosts：手机令牌只看到绑定主机；adminToken 看到全部；坏令牌 401', async () => {
  const reg = await call('/host/register', {
    method: 'POST',
    body: {
      deviceId: 'hosts-dev', hostId: 'hosts-host',
      deviceName: '档案A', platform: 'win32',
      dshCommit: 'abc123def456', engineState: 'running',
    },
  })
  assert.equal(reg.status, 200)

  const phone = await pair('hosts-dev', { phoneId: 'phone-hosts1' })
  const r1 = await call('/api/hosts', { token: phone.token })
  assert.equal(r1.status, 200)
  assert.equal(r1.json.data.rows.length, 1, '手机只看到自己绑定的主机')
  const row = r1.json.data.rows[0]
  assert.equal(row.hostId, 'hosts-host')
  assert.equal(row.deviceId, 'hosts-dev', '旧客户端兼容字段与 hostId 同值并存')
  assert.equal(row.kind, 'relay')
  assert.equal(row.name, '档案A')
  assert.equal(row.platform, 'win32')
  assert.equal(row.dshCommit, 'abc123def456')
  assert.equal(row.engineState, 'running')
  assert.equal(row.online, true)
  assert.ok(Array.isArray(row.phones))

  const admin = await call('/api/hosts', { token: 'admin-secret' })
  assert.equal(admin.status, 200)
  assert.ok(admin.json.data.rows.some((h) => h.hostId === 'hosts-host'), 'admin 看到注册过的主机')

  const bad = await call('/api/hosts', { token: 'wrong-token' })
  assert.equal(bad.status, 401)
})

test('H-2 hostId= 查询参数：与 deviceId= 同值兼容；响应补 hostId 字段', async () => {
  const p = await pair('hosts-dev', { phoneId: 'phone-hosts2' })
  relay.cp.putSession('hosts-dev', { sessionId: 'session-h1', state: 'stopped', lastSeq: 1 })

  const a = await call('/api/sessions?hostId=hosts-dev', { token: p.token })
  assert.equal(a.status, 200)
  assert.deepEqual(a.json.data.rows.map((r) => r.sessionId), ['session-h1'])
  assert.equal(a.json.data.hostId, 'hosts-host', '响应顶层带 hostId（注册声明值；只增不删）')
  assert.equal(a.json.data.host.hostId, 'hosts-host')

  const b = await call('/api/sessions?deviceId=hosts-dev', { token: p.token })
  assert.equal(b.status, 200, '旧参数 deviceId= 继续接受')
  assert.equal(b.json.data.rows.length, 1)

  // 越权：用 A 主机的令牌读 B 主机 → 409 HOST_MISMATCH（hostId 参数不改变鉴权边界；r19 切换语义）
  const c = await call('/api/sessions?hostId=pin-dev', { token: p.token })
  assert.equal(c.status, 409)
  assert.equal(c.json.error.code, 'HOST_MISMATCH')
})
