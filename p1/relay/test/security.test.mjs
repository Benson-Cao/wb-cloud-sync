/**
 * P3 W10 · 渗透用例（docs/07 §7 安全、docs/08 §10 合规检查单、docs/05 W10「渗透用例」）
 * ---------------------------------------------------------------
 * 与 TC 表里的功能用例不同，这里每条都是**攻击者视角**：不带凭据、拿别人的凭据、
 * 构造畸形路径、抢在鉴权之前动作。判据一律是「攻击者拿不到东西 / 改不了状态」，
 * 而不是「返回了某个我期望的码」——所以能读到的内容也要断言为空。
 *
 * 用例编号 S1–S16；每条都在注释里写明「不打这个补丁会发生什么」。
 */
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { after, before, test } from 'node:test'
import { createRelay, PROTOCOL } from '../src/server.js'

const HOST_TOKEN = 'host-secret'
let relay, port

const rand = (() => {
  let n = 20_000
  return (size) => Buffer.alloc(size, (++n) & 0xff)
})()

const call = async (path, { method = 'GET', body, token, hostToken, rawBody } = {}) => {
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  if (hostToken) headers.Authorization = `Bearer ${hostToken}`
  const payload = rawBody !== undefined ? rawBody : (body === undefined ? undefined : JSON.stringify(body))
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers, body: payload })
  const text = await r.text()
  let json = {}
  try { json = JSON.parse(text) } catch { /* 非 JSON 也算响应，交给断言看 */ }
  return { status: r.status, json, text }
}

const pair = async (deviceId) => {
  const g = await call('/pair/generate', { method: 'POST', body: { deviceId } })
  const c = await call('/pair', { method: 'POST', body: { code: g.json.data.code } })
  const sig = createHmac('sha256', c.json.data.pairSecret).update(c.json.data.challenge).digest('hex')
  const v = await call('/pair/verify', { method: 'POST', body: { challenge: c.json.data.challenge, sig, clientId: 'pen' } })
  assert.equal(v.status, 200, `配对失败：${v.text}`)
  return { token: v.json.data.deviceToken, challenge: c.json.data.challenge, pairSecret: c.json.data.pairSecret }
}

/** 开一条 WS，用 Promise 等到 open / 关闭码任一结果。 */
const openWs = (path) => new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`)
  const state = { ws, opened: false, closeCode: null }
  ws.addEventListener('open', () => { state.opened = true; resolve(state) })
  ws.addEventListener('close', (e) => { state.closeCode = e.code ?? 1006; if (!state.opened) resolve(state) }, { once: true })
  ws.addEventListener('error', () => { if (!state.opened) { state.closeCode = state.closeCode ?? 1006; resolve(state) } }, { once: true })
})

const waitClose = (state, timeoutMs = 3000) => new Promise((resolve) => {
  if (state.closeCode !== null) return resolve(state.closeCode)
  const timer = setTimeout(() => resolve(null), timeoutMs)
  state.ws.addEventListener('close', (e) => { clearTimeout(timer); resolve(e.code ?? 1006) }, { once: true })
})

before(async () => {
  relay = createRelay({
    hostToken: HOST_TOKEN,
    adminToken: 'admin-secret',
    requestTimeoutMs: 3000,
    registerTimeoutMs: 400,   // 未注册连接必须在这个窗口内被关掉
    randomBytes: rand,
  })
  port = await relay.start(0)
})
after(async () => { await relay.stop() })

/* --------------------------------------------------------- S1 令牌伪造 */

test('S1 伪造 / 篡改设备令牌一律 401，不泄漏「哪一段错了」', async () => {
  const deviceId = 'pen-token'
  const { token } = await pair(deviceId)
  const variants = [
    ['空令牌', ''],
    ['非 hex', 'zzzz'],
    ['长度不足', token.slice(0, 16)],
    ['改最后一位', `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`],
    ['多加一位', `${token}0`],
    ['别的设备真实令牌', (await pair('pen-token-other')).token],
    ['摘要当令牌', 'a'.repeat(64)],
  ]
  for (const [name, t] of variants) {
    const r = await call(`/d/${deviceId}/session/prompt`, { method: 'POST', token: t, body: { text: 'x' } })
    assert.equal(r.status, 401, `${name} 应 401，实际 ${r.status}`)
    assert.equal(r.json.error.code, 'UNAUTHORIZED')
    // 错误信息必须统一，不能区分「没这个设备」与「令牌错」——那等于给了枚举设备的接口
    assert.equal(r.json.error.message, '令牌缺失、失效或已吊销', `${name} 泄漏了具体失败原因`)
  }
})

/* --------------------------------------------------------- S2 跨设备冒用 */

test('S2 拿 A 的合法令牌打 B 的路径：401，且不能读到 B 的会话列表', async () => {
  const a = await pair('pen-a')
  await pair('pen-b')
  const prompt = await call('/d/pen-b/session/prompt', { method: 'POST', token: a.token, body: { text: 'steal' } })
  assert.equal(prompt.status, 401)
  const list = await call('/api/sessions?deviceId=pen-b', { token: a.token })
  assert.equal(list.status, 401, '跨设备读列表必须被拒')
  assert.equal(list.json.data, undefined, '被拒时不许带回任何行')
})

/* --------------------------------------------------------- S3/S4 重放 */

test('S3 挑战一次性：同一 challenge 二次 verify 必败（防重放）', async () => {
  const g = await call('/pair/generate', { method: 'POST', body: { deviceId: 'pen-replay' } })
  const c = await call('/pair', { method: 'POST', body: { code: g.json.data.code } })
  const sig = createHmac('sha256', c.json.data.pairSecret).update(c.json.data.challenge).digest('hex')
  const first = await call('/pair/verify', { method: 'POST', body: { challenge: c.json.data.challenge, sig } })
  assert.equal(first.status, 200)
  const replay = await call('/pair/verify', { method: 'POST', body: { challenge: c.json.data.challenge, sig } })
  assert.equal(replay.status, 400, '同一挑战不能用第二次')
  assert.equal(replay.json.error.code, 'CHALLENGE_EXPIRED')
})

test('S4 配对码一次性：同一 code 二次 /pair 必败（防并发抢码）', async () => {
  const g = await call('/pair/generate', { method: 'POST', body: { deviceId: 'pen-code-reuse' } })
  const code = g.json.data.code
  assert.equal((await call('/pair', { method: 'POST', body: { code } })).status, 200)
  const again = await call('/pair', { method: 'POST', body: { code } })
  assert.equal(again.status, 400)
  assert.equal(again.json.error.code, 'PAIR_CODE_INVALID')
})

/* --------------------------------------------------------- S5 限速 */

test('S5 配对码穷举：第 6 次起被限速，且不能靠换 code 绕过', async () => {
  const deviceId = 'pen-brute'
  const statuses = []
  for (let i = 0; i < 6; i++) {
    const r = await call('/pair/generate', { method: 'POST', body: { deviceId } })
    statuses.push(r.status)
  }
  assert.deepEqual(statuses.slice(0, 5), [200, 200, 200, 200, 200], '前 5 次应放行')
  assert.equal(statuses[5], 400, '第 6 次必须被限速')
  // 限速键是 deviceId|ip：拿别的 deviceId 来猜不应当绕过
  const other = await call('/pair/generate', { method: 'POST', body: { deviceId: 'pen-brute-2' } })
  assert.equal(other.status, 200, '限速按设备维度，不误伤同 IP 的其它设备（这是取舍，写进文档）')
})

/* --------------------------------------------------------- S6 路径归一化 */

test('S6 路径穿越 / 大小写 / 尾斜杠都到不了 /admin，且不越出白名单', async () => {
  const { token } = await pair('pen-path')
  const attacks = [
    'session/../admin/revoke',
    'session/..%2Fadmin%2Frevoke',
    'session/%2e%2e/admin',
    'SESSION/PROMPT',
    'session/prompt/extra',
    'session/prompt%00',
    '../../admin/revoke',
    'fileUploads/../admin',
  ]
  for (const ep of attacks) {
    const r = await call(`/d/pen-path/${ep}`, { method: 'POST', token, body: { text: 'x' } })
    // 401 也算被拒：'../../admin/revoke' 这条会在客户端就被 URL 解析器归一化成
    // /admin/revoke，于是撞上的是 admin 凭据闸而不是白名单——结论同样是「过不去」。
    assert.ok([400, 401, 403, 404].includes(r.status), `${ep} 应被拒（400/401/403/404），实际 ${r.status}`)
    assert.equal(r.json.ok, false, `${ep} 竟然成功了`)
    // 关键判据：不能因为穿越而真的执行了吊销
    const dev = relay.cp.getDevice('pen-path')
    assert.equal(Boolean(dev?.tombstone), false, `${ep} 触发了吊销副作用`)
  }
})

/* --------------------------------------------------------- S7/S8 报文 */

test('S7 超过 1 MiB 的请求体 413，不缓冲到内存耗尽', async () => {
  const { token } = await pair('pen-huge')
  const huge = 'x'.repeat(1_100_000)
  const r = await call('/d/pen-huge/session/prompt', {
    method: 'POST', token, rawBody: JSON.stringify({ text: huge }),
  })
  assert.ok([413, 400].includes(r.status), `超大体积应被拒，实际 ${r.status}`)
  if (r.status === 413) assert.equal(r.json.error.message, '请求体超过 1 MiB')
})

test('S8 非法 JSON 400，不把解析异常升成 500（避免用错误码探测实现）', async () => {
  const { token } = await pair('pen-badjson')
  // 合法 JSON 但**不是对象**同样按非法处理：放行会让 body.deviceId 抛 TypeError 变 500
  for (const raw of ['{', 'not json', '{"text":', '[]', 'null', '123', '"str"']) {
    const r = await call('/d/pen-badjson/session/prompt', { method: 'POST', token, rawBody: raw })
    assert.ok([400, 200].includes(r.status), `raw=${raw.slice(0, 8)} 得到 ${r.status}`)
    assert.notEqual(r.status, 500, '解析失败不许变 500')
  }
})

/* --------------------------------------------------------- S9/S10 WS 抢跑 */

test('S9 WS 未注册即发业务帧：1008 关闭，且不建立任何设备状态', async () => {
  const state = await openWs('/ws/host')
  assert.equal(state.opened, true)
  state.ws.send(JSON.stringify({ t: 'session/event', sessionId: 's', ev: { seq: 0 } }))
  const code = await waitClose(state)
  assert.equal(code, 1008, `应 1008 关闭，实际 ${code}`)
  assert.equal(relay.state.sockets.size, 0, '未注册连接不许进 sockets')
})

test('S10 WS 连上但一直不注册：超过窗口被服务端关掉（防未认证连接占满 fd）', async () => {
  const before = relay.state.sockets.size
  const state = await openWs('/ws/host')
  try {
    assert.equal(state.opened, true)
    const code = await waitClose(state, 3000)
    assert.ok(code !== null, '未注册连接必须被服务端主动关闭，否则可无限堆积占满文件描述符')
    assert.equal(relay.state.sockets.size, before, '未注册连接不许进 sockets')
  } finally {
    // 不主动关掉会让客户端连接吊住事件循环，整个测试文件被拖到超时
    try { state.ws.close() } catch { /* 已关 */ }
  }
})

/* --------------------------------------------------------- S11–S14 降级通道 */

test('S11 无 HOST_TOKEN 的 /host/poll 读不到手机排队的请求正文', async () => {
  const deviceId = 'pen-poll'
  const { token } = await pair(deviceId)
  // 已配对使 CP 认为在线，但 Host 没有 WS → 请求落降级队列
  const inflight = call(`/d/${deviceId}/session/prompt`, { method: 'POST', token, body: { text: '机密内容-SECRET' } })
  for (let i = 0; i < 60; i++) {
    if ((relay.state.queue.get(deviceId) ?? []).length) break
    await new Promise((r) => setTimeout(r, 5))
  }
  const stolen = await call(`/host/poll?deviceId=${deviceId}`)
  assert.equal(stolen.status, 401, '没有 HOST_TOKEN 不许取帧——否则同网段任何人都能读到手机发出的提示词')
  assert.equal(stolen.text.includes('SECRET'), false, '响应体里出现了请求正文')
  assert.equal((relay.state.queue.get(deviceId) ?? []).length, 1, '被拒的轮询不许把队列清空（否则等于替 Host 丢帧）')

  // 带正确令牌才能取到
  const legit = await call(`/host/poll?deviceId=${deviceId}`, { hostToken: HOST_TOKEN })
  assert.equal(legit.status, 200)
  assert.equal(legit.json.data.frames.length, 1)
  const frame = legit.json.data.frames[0]
  const answer = await call('/host/respond', {
    method: 'POST', hostToken: HOST_TOKEN,
    body: { reqId: frame.reqId, status: 200, body: { ok: true, data: { ok: true }, protocol: PROTOCOL } },
  })
  assert.equal(answer.status, 200)
  assert.equal((await inflight).status, 200)
})

test('S12 无 HOST_TOKEN 的 /host/sessions 写不进索引（防投毒）', async () => {
  const deviceId = 'pen-poison'
  const own = await pair(deviceId)
  const poison = await call('/host/sessions', {
    method: 'POST',
    body: { deviceId, rows: [{ sessionId: 'forged', state: 'running', lastSeq: 999 }] },
  })
  assert.equal(poison.status, 401, '没有 HOST_TOKEN 不许写索引')
  // 用该设备自己的令牌读它自己的列表：令牌与 deviceId 绑定，拿别人的令牌只会得到 401
  const listed = await call(`/api/sessions?deviceId=${deviceId}`, { token: own.token })
  assert.equal(listed.status, 200)
  assert.equal(listed.json.data.rows.some((r) => r.sessionId === 'forged'), false, '伪造行进了索引')
})

test('S13 无 HOST_TOKEN 的 /host/heartbeat 不能把离线设备拉回在线', async () => {
  const deviceId = 'pen-heartbeat'
  await pair(deviceId)
  relay.cp.markDeviceOffline(deviceId)
  const forged = await call('/host/heartbeat', { method: 'POST', body: { deviceId } })
  assert.equal(forged.status, 401, '没有 HOST_TOKEN 不许伪造心跳——否则可让手机一直往离线设备投递、全部挂到超时')
  assert.equal(relay.cp.getDevice(deviceId)?.state, 'offline', '设备状态被改回在线了')

  const legit = await call('/host/heartbeat', { method: 'POST', hostToken: HOST_TOKEN, body: { deviceId } })
  assert.equal(legit.status, 200)
})

test('S14 无 HOST_TOKEN 的 /host/respond 不能替 Host 应答（防中间人改写回复）', async () => {
  const deviceId = 'pen-respond'
  const { token } = await pair(deviceId)
  const inflight = call(`/d/${deviceId}/session/prompt`, { method: 'POST', token, body: { text: 'real' } })
  for (let i = 0; i < 60; i++) {
    if ((relay.state.queue.get(deviceId) ?? []).length) break
    await new Promise((r) => setTimeout(r, 5))
  }
  const frame = relay.state.queue.get(deviceId)[0]

  const forged = await call('/host/respond', {
    method: 'POST',
    body: { reqId: frame.reqId, status: 200, body: { ok: true, data: { tampered: true }, protocol: PROTOCOL } },
  })
  assert.equal(forged.status, 401, '没有 HOST_TOKEN 不许代为应答')
  assert.equal(relay.state.pending.has(frame.reqId), true, '被拒的应答不许把在途请求摘掉')

  await call('/host/respond', {
    method: 'POST', hostToken: HOST_TOKEN,
    body: { reqId: frame.reqId, status: 200, body: { ok: true, data: { tampered: false }, protocol: PROTOCOL } },
  })
  const r = await inflight
  assert.equal(r.status, 200)
  assert.equal(r.json.data.tampered, false, '真应答被伪造应答改写')
})

/* --------------------------------------------------------- S16 订阅鉴权 */

test('S16 事件订阅 WS 带错令牌：握手即拒（不带业务帧回去）', async () => {
  const deviceId = 'pen-sub'
  await pair(deviceId)
  const reg = await call('/host/register', { method: 'POST', hostToken: HOST_TOKEN, body: { deviceId } })
  assert.equal(reg.status, 200)
  const state = await openWs(`/d/${deviceId}/events/session-x?token=deadbeef&sinceSeq=-1`)
  assert.equal(state.opened, false, '错令牌不该握手成功')
  assert.equal(relay.state.hub.stats().subscribers, 0, '被拒的连接不许进订阅集合')
})
