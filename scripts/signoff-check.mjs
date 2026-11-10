#!/usr/bin/env node
/**
 * 会签状态终检（P0 · 一条命令出治理状态清单）
 * ---------------------------------------------------------------
 * 目的：把治理状态从「翻 11 份文档 + 4 个证据 JSON」压成一条命令。
 * 只读、不写业务文件；输出 spike/evidence/signoff-readiness.json 作附件。
 *
 *   node scripts/signoff-check.mjs              # 打印 + 写附件
 *   node scripts/signoff-check.mjs --no-write   # CI：只打印，不产生脏 diff
 *
 * 判定边界：**只报告，不代替签字，也不代替裁定**。脚本永远不因为治理状态
 * 返回非 0；CI 里作为记录步骤使用。读的是**入库的本机证据**，不是当前 CI 环境。
 *
 * 2026-11-10 19:4x：发起人永久取消四方会签（SIGNOFF-WAIVER.md）。此时 verdict 为
 * SIGNOFF_ABOLISHED，**不是** SIGNED_OFF；签署栏未填写、ADR 未由四方接受，
 * 不代签、不改写状态。SIGN-OFF-PROCEDURE.md 所列流程已废止，保留作历史记录。
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
const proposal = read('P1-PREREQUISITES.md')
const waiver = read('SIGNOFF-WAIVER.md')
const waiverActive = Boolean(waiver) && /^> 状态：\*\*永久生效\*\*/m.test(waiver)
const signoffAbolished = Boolean(waiver) && /四方会签要求已取消|永久取消/.test(waiver)

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
const p1PrereqKeys = ['| #2 |', '| #3 |', '| #4 |', '| #5b |']
const p1Prereqs = p1PrereqKeys.filter((k) => signoff.includes(k)).length
const securityItem5 = /\| 5 \| 自托管 Relay/.test(security)
const gateStatus = gate.freshness?.status ?? 'UNKNOWN'
const automatedOk = gate.automatedPassed === gate.automatedTotal && gate.automatedTotal > 0
const snapshotOk = gateStatus === 'CURRENT' || gateStatus === 'DRIFTED'
const envOk = env.verdict === 'READY'
const proposalReady = Boolean(proposal) && p1Prereqs === p1PrereqKeys.length

const engineeringReady = automatedOk && snapshotOk && envOk && Boolean(reference) && securityItem5 && proposalReady
const signedOff = pendingSignatures === 0 && pendingAdrs.length === 0
// 取消四方会签优先于一切签字判定：绝不因为签署栏清空而误报 SIGNED_OFF
const verdict = signoffAbolished
  ? 'SIGNOFF_ABOLISHED'
  : signedOff
    ? 'SIGNED_OFF'
    : !engineeringReady
      ? 'ENGINEERING_NOT_READY'
      : waiverActive
        ? 'DEV_PROCEED_WAIVED'
        : 'READY_FOR_SIGNOFF'

const result = {
  schema: 'wbsync-signoff-readiness/4',
  capturedAt: new Date().toISOString(),
  verdict,
  note: 'SIGNOFF_ABOLISHED 表示发起人永久取消了四方会签要求，**不是** SIGNED_OFF：原签署栏未填写、ADR-007~010 仍为「提议中」、不代签不代裁定。其余 GA 门禁（00 成功指标 / 07 M3 / 08 §10 / P3 W10 出网审计）照旧。脚本不因治理状态返回非 0。engineering 字段读自入库的本机证据，不代表当前 CI 环境',
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
    p1ProposalReady: proposalReady,
  },
  waiver: {
    active: waiverActive,
    abolished: signoffAbolished,
    document: waiver ? 'SIGNOFF-WAIVER.md' : null,
    scope: signoffAbolished ? '四方会签要求永久取消；P0 设计冻结由发起人裁定' : null,
    gaBlocked: false,
    note: signoffAbolished
      ? '原签署栏未填写、ADR 未由四方接受；不伪造签字，决策责任由发起人承接（09 R-20）'
      : null,
  },
  signatures: {
    pending: pendingSignatures,
    roles: ['发起人 / PM', '架构师', '安全 Owner', 'QA Owner'],
    source: 'docs/01_项目章程.md §9',
    note: signoffAbolished ? '四方会签已取消，此列表仅作历史角色记录' : null,
  },
  adrs,
  pendingAdrs: pendingAdrs.map((a) => a.id),
  p1Prereqs: {
    count: p1Prereqs,
    expected: p1PrereqKeys.length,
    source: 'SIGN-OFF.md §二 · P1 开工前置清单 / P1-PREREQUISITES.md',
    items: [
      '#2 pairSecret 生成/分发/账号绑定',
      '#3 配对状态三处权威归属',
      '#4 allowedEndpoints 覆盖 FR-6/FR-7',
      '#5b Cursor 双真源',
    ],
    proposalDocument: proposal ? 'P1-PREREQUISITES.md' : null,
    note: signoffAbolished
      ? '经发起人裁定采纳推荐方案为默认实现口径，非四方会签，可回滚'
      : '裁定权属于会签后的 ARC / 安全 Owner；会签时须写明裁定结论并回写 ADR 或 04',
  },
  nextStep: verdict === 'SIGNOFF_ABOLISHED'
    ? '四方会签已取消；按自动项 9/9 + 快照 CURRENT 继续推进，其余 GA 门禁（07 M3 / 08 §10 / P3 W10 出网审计）照旧'
    : verdict === 'SIGNED_OFF'
      ? '先裁定 P1 开工前置四项并回写契约，再按 05 W3 进入编码'
      : verdict === 'DEV_PROCEED_WAIVED'
        ? '继续 W3 开发；GA 前按 SIGN-OFF-PROCEDURE.md 补签，P3 W10 出网审计照旧'
        : verdict === 'READY_FOR_SIGNOFF'
          ? '一次会签：先看 SECURITY-REVIEW.md 五项并签 ADR-007~010，再裁定 P1-PREREQUISITES.md 四项；签完按 SIGN-OFF.md §七 收尾'
          : '先修复未达标的自动项 / 快照 / 构建链 / 会签材料',
}

const out = join(ROOT, 'spike', 'evidence', 'signoff-readiness.json')
if (!process.argv.includes('--no-write')) writeFileSync(out, JSON.stringify(result, null, 2), 'utf8')

console.log('会签状态终检 ·', result.capturedAt, '| 依据：入库的本机证据，非当前 CI 环境')
console.log(`  当前 HEAD ${String(result.engineering.currentHead).slice(0, 8)}（工作区${result.engineering.worktreeClean ? '干净' : '有改动'}）| 快照 HEAD ${String(result.engineering.snapshotGitHead).slice(0, 8)} @ ${result.engineering.snapshotCapturedAt}`)
console.log(`  自动项 ${result.engineering.automated} ${automatedOk ? 'PASS' : 'FAIL'} | 快照 ${gateStatus} ${snapshotOk ? 'OK' : 'FAIL'}`)
console.log(`  M6b ${result.engineering.envPassed} ${result.engineering.envVerdict}${result.engineering.envToolchain ? ` (Node ${result.engineering.envToolchain.node} / pnpm ${result.engineering.envToolchain.pnpm})` : ''}`)
console.log(`  ADR 共 ${adrs.length} 个，待接受 ${pendingAdrs.length} 个：${pendingAdrs.map((a) => a.id).join(', ') || '无'}`)
console.log(`  四方会签：${signoffAbolished ? '已取消（发起人裁定，非 SIGNED_OFF）' : `${pendingSignatures} 行「待签」`} | 安全一页纸第 5 项 ${securityItem5 ? '存在' : '缺失'} | 对标复核 ${reference ? '存在' : '缺失'}`)
console.log(`  发起人裁定：${signoffAbolished ? '四方会签永久取消，责任由发起人承接' : (waiverActive ? '开发期豁免生效中' : '无')}`)
console.log(`  P1 前置提案：${p1Prereqs}/${p1PrereqKeys.length} 项已登记，白皮书 ${proposal ? '存在' : '缺失'}（发起人裁定采纳默认口径）`)
console.log(`  结论：${verdict} —— ${result.nextStep}`)
if (!process.argv.includes('--no-write')) console.log('  证据:', out)
