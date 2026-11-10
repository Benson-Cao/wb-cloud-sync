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
import { listTarEntries } from './lib/tar.mjs'

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

// 指纹分两组：**证据数据**（事实）与**描述文字**（说法）。
// 事实一变必须重算快照；只是措辞变了不该拦 PR。
const fingerprints = {
  // 运行代码 + 实测证据：这一组是「事实」，变了必须重算快照
  data: {
    'index.js': sha256('index.js'),
    'cordis.patch.yml': sha256('cordis.patch.yml'),
    'package.json': sha256('package.json'),
    'host-probe.json': sha256('spike/evidence/host-probe.json'),
    'check-plugin.json': sha256('spike/evidence/check-plugin.json'),
  },
  // 发布物：tgz 里含 README，重建（哪怕只改了文档）不代表事实变了，
  // 所以只提示核对，不阻断。
  artifact: {
    'dist-tarball': sha256('dist/dsh-wb-cloud-sync-spike-0.1.0.tgz'),
  },
  // 说法：描述文字
  narrative: {
    'REPORT.md': sha256('spike/REPORT.md'),
    'PROTOCOL.md': sha256('PROTOCOL.md'),
  },
}

const SNAPSHOT = join(ROOT, 'spike/evidence/gate-check.json')
let previous = null
try { previous = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) } catch { /* 首次运行 */ }

/** 返回变化的键；previous 缺该组（旧格式）时返回 null，表示无法比较。 */
const diffGroup = (group) => (previous?.fingerprints?.[group]
  ? Object.keys(fingerprints[group]).filter((k) => previous.fingerprints[group][k] !== fingerprints[group][k])
  : null)

const dataChanged = diffGroup('data')
const artifactChanged = diffGroup('artifact')
const narrativeChanged = diffGroup('narrative')
const legacySnapshot = Boolean(previous) && !previous.fingerprints

const ageDays = previous?.capturedAt
  ? Math.floor((Date.now() - Date.parse(previous.capturedAt)) / 86_400_000)
  : null

// CURRENT  = 三组一致
// DRIFTED  = 仅发布物重建 / 描述文字变化（不阻断，但留痕）
// STALE    = 运行代码或证据数据变化 / 旧格式快照 / 超过 30 天（阻断）
// 发布物（tgz）是派生产物，且 npm pack 不可复现（gzip 头带时间戳）：
// 同样内容两次打包 sha 不同。所以 artifact 变化**只记录、不参与判定**，
// 否则每次 repack 都会误报。防「发布物与源码脱节」靠 G4 之外的实时校验，
// 而不是快照指纹。
let status
if (!previous) status = 'FIRST_RUN'
else if (legacySnapshot) status = 'STALE'
else if (dataChanged?.length) status = 'STALE'
else if (narrativeChanged?.length) status = 'DRIFTED'
else status = 'CURRENT'

const freshness = {
  status,
  dataChanged: dataChanged ?? [],
  artifactChanged: artifactChanged ?? [],
  narrativeChanged: narrativeChanged ?? [],
  notes: [],
  previousCapturedAt: previous?.capturedAt ?? null,
  previousGitHead: previous?.git?.head ?? null,
  ageDays,
  maxAgeDays: 30,
}
if (artifactChanged?.length) {
  freshness.notes.push(`发布物已重建（仅记录，不影响判定）：${artifactChanged.join(', ')}`)
}
if (legacySnapshot) {
  freshness.reason = `快照格式为 ${previous.schema ?? '未知'}（缺少分组指纹），需重算一次`
} else if (status === 'STALE' && dataChanged?.length) {
  freshness.reason = `运行代码/证据已变化（阻断）：${dataChanged.join(', ')}`
} else if (status === 'DRIFTED') {
  freshness.reason = `描述文字变化（不阻断）：${narrativeChanged.join(', ')}`
}
if ((status === 'CURRENT' || status === 'DRIFTED') && ageDays !== null && ageDays > freshness.maxAgeDays) {
  freshness.status = 'STALE'
  freshness.reason = `快照已 ${ageDays} 天，超过 ${freshness.maxAgeDays} 天上限`
}

// G9：发布包内容与仓库源码逐文件一致。
// tgz 不可复现（gzip 头带时间），所以只比对**解包后的文件 sha**，不比 tgz 本身。
// 这样既能保证「装到的东西 = 源码」，又不会被 repack 误报。
const TARBALL = join(ROOT, 'dist/dsh-wb-cloud-sync-spike-0.1.0.tgz')
const TARBALL_MAP = {
  'package/index.js': 'index.js',
  'package/cordis.patch.yml': 'cordis.patch.yml',
  'package/package.json': 'package.json',
  'package/README.md': 'README.md',
  'package/LICENSE': 'LICENSE',
}
let tarballChecks = []
try {
  const entries = listTarEntries(readFileSync(TARBALL))
  tarballChecks = Object.entries(TARBALL_MAP).map(([inTar, inRepo]) => {
    const entry = entries.find((e) => e.path === inTar)
    return {
      file: inRepo,
      present: Boolean(entry),
      matched: Boolean(entry) && entry.sha256 === sha256(inRepo),
    }
  })
} catch { tarballChecks = [] }
const tarballConsistent = tarballChecks.length > 0 && tarballChecks.every((c) => c.present && c.matched)

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
  { id: 'G7', label: 'ADR-007~010 已写入 03',
    pass: (arch.match(/^### ADR-(00[789]|010)/gm) ?? []).length === 4 },
  { id: 'G8', label: '仓库跟踪文件无 PAT/密钥命中',
    pass: secretClean },
  { id: 'G9', label: '发布包内容与仓库源码逐文件一致（解包比对）',
    pass: tarballConsistent },
]

// 脚本判不了、必须由人签署 / 人工复核的项
const manual = [
  { id: 'M1', label: '四方文档会签（01 §9：PM / 架构师 / 安全 Owner / QA Owner）', status: 'NOT MET', owner: 'PM' },
  { id: 'M2', label: 'ADR-007 事件契约以宿主实测为准', status: '提议中，待会签', owner: 'ARC + PM' },
  { id: 'M3', label: 'ADR-008 幂等与写入权归宿主', status: '提议中，待会签', owner: 'ARC + PM' },
  { id: 'M4', label: 'ADR-009 PROTOCOL.md 为唯一契约源', status: '提议中，待会签', owner: 'ARC' },
  { id: 'M5', label: '安全项一票否决权行使（08 / 01 §6）', status: '待安全 Owner', owner: '安全 Owner' },
  { id: 'M6a', label: 'CI 闸门接入（GitHub Actions · gate.yml）', status: 'MET · run 42366496926', owner: 'HE-A + BE-RL' },
  { id: 'M6b', label: '本地构建链 Node ≥24.9 + pnpm 11（见 scripts/check-env.mjs）', status: 'NOT MET · 2/5', owner: 'HE-A + BE-RL' },
  { id: 'M7', label: 'ADR-010 正文可见性边界（信任边界，安全 Owner 必看）', status: '提议中，待会签', owner: 'ARC + 安全 Owner' },
]

const result = {
  schema: 'wbsync-gate-check/3',
  capturedAt: new Date().toISOString(),
  git: {
    head: git('rev-parse', 'HEAD'),
    branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
    worktreeClean: (git('status', '--porcelain') ?? '').length === 0,
  },
  pinnedCommit: upstreamCommit,
  freshness,
  fingerprints,
  tarballFiles: tarballChecks,
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
      ageDays: 0,        // 新快照刚诞生，年龄归零（上一份的年龄在 supersedes.capturedAt）
      reason: undefined, // 上一份的判定理由归入 supersedes，避免快照自述为「需重算」
      supersedes: {
        previousStatus: freshness.status,
        previousReason: freshness.reason,
        capturedAt: freshness.previousCapturedAt,
        gitHead: freshness.previousGitHead,
        dataChanged: freshness.dataChanged,
        artifactChanged: freshness.artifactChanged,
        narrativeChanged: freshness.narrativeChanged,
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
  const stale = freshness.status === 'STALE'
  if (process.argv.includes('--assert-fresh') && stale) {
    console.error('  FAIL: 快照 STALE（证据数据变了 / 旧格式 / 超期）→ 先运行 node scripts/gate-check.mjs 重算并提交')
    process.exitCode = 2
  } else {
    if (freshness.reason) console.log('  NOTE:', freshness.reason)
    for (const note of freshness.notes ?? []) console.log('  NOTE:', note)
    process.exitCode = ok ? 0 : 1
  }
}
