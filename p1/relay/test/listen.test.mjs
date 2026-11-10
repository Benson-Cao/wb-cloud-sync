/**
 * 监听地址与启动器 · 测试
 * start(port, host) 第二参数生效（真机联调需监听网卡而非回环）；
 * run.mjs 的语义（未设 hostToken → 注册不校验）在服务端行为里验证。
 */
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createRelay } from '../src/server.js'

let relay, port

before(async () => {
  // 不设 hostToken（run.mjs 未配置时的形态）+ 监听 0.0.0.0
  relay = createRelay({ requestTimeoutMs: 300 })
  port = await relay.start(0, '0.0.0.0')
})
after(async () => { await relay.stop() })

test('L1 监听 0.0.0.0 后回环地址可达（手机经局域网访问的等价形态）', async () => {
  const r = await fetch(`http://127.0.0.1:${port}/health`)
  assert.equal(r.status, 200)
  const json = await r.json()
  assert.equal(json.ok, true)
})

test('L2 未设 hostToken 时 /app 静态壳可访问（run.mjs 默认形态不破坏壳服务）', async () => {
  const r = await fetch(`http://127.0.0.1:${port}/app`)
  assert.equal(r.status, 200)
  assert.match(await r.text(), /WBSync 会话/)
})

test('L3 未设 hostToken 时 Host 注册不校验令牌（试跑形态；对外必须显式设置）', async () => {
  const r = await fetch(`http://127.0.0.1:${port}/host/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: 'pc-open', hostToken: 'anything-or-empty' }),
  })
  assert.equal(r.status, 200)
  const json = await r.json()
  assert.equal(json.ok, true)
})
