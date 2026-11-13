/**
 * v2.3（r16）注册协商 · 确定性测试
 * ---------------------------------------------------------------
 * 覆盖三件事：
 *   1. HOST_MISMATCH：注册帧声明 protocol ≠ 当前协议 → 拒绝（WS close 1008 / HTTP 409）。
 *      wbsync/1→2 是不兼容升级，协议号自 r15 起不再是纯声明性字段。
 *   2. COMMIT_DRIFT：注册帧 dshCommit 与 Relay 配置的 pinnedDshCommit 不符 → 拒绝。
 *      未配置 pinned（默认）时不启用强制校验，只落库展示。
 *   3. ENGINE_SAFE_MODE：注册帧声明 safe-mode → /d/<hostId>/* 一律 503，
 *      重新声明 running 后恢复可桥（声明驱动、后到优先）。
 * 一律用「明确声明且不符才拒绝」口径：未声明字段的旧客户端照常注册。
 */
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { after, before, test } from 'node:test'
import { createRelay, PROTOCOL } from '../src/server.js'

const PINNED = '66491b05e3f05ad3-pin'

let relay, port
const rand = (() => {
  let n = 7000
  return (size) => Buffer.alloc(size, (++n) & 0xff)
})()

const call = async (path, { method = 'GET', body, token, hostToken } = {}) => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(hostToken ? { Authorization: `Bearer ${hostToken}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: r.status, json: await r.json() }
}

const pair = async (deviceId) => {
  const g = await call('/pair/generate', { method: 'POST', body: { deviceId } })
  const c = await call('/pair', { method: 'POST', body: { code: g.json.data.code } })
  const sig = createHmac('sha256', c.json.data.pairSecret).update(c.json.data.challenge).digest('hex')
  const v = await call('/pair/verify', { method: 'POST', body: { challenge: c.json.data.challenge, sig, clientId: 'p' } })
  assert.equal(v.status, 200)
  return v.json.data.deviceToken
}

const openWs = () => new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/host`)
  ws.addEventListener('open', () => resolve(ws), { once: true })
  ws.addEventListener('error', () => reject(new Error('ws 连接失败')), { once: true })
})

const createInbox = (ws) => {
  const queue = []
  let waiter = null
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(String(e.data))
    if (waiter) { const w = waiter; waiter = null; w(msg) } else queue.push(msg)
  })
  return {
    size: () => queue.length,
    next: () => new Promise((resolve, reject) => {
      if (queue.length) return resolve(queue.shift())
      const timer = setTimeout(() => { waiter = null; reject(new Error('收件箱超时')) }, 2000)
      waiter = (msg) => { clearTimeout(timer); resolve(msg) }
    }),
  }
}

const register = async (ws, inbox, deviceId, extra = {}) => {
  ws.send(JSON.stringify({ t: 'host/register', deviceId, hostToken: 'host-secret', caps: [], ...extra }))
  return inbox.next()
}

/** 等连接关闭并带回关闭码与原因（undici 客户端会把服务端 close 帧的 reason 解出来）。 */
const closeInfo = (ws) => new Promise((resolve) => {
  if (ws.readyState === WebSocket.CLOSED) return resolve({ code: null, reason: '' })
  ws.addEventListener('close', (e) => resolve({ code: e.code, reason: String(e.reason ?? '') }), { once: true })
})

before(async () => {
  relay = createRelay({
    hostToken: 'host-secret',
    requestTimeoutMs: 400,
    pinnedDshCommit: PINNED,
    randomBytes: rand,
  })
  port = await relay.start(0)
})
after(async () => { await relay.stop() })

test('N1 WS：声明旧协议（wbsync/1）→ close 1008 HOST_MISMATCH，且不落任何设备行', async () => {
  const ws = await openWs()
  const inbox = createInbox(ws)
  ws.send(JSON.stringify({ t: 'host/register', deviceId: 'neg-old', hostToken: 'host-secret', protocol: 'wbsync/1' }))
  const closed = await closeInfo(ws)
  assert.equal(closed.code, 1008)
  assert.ok(closed.reason.startsWith('HOST_MISMATCH'), `关闭原因应指向 HOST_MISMATCH，实际：${closed.reason}`)
  assert.ok(relay.cp.getDevice('neg-old') === null, '被拒注册帧不能留下设备行')
  assert.equal(relay.state.sockets.has('neg-old'), false)
  void inbox
})

test('N2 WS：声明未来协议同样 HOST_MISMATCH；声明当前协议照常注册', async () => {
  const ws = await openWs()
  const inbox = createInbox(ws)
  ws.send(JSON.stringify({ t: 'host/register', deviceId: 'neg-future', hostToken: 'host-secret', protocol: 'wbsync/9' }))
  const closed = await closeInfo(ws)
  assert.equal(closed.code, 1008)
  assert.ok(closed.reason.startsWith('HOST_MISMATCH'))
  assert.ok(relay.cp.getDevice('neg-future') === null)

  const ws2 = await openWs()
  const inbox2 = createInbox(ws2)
  const reg = await register(ws2, inbox2, 'neg-current', { protocol: PROTOCOL })
  assert.equal(reg.t, 'host/registered')
  await ws2.close()
})

test('N3 WS：dshCommit 与 pinned 不符 → COMMIT_DRIFT；相符 / 未声明均放行', async () => {
  const ws = await openWs()
  const inbox = createInbox(ws)
  ws.send(JSON.stringify({
    t: 'host/register', deviceId: 'neg-drift', hostToken: 'host-secret',
    protocol: PROTOCOL, dshCommit: 'deadbeef-drift',
  }))
  const closed = await closeInfo(ws)
  assert.equal(closed.code, 1008)
  assert.ok(closed.reason.startsWith('COMMIT_DRIFT'), `关闭原因应指向 COMMIT_DRIFT，实际：${closed.reason}`)
  assert.ok(relay.cp.getDevice('neg-drift') === null, '漂移注册不能留下设备行')

  // 相符 → 注册成功且落库（去空白限长）
  const ws2 = await openWs()
  const inbox2 = createInbox(ws2)
  await register(ws2, inbox2, 'neg-pinned', { protocol: PROTOCOL, dshCommit: `  ${PINNED}  ` })
  assert.equal(relay.cp.getDevice('neg-pinned').dshCommit, PINNED)
  await ws2.close()

  // 未声明（旧客户端）→ 放行；已落库的值 sticky，不被空声明冲掉
  const ws3 = await openWs()
  const inbox3 = createInbox(ws3)
  await register(ws3, inbox3, 'neg-pinned')
  assert.equal(relay.cp.getDevice('neg-pinned').dshCommit, PINNED)
  await ws3.close()
})

test('N4 HTTP 降级通道：同一套协商口径（409 HOST_MISMATCH / COMMIT_DRIFT）', async () => {
  const oldProto = await call('/host/register', {
    method: 'POST', hostToken: 'host-secret',
    body: { deviceId: 'neg-http-old', protocol: 'wbsync/1' },
  })
  assert.equal(oldProto.status, 409)
  assert.equal(oldProto.json.error.code, 'HOST_MISMATCH')
  assert.ok(relay.cp.getDevice('neg-http-old') === null)

  const drift = await call('/host/register', {
    method: 'POST', hostToken: 'host-secret',
    body: { deviceId: 'neg-http-drift', dshCommit: 'deadbeef-drift' },
  })
  assert.equal(drift.status, 409)
  assert.equal(drift.json.error.code, 'COMMIT_DRIFT')

  const okReg = await call('/host/register', {
    method: 'POST', hostToken: 'host-secret',
    body: { deviceId: 'neg-http-ok', dshCommit: PINNED, engineState: 'safe-mode' },
  })
  assert.equal(okReg.status, 200)
  const d = relay.cp.getDevice('neg-http-ok')
  assert.equal(d.dshCommit, PINNED)
  assert.equal(d.engineState, 'safe-mode')
})

test('N5 ENGINE_SAFE_MODE：safe-mode 主机的 /d/* 一律 503；重新声明 running 后恢复', async () => {
  const token = await pair('neg-safe')
  const ws = await openWs()
  const inbox = createInbox(ws)
  try {
    await register(ws, inbox, 'neg-safe', { protocol: PROTOCOL, engineState: 'safe-mode' })
    assert.equal(relay.isOnline('neg-safe'), true, 'safe-mode 只挡业务请求，不挡在线状态')

    const blocked = await call('/d/neg-safe/session/prompt', { method: 'POST', token, body: { text: 'x' } })
    assert.equal(blocked.status, 503)
    assert.equal(blocked.json.error.code, 'ENGINE_SAFE_MODE')
    assert.equal(blocked.json.error.retryable, true)
    await new Promise((r) => setTimeout(r, 60))
    assert.equal(inbox.size(), 0, '503 不应向 Host 投递任何帧')

    // 重新声明 running（声明驱动、后到优先）→ 恢复可桥
    const ws2 = await openWs()
    const inbox2 = createInbox(ws2)
    try {
      await register(ws2, inbox2, 'neg-safe', { protocol: PROTOCOL, engineState: 'running' })
      const inflight = call('/d/neg-safe/session/prompt', { method: 'POST', token, body: { text: 'back' } })
      const frame = await inbox2.next()
      assert.equal(frame.t, 'http/request')
      ws2.send(JSON.stringify({
        t: 'http/response', reqId: frame.reqId, status: 200,
        body: { ok: true, data: { via: 'recovered' }, protocol: PROTOCOL },
      }))
      const done = await inflight
      assert.equal(done.status, 200)
      assert.equal(done.json.data.via, 'recovered')
    } finally {
      await ws2.close()
    }
  } finally {
    await ws.close()
  }
})
