#!/usr/bin/env node
/**
 * 会签就绪终检（P0 · 一条命令出签字清单）
 * ---------------------------------------------------------------
 * 目的：把「四方会签」从「翻 11 份文档 + 3 个证据 JSON」压成一条命令。
 * 只读、不写业务文件；输出 spike/evidence/signoff-readiness.json 作会签附件。
 *
 *   node scripts/signoff-check.mjs              # 打印 + 写会签附件
 *   node scripts/signoff-check.mjs --no-write   # CI：只打印，不产生脏 diff
 *
 * 判定边界：**只报告，不代替签字**。会签是人的动作，脚本永远不因为
 * 「没签字」而返回非 0；CI 里作为记录步骤使用。
 * 读的是**入库的本机证据**，不是当前 CI 环境——两者不要混。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => {
  const f = join(ROOT, p)
  return existsSync(f) ? readFileSync(f, 'utf8') : null
}
const json = (p) => { try { return JSON.parse(read(p) ?? '{}') } catch { return {} } }
const git = (...args) => {
  try { return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', timeout: 8000 }).trim() }
  catch { return null }
}

const gate = json('spike/evidence/gate-check.json')
const env = json('spike/evidence/env-check.json')
const arch = read('docs/03_系统架构设计.md') ?? ''
const charter = read('docs/01_项目章程.md') ?? ''
const signoff = read('SIGN-OFF.md') ?? ''
const security = read('SECURITY-REVIEW.md') ?? ''
const reference = read('WORKBUDDY-REFERENCE.md')

// ADR 状态：按 ### ADR-xxx 分块，取块内「- **状态**：」
const adrs = []
const blocks = arch.split(/^### (ADR-\d{3})/gm)
for (let i = 1; i < blocks.length; i += 2) {
  const id = blocks[i]
  const body = blocks[i + 1] ?? ''
  const status = /- \*\*状态\*\*：(.+)/.exec(body)?.[1]?.trim() ?? '未标注'
  adrs.push({ id, status, accepted: /已接受/.test(status) })
}
const pendingAdrs = adrs.filter((a) => !a.accepted)

const pendingSignatures = (charter.match(/\| 待签 \|/g) ?? []).length
const p1Prereqs = ['| #2 |', '| #3 |', '| #4 |'].filter((k) => signoff.includes(k)).length
const securityItem5 = /\| 5 \| 自托管 Relay/.test(security)
const gateStatus = gate.freshness?.status ?? 'UNKNOWN'
const automatedOk = gate.automatedPassed === gate.automatedTotal && gate.automatedTotal > 0
const snapshotOk = gateStatus === 'CURRENT' || gateStatus === 'DRIFTED'
const envOk = env.verdict === 'READY'

const engineeringReady = automatedOk && snapshotOk && envOk && Boolean(reference) && securityItem5
const verdict = pendingSignatures === 0 && pendingAdrs.length === 0
  ? 'SIGNED_OFF'
  : engineeringReady
    ? 'READY_FOR_SIGNOFF'
    : 'ENGINEERING_NOT_READY'

const result = {
  schema: 'wbsync-signoff-readiness/1',
  capturedAt: new Date().toISOString(),
  verdict,
  note: 'SIGNED_OFF 需人工把 01 §9 与四个 ADR 状态改为已接受；脚本不代签，也不因未签字返回非 0。engineering 字段读自入库的本机证据，不代表当前 CI 环境',
  engineering: {
    currentHead: git('rev-parse', 'HEAD'),
    worktreeClean: (git('status', '--porcelain') ?? '').length === 0,
    automated: `${gate.automatedPassed ?? 0}/${gate.automatedTotal ?? 0}`,
    automatedOk,
    snapshotStatus: gateStatus,
    snapshotCapturedAt: gate.capturedAt ?? null,
    snapshotGitHead: gate.git?.head ?? null,
    snapshotOk,
    envVerdict: env.verdict ?? 'UNKNOWN',
    envPassed: `${env.passed ?? 0}/${env.total ?? 0}`,
    envToolchain: env.toolchain ? { node: env.toolchain.nodeVersion, pnpm: env.toolchain.pnpmVersion } : null,
    envOk,
    securityReviewItem5: securityItem5,
    workbuddyReference: Boolean(reference),
  },
  signatures: {
    pending: pendingSignatures,
    roles: ['发起人 / PM', '架构师', '安全 Owner', 'QA Owner'],
    source: 'docs/01_项目章程.md §9',
  },
  adrs,
  pendingAdrs: pendingAdrs.map((a) => a.id),
  p1Prereqs: {
    count: p1Prereqs,
    source: 'SIGN-OFF.md §二 · P1 开工前置清单',
    items: ['#2 pairSecret 生成/分发/账号绑定', '#3 配对状态三处权威归属', '#4 allowedEndpoints 覆盖 FR-6/FR-7'],
    note: '裁定权属于会签后的 ARC / 安全 Owner；会签时须在签署栏写明裁定人与 W3 前截止时点',
  },
  nextStep: verdict === 'READY_FOR_SIGNOFF'
    ? '四方会签（一次会议即可）：先看 SECURITY-REVIEW.md 五项，再签 ADR-007~010；签完按 SIGN-OFF.md §七 收尾'
    : verdict === 'SIGNED_OFF'
      ? '先裁定 P1 开工前置三项，再按 05 W3 进入编码'
      : '先修复未达标的自动项 / 快照 / 构建链',
}

const out = join(ROOT, 'spike', 'evidence', 'signoff-readiness.json')
if (!process.argv.includes('--no-write')) writeFileSync(out, JSON.stringify(result, null, 2), 'utf8')

console.log('会签就绪终检 ·', result.capturedAt, '| 依据：入库的本机证据，非当前 CI 环境')
console.log(`  当前 HEAD ${String(result.engineering.currentHead).slice(0, 8)}（工作区${result.engineering.worktreeClean ? '干净' : '有改动'}）| 快照 HEAD ${String(result.engineering.snapshotGitHead).slice(0, 8)} @ ${result.engineering.snapshotCapturedAt}`)
console.log(`  自动项 ${result.engineering.automated} ${automatedOk ? 'PASS' : 'FAIL'} | 快照 ${gateStatus} ${snapshotOk ? 'OK' : 'FAIL'}`)
console.log(`  M6b ${result.engineering.envPassed} ${result.engineering.envVerdict}${result.engineering.envToolchain ? ` (Node ${result.engineering.envToolchain.node} / pnpm ${result.engineering.envToolchain.pnpm})` : ''}`)
console.log(`  ADR 共 ${adrs.length} 个，待接受 ${pendingAdrs.length} 个：${pendingAdrs.map((a) => a.id).join(', ') || '无'}`)
console.log(`  四方会签：${pendingSignatures} 行「待签」 | 安全一页纸第 5 项 ${securityItem5 ? '存在' : '缺失'} | 对标复核 ${reference ? '存在' : '缺失'}`)
console.log(`  P1 开工前置：${p1Prereqs} 项已登记，裁定人会签时填写`)
console.log(`  结论：${verdict} —— ${result.nextStep}`)
if (!process.argv.includes('--no-write')) console.log('  证据:', out)
