#!/usr/bin/env node
/**
 * check-upstream-drift.mjs —— 只读检查「入库三问取证」对应的上游 DSH 是否已漂移。
 *
 * 背景：spike/evidence/host-probe.json 记着取证时的 asar sha256 与宿主版本。
 * gate 的 G1 直接读这份快照判 PASS，而快照新鲜度按时间算（CURRENT 只表示没超期）；
 * 桌面版升级后，快照可能仍 CURRENT，但对应的已经不是同一份上游代码。
 * 2026-11-15 实测：快照 rc.1 / 5fa8a6b2…，本机 rc.3 / 14cfd81c…，
 * 用隔离输出重跑 probe-host 时 Q1/Q3 仍 PASS，Q2 从 PASS 变 FAIL（幂等=0）。
 *
 * 本脚本不写证据、不改门禁、不重新取证；只把漂移事实打印出来，供发起人在
 * 「在 rc.3 上重做三问取证」与「锁定 rc.1 为目标宿主」之间做裁定。
 * 注意：不要用 `npm run verify` 直接重采 —— probe-host 会覆盖入库证据，
 * 让 G1 连带变红。需要重采时用 WBSYNC_OUT=.temp/verify 隔离输出目录。
 *
 *   node scripts/check-upstream-drift.mjs
 *   node scripts/check-upstream-drift.mjs --asar <path>
 *
 * exit 0 = 一致；exit 1 = 漂移或证据/文件缺失。
 */
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const ASAR = arg('--asar', 'D:/Program AI/Deepseek Harness/resources/app.asar')
const EVIDENCE = join(ROOT, 'spike', 'evidence', 'host-probe.json')

function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    const s = createReadStream(file)
    s.on('data', (d) => h.update(d))
    s.on('end', () => resolve(h.digest('hex')))
    s.on('error', reject)
  })
}

let report
try {
  report = JSON.parse(readFileSync(EVIDENCE, 'utf8'))
} catch (e) {
  console.error(`读不到入库证据 ${EVIDENCE}: ${e.message}`)
  process.exit(1)
}

const env = report.env || {}
const snapSha = env.asarSha256 || null
const snapVer = (env.host && env.host.version) || (typeof env.host === 'string' ? env.host : '未知')
const capturedAt = env.capturedAt || '未知'
const q2 = report.questions && report.questions.Q2 && report.questions.Q2.verdict

console.log('上游漂移检查（只读）')
console.log(`  入库取证 : ${capturedAt} | 宿主 ${snapVer} | asar ${snapSha || '缺失'}`)
console.log(`  快照 Q2  : ${q2 || '未知'}`)

if (!existsSync(ASAR)) {
  console.error(`  本机 asar 不存在: ${ASAR}（用 --asar 指定）`)
  process.exit(1)
}

const currentSha = await sha256(ASAR)
console.log(`  本机 asar: ${ASAR}`)
console.log(`             sha256 ${currentSha}`)

if (!snapSha) {
  console.error('  入库证据缺 asarSha256，无法比对')
  process.exit(1)
}

if (currentSha === snapSha) {
  console.log('\n  ALIGNED — 本机上游与入库取证一致，快照仍可代表当前宿主')
  process.exit(0)
}

console.log('\n  DRIFT — 本机宿主版本与入库取证不一致')
console.log('  注意：发版检查单明确「双端 pinned-commit.txt 一致且锁 v0.2.2-rc.1」')
console.log('        （12_实施步骤手册.md §9 第 7 条 / 07_测试计划与验收标准.md 发版检查单第 6 条）。')
console.log('        所以快照对应 rc.1 是**符合计划**的，偏离的是本机环境，不是快照过期。')
console.log('  影响：gate G1 按 rc.1 快照判 PASS；在 rc.3 重采三问时 Q2 会 FAIL。')
console.log('  处置：GA 验证须在锁定的 rc.1 环境进行。不要用 rc.3 的重采结果覆盖 rc.1 证据，')
console.log('        也不要为了让 Q2 变绿而放宽判据；重采请用 WBSYNC_OUT=.temp/verify 隔离输出。')
console.log('        本脚本只读，不代改判据、不覆盖证据。')
process.exit(1)
