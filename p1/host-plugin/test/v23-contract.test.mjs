/**
 * v2.3 契约补齐（04 §8 / 12 S-3.3 / 13 C1）· Host 插件本地路由
 * ---------------------------------------------------------------
 * 这些测试锁的不是「新功能好不好用」，而是三条边界：
 *   1. 只增不删：status 原有字段一个不少，wbsync/1 帧语义不变；
 *   2. 不泄密：/__wbsync/config 绝不回 hostToken 明文；
 *   3. 不伪造：dshCommit / hostId 未配置时如实回落或为 null，绝不猜一个值。
 *
 * 不用真 Relay：这些路由是纯本地只读，autoConnect:false 即可隔离网络。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { apply } from '../src/index.js'

const PROTOCOL = 'wbsync/1'

function createMockCtx() {
  const routes = new Map()
  const kinds = []
  const effects = []
  const ctx = {
    routes,
    kinds,
    webServer: {
      register(spec) {
        routes.set(spec.path, spec.handler)
        kinds.push({ path: spec.path, kind: spec.kind })
        return () => routes.delete(spec.path)
      },
    },
    on() { return () => {} },
    effect(fn) { const dispose = fn(); effects.push(dispose); return dispose },
    dispose() { for (const d of effects.splice(0)) d?.() },
  }
  return ctx
}

const call = (ctx, path, method = 'GET') => new Promise((resolve) => {
  const handler = ctx.routes.get(path)
  if (!handler) return resolve({ status: 0, body: null, missing: true })
  let settled = false
  const done = (v) => { if (!settled) { settled = true; resolve(v) } }
  const res = {
    writeHead(status) { this.status = status; return this },
    end(payload) { done({ status: this.status, body: payload, json: (() => { try { return JSON.parse(payload) } catch { return null } })() }) },
  }
  try { handler({ method }, res) } catch (error) { done({ status: -1, error }) }
  setTimeout(() => done({ status: -2, timeout: true }), 1000)
})

/** 组装一个不联网的插件实例；调用方负责 ctx.dispose()。 */
const mount = (config = {}) => {
  const ctx = createMockCtx()
  apply(ctx, { autoConnect: false, deviceId: 'pc-1', ...config })
  return ctx
}

/* ---------------------------------------------------- status：v2.3 新字段 */

test('status 补齐 hostId / dshCommit / engineState，未配置时如实回落', async () => {
  const ctx = mount()
  try {
    const r = await call(ctx, '/__wbsync/status')
    assert.equal(r.status, 200)
    const d = r.json.data
    // 回落语义：hostId 未配置 = deviceId，且明示来源，不假装已做 hostId 命名空间隔离
    assert.equal(d.hostId, 'pc-1')
    assert.equal(d.hostIdSource, 'deviceId')
    assert.equal(d.dshCommit, null, '没锁定基线就回 null，绝不从 package.json 猜版本号')
    assert.equal(d.engineState, 'running')
    assert.equal(d.engineScope, 'pc-host', '必须说明这是 PC 插件自身，不是 Termux 本机引擎')
    // 只增不删：原有字段全部保留
    for (const key of ['connected', 'deviceId', 'relayConfigured', 'forwarded', 'dropped', 'downlinks', 'reconnects', 'writer', 'protocol']) {
      assert.ok(Object.hasOwn(d, key), `status 原有字段 ${key} 被删了`)
    }
    assert.equal(d.protocol, PROTOCOL, '链路仍是 wbsync/1，不静默升到 2.3')
  } finally { ctx.dispose() }
})

test('status 显式配置 hostId / dshCommit / engineState 时原样上报', async () => {
  const ctx = mount({
    hostId: 'host-alpha',
    dshCommit: '66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db',
    engineState: 'running',
  })
  try {
    const d = (await call(ctx, '/__wbsync/status')).json.data
    assert.equal(d.hostId, 'host-alpha')
    assert.equal(d.hostIdSource, 'config')
    assert.equal(d.dshCommit, '66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db')
    assert.equal(d.engineScope, 'pc-host')
  } finally { ctx.dispose() }
})

/* --------------------------------------------------- config：只读与脱敏 */

test('config 路由返回连接配置，且绝不回 hostToken 明文', async () => {
  const SECRET = 'host-token-plaintext-MUST-NOT-LEAK-9f3a'
  const ctx = mount({
    relayUrl: 'http://127.0.0.1:8787',
    hostToken: SECRET,
    autoConnect: false,
  })
  try {
    const r = await call(ctx, '/__wbsync/config')
    assert.equal(r.status, 200)
    assert.equal(r.json.ok, true)
    assert.equal(r.json.protocol, PROTOCOL)
    const d = r.json.data
    assert.equal(d.relayUrl, 'http://127.0.0.1:8787')
    assert.equal(d.autoConnect, false)
    assert.equal(d.hostTokenConfigured, true)
    assert.equal(d.hostId, 'pc-1')
    assert.equal(d.dshCommit, null)
    assert.equal(d.engineScope, 'pc-host')
    assert.deepEqual(d.allowedEndpoints, ['session/*', '$events/*'])
    // 关键安全断言：整段响应体（含嵌套）不得出现明文，也不得多一个 hostToken 字段
    assert.ok(!r.body.includes(SECRET), 'hostToken 明文泄漏到 /__wbsync/config 响应里')
    assert.equal(Object.hasOwn(d, 'hostToken'), false)
  } finally { ctx.dispose() }
})

test('config 未配置 hostToken 时如实报 false，不编造', async () => {
  const ctx = mount()
  try {
    const d = (await call(ctx, '/__wbsync/config')).json.data
    assert.equal(d.hostTokenConfigured, false)
    assert.equal(d.relayUrl, '')
  } finally { ctx.dispose() }
})

test('config 只读：非 GET 一律 405 ENDPOINT_NOT_ALLOWED', async () => {
  const ctx = mount()
  try {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const r = await call(ctx, '/__wbsync/config', method)
      assert.equal(r.status, 405, `${method} 应被拒绝`)
      assert.equal(r.json.ok, false)
      assert.equal(r.json.error.code, 'ENDPOINT_NOT_ALLOWED')
    }
  } finally { ctx.dispose() }
})

test('allowedEndpoints 可被配置覆盖，不改 routes.js 的实际分派口径', async () => {
  const ctx = mount({ allowedEndpoints: ['session/*'] })
  try {
    const d = (await call(ctx, '/__wbsync/config')).json.data
    assert.deepEqual(d.allowedEndpoints, ['session/*'])
  } finally { ctx.dispose() }
})

/* --------------------------------------------- v2.3：不注册任何 UI 路由 */

test('所有本地路由都是 exact 功能路由，无 prefix 静态/UI 托管', async () => {
  const ctx = mount()
  try {
    assert.ok(ctx.kinds.length > 0)
    assert.deepEqual([...new Set(ctx.kinds.map((k) => k.kind))], ['exact'])
    for (const { path } of ctx.kinds) {
      assert.ok(path.startsWith('/__wbsync/'))
      assert.ok(!path.includes('/ui/'), `出现 UI 路由 ${path}`)
      assert.ok(!path.includes('/static/'), `出现静态资源路由 ${path}`)
    }
    assert.ok(ctx.kinds.some((k) => k.path === '/__wbsync/status'))
    assert.ok(ctx.kinds.some((k) => k.path === '/__wbsync/config'))
  } finally { ctx.dispose() }
})

test('卸载即撤回：config 路由随 ctx.effect 一并注销', async () => {
  const ctx = mount()
  assert.equal((await call(ctx, '/__wbsync/config')).status, 200)
  ctx.dispose()
  const r = await call(ctx, '/__wbsync/config')
  assert.equal(r.missing, true, 'dispose 后 config 路由仍在，违反可逆性')
})
