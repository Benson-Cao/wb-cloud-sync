#!/usr/bin/env node
/**
 * 发起人豁免 + P1 W3 开工后的状态回填
 * ---------------------------------------------------------------
 * 沿用前几轮纪律：每处「恰好 1 次命中」断言、同文件串行 apply 只写一次盘、
 * 原文备份到 .revisions-backup-workbuddy/waiver-p1/。
 *
 *   node scripts/apply-waiver-and-p1.mjs --dry-run
 *   node scripts/apply-waiver-and-p1.mjs
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const dryRun = process.argv.includes('--dry-run')
const L = (...lines) => lines.join('\n')

const EDITS = {
  'SIGN-OFF.md': [
    [L('## 零、剩余工作盘点（2026-11-10 09:0x 复核）'),
     L('## 零、剩余工作盘点（2026-11-10 09:3x 复核 · 发起人豁免开发期会签）')],
    [L('**仓库状态**（2026-11-10 复核）：工作区干净；门禁快照 `CURRENT`（9/9 PASS）、`wbsync/1 r2` 已推送、CI 绿灯。已完成 r2 对标复核、旧口径清理、M6b 闭环与 `P1-PREREQUISITES.md` 提案白皮书；详见 `WORKBUDDY-REFERENCE.md`、`CHANGELOG.md` 与 `scripts/signoff-check.mjs`。'),
     L('**仓库状态**（2026-11-10 复核）：工作区干净；门禁快照 `CURRENT`（9/9 PASS）、CI 绿灯。已完成 r2 对标复核、旧口径清理、M6b 闭环与 `P1-PREREQUISITES.md` 提案白皮书。**发起人已豁免开发期会签**（`SIGNOFF-WAIVER.md`），P1 W3 第一项 Relay 骨架已落地；P0 设计冻结**未完成**，GA 前必须补签。详见 `CHANGELOG.md` 与 `scripts/signoff-check.mjs`。')],
    [L('| **P0 人工项** | M6a CI 接入 MET、**M6b 本地构建链 5/5 READY** | **M1 四方会签 + M2~M4 / M7 四个 ADR + M5 安全一票否决**（本质是**一次会签**） | 人签字 |'),
     L('| **P0 人工项** | M6a CI 接入 MET、**M6b 本地构建链 5/5 READY** | **M1 四方会签 + M2~M4 / M7 四个 ADR + M5 安全一票否决**；**发起人已豁免开发期**（`SIGNOFF-WAIVER.md`），签署栏与 ADR 状态未改 | 人签字（GA 阻塞） |')],
    [L('| **P1 MVP（W3–W6）** | 0 | **全部**：Relay 骨架、CP、配对、事件透传、幂等 prompt、队列、PWA 骨架、M1 验收 | 会签前**禁止启动**（01 §9 / 05 W1） |'),
     L('| **P1 MVP（W3–W6）** | **W3 Relay 骨架 + 9/9 单测**（`p1/relay/`） | CP / WS 帧代理 / Host 插件 / PWA / 队列 / M1 验收 | 发起人豁免开发期；GA 前仍须补签 |')],
    [L('**量化结论**：P0 的技术验证、文档链路、CI 闸门与本机构建链 **100% 完成**；P0 只剩 **1 次会签**（四方 + ADR-007~010）；P1–P3 共 **10 周工作量一行代码未动，且按规程不得提前动**。11-10 对标复核在会签前新增 ADR-010，会签项由 3 个 ADR 增至 4 个，仍属同一次会签。P1 开工前置四项已备好提案，可并入同一次会签裁定，不增加会议次数。'),
     L('**量化结论**：P0 自动项、文档链路、CI 闸门与本机构建链 **100% 完成**；**四方会签由发起人豁免**（`SIGNOFF-WAIVER.md`），P0 设计冻结**未完成**，GA 前必须补签。P1 已按 `05` W3 启动：Relay 开发骨架 + 9/9 单测落地，W3 其余项与 W4–W12 未动。**一票否决权在豁免期依然有效**，任一 Owner 提出异议即暂停 P1。P1 前置四项按推荐方案作默认实现口径（未经会签、可回滚）。')],
  ],

  'docs/09_风险登记册.md': [
    [L('| R-19 | **"正文不上云"被误读为"Relay 也看不到"**，部署方把自托管 Relay 托管到不可信第三方 / 忽略主机访问控制，或 GA 审计按错误口径判失败 | 3 | 4 | 12 | 黄 | `04` §5.4 明确 at-rest 与 in-transit 边界；ADR-010 待 ARC + 安全 Owner 会签；`10` §6 增加 Relay 主机加固清单；`SECURITY-REVIEW.md` 第 1/5 项列为安全 Owner 必看；端到端加密列 `wbsync/2` 候选 | ARC + 安全 Owner | 部署咨询、GA 审计结论与文档口径不一致 |'),
     L('| R-19 | **"正文不上云"被误读为"Relay 也看不到"**，部署方把自托管 Relay 托管到不可信第三方 / 忽略主机访问控制，或 GA 审计按错误口径判失败 | 3 | 4 | 12 | 黄 | `04` §5.4 明确 at-rest 与 in-transit 边界；ADR-010 待 ARC + 安全 Owner 会签；`10` §6 增加 Relay 主机加固清单；`SECURITY-REVIEW.md` 第 1/5 项列为安全 Owner 必看；端到端加密列 `wbsync/2` 候选 | ARC + 安全 Owner | 部署咨询、GA 审计结论与文档口径不一致 |',
       '| R-20 | **发起人跳过会签即进入编码**：安全 Owner 一票否决未行使、隐私第 5 项未经书面接受、P1 前置四项未裁定 | 3 | 5 | **15** | 红 | `SIGNOFF-WAIVER.md` 显式登记残留风险与 GA 前补签条件；实现按 ADR-010 默认口径（零落盘 / Relay 自托管）；四项前置按推荐方案作默认值并标注可回滚；任一 Owner 提出异议即暂停 P1；P3 W10 出网审计与 `08` §10 合规检查单照旧 | 发起人 + 安全 Owner | GA 前未补签、安全 Owner 提出异议、审计结论与文档口径不一致 |')],
    [L('| r2 | 2026-11-10 | WorkBuddy 对标复核：新增 R-19，R-04 缓解口径校正（19 项，红 3 / 黄 12 / 绿 4） | PM |'),
     L('| r2 | 2026-11-10 | WorkBuddy 对标复核：新增 R-19，R-04 缓解口径校正（19 项，红 3 / 黄 12 / 绿 4） | PM |',
       '| r3 | 2026-11-10 | 发起人豁免开发期会签：新增 R-20（红，15 分），登记未行使一票否决与未裁定前置（20 项，红 4 / 黄 12 / 绿 4） | PM |')],
  ],

  'README.md': [
    [L('├─ SIGN-OFF-PROCEDURE.md       # 人的会签操作卡（顺序 / 勾选 / 回写清单）'),
     L('├─ SIGN-OFF-PROCEDURE.md       # 人的会签操作卡（顺序 / 勾选 / 回写清单）',
       '├─ SIGNOFF-WAIVER.md           # 发起人豁免记录（开发期跳过会签，GA 前补签）')],
    [L('└─ LICENSE (MIT)'),
     L('├─ p1/                          # P1 开发代码（W3 Relay 骨架，不进探针 tarball）',
       '└─ LICENSE (MIT)')],
  ],

  'CHANGELOG.md': [
    [L('---', '', '## [会签操作卡] · 2026-11-10 09:2x · 非协议变更'),
     L('---', '',
       '## [发起人豁免 + P1 开工] · 2026-11-10 09:3x · 非协议变更',
       '',
       '- 用户指令「跳过会签」。**不伪造签字**：`01` §9 四行仍「待签」、ADR-007~010 仍「提议中」、`SECURITY-REVIEW.md` 会签表仍「待签」、`SIGN-OFF.md` 签署栏未动。新增 `SIGNOFF-WAIVER.md` 把流程例外回写成可审计文档（`05` §4）。',
       '- 豁免范围：仅 W3–W6 内部开发；**GA / 对外发布 / 20 人灰度仍须补签**，`00` GA 门禁、`08` §10 合规检查单、P3 W10 出网流量镜像审计照旧。一票否决权在豁免期依然有效，任一 Owner 提出异议即暂停 P1。',
       '- 显式接受 4 项残留风险（安全一票否决未行使 / 第 5 项未书面接受 / 第 3·4 项待验证 / P1 前置四项未裁定）；四项按 `P1-PREREQUISITES.md` 推荐方案作**默认实现口径**，标注未经会签、可回滚。`09` 新增 **R-20**（红，15 分）。',
       '- 门禁语义：`signoff-check.mjs` verdict 改为 `DEV_PROCEED_WAIVED`（**不是** `SIGNED_OFF`），schema 升 `wbsync-signoff-readiness/3`；`gate-check.mjs` 的 `gate` 仍 `BLOCKED_BY_SIGNOFF`（自动项判定与治理状态分开）。豁免文件纳入 `signoff` 指纹组，改动即 `STALE`。',
       '- **P1 W3 第一项落地**：新增 `p1/relay/`（零依赖、Node ≥ 24.9）——6 位码 / TTL / 限速、challenge + per-challenge `pairSecret`、HMAC 签发设备令牌（只落 SHA-256 摘要、单活跃令牌）、Host 注册 / 心跳 45s 判离线、`HOST_OFFLINE` 409、白名单 403、HTTP 轮询桥 + `NO_PROGRESS` 504、`/admin` 指纹、`sinceSeq` 仅观测。`node --test` **9/9 PASS**。',
       '- **首个缺陷由单测抓出并修复**：`pair/verify` 用值里不存在的 `c.challenge` 算 HMAC → 500；改用 Map 键 `String(body.challenge)`，并在通用 500 分支把真实异常打到 stderr，避免根因被吞。',
       '- 四项默认裁定直接编进代码（#2 / #3 / #4 / #5b），不是悬空文档；WS 帧代理与 CP 分离列为 W3 下一步，写在 `p1/relay/README.md`。`p1/` 不进可安装探针 tarball（根 `package.json` 的 `files` 白名单只含 5 个文件）；`gate.yml` 新增阻断步骤 `P1 Relay 冒烟测试`。',
       '- 状态回填：`SIGN-OFF.md` §零进度表、`09` R-20、`README.md` 目录树、`CHANGELOG.md`；新增 `scripts/apply-waiver-and-p1.mjs`（断言 + 备份）。改 README 后重打包 `dist/*.tgz` 保 G9；改判据 / 会签材料后按门禁 v4 重算快照。',
       '',
       '**P0 设计冻结仍未完成**：发起人只豁免了开发期等待，GA 前必须按 `SIGN-OFF-PROCEDURE.md` 补签。',
       '',
       '---', '',
       '## [会签操作卡] · 2026-11-10 09:2x · 非协议变更')],
  ],

  '.github/workflows/gate.yml': [
    [L('      # 会签就绪终检：输出待签清单与 P1 前置，报告型，不阻断 CI。',
       '      - name: 会签就绪终检（记录，不阻断）',
       '        run: node scripts/signoff-check.mjs --no-write'),
     L('      # 会签就绪终检：输出待签清单与 P1 前置，报告型，不阻断 CI。',
       '      - name: 会签就绪终检（记录，不阻断）',
       '        run: node scripts/signoff-check.mjs --no-write',
       '',
       '      # W3 起进入开发期：Relay 骨架单测作为阻断项（零依赖，Node 24）。',
       '      - name: P1 Relay 冒烟测试',
       '        run: node --test p1/relay/test/*.test.mjs')],
  ],
}

const targets = Object.entries(EDITS).map(([name, reps]) => ({ file: join(ROOT, name), reps }))
let problems = 0
for (const t of targets) {
  if (!existsSync(t.file)) { console.error(`MISSING ${t.file}`); problems++; continue }
  const text = readFileSync(t.file, 'utf8')
  t.original = text
  let next = text
  for (let i = 0; i < t.reps.length; i++) {
    const [from] = t.reps[i]
    const hits = next.split(from).length - 1
    if (hits !== 1) {
      console.error(`HIT ${hits} (want 1)  ${basename(t.file)}  repl#${i + 1}  ${from.slice(0, 70).replace(/\n/g, '\\n')}`)
      problems++
    } else {
      next = next.replace(from, t.reps[i][1])
    }
  }
  t.result = next
}
if (problems) {
  console.error(`\nABORT: ${problems} 处断言失败，未写入任何文件。`)
  process.exit(1)
}
console.log(`断言全过：${targets.length} 个文件 / ${targets.reduce((n, t) => n + t.reps.length, 0)} 处替换` + (dryRun ? '（--dry-run，未写盘）' : ''))
if (dryRun) process.exit(0)

const backupDir = join(ROOT, '.revisions-backup-workbuddy', 'waiver-p1')
mkdirSync(backupDir, { recursive: true })
for (const t of targets) {
  const rel = t.file.replace(ROOT, '').replace(/^[\\/]/, '').replace(/[\\/]/g, '__')
  writeFileSync(join(backupDir, rel), t.original, 'utf8')
  writeFileSync(t.file, t.result, 'utf8')
  console.log(`  wrote ${t.file}`)
}
console.log(`备份：${backupDir}`)
