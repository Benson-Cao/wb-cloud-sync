/**
 * r19 · 主机切换器（S-6.9 BE-CP）端到端确定性单测（node --test，零依赖）
 * ---------------------------------------------------------------
 * 规格依据 docs/04 §6 切换协议（v2.3）：`POST /api/hosts/select` 用手机令牌反查
 * 当前绑定（**不信任 body 的 from**），实际切换必须显式 `confirmNoMigration:true`
 * ——「不带走会话/文件/插件」的服务端强制点。切换即重绑（令牌不变、绑定变），
 * 旧主机的后续请求回到 409 HOST_MISMATCH；反代会话票与旧主机事件订阅即刻清理。
 *
 * 覆盖：
 *   SW1 确认强制（缺省 / 假值不放行，绑定不被改动）
 *   SW2 令牌反查决定一切（坏令牌 401；body.from 不被信任；hostId 缺失 400）
 *   SW3 切换成功档案响应 + CP 绑定落盘 + 新主机立即可用
 *   SW4 目标主机手机数达上限 → 409 CLIENT_LIMIT
 *   SW5 目标不存在 / 已吊销 → 404 HOST_OFFLINE
 *   SW6 select 当前绑定主机 = no-op（无需 confirm）
 *   SW7 切换后旧 hostId → 409 HOST_MISMATCH；往返切换双向成立
 *   SW8 切换即刻清两张反代票表 + 断开旧主机事件订阅
 *   SW9 离线目标也可切（切过去看离线页，S-6.8）
 */
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { test } from 'node:test'
import { createRelay } from '../src/server.js'

let relay, port

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
  const text = await r.text()
  let json = {}
  try { json = JSON.parse(text) } catch { /* 非 JSON 交给断言 */ }
  return { status: r.status, json, text }
}

const select = (token, body) => call('/api/hosts/select', { method: 'POST', token, body })

const pairPhone = async (deviceId, phoneId) => {
  const g = await call('/pair/generate', { method: 'POST', body: { deviceId } })
  assert.equal(g.status, 200, 'pair/generate 发码')
  const c = await call('/pair', { method: 'POST', body: { code: g.json.data.code } })
  assert.equal(c.status, 200, 'pair 换挑战')
  const { challenge, pairSecret } = c.json.data
  const sig = createHmac('sha256', pairSecret).update(challenge).digest('hex')
  const v = await call('/pair/verify', { method: 'POST', body: { challenge, sig, phoneId } })
  assert.equal(v.status, 200, 'pair/verify 发令牌')
  return v.json.data.deviceToken
}

const registerHost = async (deviceId, extra = {}) => {
  const r = await call('/host/register', {
    method: 'POST',
    body: { deviceId, hostId: deviceId, deviceName: `档案-${deviceId}`, platform: 'win32', ...extra },
  })
  assert.equal(r.status, 200, `host/register ${deviceId}: ${r.text}`)
  return r
}

/** 可变时钟：SW9 要把目标主机推过 45s 离线窗口。 */
const boot = async (extra = {}) => {
  let t = 1_700_000_000_000
  relay = createRelay({ now: () => t, randomBytes: rand, tick: (ms) => { t += ms }, ...extra })
  port = await relay.start(0)
  return { advance: (ms) => { t += ms } }
}
const shutdown = async () => { await relay.stop() }

const openWs = (path) => new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`)
  ws.addEventListener('open', () => resolve(ws), { once: true })
  ws.addEventListener('error', () => reject(new Error('ws 连接失败')), { once: true })
})
const waitForClose = (ws, timeoutMs = 3000) => new Promise((resolve) => {
  const timer = setTimeout(() => resolve('timeout'), timeoutMs)
  ws.addEventListener('close', () => { clearTimeout(timer); resolve('closed') }, { once: true })
})

/* ---------------------------------------------------------------- 用例 */

test('SW1 切换必须显式 confirmNoMigration:true；缺省/假值不放行且绑定不动', async () => {
  const { advance } = await boot()
  try {
    advance(0)
    await registerHost('sw-a')
    await registerHost('sw-b')
    const t = await pairPhone('sw-a', 'phone-sw1')
    const r = await select(t, { hostId: 'sw-b' })
    assert.equal(r.status, 400, r.text)
    assert.equal(r.json.error.code, 'CONFIRM_REQUIRED')
    assert.equal(relay.cp.findPhoneByToken(t).boundHostId, 'sw-a', '确认缺失时绑定不能被改动')
    // 字符串 'true' 不是显式确认——规格要求布尔 true
    const r2 = await select(t, { hostId: 'sw-b', confirmNoMigration: 'true' })
    assert.equal(r2.status, 400)
    assert.equal(relay.cp.findPhoneByToken(t).boundHostId, 'sw-a')
  } finally { await shutdown() }
})

test('SW2 令牌反查决定一切：坏令牌 401；body.from 不被信任；hostId 缺失 400', async () => {
  const { advance } = await boot()
  try {
    advance(0)
    await registerHost('sw-a')
    await registerHost('sw-b')
    const t = await pairPhone('sw-a', 'phone-sw2')
    const noTok = await select('', { hostId: 'sw-b', confirmNoMigration: true })
    assert.equal(noTok.status, 401)
    const badTok = await select('deadbeefdeadbeef', { hostId: 'sw-b', confirmNoMigration: true })
    assert.equal(badTok.status, 401)
    // body 里伪造 from: 'sw-b' 改变不了判定——真实绑定是 sw-a，切到 sw-b 就是真切换
    const trick = await select(t, { hostId: 'sw-b', from: 'sw-b', confirmNoMigration: true })
    assert.equal(trick.status, 200)
    assert.equal(trick.json.data.switched, true, 'from 字段不参与判定')
    assert.equal(trick.json.data.from, 'sw-a', 'from 回的是令牌反查出的旧绑定')
    const noTarget = await select(t, { confirmNoMigration: true })
    assert.equal(noTarget.status, 400)
    assert.equal(noTarget.json.error.code, 'INVALID_ARGUMENT')
  } finally { await shutdown() }
})

test('SW3 切换成功：档案响应齐全，CP 绑定落盘，新主机立即可用', async () => {
  const { advance } = await boot()
  try {
    advance(0)
    await registerHost('sw-a')
    await registerHost('sw-b', { dshCommit: 'abc123def', engineState: 'running', caps: ['approval'] })
    relay.cp.putSession('sw-b', { sessionId: 's-b1', state: 'stopped', lastSeq: 1 })
    const t = await pairPhone('sw-a', 'phone-sw3')
    const r = await select(t, { hostId: 'sw-b', confirmNoMigration: true })
    assert.equal(r.status, 200, r.text)
    const d = r.json.data
    assert.equal(d.switched, true)
    assert.equal(d.from, 'sw-a')
    assert.equal(d.hostId, 'sw-b')
    assert.equal(d.kind, 'relay')
    assert.equal(d.dshCommit, 'abc123def', '客户端据此做 COMMIT_DRIFT 判断（索引不合并只提示）')
    assert.ok(String(d.endpoint).includes(`127.0.0.1:${port}`), 'endpoint 指回本 Relay')
    assert.equal(d.notice, '切换主机不会带走会话、文件与插件')
    assert.equal(d.sessionCount, 1)
    assert.equal(d.online, true, '目标主机刚注册（HTTP 注册即刷在线窗口）')
    assert.equal(d.engineState, 'running')
    assert.equal(relay.cp.findPhoneByToken(t).boundHostId, 'sw-b', 'CP 绑定已重绑')
    // 新主机上旧令牌直接可用（令牌不变、绑定变）
    const list = await call('/api/sessions?hostId=sw-b', { token: t })
    assert.equal(list.status, 200)
    assert.deepEqual(list.json.data.rows.map((x) => x.sessionId), ['s-b1'])
  } finally { await shutdown() }
})

test('SW4 目标主机手机数达上限 → 409 CLIENT_LIMIT，绑定不变', async () => {
  const { advance } = await boot({ maxPhonesPerHost: 2 })
  try {
    advance(0)
    await registerHost('sw-a')
    await registerHost('sw-b')
    const t = await pairPhone('sw-a', 'phone-sw4')
    await pairPhone('sw-b', 'phone-sw4b1')
    await pairPhone('sw-b', 'phone-sw4b2')
    const r = await select(t, { hostId: 'sw-b', confirmNoMigration: true })
    assert.equal(r.status, 409, r.text)
    assert.equal(r.json.error.code, 'CLIENT_LIMIT')
    assert.equal(relay.cp.findPhoneByToken(t).boundHostId, 'sw-a')
  } finally { await shutdown() }
})

test('SW5 目标不存在或已吊销 → 404 HOST_OFFLINE', async () => {
  const { advance } = await boot()
  try {
    advance(0)
    await registerHost('sw-a')
    await registerHost('sw-gone')
    const t = await pairPhone('sw-a', 'phone-sw5')
    const nope = await select(t, { hostId: 'sw-nope', confirmNoMigration: true })
    assert.equal(nope.status, 404)
    assert.equal(nope.json.error.code, 'HOST_OFFLINE')
    relay.cp.revokeDevice('sw-gone')
    const gone = await select(t, { hostId: 'sw-gone', confirmNoMigration: true })
    assert.equal(gone.status, 404)
    assert.equal(gone.json.error.code, 'HOST_OFFLINE')
    assert.equal(relay.cp.findPhoneByToken(t).boundHostId, 'sw-a', '失败切换不动绑定')
  } finally { await shutdown() }
})

test('SW6 select 当前绑定主机 = no-op：switched:false，无需 confirm', async () => {
  const { advance } = await boot()
  try {
    advance(0)
    await registerHost('sw-a')
    const t = await pairPhone('sw-a', 'phone-sw6')
    const r = await select(t, { hostId: 'sw-a' })   // 故意不带 confirmNoMigration
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.data.switched, false)
    assert.equal(r.json.data.hostId, 'sw-a')
    assert.equal(relay.cp.findPhoneByToken(t).boundHostId, 'sw-a')
  } finally { await shutdown() }
})

test('SW7 切换后旧 hostId → 409 HOST_MISMATCH；往返切换双向成立', async () => {
  const { advance } = await boot()
  try {
    advance(0)
    await registerHost('sw-a')
    await registerHost('sw-b')
    const t = await pairPhone('sw-a', 'phone-sw7')
    assert.equal((await call('/api/sessions?hostId=sw-a', { token: t })).status, 200)
    await select(t, { hostId: 'sw-b', confirmNoMigration: true })
    const stale = await call('/api/sessions?hostId=sw-a', { token: t })
    assert.equal(stale.status, 409, `旧 hostId 应 409 HOST_MISMATCH：${stale.text}`)
    assert.equal(stale.json.error.code, 'HOST_MISMATCH')
    assert.equal(stale.json.data, undefined, '被拒时不许带数据')
    // 往返：切回 sw-a 后 sw-b 变 409，sw-a 恢复 200
    const back = await select(t, { hostId: 'sw-a', confirmNoMigration: true })
    assert.equal(back.status, 200)
    assert.equal(back.json.data.switched, true)
    assert.equal(back.json.data.from, 'sw-b')
    const staleB = await call('/api/sessions?hostId=sw-b', { token: t })
    assert.equal(staleB.status, 409)
    const freshA = await call('/api/sessions?hostId=sw-a', { token: t })
    assert.equal(freshA.status, 200)
  } finally { await shutdown() }
})

test('SW8 切换即刻清两张反代票表 + 断开旧主机事件订阅', async () => {
  const { advance } = await boot()
  try {
    advance(0)
    await registerHost('sw-a')
    await registerHost('sw-b')
    const t = await pairPhone('sw-a', 'phone-sw8')
    // 手工种票（issueUiTicket 是闭包内函数；语义与 ?pt= 换出的票一致）
    relay.state.uiTickets.set('tk-old', { hostId: 'sw-a', clientId: 'phone-sw8', expiresAt: 1_700_000_999_999 })
    relay.state.uiTickets.set('tk-new', { hostId: 'sw-b', clientId: 'phone-sw8', expiresAt: 1_700_000_999_999 })
    const ws = await openWs(`/d/sw-a/events/s1?token=${t}&sinceSeq=-1`)
    assert.equal(ws.readyState, WebSocket.OPEN)
    const r = await select(t, { hostId: 'sw-b', confirmNoMigration: true })
    assert.equal(r.status, 200)
    assert.equal(relay.state.uiTickets.has('tk-old'), false, '旧主机票被清')
    assert.equal(relay.state.uiTickets.has('tk-new'), false, '新主机同手机的票也一并清（防旧票跨主机复用）')
    assert.equal(await waitForClose(ws), 'closed', '旧主机事件订阅被断开')
    // 新主机上的订阅可以重新建立（断的是旧主机的长连，不是把手机拉黑）
    const ws2 = await openWs(`/d/sw-b/events/s1?token=${t}&sinceSeq=-1`)
    assert.equal(ws2.readyState, WebSocket.OPEN)
    ws2.close()
  } finally { await shutdown() }
})

test('SW9 离线目标也可切（切过去看离线页，S-6.8）', async () => {
  const { advance } = await boot()
  try {
    advance(0)
    await registerHost('sw-a')
    await registerHost('sw-b')
    const t = await pairPhone('sw-a', 'phone-sw9')
    advance(60_000)                      // 推过 45s 离线窗口：sw-b 掉线（sw-a 也掉线，不影响 select）
    const r = await select(t, { hostId: 'sw-b', confirmNoMigration: true })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.data.switched, true)
    assert.equal(r.json.data.online, false, '离线目标照常切：响应里如实报 online:false')
    assert.equal(relay.cp.findPhoneByToken(t).boundHostId, 'sw-b')
  } finally { await shutdown() }
})
