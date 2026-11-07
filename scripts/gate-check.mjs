#!/usr/bin/env node
/**
 * P0 门禁自动核查 · 会签依据快照
 * ---------------------------------------------------------------
 * 把「能用脚本判定的」和「必须由人签署的」分开列，避免会签时靠口头汇总。
 *
 *   node scripts/gate-check.mjs            # 打印 + 写证据
 *   node scripts/gate-check.mjs --check    # CI 模式：自动项全过才 exit 0
 *
 * 输出：spike/evidence/gate-check.json（入库，作为会签时点的机器可读快照）
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => {
  const f = join(ROOT, p)
  return existsSync(f) ? readFileSync(f, 'utf8') : null
}
const sha256 = (p) => {
  const f = join(ROOT, p)
  return existsSync(f) ? createHash('sha256').update(readFileSync(f)).digest('hex') : null
}
const git = (...args) => {
  try { return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', timeout: 8000 }).trim() }
  catch { return null }
}
const json = (p) => { try { return JSON.parse(read(p) ?? '{}') } catch { return {} } }

const pin = read('pinned-commit.txt') ?? ''
const upstreamCommit = /^upstream_commit=(.+)$/m.exec(pin)?.[1]?.trim() ?? null
const hostProbe = json('spike/evidence/host-probe.json')
const checkPlugin = json('spike/evidence/check-plugin.json')
const report = read('spike/REPORT.md') ?? ''
const arch = read('docs/03_系统架构设计.md') ?? ''

let protocolSync = false
try {
  execFileSync(process.execPath, [join(ROOT, 'scripts/sync-protocol.mjs'), '--check'],
    { cwd: ROOT, stdio: 'pipe', timeout: 10000 })
  protocolSync = true
} catch { /* 不一致即 FAIL */ }

let secretClean = false
try {
  execFileSync('git', ['grep', '-n', '-I', '-E', 'ghp_[A-Za-z0-9]{20,}'],
    { cwd: ROOT, stdio: 'pipe', timeout: 15000 })
  // grep 命中时 exit 0 → 有泄漏
} catch (error) {
  // exit 1 = 无命中；其它错误保守判失败
  secretClean = error?.status === 1
}

// 证据输入指纹：用来判断「入库快照是否还能代表当前证据」
const evidenceSha = {
  'host-probe.json': sha256('spike/evidence/host-probe.json'),
  'check-plugin.json': sha256('spike/evidence/check-plugin.json'),
  'REPORT.md': sha256('spike/REPORT.md'),
  'PROTOCOL.md': sha256('PROTOCOL.md'),
  'dist-tarball': sha256('dist/dsh-wb-cloud-sync-spike-0.1.0.tgz'),
}

// 新鲜度以「证据输入是否变化」为准，而不是 git HEAD：
// 只改文档 / 提交信息不该让快照失效，但证据文件一变就必须重算。
const SNAPSHOT = join(ROOT, 'spike/evidence/gate-check.json')
let previous = null
try { previous = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) } catch { /* 首次运行 */ }

const changedInputs = previous?.evidenceSha256
  ? Object.keys(evidenceSha).filter((k) => previous.evidenceSha256[k] !== evidenceSha[k])
  : Object.keys(evidenceSha)
const ageDays = previous?.capturedAt
  ? Math.floor((Date.now() - Date.parse(previous.capturedAt)) / 86_400_000)
  : null
const freshness = {
  status: !previous ? 'FIRST_RUN' : changedInputs.length === 0 ? 'CURRENT' : 'STALE',
  previousCapturedAt: previous?.capturedAt ?? null,
  previousGitHead: previous?.git?.head ?? null,
  changedInputs: previous ? changedInputs : [],
  ageDays,
  maxAgeDays: 30,
}
if (freshness.status === 'CURRENT' && ageDays !== null && ageDays > freshness.maxAgeDays) {
  freshness.status = 'STALE'
  freshness.reason = `快照已 ${ageDays} 天，超过 ${freshness.maxAgeDays} 天上限`
} else if (freshness.status === 'STALE' && changedInputs.length) {
  freshness.reason = `证据输入已变化：${changedInputs.join(', ')}`
}

const automated = [
  { id: 'G1', label: '三问离线取证 Q1/Q2/Q3 全 PASS',
    pass: ['Q1', 'Q2', 'Q3'].every((q) => hostProbe.questions?.[q]?.verdict === 'PASS') },
  { id: 'G2', label: '插件加载验证 check-plugin PASS',
    pass: checkPlugin.verdict === 'PASS' },
  { id: 'G3', label: '上游 commit 已锁定（40 位 SHA）',
    pass: Boolean(upstreamCommit && /^[0-9a-f]{40}$/.test(upstreamCommit)) },
  { id: 'G4', label: 'PROTOCOL.md 与 docs/04 单向同步一致',
    pass: protocolSync },
  { id: 'G5', label: '真机加载 + 运行时事件闭环已记录（REPORT §4.1.2）',
    pass: report.includes('4.1.2') && report.includes('8/8') },
  { id: 'G6', label: 'TC-4.10 真机卸载已记录（REPORT §4.1.3）',
    pass: report.includes('4.1.3') },
  { id: 'G7', label: 'ADR-007~009 已写入 03',
    pass: (arch.match(/^### ADR-00[789]/gm) ?? []).length === 3 },
  { id: 'G8', label: '仓库跟踪文件无 PAT/密钥命中',
    pass: secretClean },
]

// 脚本判不了、必须由人签署 / 人工复核的项
const manual = [
  { id: 'M1', label: '四方文档会签（01 §9：PM / 架构师 / 安全 Owner / QA Owner）', status: 'NOT MET', owner: 'PM' },
  { id: 'M2', label: 'ADR-007 事件契约以宿主实测为准', status: '提议中，待会签', owner: 'ARC + PM' },
  { id: 'M3', label: 'ADR-008 幂等与写入权归宿主', status: '提议中，待会签', owner: 'ARC + PM' },
  { id: 'M4', label: 'ADR-009 PROTOCOL.md 为唯一契约源', status: '提议中，待会签', owner: 'ARC' },
  { id: 'M5', label: '安全项一票否决权行使（08 / 01 §6）', status: '待安全 Owner', owner: '安全 Owner' },
  { id: 'M6', label: '构建链环境 Node ≥24.9 + pnpm 11 + CI 接入', status: 'NOT MET', owner: 'HE-A + BE-RL' },
]

const result = {
  schema: 'wbsync-gate-check/1',
  capturedAt: new Date().toISOString(),
  git: {
    head: git('rev-parse', 'HEAD'),
    branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
    worktreeClean: (git('status', '--porcelain') ?? '').length === 0,
  },
  pinnedCommit: upstreamCommit,
  freshness,
  evidenceSha256: evidenceSha,
  automated,
  automatedPassed: automated.filter((c) => c.pass).length,
  automatedTotal: automated.length,
  manual,
  gate: automated.every((c) => c.pass) ? 'BLOCKED_BY_SIGNOFF' : 'FAIL',
}

const out = SNAPSHOT
// --check 只校验不写盘：CI 里不应产生脏 diff；默认模式才生成会签快照
if (!process.argv.includes('--check')) {
  // freshness 是「相对上一份快照」的判定；新快照诞生的那一刻本身就是 CURRENT。
  // 差异留在 supersedes 里可追溯，避免快照自述为 STALE 引起误读。
  const snapshot = {
    ...result,
    freshness: {
      ...freshness,
      status: 'CURRENT',
      supersedes: {
        previousStatus: freshness.status,
        capturedAt: freshness.previousCapturedAt,
        gitHead: freshness.previousGitHead,
        changedInputs: freshness.changedInputs,
      },
    },
  }
  writeFileSync(out, JSON.stringify(snapshot, null, 2), 'utf8')
}

console.log('P0 门禁自动核查 ·', result.capturedAt)
for (const c of automated) console.log(`  ${c.id} ${(c.pass ? 'PASS' : 'FAIL').padEnd(5)} ${c.label}`)
console.log(`  自动项 ${result.automatedPassed}/${result.automatedTotal}`)
console.log('  人工项（不由脚本判定）：')
for (const m of manual) console.log(`    ${m.id} ${m.status.padEnd(16)} ${m.label}`)
console.log('  门禁:', result.gate, '| git:', result.git.branch, result.git.head?.slice(0, 8), '| clean:', result.git.worktreeClean)
console.log('  快照:', freshness.status, freshness.reason ? `(${freshness.reason})` : `(age ${ageDays ?? 0}d / max ${freshness.maxAgeDays}d)`)
console.log('  证据:', out)

if (process.argv.includes('--check')) {
  const ok = automated.every((c) => c.pass)
  if (process.argv.includes('--assert-fresh') && freshness.status !== 'CURRENT') {
    console.error(`  FAIL: 快照不新鲜（${freshness.status}）→ 先运行 node scripts/gate-check.mjs 重算`)
    process.exitCode = 2
  } else {
    process.exitCode = ok ? 0 : 1
  }
}
