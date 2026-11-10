/**
 * PWA 壳静态服务 · 测试
 * /app → p1/pwa/public，/src → p1/pwa/src；无鉴权静态（PWA 必需），
 * 单层文件名白名单式校验（拒绝子路径 / 反斜杠 / ..），staticDir:null 可关闭。
 */
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createRelay } from '../src/server.js'

let relay, port, closed, closedPort

const get = async (port, path) => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`)
  return { status: r.status, type: r.headers.get('content-type') ?? '', text: await r.text() }
}

before(async () => {
  relay = createRelay({ hostToken: 'host-secret', requestTimeoutMs: 300 })
  port = await relay.start(0)
  closed = createRelay({ hostToken: 'host-secret', staticDir: null })
  closedPort = await closed.start(0)
})
after(async () => {
  await relay.stop()
  await closed.stop()
})

test('S1 /app 与 /app/ 都回壳页面，/src/client.js 可取（页面相对路径的解析目标）', async () => {
  for (const p of ['/app', '/app/']) {
    const page = await get(port, p)
    assert.equal(page.status, 200)
    assert.match(page.type, /text\/html/)
    assert.match(page.text, /WBSync 会话/)
  }
  const client = await get(port, '/src/client.js')
  assert.equal(client.status, 200)
  assert.match(client.type, /text\/javascript/)
  assert.match(client.text, /createPwaClient/)
  const pairing = await get(port, '/src/pairing.js')
  assert.equal(pairing.status, 200)
  assert.match(pairing.text, /pairWithRelay/)
})

test('S2 其余壳资源：sw.js / manifest / icon，MIME 正确', async () => {
  const sw = await get(port, '/app/sw.js')
  assert.equal(sw.status, 200)
  assert.match(sw.type, /text\/javascript/)
  const manifest = await get(port, '/app/manifest.webmanifest')
  assert.equal(manifest.status, 200)
  assert.match(manifest.type, /manifest\+json/)
  const icon = await get(port, '/app/icon.svg')
  assert.equal(icon.status, 200)
  assert.match(icon.type, /image\/svg/)
})

test('S3 路径遍历与子路径一律拒绝；未知文件 404', async () => {
  // %2e%2e（.. 的编码形态）解码后含 .. → 403
  const dotdot = await get(port, '/app/%2e%2e%2frelay%2fsrc%2fserver.js')
  assert.equal(dotdot.status, 403)
  // 反斜杠形态
  const backslash = await get(port, '/app/..%5crelay%5csrc%5cserver.js')
  assert.equal(backslash.status, 403)
  // 不存在的文件与无扩展名请求
  assert.equal((await get(port, '/app/nope.js')).status, 404)
  assert.equal((await get(port, '/src/nope.js')).status, 404)
  // 壳页面源码不被越权枚举：/app 下没有 server.js
  assert.equal((await get(port, '/app/server.js')).status, 404)
})

test('S4 staticDir:null 显式关闭 → /app 404', async () => {
  const page = await get(closedPort, '/app')
  assert.equal(page.status, 404)
  assert.match(page.text, /未启用静态壳服务/)
})

test('S5 壳页面引用的资源都能从 /app 页面解析路径取到（自洽检查）', async () => {
  const page = await get(port, '/app/')
  // 页面里 import '../src/client.js'、'../src/pairing.js' → 从 /app/ 解析为 /src/*
  // 页面里 import { x } from '../src/client.js'、href="./manifest.webmanifest"
  const refs = [...page.text.matchAll(/(?:\bfrom|href|src)\s*=?\s*["']([^"']+)["']/g)].map((m) => m[1])
  assert.ok(refs.includes('../src/client.js'), '页面应引用 ../src/client.js')
  assert.ok(refs.includes('./manifest.webmanifest'), '页面应引用 ./manifest.webmanifest')
  for (const ref of refs) {
    if (!ref.startsWith('.') && !ref.startsWith('http')) continue
    const resolved = new URL(ref, 'http://x/app/').pathname
    const r = await get(port, resolved)
    assert.equal(r.status, 200, `引用资源应可取：${ref} → ${resolved}`)
  }
})
