/**
 * W3 开发骨架 · Relay（零依赖，Node >= 24.9）
 * ---------------------------------------------------------------
 * 范围（05 W3）：配对、设备注册、心跳与离线判定、白名单、Host 离线立即 409、
 * **Host 主动 WebSocket 长连与帧保序**，以及会话索引上报。
 *
 * 传输分工：
 *   - Host → Relay：`WS /ws/host` 长连（正式设计，docs/04 §5.2）。
 *   - 手机 → Relay：HTTP（W3 骨架；PWA 侧的 SSE/WS 属后续提交）。
 *   - 手机 HTTP 请求经 `http/request` 帧转给 Host，Host 用 `http/response` 回，
 *     帧字段与 docs/04 §5.3 一致；**同一连接的帧按发送顺序到达**（帧序即流序）。
 *   - HTTP 轮询桥（`GET /host/poll` + `POST /host/respond`）保留为**降级通道**：
 *     当设备没有活跃 WS 连接时使用，便于旧 Host 与单测。
 *
 * 四项 P1 前置按 SIGNOFF-WAIVER.md §5 的**默认口径**实现（未经会签）：
 *   #2 pairSecret = per-challenge 一次性随机数，不落盘、不参与令牌派生；
 *   #3 单机期 Relay 内存表为活跃令牌、在线状态与会话索引的权威；
 *   #4 只开放 session/* 与 $events/*，其余端点默认拒绝；
 *   #5b 客户端 sinceSeq 唯一权威，服务端 Cursor 仅作可观测性快照。
 *
 * **CP 分离（本轮）**：#3 那条口径已经过时——设备表、会话索引、写句柄租约、消费位点
 * 四张表迁到 `p1/cp`（接口按 PROTOCOL §2 的 Postgres 表设计）。Relay 只剩传输状态
 * （套接字、待转发帧、事件缓冲、配对短时码）。多个 Relay 实例共享同一个 CP 实例时，
 * 看到的是同一份设备与会话视图。
 */
import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createControlPlane } from '../../cp/src/index.js'
import { createEventHub } from './events.js'
import { upgradeToWebSocket } from './ws.js'

export const PROTOCOL = 'wbsync/2.3'
// `fileUploads/*` 于 wbsync/1 r3 加入：附件上行经 Relay 内存中转，不落盘、不缓存、不进事件流
export const ALLOWED_ENDPOINTS = ['session/*', 'fileUploads/*', '$events/*']

const DEFAULTS = {
  codeTtlMs: 600_000,          // 6 位码 10 分钟
  challengeTtlMs: 60_000,      // 一次性挑战 60 秒
  heartbeatTimeoutMs: 45_000,  // >45s 无心跳判离线
  rateLimitPerMin: 5,          // 设备 + IP 维度 5 次/分
  rateWindowMs: 60_000,
  requestTimeoutMs: 10_000,    // 10s 无进度防悬挂
  registerTimeoutMs: 10_000,   // WS 连上后必须在 10s 内发 host/register，否则关闭
  maxBodyBytes: 1_048_576,
  // WS 单帧上限。真机实测单条事件最大 421 KiB（p99 97 KiB），旧的 1 MiB 天花板
  // 会被长回复/大会话摘要顶破，然后以 1009 静默断连、在途请求熬成 504。
  maxFrameBytes: 8 * 1024 * 1024,
  eventBufferBytes: 32 * 1024 * 1024,
  // 一台 Host 最多绑几台手机（r9）。够用即可：这是「谁的手机能看这台电脑」的清单长度。
  maxPhonesPerHost: 8,
  // v2.3（r16）：期望的 DSH pinned commit（来自 pinned-commit.txt）。配置后，注册帧
  // 声明的 dshCommit 与之不符即拒绝（COMMIT_DRIFT）；空串 = 不启用强制校验，只落库展示。
  pinnedDshCommit: '',
}

/** 定长比较，避免按字符比密钥时的时序泄漏（`===` 会在首字节不同处提前返回）。 */
const sameSecret = (a, b) => {
  const x = Buffer.from(String(a ?? ''), 'utf8')
  const y = Buffer.from(String(b ?? ''), 'utf8')
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y)
}

/** HMAC 十六进制串的比较（长度不等直接否，不抛异常）。 */
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a), 'hex')
  const y = Buffer.from(String(b), 'hex')
  return x.length === y.length && timingSafeEqual(x, y)
}

/**
 * 手机自报的 `phoneId`：只是个**稳定身份**，不是凭据（凭据永远是令牌）。
 * 限定字符集与长度是为了让它能安全地进 URL 与日志，不必再转义。
 * 不合规就当没给 → 服务端生成一个；这比「拒绝配对」更合理：配对码才是信任建立手段。
 */
const PHONE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/
const sanitizePhoneId = (raw) => (typeof raw === 'string' && PHONE_ID_RE.test(raw) ? raw : null)
/** 设备名只做展示，截断+去控制字符，不参与任何判定。 */
const sanitizeLabel = (raw) => (typeof raw === 'string'
  ? raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40) || null
  : null)

/**
 * 「客户端刚才是用哪个地址找到我的」——优先取反代给的 X-Forwarded-Proto，其次按 Host 头拼。
 * 拿它当 `relayUrl` 回给客户端，比写死 `127.0.0.1` 有意义得多：手机上的 127.0.0.1 是手机自己。
 */
const requestOrigin = (req) => {
  const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() || 'http'
  const host = String(req.headers.host ?? '').trim()
  return host ? `${proto}://${host}` : null
}

/**
 * 端点归一化：白名单必须比对**解码后**的端点，否则 `session/..%2Fadmin%2Frevoke`
 * 能靠「看起来以 session/ 开头」混过前缀匹配，再被 Host 解码成完全不同的路径。
 * 返回 null 表示这段路径本身就不该被转发（穿越 / 多重编码 / 空字节）。
 */
const normalizeEndpoint = (raw) => {
  let decoded
  try { decoded = decodeURIComponent(raw) } catch { return null }
  if (!decoded || decoded.includes('\0')) return null
  if (/%2f|%5c/i.test(decoded)) return null            // 多重编码：解一次还带转义
  if (decoded.split('/').some((seg) => seg === '..' || seg === '.')) return null
  return decoded
}

/**
 * 白名单匹配。`session/*` 只放行**单段**端点（`session/prompt`），
 * 不再用裸 startsWith —— 那会让 `session/prompt/extra`、`session/a/b` 全体通过。
 */
const isAllowed = (endpoint, allowlist = ALLOWED_ENDPOINTS) =>
  allowlist.some((rule) => {
    if (!rule.endsWith('/*')) return endpoint === rule
    const head = rule.slice(0, -1)                     // 'session/'
    if (!endpoint.startsWith(head)) return false
    const rest = endpoint.slice(head.length)
    return rest.length > 0 && !rest.includes('/')
  })

/**
 * v2.3（r16）注册协商：只拒绝「明确声明且不符」的注册帧，未声明（旧客户端）一律放行。
 *   1. protocol 声明且 ≠ 当前协议 → HOST_MISMATCH。wbsync/1→2 是不兼容升级，协议号
 *      在 r15 之前只是声明性字段，2.3 插件连 1.0 Relay 不会被拒——r16 起注册即拦截。
 *      HOST_MISMATCH 的「主机切换」语义（请求 hostId ≠ 当前链路主机）属于 P2 CP，
 *      本轮的 hostId 值兼容 deviceId，没有可判定不一致的场景。
 *   2. dshCommit 声明、Relay 配置了 pinnedDshCommit、两者不符 → COMMIT_DRIFT：
 *      拒绝注册即索引不合并（§6「索引不合并、只提示升级」）；未配置 pinned 时不启用
 *      强制校验，只把声明值落库展示。
 * WS 关闭原因走 `detail`（RFC 6455 关闭帧 reason ≤ 123 字节，必须短）；HTTP 走 `message`。
 */
const registerIdentityError = (cfg, body) => {
  const declaredProtocol = typeof body.protocol === 'string' ? body.protocol.trim() : ''
  if (declaredProtocol && declaredProtocol !== PROTOCOL) {
    return {
      code: 'HOST_MISMATCH',
      detail: `protocol ${declaredProtocol.slice(0, 32)} != ${PROTOCOL}`,
      message: `注册帧协议 ${declaredProtocol} 与 Relay ${PROTOCOL} 不符（wbsync/1→2 为不兼容升级）`,
    }
  }
  const declaredCommit = typeof body.dshCommit === 'string' ? body.dshCommit.trim().slice(0, 64) : ''
  const pinned = String(cfg.pinnedDshCommit ?? '').trim()
  if (declaredCommit && pinned && declaredCommit !== pinned) {
    return {
      code: 'COMMIT_DRIFT',
      detail: 'dshCommit != pinned',
      message: '主机 DSH commit 与 pinned-commit 不一致，拒绝注册：请升级主机或同步 pinned 基线',
    }
  }
  return null
}

/* ------------------------------------------------------------ 静态壳服务 */

const STATIC_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.css': 'text/css; charset=utf-8',
}

/**
 * 解析静态根目录对：createRelay 不传 `staticDir` → 自动探测 `p1/pwa/public`
 * （仓库内相对定位，存在才挂）；传 `null` 显式关闭；传字符串用给定目录
 * （public 与 src 约定为兄弟目录）。
 * 真机部署时 Relay 与 p1/ 同树分发，自动探测即命中。
 */
const resolveStaticRoots = (staticDir) => {
  if (staticDir === null) return null
  let base
  if (typeof staticDir === 'string') {
    base = staticDir.replace(/[\\/]+$/, '')
  } else {
    base = fileURLToPath(new URL('../../pwa/public/', import.meta.url))
    if (!existsSync(base)) return null
    base = base.replace(/[\\/]+$/, '')
  }
  // `/app/*` → public（壳），`/src/*` → 兄弟目录 src（client.js / pairing.js，
  // 页面里的 `../src/x.js` 从 /app/ 解析为 /src/x.js）
  return { publicRoot: base, srcRoot: `${base}/../src` }
}

/**
 * 静态文件读取：只允许**单层文件名**（两个根目录都约定平铺）。
 * 先 decodeURIComponent 再校验——编码形态的遍历（`%2e%2e`、`%2f`）解码后
 * 必然带 `..` / 路径分隔符，一样被拒；从根上排除路径遍历，不依赖 URL 归一化行为。
 */
const readStaticFile = (root, rawName) => {
  if (!root) return { status: 404, code: 'ENDPOINT_NOT_ALLOWED', message: '未启用静态壳服务' }
  let name = rawName
  try { name = decodeURIComponent(String(rawName)) } catch {
    return { status: 400, code: 'INVALID_JSON', message: '静态路径解码失败' }
  }
  if (!name || name.endsWith('/')) name += 'index.html'
  if (/[/\\]|\.\./.test(name)) return { status: 403, code: 'ENDPOINT_NOT_ALLOWED', message: '非法静态路径' }
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return { status: 404, code: 'ENDPOINT_NOT_ALLOWED', message: '未知静态文件' }
  const mime = STATIC_MIME[name.slice(dot)]
  if (!mime) return { status: 404, code: 'ENDPOINT_NOT_ALLOWED', message: '不支持的静态类型' }
  try {
    return { status: 200, body: readFileSync(`${root}/${name}`), mime }
  } catch {
    return { status: 404, code: 'ENDPOINT_NOT_ALLOWED', message: `静态文件不存在：${name}` }
  }
}

const sendStatic = (res, result) => {
  if (result.status !== 200) return fail(res, result.status, result.code, result.message)
  res.writeHead(200, {
    'Content-Type': result.mime,
    'Content-Length': result.body.length,
    // 壳页面无鉴权是 PWA 必需（docs/04）；内容变更靠 sw 版本号 + no-cache 兜底
    'Cache-Control': 'no-cache',
    'X-Protocol-Version': PROTOCOL,
  })
  res.end(result.body)
}

/**
 * PC 侧设备管理页（同源调 /admin 与 /admin/revoke）。内联而非落盘，
 * 保持 Relay 零静态资源依赖；token 只存本页内存，不进 URL / localStorage。
 */
const ADMIN_UI_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>WBSync 设备管理</title>
<style>
body{font:15px/1.6 system-ui,sans-serif;max-width:900px;margin:24px auto;padding:0 16px;background:#11151c;color:#e6ecf5}
h1{font-size:20px} p{color:#9fb0c8}
input,button{font:inherit;padding:6px 10px;border-radius:6px;border:1px solid #3a4658;background:#1b2431;color:#e6ecf5}
button{cursor:pointer;background:#2b5fbd;border-color:#2b5fbd}
button.danger{background:#8b3030;border-color:#8b3030}
table{width:100%;border-collapse:collapse;margin-top:16px}
th,td{text-align:left;padding:8px;border-bottom:1px solid #2a3444;font-size:13px}
code{color:#8ab8e8} #msg{margin:12px 0;min-height:1.4em}
</style></head><body>
<h1>WBSync 设备管理</h1>
<p>吊销已配对设备：令牌立即失效、设备进入墓碑不可复活，其会话索引与租约一并清除。<b>写操作必须配置 <code>WBSYNC_ADMIN_TOKEN</code></b>；令牌只存本页内存，不写入 URL 或本地存储。</p>
<p>一台电脑可以配对多台手机（r9）。撤回其中一台只会断它自己，不影响电脑与其它手机。</p>
<label>Admin Token <input id="token" type="password" autocomplete="off" size="32"></label>
<button id="refresh">刷新设备列表</button>
<div id="msg"></div>
<table><thead><tr><th>设备</th><th>状态</th><th>最近活跃</th><th>令牌摘要</th><th>操作</th></tr></thead><tbody id="rows"></tbody></table>
<script>
const $ = (id) => document.getElementById(id)
const say = (t, bad) => { $('msg').textContent = t; $('msg').style.color = bad ? '#e07a7a' : '#7fd18c' }
const headers = () => ({ Authorization: 'Bearer ' + $('token').value.trim() })
const load = async () => {
  try {
    const r = await fetch('/admin', { headers: headers() })
    const j = await r.json()
    if (!r.ok) { say('读取失败：' + (j.error && j.error.code) + ' ' + (j.error && j.error.message), true); return }
    $('rows').innerHTML = ''
    const cell = (s) => { const td = document.createElement('td'); td.textContent = s; return td }
    for (const d of j.data.rows) {
      const tr = document.createElement('tr')
      tr.appendChild(cell(d.deviceId))
      tr.appendChild(cell(d.tombstone ? '已吊销' : d.state))
      tr.appendChild(cell(d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString() : '—'))
      tr.appendChild(cell(d.tokenDigest ? d.tokenDigest.slice(0, 12) + '…' : '—'))
      const td = document.createElement('td')
      const btn = document.createElement('button')
      btn.textContent = d.tombstone ? '已吊销' : '吊销'
      btn.className = 'danger'
      btn.disabled = Boolean(d.tombstone)
      btn.onclick = () => revoke(d.deviceId)
      td.appendChild(btn); tr.appendChild(td); $('rows').appendChild(tr)

      // 已配对的手机逐台列在自己那台电脑下面：撤一台不等于撤一台电脑
      for (const p of (d.phones || [])) {
        const pr = document.createElement('tr')
        pr.style.opacity = '0.85'
        pr.appendChild(cell('  ↳ 手机 ' + (p.label ? p.label + ' · ' : '') + p.deviceId))
        pr.appendChild(cell('已配对'))
        pr.appendChild(cell(p.lastSeenAt ? new Date(p.lastSeenAt).toLocaleString() : '—'))
        pr.appendChild(cell(p.tokenDigest ? p.tokenDigest.slice(0, 12) + '…' : '—'))
        const ptd = document.createElement('td')
        const pb = document.createElement('button')
        pb.textContent = '收回这台手机'
        pb.className = 'danger'
        pb.onclick = () => revokeClient(d.deviceId, p.deviceId)
        ptd.appendChild(pb); pr.appendChild(ptd); $('rows').appendChild(pr)
      }
    }
    say('已列出 ' + j.data.rows.length + ' 台设备')
  } catch (e) { say('读取失败：' + e.message, true) }
}
const revoke = async (deviceId) => {
  if (!window.confirm('确认吊销 ' + deviceId + '？该操作不可撤销，其名下手机一并失效。')) return
  try {
    const r = await fetch('/admin/revoke', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, headers()), body: JSON.stringify({ deviceId }) })
    const j = await r.json()
    if (!r.ok) { say('吊销失败：' + (j.error && j.error.code) + ' ' + (j.error && j.error.message), true); return }
    say('已吊销：' + deviceId); await load()
  } catch (e) { say('吊销失败：' + e.message, true) }
}
const revokeClient = async (deviceId, clientId) => {
  if (!window.confirm('收回这台手机？它会立即掉线，需要重新输配对码。电脑与其它手机不受影响。')) return
  try {
    const r = await fetch('/admin/revoke-client', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, headers()), body: JSON.stringify({ deviceId, clientId }) })
    const j = await r.json()
    if (!r.ok) { say('收回失败：' + (j.error && j.error.code) + ' ' + (j.error && j.error.message), true); return }
    say('已收回手机：' + clientId); await load()
  } catch (e) { say('收回失败：' + e.message, true) }
}
$('refresh').onclick = load
load()
</script></body></html>`

/**
 * 跨域（W10 前置）：独立 PWA 由 Relay 同源托管，从来不需要 CORS；嵌进 DSH 手机端后，
 * 页面来自 WebView 的 `http://127.0.0.1:<port>`，Relay 在另一台机器 → 必然跨域。
 *
 * 只回显**本机源**与显式配置的来源，绝不 `*`：CORS 一旦放开到任意站点，
 * 任何网页都能拿用户浏览器里的令牌去打 Relay（令牌仍要 Authorization，
 * 但把「谁能发起请求」也交出去等于白送一半攻击面）。
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])
const isAllowedOrigin = (origin, cfg) => {
  const extra = Array.isArray(cfg?.corsOrigins) ? cfg.corsOrigins : []
  if (extra.includes(origin)) return true
  try {
    const u = new URL(origin)
    return (u.protocol === 'http:' || u.protocol === 'https:') && LOOPBACK_HOSTS.has(u.hostname)
  } catch { return false }
}

const reply = (res, status, payload, extraHeaders = {}) => {  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'X-Protocol-Version': PROTOCOL,
    ...extraHeaders,
  })
  res.end(body)
}
const ok = (res, data, status = 200) => reply(res, status, { ok: true, data, protocol: PROTOCOL })
const fail = (res, status, code, message, retryable = false) =>
  reply(res, status, { ok: false, error: { code, message, retryable }, protocol: PROTOCOL })

const readBody = async (req, maxBytes) => {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) throw new Error('BODY_TOO_LARGE')
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  let parsed
  try { parsed = JSON.parse(text) } catch { throw new Error('INVALID_JSON') }
  // 协议里每个请求体都是对象；数组 / null / 数字 / 字符串一律按非法处理。
  // 放行它们会让后续 `body.deviceId` 之类的取值抛出 TypeError 变 500，
  // 而 500 与非 500 的差异可被用来探测服务端实现细节。
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('INVALID_JSON')
  }
  return parsed
}

/**
 * 创建 Relay 实例。返回未 listen 的 http.Server，便于测试。
 * 注入 now() / randomBytes() 可让时间与随机性确定，规则判定是纯函数。
 */
export function createRelay(options = {}) {
  const cfg = { ...DEFAULTS, ...options }
  const now = cfg.now ?? (() => Date.now())
  const rand = cfg.randomBytes ?? randomBytes
  const allowlist = cfg.allowedEndpoints ?? ALLOWED_ENDPOINTS
  // 元数据全在 CP；Relay 不再自己存设备表 / 索引 / 位点
  const cp = cfg.controlPlane ?? createControlPlane({
    now,
    offlineAfterMs: cfg.heartbeatTimeoutMs,
    maxPhonesPerHost: cfg.maxPhonesPerHost,
  })
  // PWA 壳静态根（/app → public/，/src → pwa/src）；null 关闭
  const staticRoots = resolveStaticRoots(cfg.staticDir)

  const state = {
    codes: new Map(),        // code -> { deviceId, expiresAt }（配对短时态，P2 迁 CP）
    challenges: new Map(),   // challenge -> { code, deviceId, pairSecret, expiresAt }
    rateHits: new Map(),     // `${deviceId}|${ip}` -> number[] (ms)
    queue: new Map(),        // deviceId -> 待转发帧（无 WS 时的降级通道）
    pending: new Map(),      // reqId -> { resolve, timer }
    sockets: new Map(),      // deviceId -> WS 连接（正式通道）
    hub: createEventHub({ capacity: cfg.eventBuffer ?? 1000, maxBytes: cfg.eventBufferBytes }),  // 事件缓冲 + 订阅广播
    // 审批看板：Host 判、Relay 存、手机拉。存的是**已下发过的原帧**，所以手机断线期间
    // 的审批不会丢——重连后 `GET /api/approvals` 就能补回来。
    approvals: new Map(),    // approvalId -> { deviceId, payload, expiresAt, createdAt }
    phoneConns: new Map(),   // deviceId -> Set<conn>（手机上任何会话订阅都算，审批是设备级的）
    // 产物下载票（ADR-011）：只在内存里，60s TTL、单次使用、绑定手机令牌摘要。
    // 绝不用它承载会话正文，也绝不落盘。
    downloads: new Map(),    // ticketId -> { bytes, name, mime, expiresAt, tokenDigest }
  }

  /** 手机侧已建立的事件订阅连接，按设备归组（审批通知要发给该设备的每一台手机）。 */
  const trackPhoneConn = (deviceId, conn) => {
    const set = state.phoneConns.get(deviceId) ?? new Set()
    set.add(conn)
    state.phoneConns.set(deviceId, set)
  }
  const untrackPhoneConn = (deviceId, conn) => {
    const set = state.phoneConns.get(deviceId)
    if (!set) return
    set.delete(conn)
    if (!set.size) state.phoneConns.delete(deviceId)
  }
  /** 广播给该设备上的手机；断掉的顺手剔除。 */
  const broadcastToDevice = (deviceId, frame) => {
    const set = state.phoneConns.get(deviceId)
    if (!set) return 0
    let reached = 0
    for (const conn of [...set]) {
      if (conn.isOpen()) { conn.sendJson(frame); reached++ } else set.delete(conn)
    }
    return reached
  }
  /** 关掉某台手机的事件订阅长连（按手机收回令牌时用：只断它，不碰同设备的其它手机）。 */
  const closePhoneClient = (deviceId, clientId) => {
    const set = state.phoneConns.get(deviceId)
    if (!set) return 0
    let closed = 0
    for (const conn of [...set]) {
      if (conn.clientId !== clientId) continue
      try { conn.close?.(1008, 'token revoked'); closed++ } catch { /* 已断开 */ }
    }
    return closed
  }
  /** 惰性清过期条目：不额外起定时器，读写时顺手扫。 */
  const sweepApprovals = (deviceId = null) => {
    const t = now()
    for (const [id, row] of state.approvals) {
      if (deviceId && row.deviceId !== deviceId) continue
      if (row.expiresAt && row.expiresAt < t) {
        state.approvals.delete(id)
        broadcastToDevice(row.deviceId, { t: 'approval/resolved', approvalId: id, outcome: 'cancelled', by: 'expired' })
      }
    }
  }

  const sixDigitCode = () => String(rand(4).readUInt32BE(0) % 1_000_000).padStart(6, '0')
  const hex = (n) => rand(n).toString('hex')

  /**
   * `/host/*` 的凭据闸。配置了 `hostToken` 就必须带，三种载体任选其一
   * （Bearer 头 / body.hostToken / query `hostToken`），因为降级通道历史上三种都写过。
   *
   * 为什么必须逐端点校验、不能只在 `/host/register` 查一次：这些是**独立 HTTP 请求**，
   * 彼此没有会话关联。只在注册处校验，等于同网段任何人都能
   * `GET /host/poll` 读走手机发出的提示词、`POST /host/respond` 改写回复、
   * `POST /host/sessions` 往手机列表里投毒、`POST /host/heartbeat` 把离线设备伪装成在线。
   * 未配置 `hostToken` 视为明确的单机开发模式（`run.mjs` 会打警告），不静默放行。
   */
  const hostAuthOk = (req, body, url) => {
    if (!cfg.hostToken) return true
    const bearer = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
    const fromBody = typeof body?.hostToken === 'string' ? body.hostToken : ''
    const fromQuery = url.searchParams.get('hostToken') ?? ''
    return [bearer, fromBody, fromQuery].some((t) => t && sameSecret(t, cfg.hostToken))
  }
  const rejectHost = (res) => fail(res, 401, 'UNAUTHORIZED', 'HOST_TOKEN 缺失或不匹配')

  const rateLimited = (deviceId, ip) => {
    const key = `${deviceId}|${ip}`
    const t = now()
    const hits = (state.rateHits.get(key) ?? []).filter((ts) => t - ts < cfg.rateWindowMs)
    hits.push(t)
    state.rateHits.set(key, hits)
    return hits.length > cfg.rateLimitPerMin
  }

  /** 有活跃 WS 连接即在线；否则问 CP（心跳时间窗 / 墓碑）。 */
  const isOnline = (deviceId) => {
    const conn = state.sockets.get(deviceId)
    if (conn?.isOpen()) return true
    return cp.isDeviceAlive(deviceId, now())
  }

  /**
   * 往一个可能已经断掉的 HTTP 响应上写错误：客户端先断开时 writeHead 会抛
   * `ERR_STREAM_DESTROYED`，在 setTimeout 回调里抛就是未捕获异常，能把进程带走。
   */
  const safeFail = (res, status, code, message, retryable) => {
    try { fail(res, status, code, message, retryable) } catch { /* 对端已断开，无需再写 */ }
  }

  /**
   * Host 连接猝死时，挂在它上面的在途请求永远等不到回帧：立刻判失败，
   * 不让手机空等到超时窗口（默认 10s）才看到 504。
   * 只回收**这一条连接**上的请求——降级轮询通道的条目 conn 为 undefined，不受影响。
   */
  const failPendingOnConn = (conn) => {
    let failed = 0
    for (const [reqId, p] of [...state.pending]) {
      if (p.conn !== conn) continue
      state.pending.delete(reqId)
      clearTimeout(p.timer)
      safeFail(p.res, 409, 'HOST_OFFLINE', 'Host 连接中断，请求未完成', true)
      failed++
    }
    return failed
  }

  /** 手机侧 /d/<id>/<endpoint> 请求 → 帧 → 等待 Host 响应。afterResponse 在响应落地后拿到原始应答（可选）。 */
  const bridge = (req, res, deviceId, endpoint, body, afterResponse = null, transform = null) => {
    const reqId = hex(16)
    const frame = { t: 'http/request', reqId, method: req.method, endpoint, body, sinceSeq: body?.sinceSeq ?? null }
    const conn = state.sockets.get(deviceId)
    if (conn?.isOpen()) {
      conn.sendJson(frame)                 // 正式通道：WS 长连，帧序即流序
    } else {
      const frames = state.queue.get(deviceId) ?? []
      frames.push(frame)                   // 降级通道：HTTP 轮询
      state.queue.set(deviceId, frames)
    }

    const timer = setTimeout(() => {
      const p = state.pending.get(reqId)
      if (!p) return
      state.pending.delete(reqId)
      safeFail(res, 504, 'NO_PROGRESS', '10s 内 Host 未回响应', true)
    }, cfg.requestTimeoutMs)

    state.pending.set(reqId, {
      res,                                 // 连接猝死时用它快速回错误
      conn: conn?.isOpen() ? conn : null,  // 记住这帧发在哪条连接上
      resolve: (raw) => {
        clearTimeout(timer)
        // transform 可把「带字节的 Host 响应」换成「只含票据元数据的手机响应」，
        // 字节留在 Relay 内存里（ADR-011）。没有 transform 时行为与以前完全一致。
        let out = raw
        if (transform) {
          try { out = transform(raw) ?? raw } catch (error) {
            out = { status: 502, body: { ok: false, error: { code: 'BRIDGE_TRANSFORM', message: error?.message ?? 'transform failed', retryable: false }, protocol: PROTOCOL } }
          }
        }
        reply(res, out.status ?? 200, out.body ?? { ok: true, data: {}, protocol: PROTOCOL })
        if (afterResponse) { try { afterResponse(out) } catch { /* 记录失败不影响响应 */ } }
      },
      timer,
    })
  }

  /** 处理 Host 通过 WS 发来的帧。 */
  const handleHostFrame = (deviceId, text, conn) => {
    let msg
    try { msg = JSON.parse(text) } catch { return conn.close(1003, 'invalid json') }
    if (msg.t === 'host/heartbeat') {
      try { cp.heartbeatDevice(deviceId, now()) } catch { /* 已吊销：等下一个请求自然 401 */ }
      return conn.sendJson({ t: 'host/heartbeat/ack', ts: now() })
    }
    if (msg.t === 'host/sessions') {
      const rows = Array.isArray(msg.rows) ? msg.rows : []
      const removedIds = Array.isArray(msg.removedIds) ? msg.removedIds : []
      // mode:'full'（首轮 / 重连后）走全量替换建基线；'diff' 只应用变化
      const r = msg.mode === 'diff'
        ? cp.applySessionDiff(deviceId, rows, removedIds)
        : cp.upsertSessions(deviceId, rows)
      return conn.sendJson({ t: 'host/sessions/ack', count: rows.length, removed: r.removed, mode: msg.mode ?? 'full' })
    }
    if (msg.t === 'http/response') {
      const p = state.pending.get(String(msg.reqId ?? ''))
      if (!p) return conn.sendJson({ t: 'ack', ref: msg.reqId, status: 'rejected' })
      state.pending.delete(String(msg.reqId))
      p.resolve({ status: msg.status ?? 200, body: msg.body ?? {} })
      return conn.sendJson({ t: 'ack', ref: msg.reqId, status: 'accepted' })
    }
    if (msg.t === '$events/request') {
      // 审批请求：存看板 + 推给该设备的所有手机。`expiresAt` 由 Host 给（它才是决定超时的人）。
      const approvalId = String(msg.approvalId ?? '')
      if (!approvalId) return conn.sendJson({ t: 'ack', ref: null, status: 'BAD_EVENT' })
      const payload = {
        t: 'approval/request',
        approvalId,
        sessionId: msg.sessionId ?? null,
        toolName: msg.toolName ?? 'unknown',
        callId: msg.callId ?? null,
        reason: msg.reason ?? null,
        expiresAt: msg.expiresAt ?? null,
      }
      state.approvals.set(approvalId, {
        deviceId, payload, expiresAt: msg.expiresAt ?? null, createdAt: now(),
      })
      const delivered = broadcastToDevice(deviceId, payload)
      return conn.sendJson({ t: 'ack', ref: approvalId, status: 'accepted', delivered })
    }
    if (msg.t === '$events/resolved') {
      // Host 侧先答了 / 超时 / 被 abort：手机上的卡片要撤
      const approvalId = String(msg.approvalId ?? '')
      state.approvals.delete(approvalId)
      const delivered = broadcastToDevice(deviceId, {
        t: 'approval/resolved',
        approvalId,
        outcome: msg.outcome ?? 'cancelled',
        by: msg.by ?? 'host',
      })
      return conn.sendJson({ t: 'ack', ref: approvalId, status: 'accepted', delivered })
    }
    if (msg.t === 'session/event') {
      // 上行事件：按连续 seq 推进并广播给订阅该会话的手机
      const r = state.hub.ingest(String(msg.sessionId ?? ''), msg.ev)
      if (r.rejected) return conn.sendJson({ t: 'ack', ref: msg.sessionId ?? null, status: r.rejected })
      return conn.sendJson({
        t: 'ack', ref: msg.sessionId, status: 'accepted',
        advanced: r.advanced, delivered: r.delivered,
      })
    }
    return conn.sendJson({ t: 'ack', ref: msg.t ?? null, status: 'ignored' })
  }

  const handler = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname
    const method = req.method ?? 'GET'
    const ip = req.socket?.remoteAddress ?? 'unknown'

    // 预检与跨域头：写在分流之前，所有响应（含文件流）都带上
    const origin = req.headers.origin
    if (origin && isAllowedOrigin(origin, cfg)) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Protocol-Version')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS')
      res.setHeader('Access-Control-Allow-Credentials', 'true')
      res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition')
      res.setHeader('Access-Control-Max-Age', '600')
    }
    if (method === 'OPTIONS') {
      // 未获准的 Origin 也回 204 但不给 ACAO：浏览器会自己拦下来
      res.writeHead(204)
      return res.end()
    }

    try {
      if (method === 'GET' && path === '/health') {
        return ok(res, {
          protocol: PROTOCOL,
          // 只数电脑：手机是客户端，混进 online 会让「电脑在线吗」这个问题失去答案
          online: cp.listDevices().filter((d) => d.role !== 'phone' && !d.tombstone && isOnline(d.deviceId)).length,
          sockets: [...state.sockets.entries()].filter(([, c]) => c.isOpen()).length,
        })
      }

      // PC 侧登记配对码（正式设计由 CP 承担，单机开发期由 Relay 兼任）
      if (method === 'POST' && path === '/pair/generate') {
        const body = await readBody(req, cfg.maxBodyBytes)
        if (!body.deviceId) return fail(res, 400, 'PAIR_CODE_INVALID', '缺少 deviceId')
        if (rateLimited(body.deviceId, ip)) return fail(res, 400, 'PAIR_CODE_INVALID', '设备/IP 限速 5 次/分')
        const code = sixDigitCode()
        state.codes.set(code, { deviceId: body.deviceId, expiresAt: now() + cfg.codeTtlMs })
        return ok(res, { code, deviceId: body.deviceId, ttl: cfg.codeTtlMs / 1000 })
      }

      // 手机输码 → 一次性挑战 + #2 per-challenge pairSecret
      if (method === 'POST' && path === '/pair') {
        const body = await readBody(req, cfg.maxBodyBytes)
        const entry = state.codes.get(String(body.code ?? ''))
        if (!entry || entry.expiresAt < now()) return fail(res, 400, 'PAIR_CODE_INVALID', '配对码错误或过期')
        state.codes.delete(String(body.code))
        const challenge = hex(24)
        const pairSecret = hex(16)   // 128 bit，per-challenge，不落盘、不参与令牌派生
        state.challenges.set(challenge, {
          code: String(body.code), deviceId: entry.deviceId, pairSecret,
          expiresAt: now() + cfg.challengeTtlMs,
        })
        return ok(res, { challenge, pairSecret, expiresIn: cfg.challengeTtlMs / 1000, deviceId: entry.deviceId })
      }

      if (method === 'POST' && path === '/pair/verify') {
        const body = await readBody(req, cfg.maxBodyBytes)
        const c = state.challenges.get(String(body.challenge ?? ''))
        if (!c) return fail(res, 400, 'CHALLENGE_EXPIRED', '挑战不存在或已使用')
        state.challenges.delete(String(body.challenge))
        if (c.expiresAt < now()) return fail(res, 400, 'CHALLENGE_EXPIRED', '挑战超过 60s')
        // challenge 是 Map 的键，值里不重复存；用请求里的原始值参与 HMAC
        const expected = createHmac('sha256', c.pairSecret).update(String(body.challenge)).digest('hex')
        if (!safeEqual(String(body.sig ?? ''), expected)) return fail(res, 401, 'UNAUTHORIZED', 'HMAC 校验失败')

        const deviceToken = hex(32)
        // 手机是**独立设备行**（r9）：多台手机各持一枚令牌，同 phoneId 重配只覆盖它自己那枚。
        // 之前令牌直接落在这台 Host 行上，第二台手机配对就会把第一台顶掉。
        const prev = cp.getDevice(c.deviceId)
        if (prev?.tombstone) return fail(res, 401, 'UNAUTHORIZED', '设备已吊销')
        // 配对成功即把 CP 标成在线：这台电脑刚刚生成了配对码，它显然是开着的。
        // 这个「在线」只活到 WS 注册或 45s 心跳窗口结束——之后由真实连接接管。
        cp.upsertDevice({
          deviceId: c.deviceId,
          state: 'online',
          lastSeenAt: now(),
          capabilities: prev?.capabilities ?? [],
        })
        const phoneId = sanitizePhoneId(body.phoneId) ?? `phone-${hex(8)}`
        try {
          cp.upsertPhone({ phoneId, hostId: c.deviceId, label: sanitizeLabel(body.clientName) })
          cp.setPhoneToken(phoneId, deviceToken)
        } catch (e) {
          // CP 的拒绝理由要如实回给手机：「已达上限」「该手机已吊销」与「码不对」是三种处置
          const code = e?.code ?? 'UNAUTHORIZED'
          if (code === 'CLIENT_LIMIT') return fail(res, 409, code, e.message)
          if (code === 'HOST_OFFLINE') return fail(res, 409, code, e.message, true)
          return fail(res, 401, code === 'UNAUTHORIZED' ? 'UNAUTHORIZED' : code, e?.message ?? '配对被拒绝')
        }
        return ok(res, {
          deviceToken,
          deviceId: phoneId,          // 这台手机自己的 ID：续配时回传即可轮换令牌
          hostDeviceId: c.deviceId,   // URL 里的目标是它（/d/<hostDeviceId>/…）
          protocol: PROTOCOL,
          // 回**这台客户端刚刚访问成功的地址**，而不是写死 127.0.0.1：
          // 手机把 127.0.0.1 当成「自己」，拿到它就会 ERR_CONNECTION_REFUSED。
          // Host 头由调用方自己设置，回显给他本人不构成反射面；配了 publicBaseUrl 时以配置为准。
          relayUrl: cfg.publicBaseUrl ?? requestOrigin(req) ?? 'http://127.0.0.1',
        })
      }

      // Host 注册 / 心跳 / 索引（HTTP 降级通道；正式走 WS）
      if (method === 'POST' && path === '/host/register') {
        const body = await readBody(req, cfg.maxBodyBytes)
        if (!hostAuthOk(req, body, url)) return rejectHost(res)
        const prev = cp.getDevice(body.deviceId)
        if (prev?.tombstone) return fail(res, 401, 'UNAUTHORIZED', '设备已吊销')
        // v2.3（r16）：HTTP 降级通道与 WS 注册同一套协商，判定口径完全一致
        const reject = registerIdentityError(cfg, body)
        if (reject) return fail(res, 409, reject.code, reject.message)
        cp.upsertDevice({
          deviceId: body.deviceId,
          state: 'online',
          lastSeenAt: now(),
          capabilities: body.caps ?? [],
          ...(typeof body.deviceName === 'string' && body.deviceName.trim()
            ? { deviceName: body.deviceName.trim().slice(0, 60) } : {}),
          ...(typeof body.platform === 'string' && body.platform.trim()
            ? { platform: body.platform.trim().slice(0, 20) } : {}),
          // v2.3：主机标识正式名称；缺省回落 deviceId（命名迁移第一步，值兼容）
          ...(typeof body.hostId === 'string' && body.hostId.trim()
            ? { hostId: body.hostId.trim().slice(0, 64) } : {}),
          // v2.3（r16）：引擎基线与状态声明，落库展示 + safe-mode 503 判定
          ...(typeof body.dshCommit === 'string' && body.dshCommit.trim()
            ? { dshCommit: body.dshCommit.trim().slice(0, 64) } : {}),
          ...(typeof body.engineState === 'string' && body.engineState.trim()
            ? { engineState: body.engineState.trim().slice(0, 32) } : {}),
        })
        return ok(res, { deviceId: body.deviceId, protocol: PROTOCOL })
      }
      if (method === 'POST' && path === '/host/heartbeat') {
        const body = await readBody(req, cfg.maxBodyBytes)
        if (!hostAuthOk(req, body, url)) return rejectHost(res)
        try {
          const d = cp.heartbeatDevice(body.deviceId, now())
          return ok(res, { deviceId: d.deviceId, lastSeenAt: d.lastSeenAt })
        } catch {
          return fail(res, 409, 'HOST_OFFLINE', '设备未注册或已吊销', true)
        }
      }
      if (method === 'POST' && path === '/host/sessions') {
        const body = await readBody(req, cfg.maxBodyBytes)
        if (!hostAuthOk(req, body, url)) return rejectHost(res)
        const d = cp.getDevice(body.deviceId)
        if (!d || d.tombstone) return fail(res, 409, 'HOST_OFFLINE', '设备未注册或已吊销', true)
        const rows = body.rows ?? []
        const r = body.mode === 'diff'
          ? cp.applySessionDiff(body.deviceId, rows, body.removedIds ?? [])
          : cp.upsertSessions(body.deviceId, rows)
        return ok(res, { count: r.upserted, removed: r.removed, mode: body.mode ?? 'full' })
      }
      if (method === 'GET' && path === '/host/indexes') {
        // 开发降级通道，但**不能永远裸奔**：配置了 adminToken 就要求 Bearer。
        // 手机侧正式入口是下面的 GET /api/sessions（设备令牌鉴权）。
        if (cfg.adminToken && req.headers.authorization !== `Bearer ${cfg.adminToken}`) {
          return fail(res, 401, 'UNAUTHORIZED', 'admin token 缺失')
        }
        const deviceId = url.searchParams.get('hostId') ?? url.searchParams.get('deviceId') ?? ''
        return ok(res, { deviceId, rows: cp.listSessions({ hostId: deviceId }) })
      }

      // 手机侧待审批清单（审批是设备级的，与当前看哪个会话无关）。
      // 手机断线期间错过的审批靠这条补回来——推送只是「更快」，拉取才是「不漏」。
      // v2.3（P2 · S-6.8/S-6.9 数据源）：主机档案列表。
      // 手机（设备令牌）只看到自己绑定的那台主机；adminToken 看到全部非墓碑主机。
      // kind 恒为 'relay'——CP 视角里所有注册主机都经 Relay 接入；on-device / ssh
      // 档案直连各自的 dsh web，不经 CP，此处如实不列（S-2.2 模型的单机实现）。
      if (method === 'GET' && path === '/api/hosts') {
        const auth = String(req.headers.authorization ?? '')
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
        const isAdmin = Boolean(cfg.adminToken) && Boolean(token) && sameSecret(token, cfg.adminToken)
        let scope = null
        if (!isAdmin) {
          const owner = cp.findPhoneByToken(token)
          if (!owner?.boundHostId) {
            return fail(res, 401, 'UNAUTHORIZED', '令牌缺失、失效或已吊销')
          }
          scope = owner.boundHostId
        }
        const rows = cp.listDevices()
          .filter((d) => d.role === 'host' && !d.tombstone)
          .filter((d) => scope === null || d.deviceId === scope)
          .map((d) => ({
            hostId: d.hostId ?? d.deviceId,
            deviceId: d.deviceId,          // 旧客户端兼容字段；值 = hostId（命名迁移期并存）
            kind: 'relay',
            name: d.deviceName ?? null,
            platform: d.platform ?? null,
            dshCommit: d.dshCommit ?? null,
            engineState: d.engineState ?? null,
            online: isOnline(d.deviceId),
            state: d.state ?? null,
            lastSeenAt: d.lastSeenAt ?? null,
            sessionCount: cp.listSessions({ hostId: d.deviceId, archived: null }).length,
            phones: cp.listPhones(d.deviceId)
              .filter((p) => !p.tombstone)
              .map((p) => ({
                deviceId: p.deviceId,
                name: p.deviceName ?? null,
                online: isOnline(p.deviceId),
                lastSeenAt: p.lastSeenAt ?? null,
              })),
          }))
        return ok(res, { rows })
      }

      if (method === 'GET' && path === '/api/approvals') {
        const deviceId = url.searchParams.get('hostId') ?? url.searchParams.get('deviceId') ?? ''
        const auth = String(req.headers.authorization ?? '')
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
        if (!cp.verifyClientToken(deviceId, token).ok) {
          return fail(res, 401, 'UNAUTHORIZED', '令牌缺失、失效或已吊销')
        }
        sweepApprovals(deviceId)
        const rows = [...state.approvals.values()]
          .filter((r) => r.deviceId === deviceId)
          .map((r) => r.payload)
        return ok(res, { deviceId, rows })
      }

      // 手机侧会话列表（协议 §4 CP API 的 W3 单机实现）。
      // CP 目前是 Relay 进程内的库对象，所以由 Relay 代挂 /api/*；P2 CP 独立成
      // 服务时这条路由整体迁走，客户端 URL 不变。
      if (method === 'GET' && path === '/api/sessions') {
        // v2.3（P2 命名迁移第三步）：查询参数以 hostId 为正式名，deviceId= 继续接受
        // （同一台主机的同一枚值，旧客户端零改动）。
        const deviceId = url.searchParams.get('hostId') ?? url.searchParams.get('deviceId') ?? ''
        const auth = String(req.headers.authorization ?? '')
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
        if (!cp.verifyClientToken(deviceId, token).ok) {
          return fail(res, 401, 'UNAUTHORIZED', '令牌缺失、失效或已吊销')
        }
        const rawPinned = url.searchParams.get('pinned')
        const pinned = rawPinned === null ? null : rawPinned === 'true'
        // r12：archived=true 只回已归档（恢复列表用），缺省 false 只回未归档
        const archived = url.searchParams.get('archived') === 'true'
        const host = cp.getDevice(deviceId)
        return ok(res, {
          deviceId,
          hostId: host?.hostId ?? deviceId,   // v2.3：主机标识正式名（值兼容 deviceId）
          // 状态点（W7）：手机切到这台电脑时就能知道它连没连上，不必再单独打一次 /health，
          // 也避免了「先显示在线、再弹 HOST_OFFLINE」这种自相矛盾的界面。
          host: {
            deviceId,
            hostId: host?.hostId ?? deviceId,
            name: host?.deviceName ?? null,
            platform: host?.platform ?? null,
            online: isOnline(deviceId),
            lastSeenAt: host?.lastSeenAt ?? null,
          },
          rows: cp.listSessions({ hostId: deviceId, pinned, archived }),
        })
      }

      // 手机侧新建会话（协议 §4：目标 Host 离线时 HOST_OFFLINE，入口置灰）。
      // 桥接白名单内的 session/create → Host 的 createSession 适配器（接宿主
      // 新建会话入口）；Host 未注入适配器时 409 透传，Relay 不代造会话。
      if (method === 'POST' && path === '/api/sessions') {
        const auth = String(req.headers.authorization ?? '')
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
        const body = await readBody(req, cfg.maxBodyBytes)
        const deviceId = body.hostId ?? body.deviceId
          ?? url.searchParams.get('hostId') ?? url.searchParams.get('deviceId') ?? ''
        if (!cp.verifyClientToken(deviceId, token).ok) {
          return fail(res, 401, 'UNAUTHORIZED', '令牌缺失、失效或已吊销')
        }
        if (!isOnline(deviceId)) {
          cp.markDeviceOffline(deviceId)
          return fail(res, 409, 'HOST_OFFLINE', '目标 Host 离线', true)
        }
        return bridge(req, res, deviceId, 'session/create', {
          clientId: body.clientId ?? 'pwa',
          text: typeof body.text === 'string' ? body.text : '',
          cwd: body.cwd ?? null,
        }, (response) => {
          // 创建成功即把会话写进 CP 索引，手机不用等 Host 下一个 60s 刷新周期。
          // 这里是**启动引导值**（同 sessions.js 的口径）：state/lastSeq 以 Host
          // 下一次全量上报为准，全量快照会校正本行。
          const data = response?.body?.data
          if (response.status !== 200 || !data?.sessionId) return
          const row = data.index && typeof data.index === 'object'
            ? { ...data.index, sessionId: data.sessionId }
            : { sessionId: data.sessionId, state: 'awaiting', title: data.title ?? null, lastActiveAt: now() }
          // 单行合并：upsertSessions 是全量快照语义，传单行会把该设备其余会话
          // 全部删掉（真机 0.1.5 取证：手机列表闪一下只剩新会话）。
          cp.putSession(deviceId, row)
        })
      }

      // 定时任务遥控（W9）：手机只经 Relay 转发，参数形状由 Host 的 ScheduleCreateRequest 定。
      // 创建是**写操作**，所以必须走白名单内的 session/* 下行，Relay 不代造任务。
      if ((method === 'GET' || method === 'POST') && path === '/api/schedules') {
        const auth = String(req.headers.authorization ?? '')
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
        const body = method === 'POST' ? await readBody(req, cfg.maxBodyBytes) : {}
        const deviceId = body.hostId ?? body.deviceId
          ?? url.searchParams.get('hostId') ?? url.searchParams.get('deviceId') ?? ''
        if (!cp.verifyClientToken(deviceId, token).ok) {
          return fail(res, 401, 'UNAUTHORIZED', '令牌缺失、失效或已吊销')
        }
        if (!isOnline(deviceId)) {
          cp.markDeviceOffline(deviceId)
          return fail(res, 409, 'HOST_OFFLINE', '目标 Host 离线', true)
        }
        if (method === 'GET') {
          return bridge(req, res, deviceId, 'session/schedule-list', {
            limit: Number(url.searchParams.get('limit')) || 100,
            offset: Number(url.searchParams.get('offset')) || 0,
          })
        }
        return bridge(req, res, deviceId, 'session/schedule-create', {
          title: body.title, prompt: body.prompt,
          afterSeconds: body.afterSeconds, target: body.target ?? null,
        })
      }

      if (method === 'POST' && /^\/api\/schedules\/[^/]+\/run$/.test(path)) {
        const id = decodeURIComponent(path.slice('/api/schedules/'.length, -'/run'.length))
        const auth = String(req.headers.authorization ?? '')
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
        const body = await readBody(req, cfg.maxBodyBytes)
        const deviceId = body.hostId ?? body.deviceId
          ?? url.searchParams.get('hostId') ?? url.searchParams.get('deviceId') ?? ''
        if (!cp.verifyClientToken(deviceId, token).ok) {
          return fail(res, 401, 'UNAUTHORIZED', '令牌缺失、失效或已吊销')
        }
        if (!isOnline(deviceId)) {
          cp.markDeviceOffline(deviceId)
          return fail(res, 409, 'HOST_OFFLINE', '目标 Host 离线', true)
        }
        return bridge(req, res, deviceId, 'session/schedule-run', { id })
      }

      // 置顶（r11）/ 归档（r12）/ 改名（M2-10）：PATCH /api/sessions/:id 三选一
      // DELETE /api/sessions/:id = 归档（软移除别名，协议 §4 的「移除工作空间」）。
      // 为什么不真删：手机误点的代价应该只是「从列表消失、能一键恢复」，
      // 而不是把宿主落盘日志删掉。归档集合由宿主权威，Relay 照它刷新 CP。
      if ((method === 'PATCH' || method === 'DELETE') && path.startsWith('/api/sessions/')) {
        const sessionId = decodeURIComponent(path.slice('/api/sessions/'.length))
        const auth = String(req.headers.authorization ?? '')
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
        const body = await readBody(req, cfg.maxBodyBytes)
        const deviceId = body.hostId ?? body.deviceId
          ?? url.searchParams.get('hostId') ?? url.searchParams.get('deviceId') ?? ''
        if (!cp.verifyClientToken(deviceId, token).ok) {
          return fail(res, 401, 'UNAUTHORIZED', '令牌缺失、失效或已吊销')
        }
        const wantPin = body.pinned === true || body.pinned === false
        const wantArchive = method === 'DELETE' || body.archived === true || body.archived === false
        const wantRename = typeof body.title === 'string' && body.title.trim().length > 0
        const intents = [wantPin, wantArchive, wantRename].filter(Boolean).length
        if (intents === 0) {
          return fail(res, 400, 'INVALID_JSON', 'PATCH 需要 { pinned } / { archived } / { title } 之一')
        }
        if (intents > 1) {
          return fail(res, 400, 'INVALID_JSON', '一次只做一件事：pinned / archived / title 不能同时给')
        }
        if (!isOnline(deviceId)) {
          cp.markDeviceOffline(deviceId)
          return fail(res, 409, 'HOST_OFFLINE', '目标 Host 离线', true)
        }
        const archived = method === 'DELETE' ? true : body.archived
        const endpoint = wantArchive ? 'session/archive'
          : wantRename ? 'session/rename' : 'session/pin'
        const frameBody = wantArchive
          ? { sessionId, archived }
          : wantRename ? { sessionId, title: body.title.trim() }
            : { sessionId, pinned: body.pinned }
        return bridge(req, res, deviceId, endpoint, frameBody, (response) => {
          if (response?.status !== 200) return
          if (wantRename) {
            // 标题由宿主权威（它写了标题事件），这里只同步 CP 索引供手机显示
            const title = response?.body?.data?.title
            if (typeof title === 'string') cp.patchSession(deviceId, sessionId, { title })
            return
          }
          if (wantArchive) {
            const ids = response?.body?.data?.archivedSessionIds
            cp.patchSession(deviceId, sessionId, {
              archived: Array.isArray(ids) ? ids.includes(sessionId) : Boolean(archived),
            })
            return
          }
          // 宿主回的是**全局**置顶集合（最近置顶在前）：照它刷新 pinnedOrder，
          // 不用「本地翻转布尔」去猜——别的端（PC）也可能改过。
          const ids = response?.body?.data?.pinnedSessionIds
          if (Array.isArray(ids)) {
            const idx = ids.indexOf(sessionId)
            cp.patchSession(deviceId, sessionId, { pinned: idx !== -1, pinnedOrder: idx === -1 ? 0 : idx })
          } else {
            cp.patchSession(deviceId, sessionId, { pinned: body.pinned })
          }
        })
      }

      // 产物导出（ADR-011）：显式点「下载」才走，字节只在 Relay 内存中转一次。
      // Host 校验「已呈现 + 工作区内 + 体积」，Relay 把字节换成一次性票据。
      const TICKET_MAX_BYTES = 512 * 1024
      const TICKET_TTL_MS = 60_000
      if (method === 'POST' && path === '/api/artifacts/ticket') {
        const auth = String(req.headers.authorization ?? '')
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
        const body = await readBody(req, cfg.maxBodyBytes)
        const deviceId = body.hostId ?? body.deviceId
          ?? url.searchParams.get('hostId') ?? url.searchParams.get('deviceId') ?? ''
        if (!cp.verifyClientToken(deviceId, token).ok) {
          return fail(res, 401, 'UNAUTHORIZED', '令牌缺失、失效或已吊销')
        }
        if (!body.sessionId || typeof body.path !== 'string' || !body.path.trim()) {
          return fail(res, 400, 'INVALID_ARGUMENT', '需要 { sessionId, path }')
        }
        // format 只认 'pdf'：宿主只做 Office→PDF。给别的值就明确拒绝，
        // 不然「要 docx」会被静默当原样下载，用户拿到的东西和意图不一样。
        if (body.format !== undefined && body.format !== 'pdf') {
          return fail(res, 400, 'INVALID_ARGUMENT', 'format 只支持 pdf（宿主只做 Office → PDF）')
        }
        if (!isOnline(deviceId)) {
          cp.markDeviceOffline(deviceId)
          return fail(res, 409, 'HOST_OFFLINE', '目标 Host 离线', true)
        }
        const ticketId = hex(16)
        const tokenDigest = createHash('sha256').update(token).digest('hex')
        return bridge(req, res, deviceId, 'session/artifact-ticket', {
          sessionId: body.sessionId, path: body.path,
          ...(body.format === 'pdf' ? { format: 'pdf' } : {}),
        }, null, (response) => {
          if (response?.status !== 200) return response
          const d = response.body?.data
          if (!d || typeof d.bytes !== 'string') {
            return { status: 502, body: { ok: false, error: { code: 'TICKET_FAILED', message: 'Host 未返回文件字节', retryable: false }, protocol: PROTOCOL } }
          }
          const bytes = Buffer.from(d.bytes, 'base64')
          if (!bytes.length || bytes.length > TICKET_MAX_BYTES) {
            return { status: 413, body: { ok: false, error: { code: 'ARTIFACT_TOO_LARGE', message: '文件超出下载上限，请在电脑上打开', retryable: false }, protocol: PROTOCOL } }
          }
          const name = String(d.name ?? 'artifact').slice(0, 120)
          const mime = String(d.mime ?? 'application/octet-stream')
          state.downloads.set(ticketId, {
            bytes, name, mime, deviceId, tokenDigest,
            expiresAt: now() + TICKET_TTL_MS,
          })
          return {
            status: 200,
            body: {
              ok: true,
              data: {
                ticketId, name, mime, size: bytes.length,
                expiresIn: Math.floor(TICKET_TTL_MS / 1000),
                // 转换来源要透出来：手机得能说清「这份 PDF 是转的」，别让人以为是原件
                ...(typeof d.convertedFrom === 'string' ? { convertedFrom: d.convertedFrom.slice(0, 120) } : {}),
              },
              protocol: PROTOCOL,
            },
          }
        })
      }

      // 换票：**单次使用**、TTL、绑定手机令牌；字节不写盘、不缓存、不进事件流。
      if (method === 'GET' && path.startsWith('/api/artifacts/download/')) {
        const ticketId = decodeURIComponent(path.slice('/api/artifacts/download/'.length))
        for (const [k, v] of state.downloads) if (v.expiresAt <= now()) state.downloads.delete(k)
        const t = state.downloads.get(ticketId)
        if (!t) return fail(res, 410, 'TICKET_GONE', '票据不存在或已过期')
        state.downloads.delete(ticketId)
        const auth = String(req.headers.authorization ?? '')
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
        if (createHash('sha256').update(token).digest('hex') !== t.tokenDigest
          || !cp.verifyClientToken(t.deviceId, token).ok) {
          return fail(res, 401, 'UNAUTHORIZED', '票据不属于这台手机')
        }
        res.writeHead(200, {
          'Content-Type': t.mime,
          'Content-Length': t.bytes.length,
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(t.name)}`,
          'Cache-Control': 'no-store',
          'X-Protocol-Version': PROTOCOL,
        })
        return res.end(t.bytes)
      }

      // 降级通道：轮询取帧 / 回响应
      if (method === 'GET' && path === '/host/poll') {
        if (!hostAuthOk(req, null, url)) return rejectHost(res)
        const deviceId = url.searchParams.get('deviceId') ?? ''
        const frames = state.queue.get(deviceId) ?? []
        state.queue.set(deviceId, [])
        return ok(res, { frames })
      }
      if (method === 'POST' && path === '/host/respond') {
        const body = await readBody(req, cfg.maxBodyBytes)
        if (!hostAuthOk(req, body, url)) return rejectHost(res)
        const p = state.pending.get(String(body.reqId ?? ''))
        if (!p) return fail(res, 409, 'NO_PROGRESS', '请求已超时或不存在', true)
        state.pending.delete(String(body.reqId))
        p.resolve({ status: body.status ?? 200, body: body.body ?? {} })
        return ok(res, { accepted: true })
      }

      // 管理台（只读设备总览；手机作为各自 Host 的子项列出）
      if (method === 'GET' && path === '/admin') {
        if (cfg.adminToken && req.headers.authorization !== `Bearer ${cfg.adminToken}`) {
          return fail(res, 401, 'UNAUTHORIZED', 'admin token 缺失')
        }
        const rows = cp.listDevices()
          .filter((d) => d.role !== 'phone')
          .map((d) => ({
            deviceId: d.deviceId,
            role: d.role ?? 'host',
            state: isOnline(d.deviceId) ? 'online' : 'offline',
            lastSeenAt: d.lastSeenAt,
            tokenDigest: d.tokenDigest,
            tombstone: d.tombstone,
            transport: state.sockets.get(d.deviceId)?.isOpen() ? 'ws' : 'http-poll',
            phones: cp.listPhones(d.deviceId).map((p) => ({
              deviceId: p.deviceId,
              label: p.deviceName,
              lastSeenAt: p.lastSeenAt,
              tokenDigest: p.tokenDigest,
            })),
          }))
        return ok(res, { rows })
      }

      // PC 侧主动吊销（写操作）：未配置 adminToken 时明确拒绝，不接受裸奔
      if (method === 'POST' && path === '/admin/revoke') {
        if (!cfg.adminToken) {
          return fail(res, 409, 'ENDPOINT_NOT_ALLOWED', '未配置 WBSYNC_ADMIN_TOKEN，吊销入口不可用')
        }
        if (req.headers.authorization !== `Bearer ${cfg.adminToken}`) {
          return fail(res, 401, 'UNAUTHORIZED', 'admin token 缺失')
        }
        const body = await readBody(req, cfg.maxBodyBytes)
        if (!body.deviceId) return fail(res, 400, 'INVALID_JSON', '缺少 deviceId')
        const id = String(body.deviceId)
        const d = cp.revokeDevice(id)
        if (!d) return fail(res, 404, 'HOST_OFFLINE', '设备不存在')
        // 现有 WS 立刻断开，避免吊销后旧连接继续收事件
        try { state.sockets.get(id)?.close?.() } catch { /* 已断开 */ }
        // 手机长连挂在 Host 名下，Host 吊销后一并断掉（CP 已把它们标墓碑，这里是断连）
        for (const conn of [...(state.phoneConns.get(id) ?? [])]) {
          try { conn.close?.(1008, 'device revoked') } catch { /* 已断开 */ }
        }
        return ok(res, { deviceId: d.deviceId, tombstone: d.tombstone, state: d.state })
      }

      // 单独收回一台手机（r9）：电脑与其它手机不受影响
      if (method === 'POST' && path === '/admin/revoke-client') {
        if (!cfg.adminToken) {
          return fail(res, 409, 'ENDPOINT_NOT_ALLOWED', '未配置 WBSYNC_ADMIN_TOKEN，收回入口不可用')
        }
        if (req.headers.authorization !== `Bearer ${cfg.adminToken}`) {
          return fail(res, 401, 'UNAUTHORIZED', 'admin token 缺失')
        }
        const body = await readBody(req, cfg.maxBodyBytes)
        const deviceId = String(body.deviceId ?? '')
        const clientId = String(body.clientId ?? '')
        if (!deviceId || !clientId) return fail(res, 400, 'INVALID_JSON', '缺少 deviceId / clientId')
        const phone = cp.getDevice(clientId)
        // 「这台手机不在那台电脑名下」和「手机不存在」对外同形：不给枚举探测留缝
        if (!phone || phone.role !== 'phone' || phone.boundHostId !== deviceId) {
          return fail(res, 404, 'HOST_OFFLINE', '该设备名下没有这台手机')
        }
        const r = cp.revokePhone(clientId)
        closePhoneClient(deviceId, clientId)
        return ok(res, { deviceId, clientId, tombstone: Boolean(r?.tombstone) })
      }

      // PC 侧管理页：同源 HTML，不走 PWA 的 Service Worker
      if (method === 'GET' && (path === '/admin/ui' || path === '/admin/ui/')) {
        const body = Buffer.from(ADMIN_UI_HTML, 'utf8')
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': body.length,   // 中文必须按字节算，不能用字符串长度
          'Cache-Control': 'no-cache',
          'X-Protocol-Version': PROTOCOL,
        })
        return res.end(body)
      }

      // PWA 壳：/app → p1/pwa/public，/src → p1/pwa/src（页面里 `../src/client.js`
      // 从 /app/ 解析为 /src/client.js）。无鉴权静态（PWA 必需，docs/04）；
      // 业务数据仍全走鉴权端点。
      if (method === 'GET' && (path === '/app' || path.startsWith('/app/'))) {
        return sendStatic(res, readStaticFile(staticRoots?.publicRoot, path.replace(/^\/app\/?/, '')))
      }
      if (method === 'GET' && path.startsWith('/src/')) {
        return sendStatic(res, readStaticFile(staticRoots?.srcRoot, path.replace(/^\/src\//, '')))
      }

      // 手机侧端点：/d/<hostId>/<endpoint>
      // v2.3（r16）：路径段语义改为 **hostId**（主机标识正式名，命名迁移第二步）；
      // 值与 deviceId 完全兼容（同一台主机），旧客户端 URL 不用改。CP 存储字段
      // 仍叫 deviceId，随 P2 CP Postgres 迁移再改名——存储命名不动是为了不与
      // 数据模型变更加在一起滚雪球。
      const m = /^\/d\/([^/]+)\/(.+)$/.exec(path)
      if (m) {
        const [, hostId, rawEndpoint] = m
        const auth = String(req.headers.authorization ?? '')
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
        // hostId 是**目标 Host**，令牌属于某台已配对的手机 —— 两者不是同一个身份
        const caller = cp.verifyClientToken(hostId, token)
        if (!caller.ok) {
          return fail(res, 401, 'UNAUTHORIZED', '令牌缺失、失效或已吊销')
        }
        // 先解码再判白名单：直接拿原始（可能带 %2F / ..）的串做前缀匹配，
        // 等于把 `session/..%2Fadmin%2Frevoke` 放行给 Host 自己解。
        const endpoint = normalizeEndpoint(rawEndpoint)
        if (endpoint === null) {
          return fail(res, 403, 'ENDPOINT_NOT_ALLOWED', '端点包含穿越或多重编码')
        }
        if (!isAllowed(endpoint, allowlist)) {
          return fail(res, 403, 'ENDPOINT_NOT_ALLOWED', `端点不在白名单：${endpoint}`)
        }
        if (!isOnline(hostId)) {
          cp.markDeviceOffline(hostId)
          return fail(res, 409, 'HOST_OFFLINE', '目标 Host 离线', true)
        }
        // v2.3（r16）：主机自报引擎处于安全模式 → 一律 503，不把请求投给一个跑不了的
        // 引擎（真 Host 会在注册帧里如实声明；未声明该字段的旧主机行为不变）。
        if (cp.getDevice(hostId)?.engineState === 'safe-mode') {
          return fail(res, 503, 'ENGINE_SAFE_MODE', '本机引擎处于安全模式，插件未加载', true)
        }
        let body = {}
        try { body = await readBody(req, cfg.maxBodyBytes) } catch (e) {
          return fail(res, 400, 'INVALID_JSON', String(e.message))
        }
        // #5b：客户端 sinceSeq 只作观测记录，服务端不据此替客户端决定补齐起点。
        // Cursor 的主键是 (clientId, sessionId)：拿不到 sessionId 就不记，
        // 不用 endpoint 或 hostId 冒充会话键（那会让位点落到错误的行上）。
        // clientId 优先取**鉴权结果**里的手机身份：body 里那个是客户端自报的，
        // 谁都能填，用它记位点等于允许别人改写你的进度。
        if (typeof body.sinceSeq === 'number' && body.sessionId) {
          cp.putCursor({
            clientId: caller.clientId ?? body.clientId ?? 'anonymous',
            hostId,
            sessionId: body.sessionId,
            sinceSeq: body.sinceSeq,
          })
        }
        // 审批应答：先答先得。已在别处应答/过期的一律 409，不再占用 Host 一个往返。
        if (endpoint === '$events/result') {
          const approvalId = String(body?.approvalId ?? '')
          sweepApprovals(hostId)
          if (!approvalId || !state.approvals.has(approvalId)) {
            return fail(res, 409, 'APPROVAL_GONE', '该审批已被应答或已过期', false)
          }
          return bridge(req, res, hostId, endpoint, body, (response) => {
            if (response?.status !== 200) return
            state.approvals.delete(approvalId)
            broadcastToDevice(hostId, {
              t: 'approval/resolved',
              approvalId,
              outcome: body?.outcome ?? 'cancelled',
              by: 'phone',
            })
          })
        }
        return bridge(req, res, hostId, endpoint, body)
      }

      return fail(res, 404, 'ENDPOINT_NOT_ALLOWED', `未知路径：${path}`)
    } catch (error) {
      const code = String(error?.message ?? '')
      if (code === 'BODY_TOO_LARGE') return fail(res, 413, 'INVALID_JSON', '请求体超过 1 MiB')
      if (code === 'INVALID_JSON') return fail(res, 400, 'INVALID_JSON', '请求体不是合法 JSON')
      // 开发期把真实异常打到 stderr，避免通用 500 把根因吞掉
      console.error('[relay] 未处理异常', error)
      return fail(res, 500, 'NO_PROGRESS', '内部错误', true)
    }
  }

  const server = createServer(handler)

  // 两条 upgrade 通道：Host 注册长连、手机事件订阅
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost')

    // 手机侧事件订阅：/d/<hostId>/events/<sessionId>?token=&sinceSeq=
    // v2.3（r16）：路径段语义与 HTTP /d/ 同步改为 hostId（值兼容 deviceId）。
    // 浏览器 WebSocket 不能设 Authorization 头，所以令牌走 query；不得把它写进日志。
    const sub = /^\/d\/([^/]+)\/events\/([^/]+)$/.exec(url.pathname)
    if (sub) {
      const [, hostId, sessionId] = sub
      const token = url.searchParams.get('token') ?? ''
      const caller = cp.verifyClientToken(hostId, token)
      if (!caller.ok) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n')
        return
      }
      if (!isOnline(hostId)) {
        socket.end('HTTP/1.1 409 Conflict\r\nContent-Length: 0\r\n\r\n')
        return
      }
      // v2.3（r16）：安全模式主机不接受事件订阅，与 HTTP /d/ 的 503 判定同源。
      if (cp.getDevice(hostId)?.engineState === 'safe-mode') {
        socket.end('HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n')
        return
      }
      const rawSince = url.searchParams.get('sinceSeq')
      const sinceSeq = rawSince === null ? -1 : Number(rawSince)
      let conn = null
      conn = upgradeToWebSocket(req, socket, head, {
        onMessage() { /* 手机侧只订阅；上行指令仍走 HTTP（白名单见 04 §7） */ },
        onClose() {
          if (!conn) return
          state.hub.unsubscribe(conn)
          untrackPhoneConn(hostId, conn)   // 审批通知要发到这台设备的所有手机连接
        },
      }, { maxPayload: cfg.maxFrameBytes })
      if (!conn) { socket.destroy(); return }
      // 记住是哪台手机连的：按手机吊销时要把它的长连一起断掉，
      // 否则「吊销」只挡住了新请求，旧连接还能继续收事件。
      conn.clientId = caller.clientId
      trackPhoneConn(hostId, conn)
      state.hub.subscribe(sessionId, Number.isInteger(sinceSeq) ? sinceSeq : -1, conn)
      return
    }

    // Host 主动长连：/ws/host → 注册帧 → 帧保序双向透传
    if (url.pathname !== '/ws/host') { socket.destroy(); return }

    let deviceId = null
    let registerTimer = null
    const conn = upgradeToWebSocket(req, socket, head, {
      onMessage(text) {
        if (deviceId === null) {
          let msg
          try { msg = JSON.parse(text) } catch { return conn.close(1003, 'invalid json') }
          if (msg.t !== 'host/register') return conn.close(1008, 'register first')
          if (cfg.hostToken && msg.hostToken !== cfg.hostToken) return conn.close(1008, 'bad host token')
          if (!msg.deviceId) return conn.close(1008, 'deviceId required')
          // v2.3（r16）：注册协商——协议不符 HOST_MISMATCH、基线漂移 COMMIT_DRIFT，
          // 都发生在落库之前：被拒的注册帧不会留下任何设备行或在线状态。
          const reject = registerIdentityError(cfg, msg)
          if (reject) return conn.close(1008, `${reject.code}: ${reject.detail}`.slice(0, 123))
          deviceId = String(msg.deviceId)
          if (registerTimer) { clearTimeout(registerTimer); registerTimer = null }
          const prev = cp.getDevice(deviceId)
          if (prev?.tombstone) return conn.close(1008, 'device revoked')
          state.sockets.set(deviceId, conn)
          cp.upsertDevice({
            deviceId,
            state: 'online',
            lastSeenAt: now(),
            capabilities: msg.caps ?? [],
            // 手机端切换电脑时要认得出来（r10 的 host.name 就取这个）
            ...(typeof msg.deviceName === 'string' && msg.deviceName.trim()
              ? { deviceName: msg.deviceName.trim().slice(0, 60) } : {}),
            ...(typeof msg.platform === 'string' && msg.platform.trim()
              ? { platform: msg.platform.trim().slice(0, 20) } : {}),
            // v2.3：hostId 缺省回落 deviceId；值兼容，命名语义见 PROTOCOL 变更记录
            ...(typeof msg.hostId === 'string' && msg.hostId.trim()
              ? { hostId: msg.hostId.trim().slice(0, 64) } : {}),
            // v2.3（r16）：引擎基线与状态声明清空即回落旧值（展示 + safe-mode 503 判定）
            ...(typeof msg.dshCommit === 'string' && msg.dshCommit.trim()
              ? { dshCommit: msg.dshCommit.trim().slice(0, 64) } : {}),
            ...(typeof msg.engineState === 'string' && msg.engineState.trim()
              ? { engineState: msg.engineState.trim().slice(0, 32) } : {}),
          })
          conn.sendJson({ t: 'host/registered', deviceId, protocol: PROTOCOL })
          // 时序窗口：配对 / 心跳先把 CP 标成在线，但 WS 还没注册时，bridge 会把
          // 下行帧投进降级轮询队列；而 Host 只走 WS，帧会躺到 10s 超时 → 504。
          // 注册完成后把积压帧转交给新 WS（纯轮询 Host 永不注册 WS，不受影响）。
          const queued = state.queue.get(deviceId) ?? []
          if (queued.length) {
            state.queue.delete(deviceId)
            for (const frame of queued) conn.sendJson(frame)
          }
          return
        }
        return handleHostFrame(deviceId, text, conn)
      },
      onClose() {
        if (registerTimer) { clearTimeout(registerTimer); registerTimer = null }
        if (deviceId === null) return
        // 发在这条连接上的在途帧已经不可能有回音（Host 换了新连接也认不出旧 reqId），
        // 先就地判失败，再摘连接——顺序不能反，反了就先丢 socket 再没人认领这些请求。
        failPendingOnConn(conn)
        if (state.sockets.get(deviceId) === conn) state.sockets.delete(deviceId)
        // WS 断开即视为离线，不等 45s 心跳窗口；HTTP 心跳可把状态再拉回 online
        cp.markDeviceOffline(deviceId)
      },
    }, { maxPayload: cfg.maxFrameBytes })
    if (!conn) return socket.destroy()

    // 升级请求本身**不带凭据**（令牌在 register 帧里才校验），所以必须给
    // 「连上但从不发注册帧」留一条硬截止：否则空连接可无限堆积、占满 fd。
    if (cfg.registerTimeoutMs > 0) {
      registerTimer = setTimeout(() => {
        if (deviceId === null) conn.close(1008, 'register timeout')
      }, cfg.registerTimeoutMs)
      registerTimer.unref?.()
    }
    return undefined
  })

  const start = (port = 0, host = '127.0.0.1') => new Promise((resolve, reject) => {
    // 默认只听本机回环（单测/本机调试）；真机联调用 start(port, '0.0.0.0') 或 run.mjs
    server.listen(port, host, () => resolve(server.address().port))
    server.once('error', reject)
  })
  const stop = () => new Promise((resolve) => {
    for (const p of state.pending.values()) clearTimeout(p.timer)
    state.pending.clear()
    state.hub.closeAll()                                    // 手机订阅连接
    for (const conn of state.sockets.values()) conn.close(1001, 'server stopping')
    state.sockets.clear()
    const timer = setTimeout(() => resolve(), 2000)         // 兜底：不被残留连接挂死
    server.closeAllConnections?.()
    server.close(() => { clearTimeout(timer); resolve() })
  })

  return { server, state, cp, start, stop, protocol: PROTOCOL, allowedEndpoints: allowlist, isOnline }
}
