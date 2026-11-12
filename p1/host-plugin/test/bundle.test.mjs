/**
 * 可安装 bundle · 端到端测试
 * 证明打包出的单文件 bundle/index.js（自动生成）独立可用：
 * 外连真 Relay、本地路由（status / pair 代理）可注册、wrapper 配置合并生效。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  // 隔离 wrapper 的配置文件，避免测试写用户真实的 ~/.dsh/wbsync-host.json
  process.env.WBSYNC_HOST_CONFIG = join(mkdtempSync(join(tmpdir(), 'wbsync-bundle-')), 'wbsync-host.json')
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
  assert.ok('indexStats' in res.data, 'status 需暴露增量上报明细（mode/unchanged/removed）')
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

test('B4 wrapper 持久化 deviceId：跨调用稳定、显式配置优先且不覆写落盘值', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'wbsync-stable-')), 'nested', 'wbsync-host.json')
  const prevConfig = process.env.WBSYNC_HOST_CONFIG
  const prevDevice = process.env.WBSYNC_DEVICE_ID
  process.env.WBSYNC_HOST_CONFIG = file
  delete process.env.WBSYNC_DEVICE_ID
  const made = []
  let firstId = null
  try {
    for (let i = 0; i < 2; i++) {
      const { ctx, routes } = createMockCtx()
      made.push(ctx)
      bundle.apply(ctx, { autoConnect: false })
      const res = await callRoute(routes.get('/__wbsync/status'))
      assert.match(res.data.deviceId, /^host-[0-9a-f-]{36}$/, '首次应生成稳定的 host-<uuid>')
      if (i === 0) firstId = res.data.deviceId
      else assert.equal(res.data.deviceId, firstId, '跨调用必须读到同一个稳定 ID')
    }
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).deviceId, firstId, '已落盘到 0600 配置')

    // 显式 env 只影响本次进程，不改写落盘的稳定 ID
    process.env.WBSYNC_DEVICE_ID = 'pc-from-env'
    const { ctx, routes } = createMockCtx()
    made.push(ctx)
    bundle.apply(ctx, { autoConnect: false })
    const res = await callRoute(routes.get('/__wbsync/status'))
    assert.equal(res.data.deviceId, 'pc-from-env')
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).deviceId, firstId)
  } finally {
    for (const ctx of made) ctx.dispose()
    if (prevConfig === undefined) delete process.env.WBSYNC_HOST_CONFIG
    else process.env.WBSYNC_HOST_CONFIG = prevConfig
    if (prevDevice === undefined) delete process.env.WBSYNC_DEVICE_ID
    else process.env.WBSYNC_DEVICE_ID = prevDevice
  }
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

test('B-client 前端半边声明自洽：dsh.client 必须配 "./client" 导出与 bundle patch', () => {
  const pkg = JSON.parse(readFileSync(new URL('../bundle/package.json', import.meta.url), 'utf8'))
  const hasClient = Boolean(pkg.dsh?.client)
  assert.equal(hasClient, true, '前端半边必须声明 dsh.client')

  // 缺这条会让 DSH **启动失败**（不是静默降级）：client-modules 明确的报错是
  // "declares dsh.client but exports no './client' bundle"
  assert.equal(pkg.exports?.['./client'], './client.js', 'dsh.client 必须有 ./client 导出')

  // UI 插件要能被组合进条目图，才谈得上被扫描
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml', 'UI 插件同时要是 bundle')
  assert.ok((pkg.files ?? []).includes('client.js'), 'client.js 必须进 files，否则打包丢失')

  // id 必须等于包名，否则报 duplicate factory registration 且插件不激活
  const client = readFileSync(new URL('../bundle/client.js', import.meta.url), 'utf8')
  assert.ok(client.includes("id: '" + pkg.name + "'"),
    'client.js 的模块 id 必须等于包名')
  assert.match(client, /window\.__ModuleLoader__\.load\(/, 'client.js 必须是自注册的浏览器模块')
})
