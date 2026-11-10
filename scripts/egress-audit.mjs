#!/usr/bin/env node
/**
 * 出网审计（P3 W10 前置 · 静态半边）
 * ---------------------------------------------------------------
 * GA 门禁要求「除自托管 Relay 外无第三方出网」。本脚本只做**静态半边**：
 * 扫描 `p1/` 的运行代码，提取所有 `http(s)://` / `ws(s)://` 字面量并按归属分类，
 * 把「非本机、非私网、非占位」的列为 `external`，需要人工确认（通常意味着写死了外部服务）。
 *
 *   node scripts/egress-audit.mjs            # 打印 + 写 spike/evidence/egress-audit.json
 *   node scripts/egress-audit.mjs --check     # CI：存在 external 即 exit 1
 *   node scripts/egress-audit.mjs --no-write  # 只打印，不产生脏 diff
 *
 * **运行时半边不在本脚本**：真实流量镜像要抓包环境（Wireshark / pktmon），
 * 命令与判据见 README「P3 W10」段。静态审计只能挡「代码里写死外部域名」，
 * 挡不住动态拼接的地址——两者是互补关系，不能互相替代。
 *
 * 防漏扫：文件数为 0 或字面量总数为 0 时直接 FAIL（正则失效时不能静默通过）。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'spike', 'evidence', 'egress-audit.json')
const TARGETS = ['p1']
const EXTS = new Set(['.js', '.mjs', '.html'])
const SKIP_DIRS = new Set(['node_modules', 'dist', 'bundle'])

const walk = (dir, out = []) => {
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith('.') || SKIP_DIRS.has(name)) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (EXTS.has(extname(name))) out.push(p)
  }
  return out
}

// 只捕获主机名，端口不进捕获组：模板串 `http://127.0.0.1:${port}` 不能被截成 `127.0.0.1:`
const URL_RE = /\b(?:https?|wss?):\/\/([A-Za-z0-9._-]+)/g

/** 归属分类：只有 `external` 需要人确认，其余都是自托管 / 占位。 */
export const classifyHost = (rawHost) => {
  const h = String(rawHost).toLowerCase().replace(/:\d+$/, '')
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]') return 'loopback'
  if (h === '0.0.0.0' || h === '::' || h === '[::]') return 'bind-any'
  if (h.startsWith('fe80:') || h.startsWith('fd') || h.startsWith('fc')) return 'private'   // IPv6 链路本地 / ULA
  if (/^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)) return 'private'
  if (h === 'host.docker.internal') return 'loopback'
  if (/(^|\.)example\.(com|org|net)$/.test(h)) return 'placeholder'
  // 单标签 host（如测试里的相对 URL 基准 `http://x/app/`）无法构成真实域名（真实域名必须有 TLD）
  if (/^[a-z0-9-]+$/.test(h)) return 'placeholder'
  return 'external'
}

const files = TARGETS
  .map((t) => join(ROOT, t))
  .filter((d) => existsSync(d))
  .flatMap((d) => walk(d))

const byHost = new Map()
let literalCount = 0
for (const file of files) {
  const text = readFileSync(file, 'utf8')
  for (const m of text.matchAll(URL_RE)) {
    literalCount++
    const host = m[1]
    const entry = byHost.get(host) ?? { host, class: classifyHost(host), count: 0, files: new Set() }
    entry.count++
    entry.files.add(relative(ROOT, file).replace(/\\/g, '/'))
    byHost.set(host, entry)
  }
}

const hosts = [...byHost.values()]
  .map((e) => ({ host: e.host, class: e.class, count: e.count, files: [...e.files].sort() }))
  .sort((a, b) => (a.class === b.class ? b.count - a.count : a.class.localeCompare(b.class)))
const external = hosts.filter((h) => h.class === 'external')

// 防漏扫：一个文件都没扫到、或一条 URL 都没有，说明扫描逻辑坏了，不能报 PASS
const scanBroken = files.length === 0 || literalCount === 0
const verdict = scanBroken ? 'FAIL' : external.length === 0 ? 'PASS' : 'REVIEW_REQUIRED'

/**
 * 运行时半边：只审计**我们自己的服务进程**（Relay，监听 8787）。
 * 不审计 DSH 宿主进程组——那是第三方应用的连接（更新/遥测），混进来会把结论搅浑；
 * Host 插件的出网只能靠上面的静态审计 + 代码审查，这点写在 runtimeHalf.scope 里。
 */
/**
 * 抓包级全量镜像的操作卡：本脚本不代跑（需要管理员权限 + 人工复现流量），
 * 但把命令和判据固定下来，任何有权限的人照着执行就能补齐最后一环。
 */
const PKTMON_GUIDE = {
  status: 'NOT_RUN',
  requires: '管理员 PowerShell（pktmon start 需提权；本脚本运行的会话默认不是管理员）',
  covers: 'DSH 宿主进程组、依赖包内部请求等进程级枚举看不到的流量',
  commands: [
    'pktmon start --capture --comp nics --pkt-size 128 -f C:\\temp\\wbsync-pktmon.etl',
    '# 复现一轮：手机配对 → 新建会话 → 发消息 → 传一个附件 → 取消',
    'pktmon stop',
    'pktmon format C:\\temp\\wbsync-pktmon.etl -o C:\\temp\\wbsync-pktmon.txt -v 3',
    '# 判据：目的地址只允许本机(127.0.0.1/::1)、局域网(192.168/10/172.16-31)、自托管 Relay；',
    '#       出现任何公网地址即阻断，需定位到具体端点并解释来源',
  ],
}

const collectRuntime = (enabled) => {
  if (!enabled) {
    return {
      status: 'NOT_RUN',
      scope: 'relay-process',
      hint: '加 --runtime 采集 Relay 进程的真实连接；需在配对/投递发生后执行才有代表性',
    }
  }
  if (process.platform !== 'win32') {
    return { status: 'SKIPPED', scope: 'relay-process', reason: '仅 Windows 实现（Get-NetTCPConnection）；其它平台用 ss -tnp / tcpdump' }
  }
  // PowerShell 里没有反斜杠转义，不要把 JSON 字面量嵌进 -Command；空结果统一输出 []
  const ps = [
    '$rl = @((Get-NetTCPConnection -State Listen -LocalPort 8787 -ErrorAction SilentlyContinue).OwningProcess)',
    "if ($rl.Count -eq 0) { Write-Output '[]'; exit 0 }",
    "$c = @(Get-NetTCPConnection -ErrorAction SilentlyContinue | Where-Object { $rl -contains $_.OwningProcess -and $_.State -ne 'Listen' } | Select-Object OwningProcess,RemoteAddress,RemotePort,@{n='State';e={\"$($_.State)\"}})",
    "if ($c.Count -eq 0) { Write-Output '[]' } else { ConvertTo-Json -Compress -InputObject $c }",
  ].join('\n')
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      encoding: 'utf8', timeout: 20000,
    }).trim()
    const parsed = JSON.parse(out)
    if (parsed?.error) return { status: 'NOT_RUN', scope: 'relay-process', reason: parsed.error }
    const conns = (Array.isArray(parsed) ? parsed : [parsed]).map((r) => ({
      pid: r.OwningProcess,
      remote: r.RemoteAddress,
      port: r.RemotePort,
      state: r.State,
      class: classifyHost(r.RemoteAddress),
    }))
    const external = conns.filter((r) => r.class === 'external')
    return {
      status: external.length ? 'REVIEW_REQUIRED' : 'PASS',
      scope: 'relay-process',
      connections: conns,
      external,
      note: '只覆盖 Relay 进程；DSH 宿主进程组不在审计范围（第三方应用的更新/遥测会干扰结论）',
    }
  } catch (error) {
    return { status: 'ERROR', scope: 'relay-process', reason: String(error?.message ?? error) }
  }
}

const MEASURED_RUNTIME = ['PASS', 'REVIEW_REQUIRED', 'ERROR']

/**
 * 只跑静态档时**不得抹掉**上一份的运行时实测结论。
 * 曾经发生过：加过一次 `--runtime` 拿到 PASS，之后随手跑 `--check` 再写证据，
 * 运行时半边被覆盖成 `NOT_RUN`——证据自己降级，比没测更糟（读的人会以为没测过）。
 * 因此沿用上一份实测值并标明来源与测量时间，要刷新就显式加 `--runtime`。
 */
const carryOverRuntime = (fresh, previous) => {
  if (fresh.status !== 'NOT_RUN') return fresh
  const prev = previous?.runtimeHalf
  if (!prev || !MEASURED_RUNTIME.includes(prev.status)) return fresh
  return {
    ...prev,
    carriedOver: true,
    measuredAt: previous.capturedAt ?? null,
    note: `${prev.note ? `${prev.note} ` : ''}（本次只跑了静态档，运行时数字沿用 ${previous.capturedAt ?? '上一份'} 的实测；要刷新请加 --runtime）`,
  }
}

const previousEvidence = (() => {
  try { return JSON.parse(readFileSync(OUT, 'utf8')) } catch { return null }
})()
const runtime = carryOverRuntime(collectRuntime(process.argv.includes('--runtime')), previousEvidence)

const result = {
  schema: 'wbsync-egress-audit/1',
  capturedAt: new Date().toISOString(),
  scope: TARGETS.join(', '),
  extensions: [...EXTS],
  filesScanned: files.length,
  urlLiterals: literalCount,
  hosts,
  external: external.map((h) => ({ host: h.host, count: h.count, files: h.files })),
  verdict,
  note: '静态半边：只覆盖代码里写死的 http(s)/ws(s) 字面量。动态拼接地址、运行时配置、依赖包内部请求都看不到，必须由 P3 W10 的真实流量镜像补齐。',
  runtimeHalf: runtime,
  pktmon: PKTMON_GUIDE,
}

if (!process.argv.includes('--no-write')) {
  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
}

console.log('出网审计（静态半边）·', result.capturedAt)
console.log(`  扫描 ${files.length} 个文件 / ${literalCount} 条 URL 字面量`)
for (const h of hosts) console.log(`    ${h.class.padEnd(12)} ${h.host}  ×${h.count}`)
console.log(`  静态结论：${verdict}${verdict === 'REVIEW_REQUIRED' ? '（存在外部域名，需人工确认是否必要）' : ''}`)
console.log(`  运行时半边（${runtime.scope ?? '—'}）：${runtime.status}${runtime.reason ? ` —— ${runtime.reason}` : ''}${runtime.hint ? ` —— ${runtime.hint}` : ''}`)
for (const c of runtime.connections ?? []) console.log(`    ${c.class.padEnd(10)} ${c.remote}:${c.port}  ${c.state}`)
if (!process.argv.includes('--no-write')) console.log('  证据:', OUT)

if (process.argv.includes('--check') && verdict !== 'PASS') {
  if (scanBroken) console.error('  FAIL: 未扫到任何文件或 URL 字面量，审计逻辑可能失效（不能静默通过）')
  else console.error(`  FAIL: ${external.length} 个外部域名未归类：${external.map((h) => h.host).join(', ')}`)
  process.exitCode = 1
}
if (process.argv.includes('--runtime') && runtime.status === 'REVIEW_REQUIRED') {
  console.error(`  FAIL: Relay 进程存在 ${runtime.external.length} 条外部连接：${runtime.external.map((c) => `${c.remote}:${c.port}`).join(', ')}`)
  process.exitCode = 1
}
