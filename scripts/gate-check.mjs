#!/usr/bin/env node
/**
 * P0 门禁自动核查 · 会签依据快照
 * ---------------------------------------------------------------
 * 把「能用脚本判定的」和「必须由人签署的」分开列，避免会签时靠口头汇总。
 *
 *   node scripts/gate-check.mjs            # 打印 + 写证据
 *   node scripts/gate-check.mjs --check    # CI 模式：自动项全过才 exit 0
 *   node scripts/gate-check.mjs --check --assert-fresh   # 额外要求快照不过期
 *
 * 输出：spike/evidence/gate-check.json（入库，作为会签时点的机器可读快照）
 *
 * 2026-11-10 v4 加固：
 *   - 新增 signoff 指纹组：会签材料（安全一页纸 / 会签包 / 01 会签表 /
 *     P1 前置提案 / 对标复核）一变即 STALE，防止「材料被改而快照仍 CURRENT」。
 *   - G8 改为遍历工作区（含未跟踪文件）+ 多形态密钥正则，不再只扫 ghp_ 与已跟踪文件。
 *   - manual 的 M6a / M6b 状态与 SIGN-OFF.md 对齐。
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
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

// ── 密钥扫描：遍历工作区，含未跟踪文件 ────────────────────────────────
// git grep 只能扫已跟踪文件，且原先只认 ghp_ 一种形态。会签前新建的临时
// 文件、细粒度 PAT、gho_/ghu_/ghs_/ghr_、sk- 型密钥、私钥头都会漏。
const SECRET_PATTERNS = [
  { id: 'github-classic', re: /gh[pousr]_[A-Za-z0-9]{20,}/ },
  { id: 'github-fine-grained', re: /github_pat_[A-Za-z0-9_]{20,}/ },
  { id: 'sk-prefixed', re: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { id: 'private-key', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/ },
]
const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist',
  '.revisions-backup', '.revisions-backup-realdevice', '.revisions-backup-workbuddy',
])
const TEXT_EXT = /\.(md|markdown|json|js|mjs|cjs|ts|tsx|yml|yaml|txt|sh|toml|cfg|ini|env|html|css|svg|py)$/i

const scanSecrets = () => {
  const hits = []
  let filesScanned = 0
  const walk = (dir) => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || /^dsh-home-/.test(e.name)) continue
        walk(full)
      } else if (e.isFile()) {
        if (!TEXT_EXT.test(e.name)) continue
        let size
        try { size = statSync(full).size } catch { continue }
        if (size > 2_000_000) continue
        let text
        try { text = readFileSync(full, 'utf8') } catch { continue }
        if (text.includes('\0')) continue
        filesScanned++
        const lines = text.split('\n')
        for (let i = 0; i < lines.length; i++) {
          for (const p of SECRET_PATTERNS) {
            // 只记录位置与形态，绝不把匹配内容写进证据
            if (p.re.test(lines[i])) hits.push({ file: relative(ROOT, full).replace(/\\/g, '/'), line: i + 1, pattern: p.id })
          }
        }
      }
    }
  }
  walk(ROOT)
  return { filesScanned, patterns: SECRET_PATTERNS.map((p) => p.id), hits, clean: hits.length === 0 }
}

const pin = read('pinned-commit.txt') ?? ''
const upstreamCommit = /^upstream_commit=(.+)$/m.exec(pin)?.[1]?.trim() ?? null
const hostProbe = json('spike/evidence/host-probe.json')
const checkPlugin = json('spike/evidence/check-plugin.json')
const report = read('spike/REPORT.md') ?? ''
const arch = read('docs/03_系统架构设计.md') ?? ''
const secretScan = scanSecrets()

let protocolSync = false
try {
  execFileSync(process.execPath, [join(ROOT, 'scripts/sync-protocol.mjs'), '--check'],
    { cwd: ROOT, stdio: 'pipe', timeout: 10000 })
  protocolSync = true
} catch { /* 不一致即 FAIL */ }

// 指纹分四组：
//   data     运行代码 + 实测证据（事实）→ 变了 STALE
//   signoff  会签材料（签字人实际要读的东西）→ 变了 STALE
//   narrative 描述文字（说法）→ 变了 DRIFTED，不阻断
//   artifact 发布物 → 仅记录，不参与判定（npm pack 不可复现）
const fingerprints = {
  data: {
    'index.js': sha256('index.js'),
    'cordis.patch.yml': sha256('cordis.patch.yml'),
    'package.json': sha256('package.json'),
    'host-probe.json': sha256('spike/evidence/host-probe.json'),
    'check-plugin.json': sha256('spike/evidence/check-plugin.json'),
    // 判据脚本本身也是事实：判据改了却沿用旧快照，等于用旧尺子量新代码
    'gate-check.mjs': sha256('scripts/gate-check.mjs'),
    'check-env.mjs': sha256('scripts/check-env.mjs'),
    'signoff-check.mjs': sha256('scripts/signoff-check.mjs'),
    'sync-protocol.mjs': sha256('scripts/sync-protocol.mjs'),
  },
  signoff: {
    'SECURITY-REVIEW.md': sha256('SECURITY-REVIEW.md'),
    'SIGN-OFF.md': sha256('SIGN-OFF.md'),
    'SIGN-OFF-PROCEDURE.md': sha256('SIGN-OFF-PROCEDURE.md'),
    'SIGNOFF-WAIVER.md': sha256('SIGNOFF-WAIVER.md'),
    '01-charter.md': sha256('docs/01_项目章程.md'),
    'P1-PREREQUISITES.md': sha256('P1-PREREQUISITES.md'),
    'WORKBUDDY-REFERENCE.md': sha256('WORKBUDDY-REFERENCE.md'),
  },
  artifact: {
    'dist-tarball': sha256('dist/dsh-wb-cloud-sync-spike-0.1.0.tgz'),
  },
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
const signoffChanged = diffGroup('signoff')
const artifactChanged = diffGroup('artifact')
const narrativeChanged = diffGroup('narrative')
// 缺 signoff 组的 v3 快照按旧格式处理，不静默放行
const legacySnapshot = Boolean(previous) && (!previous.fingerprints || !previous.fingerprints.signoff)

const ageDays = previous?.capturedAt
  ? Math.floor((Date.now() - Date.parse(previous.capturedAt)) / 86_400_000)
  : null

// CURRENT  = 四组一致
// DRIFTED  = 仅发布物重建 / 描述文字变化（不阻断，但留痕）
// STALE    = 运行代码 / 会签材料 / 证据数据变化 / 旧格式快照 / 超期（阻断）
let status
if (!previous) status = 'FIRST_RUN'
else if (legacySnapshot) status = 'STALE'
else if (dataChanged?.length) status = 'STALE'
else if (signoffChanged?.length) status = 'STALE'
else if (narrativeChanged?.length) status = 'DRIFTED'
else status = 'CURRENT'

const freshness = {
  status,
  dataChanged: dataChanged ?? [],
  signoffChanged: signoffChanged ?? [],
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
  freshness.reason = `快照格式为 ${previous.schema ?? '未知'}（缺少 signoff 指纹组或分组指纹），需重算一次`
} else if (status === 'STALE' && (dataChanged?.length || signoffChanged?.length)) {
  // 两组可能同时变化，全部列出，避免只报第一组让签字人误判改动范围
  const parts = []
  if (dataChanged?.length) parts.push(`运行代码/证据：${dataChanged.join(', ')}`)
  if (signoffChanged?.length) parts.push(`会签材料：${signoffChanged.join(', ')}`)
  freshness.reason = `已变化（阻断）：${parts.join('；')}`
} else if (status === 'DRIFTED') {
  freshness.reason = `描述文字变化（不阻断）：${narrativeChanged.join(', ')}`
}
if ((status === 'CURRENT' || status === 'DRIFTED') && ageDays !== null && ageDays > freshness.maxAgeDays) {
  freshness.status = 'STALE'
  freshness.reason = `快照已 ${ageDays} 天，超过 ${freshness.maxAgeDays} 天上限`
}

// G9：发布包内容与仓库源码逐文件一致。
// tgz 不可复现（gzip 头带时间），所以只比对**解包后的文件 sha**，不比 tgz 本身。
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

// G10：P3 W10 的混沌 + 压测两件证据。
// 混沌套件**现场重跑**（约 3s，确定性用例，适合放门禁）；压测只校验证据，
// 不在这里重压 500 连接——门禁要快，重压留给 scripts/bench.mjs。
let chaosPerf = { chaosPass: 0, chaosFail: null, chaosError: null, perfVerdict: null, perfAgeDays: null, perfReason: null }
try {
  const out = execFileSync(process.execPath, ['--test', 'p1/relay/test/chaos.test.mjs'],
    { cwd: ROOT, encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] })
  const m = /# pass (\d+)[\s\S]*?# fail (\d+)/.exec(out)
  chaosPerf.chaosPass = m ? Number(m[1]) : 0
  chaosPerf.chaosFail = m ? Number(m[2]) : null
} catch (e) {
  const out = String(e.stdout ?? '')
  const m = /# pass (\d+)[\s\S]*?# fail (\d+)/.exec(out)
  chaosPerf.chaosPass = m ? Number(m[1]) : 0
  chaosPerf.chaosFail = m ? Number(m[2]) : -1
  chaosPerf.chaosError = String(e.message ?? e).split('\n')[0].slice(0, 120)
}
// 混沌套件至少 8 例全绿；`fail` 解析不出来也算失败（不能把「没跑成」当「没失败」）
const chaosOk = chaosPerf.chaosFail === 0 && chaosPerf.chaosPass >= 8

const perf = json('spike/evidence/perf.json')
const perfAgeDays = perf.capturedAt ? (Date.now() - Date.parse(perf.capturedAt)) / 86_400_000 : null
const perfB6 = (perf.cases ?? []).find((c) => c.id === 'B6')
const perfReason = !perf.schema
  ? '缺少 spike/evidence/perf.json（先跑 node scripts/bench.mjs）'
  : perf.schema !== 'wbsync-perf/1'
    ? `证据 schema 不符：${perf.schema}`
    : perf.verdict !== 'PASS'
      ? `压测判定 ${perf.verdict}`
      : (perf.config?.wsConnections ?? 0) < 500 || perfB6?.threshold !== 500
        // 快速档只冒烟 100 连接：拿它充全量会让「≥500」这条指标永远绿
        ? '证据来自快速档（--quick），不能代表 500 并发指标'
        : perfB6?.value < 500
          ? `并发 WS 实测 ${perfB6?.value} < 500`
          : perfAgeDays === null || perfAgeDays > 30
            ? `压测证据已 ${Math.round(perfAgeDays ?? 999)} 天，超过 30 天上限`
            : null
chaosPerf.perfVerdict = perf.verdict ?? null
chaosPerf.perfAgeDays = perfAgeDays === null ? null : Number(perfAgeDays.toFixed(1))
chaosPerf.perfReason = perfReason
const chaosPerfOk = chaosOk && perfReason === null

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
  { id: 'G8', label: '工作区（含未跟踪）无多形态密钥命中',
    pass: secretScan.clean },
  { id: 'G9', label: '发布包内容与仓库源码逐文件一致（解包比对）',
    pass: tarballConsistent },
  { id: 'G10', label: '混沌套件现场重跑全绿 + 压测证据 PASS（500 并发 WS / P95 / 防悬挂）',
    pass: chaosPerfOk },
]

// 2026-11-10 发起人裁定：四方会签要求永久取消（SIGNOFF-WAIVER.md）。
// 以下保留为治理状态说明，**不再是门禁阻塞项**；不代签、不填签署栏、不改 ADR 状态。
const manual = [
  { id: 'M1', label: '四方文档会签（01 §9）', status: '已取消 · 发起人裁定', owner: '发起人' },
  { id: 'M2', label: 'ADR-007 事件契约以宿主实测为准', status: '按默认口径落地', owner: '发起人裁定' },
  { id: 'M3', label: 'ADR-008 幂等与写入权归宿主', status: '按默认口径落地', owner: '发起人裁定' },
  { id: 'M4', label: 'ADR-009 PROTOCOL.md 为唯一契约源', status: '按默认口径落地', owner: '发起人裁定' },
  { id: 'M5', label: '安全项一票否决权（08 / 01 §6）', status: '随会签取消 · 责任承接', owner: '发起人' },
  { id: 'M6a', label: 'CI 闸门接入（GitHub Actions · gate.yml）', status: 'MET · 持续绿灯', owner: 'HE-A + BE-RL' },
  { id: 'M6b', label: '本地构建链 Node ≥24.9 + pnpm 11（见 scripts/check-env.mjs）', status: 'MET · 5/5 READY', owner: 'HE-A + BE-RL' },
  { id: 'M7', label: 'ADR-010 正文可见性边界（信任边界）', status: '按默认口径落地', owner: '发起人裁定' },
]

const result = {
  schema: 'wbsync-gate-check/5',
  capturedAt: new Date().toISOString(),
  git: {
    head: git('rev-parse', 'HEAD'),
    branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
    worktreeClean: (git('status', '--porcelain') ?? '').length === 0,
  },
  pinnedCommit: upstreamCommit,
  freshness,
  fingerprints,
  secretScan: {
    filesScanned: secretScan.filesScanned,
    patterns: secretScan.patterns,
    hits: secretScan.hits,
  },
  tarballFiles: tarballChecks,
  chaosAndPerf: chaosPerf,
  automated,
  automatedPassed: automated.filter((c) => c.pass).length,
  automatedTotal: automated.length,
  manual,
  // 四方会签已取消：自动项全过即 PASS，不再输出 BLOCKED_BY_SIGNOFF
  gate: automated.every((c) => c.pass) ? 'PASS' : 'FAIL',
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
        signoffChanged: freshness.signoffChanged,
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
console.log(`  密钥扫描 ${secretScan.filesScanned} 个文本文件 / ${secretScan.hits.length} 命中`)
console.log('  人工项（不由脚本判定）：')
for (const m of manual) console.log(`    ${m.id} ${m.status.padEnd(16)} ${m.label}`)
console.log('  门禁:', result.gate, '| git:', result.git.branch, result.git.head?.slice(0, 8), '| clean:', result.git.worktreeClean)
console.log('  快照:', freshness.status, freshness.reason ? `(${freshness.reason})` : `(age ${ageDays ?? 0}d / max ${freshness.maxAgeDays}d)`)
console.log('  证据:', out)

if (process.argv.includes('--check')) {
  const ok = automated.every((c) => c.pass)
  const stale = freshness.status === 'STALE'
  if (process.argv.includes('--assert-fresh') && stale) {
    console.error('  FAIL: 快照 STALE（运行代码 / 会签材料 / 证据变了，或旧格式 / 超期）→ 先运行 node scripts/gate-check.mjs 重算并提交')
    process.exitCode = 2
  } else {
    if (freshness.reason) console.log('  NOTE:', freshness.reason)
    for (const note of freshness.notes ?? []) console.log('  NOTE:', note)
    process.exitCode = ok ? 0 : 1
  }
}
