/**
 * r18 · 官方 dsh web 反代（S-6.7 方案 A）确定性单测（node --test，零依赖）
 * 覆盖：uiUrl 注册收口（内存不落盘）/ 反代鉴权负向 / 正向透传链路（mock 上游）/
 * dsh-auth-* 剥离与票 cookie / 上游 401 自愈重换 / 301 补尾斜杠 / WS socket 透传 / 吊销作废。
 */
import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { createServer } from 'node:http'
import net from 'node:net'
import { test } from 'node:test'

import { createRelay } from '../src/server.js'

let relay, port, clock

const rand = (() => {
  let n = 0
  return (size) => Buffer.alloc(size, (++n) & 0xff)
})()

const call = async (path, { method = 'GET', body, token, cookie, redirect = 'follow' } = {}) => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    redirect,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const headers = {}
  for (const [k, v] of r.headers.entries()) headers[k] = v
  const setCookies = r.headers.getSetCookie?.() ?? []
  const text = await r.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 非 JSON 响应 */ }
  return { status: r.status, headers, setCookies, text, json }
}

/* ------------------------------------------------------- mock 官方 dsh web */

const startMockDshWeb = () => new Promise((resolve) => {
  const seen = []
  let currentCookie = null            // 当前有效的上游会话 cookie（模拟家目录签名密钥语义）
  let connectCalls = 0
  const server = createServer((req, res) => {
    seen.push({
      path: req.url, host: req.headers.host ?? '', cookie: req.headers.cookie ?? '',
      origin: req.headers.origin ?? null, referer: req.headers.referer ?? null,
      authorization: req.headers.authorization ?? null,
    })
    const authed = () => {
      const m = /dsh-auth-test=([^;]+)/.exec(req.headers.cookie ?? '')
      return Boolean(m) && m[1] === currentCookie
    }
    if (req.url.startsWith('/connect')) {
      // 官方 /connect 铸 v2 API 票（GET / 的 isAuthenticated 不认）——反代不应走这条
      res.writeHead(401); return res.end('unauthorized')
    }
    if (req.url === '/' || req.url.startsWith('/?')) {
      const u = new URL(req.url, 'http://mock')
      if ((u.searchParams.get('token') ?? '') === 'tok-0123456789abcdef') {
        // 官方浏览器入口（根路径 ?token=）：铸 v1 浏览器 cookie + 303 到 ./
        connectCalls++
        currentCookie = `c${connectCalls}`
        res.setHeader('Set-Cookie', `dsh-auth-test=${currentCookie}; Path=/; Max-Age=999; HttpOnly`)
        res.writeHead(303, { Location: './' })
        return res.end()
      }
      if (!authed()) { res.writeHead(401); return res.end('dsh web authentication required') }
      res.writeHead(200, { 'Content-Type': 'text/html' })
      return res.end('<html>OFFICIAL-UI-INDEX</html>')
    }
    if (req.url === '/assets/app.js') {
      if (!authed()) { res.writeHead(401); return res.end() }
      res.setHeader('Set-Cookie', 'pref=1; Path=/')
      res.writeHead(200, { 'Content-Type': 'text/javascript' })
      return res.end('console.log("ASSET-JS")')
    }
    res.writeHead(404); res.end()
  })
  server.on('upgrade', (req, socket) => {
    seen.push({ upgrade: true, path: req.url, cookie: req.headers.cookie ?? '' })
    const accept = createHash('sha1')
      .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64')
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n')
  })
  server.listen(0, '127.0.0.1', () => resolve({
    server, seen,
    port: server.address().port,
    uiUrl: `http://127.0.0.1:${server.address().port}/?token=tok-0123456789abcdef`,
    rotate: () => { currentCookie = `rotated-${connectCalls}` },   // 模拟上游签名密钥更换
    connectCount: () => connectCalls,
    stop: () => new Promise((r) => {
      server.closeAllConnections?.()
      server.close(() => r())
      setTimeout(r, 1500)   // 兜底：升级型 socket 不受 closeAllConnections 跟踪，防套件悬挂
    }),
  }))
})

/* ------------------------------------------------------------------ 工具 */

const pairPhone = async (deviceId, phoneId) => {
  const g = await call('/pair/generate', { method: 'POST', body: { deviceId } })
  assert.equal(g.status, 200, 'pair/generate 发码')
  const code = g.json.data.code
  const c = await call('/pair', { method: 'POST', body: { code } })
  assert.equal(c.status, 200, 'pair 换挑战')
  const { challenge, pairSecret } = c.json.data
  const sig = createHmac('sha256', pairSecret).update(challenge).digest('hex')
  const v = await call('/pair/verify', { method: 'POST', body: { challenge, sig, phoneId } })
  assert.equal(v.status, 200, 'pair/verify 发令牌')
  return v.json.data.deviceToken
}

const registerHost = async (deviceId, uiUrl, extra = {}) => {
  const body = { deviceId, hostId: deviceId, deviceName: `档案-${deviceId}`, platform: 'win32', ...extra }
  if (uiUrl !== undefined) body.uiUrl = uiUrl
  const r = await call('/host/register', { method: 'POST', body })
  assert.equal(r.status, 200, `host/register ${deviceId}`)
  return r
}

const boot = async ({ admin = false } = {}) => {
  clock = 1_700_000_000_000
  relay = createRelay({ now: () => clock, randomBytes: rand, ...(admin ? { adminToken: 'admin-secret' } : {}) })
  port = await relay.start(0)
  const mock = await startMockDshWeb()
  return { mock }
}

const shutdown = async (mock) => {
  await relay.stop()
  await mock.stop()
}

const ticketOf = (doc, hostId) =>
  doc.setCookies.find((c) => c.startsWith(`wbsync-ui-${hostId}=`))?.split(';')[0]

/* --------------------------------------------------------------- 用例 */

test('R1 注册收 uiUrl：Relay 内存可查、CP 不落盘、/api/hosts 报 uiAvailable', async () => {
  const { mock } = await boot({ admin: true })
  try {
    await registerHost('dev-r1', mock.uiUrl)
    const stored = relay.state.uiUrls.get('dev-r1')
    assert.ok(stored instanceof URL, 'uiUrl 以 URL 对象存内存')
    assert.equal(stored.origin, mock.uiUrl.split('/?')[0], 'origin 与注册声明一致')
    assert.equal(stored.searchParams.get('token'), 'tok-0123456789abcdef')
    // CP 是元数据权威，但 launch token 属于传输态：设备行必须没有 uiUrl 字段
    assert.equal('uiUrl' in (relay.cp.getDevice('dev-r1') ?? {}), false, 'CP 设备行不落 uiUrl')
    const hosts = await call('/api/hosts', { token: 'admin-secret' })
    const row = hosts.json.data.rows.find((h) => h.hostId === 'dev-r1')
    assert.equal(row.uiAvailable, true, '/api/hosts 行报 uiAvailable 布尔')
    assert.equal(hosts.text.includes('tok-0123456789abcdef'), false, '/api/hosts 响应不含令牌')
  } finally { await shutdown(mock) }
})

test('R2 uiUrl 三关校验：非回环/缺 token 拒收；重新注册缺席清旧值', async () => {
  const { mock } = await boot()
  try {
    await registerHost('dev-r2', 'http://192.168.1.5:3080/?token=tok-0123456789abcdef')
    assert.equal(relay.state.uiUrls.has('dev-r2'), false, '非回环拒收')
    await registerHost('dev-r2', 'http://127.0.0.1:3080/')
    assert.equal(relay.state.uiUrls.has('dev-r2'), false, '缺 token 拒收')
    await registerHost('dev-r2', 'not a url at all')
    assert.equal(relay.state.uiUrls.has('dev-r2'), false, '不可解析拒收')
    await registerHost('dev-r2', mock.uiUrl)
    assert.equal(relay.state.uiUrls.has('dev-r2'), true, '合法 uiUrl 收下')
    await registerHost('dev-r2', undefined)
    assert.equal(relay.state.uiUrls.has('dev-r2'), false, '重新注册缺席 uiUrl = 清旧值（令牌已随重启轮换）')
  } finally { await shutdown(mock) }
})

test('R3 反代鉴权：无/错 pt 401；越权主机令牌 401；无 uiUrl 409 UI_UNAVAILABLE', async () => {
  const { mock } = await boot()
  try {
    await registerHost('dev-r3', undefined)             // 本机不提供 uiUrl
    await registerHost('dev-r3b', undefined)            // 别的主机（越权对照）
    const t1 = await pairPhone('dev-r3', 'phone-r3a')
    const t2 = await pairPhone('dev-r3b', 'phone-r3b')  // 绑定 dev-r3b 的手机
    const noPt = await call('/d/dev-r3/ui/')
    assert.equal(noPt.status, 401, '无 pt 且无票 → 401')
    const badPt = await call('/d/dev-r3/ui/?pt=wrong-token')
    assert.equal(badPt.status, 401, '错 pt → 401')
    const crossPt = await call('/d/dev-r3/ui/?pt=' + t2)
    assert.equal(crossPt.status, 401, '他机令牌（绑定 dev-r3b）打 dev-r3 → 401')
    const withPt = await call('/d/dev-r3/ui/?pt=' + t1)
    assert.equal(withPt.status, 409, '令牌有效但主机无 uiUrl → 409')
    assert.equal(withPt.json.error.code, 'UI_UNAVAILABLE')
  } finally { await shutdown(mock) }
})

test('R4 正向链路：?pt= 换票 → 拿到官方 UI HTML；票 cookie 复访免 pt；令牌不出现在响应', async () => {
  const { mock } = await boot()
  try {
    await registerHost('dev-r4', mock.uiUrl)
    const phoneToken = await pairPhone('dev-r4', 'phone-r4')
    const doc = await call(`/d/dev-r4/ui/?pt=${encodeURIComponent(phoneToken)}`)
    assert.equal(doc.status, 200, '文档请求透传上游 200')
    assert.ok(doc.text.includes('OFFICIAL-UI-INDEX'), '拿到的是上游官方 UI HTML')
    assert.equal(doc.text.includes('tok-0123456789abcdef'), false, 'launch token 不出现在响应体')
    const ticketCookie = ticketOf(doc, 'dev-r4')
    assert.ok(ticketCookie, '会话票已种下（HttpOnly cookie）')
    const setCookieHeader = doc.setCookies.find((c) => c.startsWith('wbsync-ui-dev-r4=')) ?? ''
    assert.ok(setCookieHeader.includes('HttpOnly'), '票必须 HttpOnly')
    assert.ok(setCookieHeader.includes('Path=/d/dev-r4/ui/'), '票只种在反代路径下')
    // 复访：只带票，不带 pt
    const again = await call('/d/dev-r4/ui/assets/app.js', { cookie: ticketCookie })
    assert.equal(again.status, 200)
    assert.ok(again.text.includes('ASSET-JS'))
    // 上游观察：Host 是上游 authority；不带 Origin/Referer；请求带服务端换来的 cookie
    const docCalls = mock.seen.filter((s) => s.path === '/')
    assert.ok(docCalls.length >= 1, '上游收到文档请求')
    assert.equal(docCalls.every((s) => s.origin === null), true, '不透传 Origin（回环围栏输入）')
    assert.equal(docCalls.every((s) => s.referer === null), true, '不透传 Referer')
    assert.equal(docCalls.every((s) => s.authorization === null), true, '不透传 Authorization')
    const okCall = docCalls.find((s) => (s.cookie ?? '').includes('dsh-auth-test='))
    assert.ok(okCall, '请求带服务端换来的 dsh-auth-* cookie')
    assert.equal(okCall?.host, `127.0.0.1:${mock.port}`, 'Host 头为上游 authority')
  } finally { await shutdown(mock) }
})

test('R5 dsh-auth-* Set-Cookie 不透传给手机；其余 Set-Cookie 照透', async () => {
  const { mock } = await boot()
  try {
    await registerHost('dev-r5', mock.uiUrl)
    const phoneToken = await pairPhone('dev-r5', 'phone-r5')
    const doc = await call(`/d/dev-r5/ui/?pt=${encodeURIComponent(phoneToken)}`)
    const ticketCookie = ticketOf(doc, 'dev-r5')
    const asset = await call('/d/dev-r5/ui/assets/app.js', { cookie: ticketCookie })
    assert.equal(asset.status, 200)
    const all = asset.setCookies.join(' | ')
    assert.ok(all.includes('pref=1'), '非鉴权 Set-Cookie 透传')
    assert.equal(/dsh-auth-/.test(all), false, 'dsh-auth-* 永不透传（服务端持有）')
  } finally { await shutdown(mock) }
})

test('R6 上游会话失效 → 401 后自动重换 cookie 自愈', async () => {
  const { mock } = await boot()
  try {
    await registerHost('dev-r6', mock.uiUrl)
    const phoneToken = await pairPhone('dev-r6', 'phone-r6')
    const first = await call(`/d/dev-r6/ui/?pt=${encodeURIComponent(phoneToken)}`)
    assert.equal(first.status, 200)
    const before = mock.connectCount()
    mock.rotate()                                    // 模拟上游签名密钥更换 → 旧 cookie 全部失效
    const ticketCookie = ticketOf(first, 'dev-r6')
    const second = await call('/d/dev-r6/ui/', { cookie: ticketCookie })
    assert.equal(second.status, 200, '401 → 重换 cookie → 重试成功')
    assert.ok(mock.connectCount() > before, '确实重新换了 cookie')
  } finally { await shutdown(mock) }
})

test('R7 /ui 无尾斜杠 → 301 补斜杠，保留其余查询、剥掉 pt', async () => {
  const { mock } = await boot()
  try {
    await registerHost('dev-r7', mock.uiUrl)
    const phoneToken = await pairPhone('dev-r7', 'phone-r7')
    const r = await call(`/d/dev-r7/ui?pt=${encodeURIComponent(phoneToken)}&foo=bar`, { redirect: 'manual' })
    assert.equal(r.status, 301)
    assert.equal(r.headers.location, '/d/dev-r7/ui/?foo=bar')
    assert.equal(r.headers.location.includes('pt='), false, 'pt 不进重定向地址')
  } finally { await shutdown(mock) }
})

test('R8 WS mux socket 级透传：101 直通、上游收到 Cookie；无票 401', async () => {
  const { mock } = await boot()
  try {
    await registerHost('dev-r8', mock.uiUrl)
    const phoneToken = await pairPhone('dev-r8', 'phone-r8')
    const doc = await call(`/d/dev-r8/ui/?pt=${encodeURIComponent(phoneToken)}`)
    const ticketCookie = ticketOf(doc, 'dev-r8')
    const rawWs = (cookie) => new Promise((resolve) => {
      const s = net.connect(port, '127.0.0.1', () => {
        s.write([
          'GET /d/dev-r8/ui/api/remote.mux HTTP/1.1',
          'Host: relay',
          'Upgrade: websocket',
          'Connection: Upgrade',
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
          'Sec-WebSocket-Version: 13',
          ...(cookie ? [`Cookie: ${cookie}`] : []),
          '', '',
        ].join('\r\n'))
      })
      let buf = ''
      s.on('data', (d) => {
        buf += d.toString('latin1')
        if (buf.includes('\r\n\r\n') && !s._done) {
          s._done = true
          setTimeout(() => { try { s.destroy() } catch { /* 已断开 */ } }, 50)   // 不在 data 回调里同步销毁，给对端 pipe 收尾留一拍
          resolve(buf)
        }
      })
      s.on('error', () => resolve(buf))
    })
    const denied = await rawWs(null)
    assert.ok(denied.startsWith('HTTP/1.1 401'), '无票 WS 升级 → 401')
    const raw = await rawWs(ticketCookie)
    assert.ok(raw.startsWith('HTTP/1.1 101'), '升级响应直通（socket 级透传）')
    const up = mock.seen.find((s) => s.upgrade)
    assert.ok(up, '上游收到了 WS 升级请求')
    assert.equal(up.path, '/api/remote.mux', '路径剥掉反代前缀')
    assert.ok(up.cookie.includes('dsh-auth-test='), '上游请求带服务端换来的 cookie')
  } finally { await shutdown(mock) }
})

test('R9 revoke-client 使该手机的 UI 会话票即刻作废', async () => {
  const { mock } = await boot({ admin: true })
  try {
    await registerHost('dev-r9', mock.uiUrl)
    const phoneToken = await pairPhone('dev-r9', 'phone-r9')
    const doc = await call(`/d/dev-r9/ui/?pt=${encodeURIComponent(phoneToken)}`)
    const ticketCookie = ticketOf(doc, 'dev-r9')
    const ok = await call('/d/dev-r9/ui/', { cookie: ticketCookie })
    assert.equal(ok.status, 200, '收回前票有效')
    const rv = await call('/admin/revoke-client', {
      method: 'POST', token: 'admin-secret',
      body: { deviceId: 'dev-r9', clientId: 'phone-r9' },
    })
    assert.equal(rv.status, 200)
    const after = await call('/d/dev-r9/ui/', { cookie: ticketCookie })
    assert.equal(after.status, 401, '收回后票即刻作废（不带 pt 无法再进）')
  } finally { await shutdown(mock) }
})
