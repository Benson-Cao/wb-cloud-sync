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
  if (h === '0.0.0.0' || h === '[::]') return 'bind-any'
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
  runtimeHalf: {
    status: 'NOT_RUN',
    hint: 'Windows: pktmon start --capture --comp nics → 复现一轮配对/投递 → pktmon stop → pktmon format 导出；判据：除 Relay 自托管地址外不得出现其它外部目的地址',
  },
}

if (!process.argv.includes('--no-write')) {
  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
}

console.log('出网审计（静态半边）·', result.capturedAt)
console.log(`  扫描 ${files.length} 个文件 / ${literalCount} 条 URL 字面量`)
for (const h of hosts) console.log(`    ${h.class.padEnd(12)} ${h.host}  ×${h.count}`)
console.log(`  结论：${verdict}${verdict === 'REVIEW_REQUIRED' ? '（存在外部域名，需人工确认是否必要）' : ''}`)
console.log(`  运行时半边：${result.runtimeHalf.status} —— ${result.runtimeHalf.hint}`)
if (!process.argv.includes('--no-write')) console.log('  证据:', OUT)

if (process.argv.includes('--check') && verdict !== 'PASS') {
  if (scanBroken) console.error('  FAIL: 未扫到任何文件或 URL 字面量，审计逻辑可能失效（不能静默通过）')
  else console.error(`  FAIL: ${external.length} 个外部域名未归类：${external.map((h) => h.host).join(', ')}`)
  process.exitCode = 1
}
