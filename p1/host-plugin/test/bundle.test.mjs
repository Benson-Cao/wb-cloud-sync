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

test('B-client2 设置页只读同源 /__wbsync/*：不拉会话、不碰写入', () => {
  const client = readFileSync(new URL('../bundle/client.js', import.meta.url), 'utf8')

  // 设置页跑在 PC 的 DSH web 里，与插件同源：状态与配置直接读本地路由
  assert.match(client, /'\/__wbsync\/status'/, '要读同源状态路由')
  assert.match(client, /'\/__wbsync\/config'/, '要读同源配置路由')
  assert.match(client, /'\/__wbsync\/pair'/, '配对码走同源 pair 路由')

  // v2.3（13 §1）：不再自己拉会话、不再渲染会话列表
  assert.equal(client.includes('/api/sessions'), false, '不许再自己拉 Relay 会话列表')
  assert.equal(/function\s+Conversation/.test(client), false, '不许保留会话视图')
  assert.equal(/function\s+SessionRow/.test(client), false, '不许保留会话行')
  assert.equal(client.includes('写回缓存'), false)

  // 令牌只展示「是否配置」布尔，绝不在页面里读取或展示明文
  assert.match(client, /hostTokenConfigured/, '只读脱敏布尔')
  assert.equal(/config\?\.hostToken\b/.test(client), false, '不许从 config 读 hostToken 字段')

  // 样例数据不许回来
  assert.equal(client.includes('季度报告整理'), false, '不许留样例会话名')
  assert.equal(client.includes('半导体调研'), false, '不许留样例会话名')
})

test('B-client3 零事件流：不订阅、不解析、不代发（界面归官方 dsh web）', () => {
  const client = readFileSync(new URL('../bundle/client.js', import.meta.url), 'utf8')

  // v2.3：手机界面由官方 dsh web 提供，插件前端半边不再持有事件通道
  assert.equal(/new WebSocket|EventSource/.test(client), false, '不许订阅事件流')
  assert.equal(client.includes('/events/'), false, '不许拼事件通道地址')
  assert.equal(client.includes('sinceSeq'), false, '不许做断线补齐')

  // 写路径与审批由官方 UI 直接走宿主入口，插件不再代理
  assert.equal(client.includes('/session/prompt'), false, '不许代发消息')
  assert.equal(client.includes('$events/result'), false, '不许代答审批')
  assert.equal(client.includes('assistant/message'), false, '不许解析事件正文')

  // 只保留设置：两个 slot（设置面板 + 侧栏入口），不多不少
  assert.equal((client.match(/slots\.register/g) ?? []).length, 2, '只注册设置面板与入口两个 slot')
  assert.equal(client.includes('data-wbsync'), true, '设置组件要有可定位标记')
})
