/**
 * 宿主真实入口适配器 · 测试
 * ---------------------------------------------------------------
 * 形状取证自 DSH asar（sessionController.create / prompt，见 src/host-adapters.js
 * 头注）。覆盖：参数映射、幂等 requestId、部分成功语义、服务缺失 409、
 * 以及**真 Relay 端到端**：手机 POST /api/sessions → Host 适配器 → 宿主入口
 * → 返回 sessionId → CP 写引导行。最后一例用打包产物 bundle/index.js 验证
 * 「新模块确实被合成进单文件」，防止源码改了但用户装的包没接上。
 */
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { test } from 'node:test'
import { createRelay } from '../../relay/src/server.js'
import { createHostAdapters } from '../src/host-adapters.js'
import { apply } from '../src/index.js'

const makeController = (overrides = {}) => {
  const calls = { create: [], prompt: [] }
  const controller = {
    create: async (request) => { calls.create.push(request); return { sessionId: 'session-created-1' } },
    prompt: async (request, source) => { calls.prompt.push({ request, source }); return { accepted: true } },
    ...overrides,
  }
  return { ctx: { sessionController: controller }, controller, calls }
}

test('HA1 空会话：create({}) → sessionId，不调 prompt', async () => {
  const { ctx, calls } = makeController()
  const r = await createHostAdapters(ctx).createSession({ text: '', cwd: null, clientId: 'pwa' })
  assert.equal(r.ok, true)
  assert.equal(r.value.sessionId, 'session-created-1')
  assert.deepEqual(calls.create, [{}])
  assert.equal(calls.prompt.length, 0)
})

test('HA2 cwd 透传 + 第一句话：requestId/rpcId 一致、content 走宿主结构', async () => {
  const { ctx, calls } = makeController()
  const r = await createHostAdapters(ctx, { randomId: () => 'req-fixed' })
    .createSession({ text: '  第一句话  ', cwd: 'D:/work', clientId: 'pwa' })
  assert.equal(r.ok, true)
  assert.equal(r.value.prompted, true)
  assert.deepEqual(calls.create, [{ cwd: 'D:/work' }])
  assert.equal(calls.prompt.length, 1)
  const { request, source } = calls.prompt[0]
  assert.equal(request.sessionId, 'session-created-1')
  assert.equal(request.mode, 'queue')
  assert.deepEqual(request.content, [{ type: 'text', text: '第一句话' }])
  assert.equal(request.requestId, 'req-fixed')
  assert.deepEqual(source, { kind: 'user', rpcId: 'req-fixed' })
})

test('HA3 部分成功：create 成功但 prompt 抛错 → 如实返回成功 + promptError', async () => {
  const { ctx } = makeController({ prompt: async () => { throw new Error('writer held') } })
  const r = await createHostAdapters(ctx, { randomId: () => 'r1' }).createSession({ text: 'hi' })
  assert.equal(r.ok, true, '会话已客观存在，不能报失败让手机重复创建')
  assert.equal(r.value.sessionId, 'session-created-1')
  assert.equal(r.value.prompted, false)
  assert.match(r.value.promptError, /writer held/)
})

test('HA4 prompt 入口缺失 → 仍返回会话，附未发送说明', async () => {
  const { ctx, controller } = makeController()
  delete controller.prompt
  const r = await createHostAdapters(ctx).createSession({ text: 'hi' })
  assert.equal(r.ok, true)
  assert.equal(r.value.prompted, false)
  assert.match(r.value.promptError, /未提供 prompt/)
})

test('HA5 服务软探测：直接属性 / ctx.get / 缺失 → 409', async () => {
  const viaGet = createHostAdapters({ get: (n) => (n === 'sessionController'
    ? { create: async () => ({ sessionId: 'session-via-get' }) } : undefined) })
  assert.equal((await viaGet.createSession({})).value.sessionId, 'session-via-get')
  assert.deepEqual(viaGet.capabilities(), { controller: true, create: true, prompt: false, cancel: false })

  const missing = createHostAdapters({})
  assert.deepEqual(missing.capabilities(), { controller: false, create: false, prompt: false, cancel: false })
  const r = await missing.createSession({})
  assert.equal(r.ok, false)
  assert.equal(r.code, 'WRITER_UNAVAILABLE')
  assert.equal((await missing.submitPrompt({ sessionId: 's', text: 'x' })).code, 'WRITER_UNAVAILABLE')
  assert.equal((await missing.cancelTurn({})).code, 'WRITER_UNAVAILABLE')
})

test('HA6 create 抛错 / 未返回 sessionId → HOST_ADAPTER_ERROR', async () => {
  const thrown = createHostAdapters({ sessionController: { create: async () => { throw new Error('workspace gone') } } })
  const a = await thrown.createSession({})
  assert.equal(a.code, 'HOST_ADAPTER_ERROR')
  assert.match(a.message, /workspace gone/)

  const noId = createHostAdapters({ sessionController: { create: async () => ({}) } })
  assert.equal((await noId.createSession({})).code, 'HOST_ADAPTER_ERROR')
})

test('HA7 submitPrompt：clientMsgId → requestId，宿主原生幂等键', async () => {
  const { ctx, calls } = makeController()
  const r = await createHostAdapters(ctx).submitPrompt({ sessionId: 's-7', text: '远程跑', clientMsgId: 'msg-7' })
  assert.equal(r.ok, true)
  assert.equal(calls.prompt[0].request.requestId, 'msg-7')
  assert.equal(calls.prompt[0].source.rpcId, 'msg-7')
  assert.equal(calls.prompt[0].request.sessionId, 's-7')
})

/* --------------------------------------------------------- 端到端（真 Relay） */

const hmac = (secret, msg) => createHmac('sha256', secret).update(msg).digest('hex')

const createMockCtx = () => {
  const listeners = new Map()
  const routes = new Map()
  const effects = []
  return {
    routes,
    on: (event, fn) => { listeners.set(event, fn); return () => listeners.delete(event) },
    effect: (fn) => { const d = fn(); effects.push(d); return d },
    webServer: {
      register: (def) => { routes.set(def.path, def.handler); return () => routes.delete(def.path) },
    },
    emit: (event, ...args) => listeners.get(event)?.(...args),
    dispose: () => { for (const d of effects.splice(0)) d?.() },
  }
}

const waitFor = async (predicate, timeout = 3000, describe = '条件') => {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`等待超时：${describe}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

/** 起真 Relay、配对、装插件，返回发请求所需的一切。 */
const setup = async (applyImpl, controller) => {
  const relay = createRelay()
  const port = await relay.start(0)
  const base = `http://127.0.0.1:${port}`
  const post = async (path, body, headers = {}) => {
    const r = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
    return { status: r.status, json: await r.json() }
  }
  const gen = await post('/pair/generate', { deviceId: 'pc-1' })
  const pair = await post('/pair', { code: gen.json.data.code })
  const { challenge, pairSecret } = pair.json.data
  const verify = await post('/pair/verify', { challenge, sig: hmac(pairSecret, challenge) })
  const token = verify.json.data.deviceToken

  const ctx = createMockCtx()
  ctx.sessionController = controller
  const plugin = applyImpl(ctx, {
    relayUrl: base, deviceId: 'pc-1', autoConnect: true, indexRefreshMs: 0,
  })
  // 必须等 Host 收到 host/registered：relay.isOnline 会因 CP 活跃标记提前为 true，
  // 那时 bridge 还找不到 WS 连接，帧会被投进降级轮询队列 → 504。
  await waitFor(() => plugin.state.connected, '插件收到 host/registered')
  return {
    relay, base, token, post,
    create: (body) => post('/api/sessions', { deviceId: 'pc-1', ...body }, { Authorization: `Bearer ${token}` }),
    cleanup: () => { ctx.dispose(); return relay.stop() },
  }
}

test('HA8 端到端（src）：手机新建会话 → 宿主 create/prompt → CP 引导行', async () => {
  const calls = { create: [], prompt: [] }
  const controller = {
    create: async (r) => { calls.create.push(r); return { sessionId: 'session-e2e-1' } },
    prompt: async (r, s) => { calls.prompt.push({ request: r, source: s }); return { accepted: true } },
  }
  const env = await setup(apply, controller)
  try {
    const r = await env.create({ text: '手机发来的第一句话', cwd: 'D:/pwa' })
    assert.equal(r.status, 200, JSON.stringify(r.json))
    assert.equal(r.json.data.sessionId, 'session-e2e-1')
    assert.equal(r.json.data.prompted, true)
    assert.deepEqual(calls.create, [{ cwd: 'D:/pwa' }])
    assert.equal(calls.prompt[0].request.sessionId, 'session-e2e-1')
    assert.equal(calls.prompt[0].request.content[0].text, '手机发来的第一句话')

    const list = await fetch(`${env.base}/api/sessions?deviceId=pc-1`, {
      headers: { Authorization: `Bearer ${env.token}` },
    })
    const rows = (await list.json()).data.rows
    assert.ok(rows.some((row) => row.sessionId === 'session-e2e-1'), '创建成功即写 CP 引导行')
  } finally {
    await env.cleanup()
  }
})

test('HA9 端到端（bundle 产物）：合成包也能接上宿主新建会话入口', async () => {
  const bundle = await import('../bundle/index.js')
  const calls = { create: [], prompt: [] }
  const controller = {
    create: async (r) => { calls.create.push(r); return { sessionId: 'session-bundle-1' } },
    prompt: async (r, s) => { calls.prompt.push({ request: r, source: s }); return { accepted: true } },
  }
  const env = await setup(bundle.apply, controller)
  try {
    const r = await env.create({ text: '' })
    assert.equal(r.status, 200, JSON.stringify(r.json))
    assert.equal(r.json.data.sessionId, 'session-bundle-1')
    assert.equal(calls.create.length, 1)
    assert.equal(calls.prompt.length, 0)
  } finally {
    await env.cleanup()
  }
})
