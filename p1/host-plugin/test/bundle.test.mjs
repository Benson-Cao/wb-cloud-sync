/**
 * 可安装 bundle · 端到端测试
 * 证明打包出的单文件 bundle/index.js（自动生成）独立可用：
 * 外连真 Relay、本地路由（status / pair 代理）可注册、wrapper 配置合并生效。
 */
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createRelay } from '../../relay/src/server.js'

let bundle   // 动态导入的 bundle/index.js
let relay, port, base

const callRoute = async (handler, { method = 'GET', body } = {}) => {
  if (!handler) throw new Error('路由未注册')
  return new Promise((resolve, reject) => {
    const res = {
      writeHead: () => {},
      end: (payload) => { try { resolve(JSON.parse(payload)) } catch (e) { reject(e) } },
    }
    void handler({ method, on: () => {} }, res)
  })
}

/** 最小 mock ctx：on / effect / webServer.register 三个缝。 */
const createMockCtx = () => {
  const listeners = new Map()
  const routes = new Map()
  const disposers = []
  return {
    ctx: {
      on: (event, handler) => { listeners.set(event, handler); return () => listeners.delete(event) },
      effect: (fn) => { disposers.push(fn()); },
      webServer: {
        register: (def) => { routes.set(def.path, def.handler); return () => routes.delete(def.path) },
      },
      emit: (event, ...args) => listeners.get(event)?.(...args),
      dispose: () => { for (const d of disposers.splice(0)) d?.() },
    },
    routes,
  }
}

const waitFor = async (predicate, timeout = 3000, describe = '条件') => {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`等待超时：${describe}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

before(async () => {
  bundle = await import('../bundle/index.js')
  relay = createRelay({ hostToken: 'host-secret', requestTimeoutMs: 1000 })
  port = await relay.start(0)
  base = `http://127.0.0.1:${port}`
})
after(async () => { await relay.stop() })

test('B1 bundle 独立外连真 Relay：注册成功、status 路由如实上报', async () => {
  const { ctx, routes } = createMockCtx()
  const plugin = bundle.apply(ctx, { relayUrl: base, deviceId: 'pc-bundle', hostToken: 'host-secret', indexRefreshMs: 0 })
  await waitFor(() => plugin.state.connected, 3000, 'bundle 连上 Relay')
  assert.equal(relay.isOnline('pc-bundle'), true)

  const res = await callRoute(routes.get('/__wbsync/status'))
  assert.equal(res.ok, true)
  assert.equal(res.data.connected, true)
  assert.equal(res.data.deviceId, 'pc-bundle')
  assert.equal(res.data.indexReady, false)   // 无 sessionPersistence：如实上报，不谎报
  ctx.dispose()
  await waitFor(() => !relay.isOnline('pc-bundle'), 2000, '卸载后判离线')
})

test('B2 bundle 的 pair 路由代理真 Relay 的 /pair/generate', async () => {
  const { ctx, routes } = createMockCtx()
  const plugin = bundle.apply(ctx, { relayUrl: base, deviceId: 'pc-pair-b', hostToken: 'host-secret', indexRefreshMs: 0 })
  await waitFor(() => plugin.state.connected, 3000, '已连接')

  const res = await callRoute(routes.get('/__wbsync/pair'), { method: 'POST' })
  assert.equal(res.ok, true)
  assert.match(String(res.data.code), /^\d{6}$/)
  assert.equal(res.data.deviceId, 'pc-pair-b')
  ctx.dispose()
})

test('B3 wrapper 配置链：环境变量覆盖默认值（deviceId）', async () => {
  process.env.WBSYNC_DEVICE_ID = 'pc-from-env'
  const { ctx, routes } = createMockCtx()
  // 不传 config：应落到 BUNDLE_DEFAULTS + env
  const plugin = bundle.apply(ctx, { relayUrl: base, hostToken: 'host-secret', indexRefreshMs: 0 })
  await waitFor(() => plugin.state.connected, 3000, '已连接')
  const res = await callRoute(routes.get('/__wbsync/status'))
  assert.equal(res.data.deviceId, 'pc-from-env')
  delete process.env.WBSYNC_DEVICE_ID
  ctx.dispose()
})
