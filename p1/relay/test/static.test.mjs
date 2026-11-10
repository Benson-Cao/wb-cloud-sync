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

test('S6 SW 缓存清单覆盖壳页面与 src 模块的传递引用', async () => {
  const sw = await get(port, '/app/sw.js')
  const assets = sw.text.match(/SHELL_ASSETS\s*=\s*\[([\s\S]*?)\]/)?.[1] ?? ''
  const listed = [...assets.matchAll(/["']([^"']+)["']/g)].map((m) => m[1])

  const listedPaths = new Set(listed.map((a) => new URL(a, 'http://x/app/').pathname))
  // 页面引用的相对资源必须都在清单里（按 /app/ 解析，与清单项同一基准）
  const page = (await get(port, '/app/')).text
  const pageRefs = [...page.matchAll(/(?:\bfrom|href|src)\s*=?\s*["'](\.[^"']+)["']/g)].map((m) => m[1])
  for (const ref of pageRefs) {
    const resolved = new URL(ref, 'http://x/app/').pathname
    assert.ok(listedPaths.has(resolved), `SW 缓存清单缺少页面引用：${ref}`)
  }

  // src 模块间的相对 import 也必须在清单里（新增配对依赖漏缓存会导致离线加载失败）
  for (const name of ['client.js', 'pairing.js', 'hmac-sha256.js']) {
    const src = (await get(port, `/src/${name}`)).text
    for (const m of src.matchAll(/\bfrom\s*["'](\.\/[^"']+)["']/g)) {
      const dep = m[1].replace(/^\.\//, '')
      assert.ok(listed.includes(`../src/${dep}`), `SW 缓存清单缺少模块依赖：${name} → ${dep}`)
      assert.equal((await get(port, `/src/${dep}`)).status, 200, `依赖应可从 /src/ 取到：${dep}`)
    }
  }
  // 缓存名不硬编码具体版本：只要保持 vN 且不低于当前基线即可，
  // 避免每次递增（v3 → v4 → …）都要回来改这条断言。
  const cache = sw.text.match(/SHELL_CACHE\s*=\s*["']wbsync-shell-v(\d+)["']/)
  assert.ok(cache, 'SHELL_CACHE 必须是 wbsync-shell-vN 形式')
  assert.ok(Number(cache[1]) >= 4,
    `壳资源变更后缓存名应递增（当前基线 v4），实际 v${cache[1]}`)
  // 真机 0.1.6 取证：滚到事件流区域点按钮后，顶部反馈条看不见，被误判成「点了没反应」
  assert.match(page, /scrollIntoView/, '操作反馈必须主动滚入视口')
  assert.match(page, /STATUS_TEXT/, '订阅状态需映射中文，不暴露 connecting/following 内部值')
  assert.match(page, /fold\.type === type/, '连续同类型事件需折叠，避免流式碎片把页面拉爆')
  assert.match(page, /id="forget"/, '必须有「忘掉这台电脑」入口，清令牌不靠清浏览器数据')
  assert.match(page, /for \(const k of \['wbsync\.token'/, '忘掉电脑必须真的清掉令牌 / 设备 ID / 地址')
  assert.match(page, /#newbar\[hidden\][\s\S]*?display:\s*none/,
    'display:flex 会盖掉 UA 的 [hidden]{display:none}，必须显式提权重，否则 hidden 形同虚设')
})
