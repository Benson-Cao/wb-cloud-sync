/**
 * 新建会话链路 · 端到端测试
 * 真实 createRelay()：POST /api/sessions → 桥接 session/create → Host 适配器。
 * 覆盖：鉴权、成功后 CP 立即可见（引导行）、适配器 409 透传、Host 离线 409、
 * 客户端 createSession() 全链路。
 */
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { after, before, test } from 'node:test'
import { createRelay } from '../../relay/src/server.js'
import { createPwaClient } from '../src/client.js'

let relay, port, base
let clock = 1_700_000_000_000
const advance = (ms) => { clock += ms }

const call = async (path, { method = 'GET', body, token } = {}) => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: r.status, json: await r.json() }
}

const pair = async (deviceId) => {
  const g = await call('/pair/generate', { method: 'POST', body: { deviceId } })
  const c = await call('/pair', { method: 'POST', body: { code: g.json.data.code } })
  const sig = createHmac('sha256', c.json.data.pairSecret).update(c.json.data.challenge).digest('hex')
  const v = await call('/pair/verify', { method: 'POST', body: { challenge: c.json.data.challenge, sig } })
  assert.equal(v.status, 200)
  return v.json.data.deviceToken
}

const openHostWs = () => new Promise((resolve, reject) => {
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
    next(timeout = 2000) {
      return new Promise((resolve, reject) => {
        if (queue.length) return resolve(queue.shift())
        const timer = setTimeout(() => { waiter = null; reject(new Error('收件箱超时')) }, timeout)
        timer.unref?.()
        waiter = (msg) => { clearTimeout(timer); resolve(msg) }
      })
    },
  }
}

/**
 * 注册模拟 Host。createHandler 应答 `session/create` 帧：
 *   - 传函数 → 用其返回值作为 http/response 的 {status, body}
 *   - 不传   → 不应答（请求会走 10s 超时；测试里不会用到）
 */
const registerHost = async (deviceId, createHandler = null) => {
  const ws = await openHostWs()
  const inbox = createInbox(ws)
  ws.send(JSON.stringify({ t: 'host/register', deviceId, hostToken: 'host-secret', caps: [] }))
  assert.equal((await inbox.next()).t, 'host/registered')
  ;(async () => {
    for (;;) {
      const msg = await inbox.next(60_000).catch(() => null)
      if (!msg) return
      if (msg.t === 'http/request' && msg.endpoint === 'session/create' && createHandler) {
        const { status, body } = await createHandler(msg.body ?? {})
        ws.send(JSON.stringify({ t: 'http/response', reqId: msg.reqId, status, body }))
      }
    }
  })()
  return { ws, inbox, send: (frame) => ws.send(JSON.stringify(frame)) }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

before(async () => {
  relay = createRelay({ hostToken: 'host-secret', requestTimeoutMs: 1000, now: () => clock })
  port = await relay.start(0)
  base = `http://127.0.0.1:${port}`
})
after(async () => {
  for (const ws of relay.state.sockets.values()) { try { ws.close(1000, 'done') } catch { /* 已关闭 */ } }
  await wait(50)
  await relay.stop()
})

test('C1 POST /api/sessions 无令牌 / 错令牌 → 401', async () => {
  const no = await call('/api/sessions', { method: 'POST', body: { deviceId: 'pc-c', text: '' } })
  assert.equal(no.status, 401)
  const bad = await call('/api/sessions', { method: 'POST', token: 'wrong', body: { deviceId: 'pc-c', text: '' } })
  assert.equal(bad.status, 401)
})

test('C2 Host 适配器创建成功 → 200 {sessionId}，CP 立即可见引导行（state=awaiting）', async () => {
  const token = await pair('pc-c2')
  await registerHost('pc-c2', async () => ({
    status: 200,
    body: { ok: true, data: { sessionId: 'session-new-1', title: null } },
  }))

  const r = await call('/api/sessions', { method: 'POST', token, body: { deviceId: 'pc-c2', text: '第一句话' } })
  assert.equal(r.status, 200)
  assert.equal(r.json.data.sessionId, 'session-new-1')

  // 不等 Host 的 60s 索引刷新：引导行应立即可查
  const list = await call('/api/sessions?deviceId=pc-c2', { token })
  assert.equal(list.status, 200)
  const row = list.json.data.rows.find((x) => x.sessionId === 'session-new-1')
  assert.ok(row, '引导行应已写入 CP')
  assert.equal(row.state, 'awaiting')
})

test('C3 Host 适配器拒绝（WRITER_UNAVAILABLE）→ 409 原样透传，CP 不出幽灵会话', async () => {
  const token = await pair('pc-c3')
  await registerHost('pc-c3', async () => ({
    status: 409,
    body: { ok: false, error: { code: 'WRITER_UNAVAILABLE', message: '未注入 createSession 适配器', retryable: false } },
  }))
  const r = await call('/api/sessions', { method: 'POST', token, body: { deviceId: 'pc-c3', text: '' } })
  assert.equal(r.status, 409)
  assert.equal(r.json.error.code, 'WRITER_UNAVAILABLE')
  const list = await call('/api/sessions?deviceId=pc-c3', { token })
  assert.deepEqual(list.json.data.rows, [])
})

test('C4 Host 离线（心跳窗口过后）→ 409 HOST_OFFLINE（retryable）', async () => {
  const token = await pair('pc-c4')
  // 配对即视为最近活跃（45s 窗口内），把时钟推过窗口即判离线
  advance(45_001)
  const r = await call('/api/sessions', { method: 'POST', token, body: { deviceId: 'pc-c4', text: '' } })
  assert.equal(r.status, 409)
  assert.equal(r.json.error.code, 'HOST_OFFLINE')
  assert.equal(r.json.error.retryable, true)
})

test('C6 客户端 createSession()：宿主异常原文透传，真机不用只靠 code 猜', async () => {
  const token = await pair('pc-c6')
  const hostMessage = 'sessions.create: entry already exists'
  await registerHost('pc-c6', async () => ({
    status: 409,
    body: { ok: false, error: { code: 'HOST_ADAPTER_ERROR', message: hostMessage, retryable: false } },
  }))
  const client = createPwaClient({ baseUrl: base, deviceId: 'pc-c6', token, reconnectBaseMs: 40 })
  try {
    await assert.rejects(
      () => client.createSession({ text: '' }),
      (e) => {
        assert.equal(e.code, 'HOST_ADAPTER_ERROR')
        assert.equal(e.detail, hostMessage)
        assert.match(e.message, /entry already exists/)
        return true
      },
    )
  } finally {
    client.stop()
  }
})

test('C5 客户端 createSession()：返回 sessionId 且列表立刻可见', async () => {
  const token = await pair('pc-c5')
  let createCalls = []
  await registerHost('pc-c5', async (reqBody) => {
    createCalls.push(reqBody)
    return { status: 200, body: { ok: true, data: { sessionId: 'session-new-5' } } }
  })
  const client = createPwaClient({ baseUrl: base, deviceId: 'pc-c5', token, reconnectBaseMs: 40 })
  const created = await client.createSession({ text: '帮我建个会话' })
  assert.equal(created.sessionId, 'session-new-5')
  assert.deepEqual(createCalls, [{ clientId: 'pwa', text: '帮我建个会话', cwd: null }])
  const rows = client.snapshot().sessions
  assert.ok(rows.some((x) => x.sessionId === 'session-new-5'))
  client.stop()
})
