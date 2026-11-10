#!/usr/bin/env node
/**
 * P1 开工前置提案就绪后的状态回填
 * ---------------------------------------------------------------
 * 纪律沿用前两个修订脚本：每处「恰好 1 次命中」断言、同文件串行 apply
 * 只写一次盘、原文备份到 .revisions-backup-workbuddy/p1-prereq/。
 *
 *   node scripts/apply-p1-prereq-updates.mjs --dry-run
 *   node scripts/apply-p1-prereq-updates.mjs
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const dryRun = process.argv.includes('--dry-run')
const L = (...lines) => lines.join('\n')

const EDITS = {
  'docs/04_接口协议与数据模型.md': [
    [L('> 字段名以锁定的 DSH commit 实际类型为准；标注「示意」处需在 W1 Spike 后回填精确类型。'),
     L('> 字段名以锁定的 DSH commit 实际类型为准；W1 Spike 已完成实测回填（见 §3）。上游升级前须重跑全量契约测试（见 `07`）。')],
  ],

  'spike/REPORT.md': [
    [L('| #2 `pairSecret` 未定义 | **仍未解决**（属配对协议，非 Spike 范围）：`pairSecret` 的生成 / 分发与 OAuth 主体绑定需 ARC 补 |'),
     L('| #2 `pairSecret` 未定义 | **提案已就绪，待会签裁定**（`P1-PREREQUISITES.md` §1）：推荐 per-challenge 一次性随机数 + 五条边界；带外长密钥列为 v2 加固候选 |')],
    [L('| #3 配对状态三处归属 | **仍未解决**（CP / Relay / Host 本地三处），需定权威表与时序 |'),
     L('| #3 配对状态三处归属 | **提案已就绪，待会签裁定**（`P1-PREREQUISITES.md` §2）：CP 管档案 / Relay 管令牌 / Host 仅缓存，含两帧时序与失败回滚 |')],
    [L('| #4 白名单 vs FR-6/FR-7 | **仍未解决**：`allowedEndpoints` 只有 `session/*`、`$events/*`，附件 / 产物 / 定时任务端点无归属 |'),
     L('| #4 白名单 vs FR-6/FR-7 | **提案已就绪，待会签裁定**（`P1-PREREQUISITES.md` §3）：分阶段开放 `artifacts/*`（P1）、`attachments/*` + `schedule/*`（P2）；附件写能力须安全 Owner 单独确认 |')],
    [L('| #5 幂等表 / RouteLease / Cursor | **已修复（ADR-008 提议中）**：Host 侧去重归宿主 `requestId`，CP 侧 `Idempotency` 降级为路由审计；Cursor 双真源仍待定 |'),
     L('| #5 幂等表 / RouteLease / Cursor | **已修复（ADR-008 提议中）**：Host 侧去重归宿主 `requestId`，CP 侧 `Idempotency` 降级为路由审计；**#5b Cursor 双真源提案已就绪**（`P1-PREREQUISITES.md` §4）：客户端 `sinceSeq` 唯一权威，CP `Cursor` 降为可观测性快照 |')],
    [L('> **#2 / #3 / #4 的裁定权属于会签后的 ARC 与安全 Owner**（配对密钥涉及信任边界、白名单涉及 `08` §5 权限评审），本阶段不代签、不擅自改契约；三项已提升为 `SIGN-OFF.md` §二的「P1 开工前置清单」，会签时须显式确认由谁在 W3 前裁定。'),
     L('> **#2 / #3 / #4 / #5b 的裁定权属于会签后的 ARC 与安全 Owner**（配对密钥涉及信任边界、白名单涉及 `08` §5 权限评审），本阶段不代签、不擅自改契约。`P1-PREREQUISITES.md` 已把四项整理成带方案、权衡、推荐与契约影响清单的会签输入，`SIGN-OFF.md` §二保留「P1 开工前置清单」，会签时须显式确认裁定人与 W3 前截止时点。')],
    [L('4. **解决上表 #2 / #3 / #4**：配对密钥与账号绑定、配对状态权威归属、白名单端点覆盖。'),
     L('4. **裁定上表 #2 / #3 / #4 / #5b**：`P1-PREREQUISITES.md` 已备好方案、权衡、推荐与契约影响清单；会签时一次性裁定，结论回写 ADR 或 `04`，之后才按 `05` W3 进入编码。')],
  ],

  'SIGN-OFF.md': [
    [L('## 零、剩余工作盘点（2026-11-10 08:5x 复核）'),
     L('## 零、剩余工作盘点（2026-11-10 09:0x 复核）')],
    [L('**仓库状态**（2026-11-10 复核）：工作区干净；门禁快照 `CURRENT`（9/9 PASS）、`wbsync/1 r2` 已推送 `d4f02cb`、CI 绿灯。本轮（r2 后续）清掉了旧口径残留、闭环 M6b、新增会签就绪终检；详见 `WORKBUDDY-REFERENCE.md`、`CHANGELOG.md` 与 `scripts/signoff-check.mjs`。'),
     L('**仓库状态**（2026-11-10 复核）：工作区干净；门禁快照 `CURRENT`（9/9 PASS）、`wbsync/1 r2` 已推送、CI 绿灯。已完成 r2 对标复核、旧口径清理、M6b 闭环与 `P1-PREREQUISITES.md` 提案白皮书；详见 `WORKBUDDY-REFERENCE.md`、`CHANGELOG.md` 与 `scripts/signoff-check.mjs`。')],
    [L('| **P0 人工项** | M6a CI 接入 MET、**M6b 本地构建链 5/5 READY** | **M1 四方会签 + M2~M4 / M7 四个 ADR + M5 安全一票否决**（本质是**一次会签**） | 人签字 |'),
     L('| **P0 人工项** | M6a CI 接入 MET、**M6b 本地构建链 5/5 READY** | **M1 四方会签 + M2~M4 / M7 四个 ADR + M5 安全一票否决**（本质是**一次会签**） | 人签字 |',
       '| **P1 开工前置** | **4 项提案白皮书已就绪**（`P1-PREREQUISITES.md`） | 会签时一次性裁定，结论回写 ADR 或 `04`（预计 `wbsync/1 r3`） | 人的决策 |')],
    [L('**量化结论**：P0 的技术验证、文档链路、CI 闸门与本机构建链 **100% 完成**；P0 只剩 **1 次会签**（四方 + ADR-007~010）；P1–P3 共 **10 周工作量一行代码未动，且按规程不得提前动**。11-10 对标复核在会签前新增 ADR-010，会签项由 3 个 ADR 增至 4 个，仍属同一次会签。'),
     L('**量化结论**：P0 的技术验证、文档链路、CI 闸门与本机构建链 **100% 完成**；P0 只剩 **1 次会签**（四方 + ADR-007~010）；P1–P3 共 **10 周工作量一行代码未动，且按规程不得提前动**。11-10 对标复核在会签前新增 ADR-010，会签项由 3 个 ADR 增至 4 个，仍属同一次会签。P1 开工前置四项已备好提案，可并入同一次会签裁定，不增加会议次数。')],
    [L('### P1 开工前置清单（本阶段不代签，会签时须显式确认裁定人）',
       '',
       '`spike/REPORT.md` §6 标为「仍未解决」的三项，裁定权属于会签后的 ARC / 安全 Owner，**不属 P0 自动项**，也不由本轮擅自改契约：',
       '',
       '| 编号 | 缺口 | 为何 P0 不定 | 建议裁定人 / 时点 |',
       '|---|---|---|---|',
       '| #2 | `pairSecret` 的生成、分发与账号绑定未定义（`04` §5.1 时序里凭空出现） | 涉及信任边界与密钥分发，须安全 Owner 参与；贸然写死会锁死实现 | ARC + 安全 Owner · W3 详细设计前 |',
       '| #3 | 配对状态在 CP / Relay / Host 本地三处归属未定权威 | 决定鉴权真源，属架构决策，需 ADR | ARC · W3 详细设计前 |',
       '| #4 | `allowedEndpoints` 只有 `session/*`、`$events/*`，FR-6 附件/产物与 FR-7 定时任务端点无归属 | `08` §5 规定新增端点必须走 ADR + 白名单评审，且附件上传是写能力 | ARC + 安全 Owner · W3 详细设计前 |',
       '',
       '> 这三项**不阻塞 P0 会签，但阻塞 W3 编码**；会签时请在签署栏备注写明裁定人与截止时点，避免「签完就开工」时才发现契约空白。'),
     L('### P1 开工前置清单（本阶段不代签，会签时一次性裁定）',
       '',
       '`spike/REPORT.md` §6 登记的四项契约空白，裁定权属于会签后的 ARC / 安全 Owner，**不属 P0 自动项**，也不由本轮擅自改契约。完整方案、权衡、推荐与契约影响清单见 **[`P1-PREREQUISITES.md`](P1-PREREQUISITES.md)**：',
       '',
       '| 编号 | 缺口 | 推荐裁定 | 裁定人 / 时点 |',
       '|---|---|---|---|',
       '| #2 | `pairSecret` 的生成 / 分发 / 账号绑定未定义（`04` §5.1 时序里凭空出现） | per-challenge 一次性随机数 + 五条边界；带外长密钥列 v2 加固 | ARC + 安全 Owner · W3 前 |',
       '| #3 | 配对状态在 CP / Relay / Host 本地三处无权威 | CP 管档案 / Relay 管令牌 / Host 仅缓存，补两帧时序与失败回滚 | ARC · W3 前 |',
       '| #4 | `allowedEndpoints` 未覆盖 FR-6 附件/产物与 FR-7 定时任务 | 分阶段开放 `artifacts/*`（P1）、`attachments/*` + `schedule/*`（P2）；附件写能力单独确认 | ARC + 安全 Owner · W3 前 |',
       '| #5b | `Cursor` 双真源（CP 表 vs 客户端 `sinceSeq`）未定 | 客户端 `sinceSeq` 唯一权威，CP `Cursor` 降为可观测性快照 | ARC · W3 前 |',
       '',
       '> 这四项**不阻塞 P0 会签，但阻塞 W3 编码**；会签时请在签署栏备注写明裁定结论与截止时点，结论必须回写 ADR 或 `04`（`05` §4）。若四项全部采纳，预计产生 `wbsync/1 r3`，需 `PROTOCOL.md` 单向同步 + `CHANGELOG.md` 记一条。')],
  ],

  'SECURITY-REVIEW.md': [
    [L('> 若勾选「附条件同意」，请把条件抄进 `SIGN-OFF.md` 的签署栏备注，并在 `CHANGELOG.md` 记一条；只在大群里说不算决策（`05` §4）。'),
     L('> 若勾选「附条件同意」，请把条件抄进 `SIGN-OFF.md` 的签署栏备注，并在 `CHANGELOG.md` 记一条；只在大群里说不算决策（`05` §4）。',
       '',
       '## 会签时还需裁定的两项',
       '',
       '`P1-PREREQUISITES.md` 把安全 Owner 列为 **#2（配对密钥边界）** 与 **#4（端点白名单分阶段开放）** 的裁定人：',
       '',
       '- **#2**：确认是否接受「`pairSecret` 不承担身份鉴别，身份门槛是同账号 + PC 显式开关 + 6 位短码 TTL/限速 + 一次性挑战」。若要求「即使拿到短码也连不上」，须升级到带外长密钥方案并同步修改二维码口径。',
       '- **#4**：单独确认 `attachments/*` 让手机向 PC 工作区写文件的能力；它与第 1 项「文件不离开 PC」不是同一回事（文件进 PC、不是出 PC），但仍属写权限扩张，不能随其它只读端点批量放行。',
       '',
       '两项均备有替代方案与契约影响清单，本页不代为裁定。')],
  ],

  'README.md': [
    [L('├─ WORKBUDDY-REFERENCE.md       # WorkBuddy 手机/电脑端对标复核（r2 修订依据）'),
     L('├─ WORKBUDDY-REFERENCE.md       # WorkBuddy 手机/电脑端对标复核（r2 修订依据）',
       '├─ P1-PREREQUISITES.md          # P1 开工前置四项提案（提议中，待会签裁定）')],
    [L('**P0 门禁**：三问离线 PASS、真机加载 + 运行时事件闭环 8/8 PASS、上游 commit 锁定（`66491b0…`）、`04` 已修订至 `wbsync/1 r2`（含 WorkBuddy 对标复核）、自动项 9/9、快照 `CURRENT`、M6b 构建链 5/5 `READY`。**唯一剩余硬阻塞是四方会签**（ADR-007~010 均为「提议中」），完成前不得进入 P1 编码。详见 `SIGN-OFF.md` 与 `spike/REPORT.md` §5。'),
     L('**P0 门禁**：三问离线 PASS、真机加载 + 运行时事件闭环 8/8 PASS、上游 commit 锁定（`66491b0…`）、`04` 已修订至 `wbsync/1 r2`（含 WorkBuddy 对标复核）、自动项 9/9、快照 `CURRENT`、M6b 构建链 5/5 `READY`。**唯一剩余硬阻塞是四方会签**（ADR-007~010 均为「提议中」），完成前不得进入 P1 编码。P1 开工前置四项已有提案白皮书 `P1-PREREQUISITES.md`，可并入同一次会签裁定。详见 `SIGN-OFF.md` 与 `spike/REPORT.md` §5。')],
  ],

  'CHANGELOG.md': [
    [L('---', '', '## [r2 后续] · 2026-11-10 08:5x · 非协议变更'),
     L('---', '',
       '## [P1 前置提案] · 2026-11-10 09:0x · 非协议变更',
       '',
       '**性质**：把 `spike/REPORT.md` §6 的「仍未解决」整理成可会签的提案；**未修改任何契约字段、未新增 ADR、未启动 P1 编码**。',
       '',
       '- 新增 **`P1-PREREQUISITES.md`**：四项提案（#2 `pairSecret`、#3 配对状态权威、#4 端点白名单、#5b `Cursor` 双真源），每项含问题、方案对比、推荐裁定、契约影响清单与裁定人；明确标注「提议中，待会签裁定」。',
       '  - #2 推荐 per-challenge 一次性随机数 + 五条边界，并写明 `pairSecret` 不承担身份鉴别；带外长密钥列 v2 加固候选，PAKE 否决。',
       '  - #3 定 CP 管档案 / Relay 管令牌 / Host 仅缓存，补 `device/paired` / `device/updated` 两帧与失败回滚。',
       '  - #4 分阶段开放 `artifacts/*`（P1）、`attachments/*` + `schedule/*`（P2）；附件写能力须安全 Owner 单独确认；v1 不做的 `config/*` / `permission/*` / `remote-desktop/*` 不开放。',
       '  - #5b 客户端 `sinceSeq` 唯一权威，CP `Cursor` 降为可观测性快照（避免服务端游标领先导致漏事件）。',
       '- **会签效率**：四项并入同一次会议裁定，不增加会议次数；若全部采纳，预计 `wbsync/1 r3`（仅新增可选帧/端点前缀与说明，无删除改名）。',
       '- 状态回填：`SIGN-OFF.md` §零进度表新增「P1 开工前置」行、§二清单由 3 项扩为 4 项并指向白皮书；`SECURITY-REVIEW.md` 新增「会签时还需裁定的两项」；`spike/REPORT.md` §6/§7 的「仍未解决」改为「提案已就绪，待会签裁定」；`README.md` 目录树与门禁段同步。',
       '- 清掉一处过时表述：`04` 头部「标注『示意』处需在 W1 Spike 后回填精确类型」——W1 Spike 早已完成实测回填，改为「上游升级前须重跑全量契约测试」；`PROTOCOL.md` 由单向同步脚本重生成。',
       '- `scripts/signoff-check.mjs` 升级：P1 前置计数 3→4、新增提案白皮书存在性校验，输出区分「工程就绪」与「待裁定」。',
       '- 新增 `scripts/apply-p1-prereq-updates.mjs`（每处恰好 1 次命中断言 + 原文备份）；`docs/04` 同步回桌面原稿，11 份文档仍逐字节一致。',
       '',
       '**P0 门禁状态不变**：`BLOCKED_BY_SIGNOFF`；工程侧 100% 完成，剩余只有一次会签。',
       '',
       '---', '',
       '## [r2 后续] · 2026-11-10 08:5x · 非协议变更')],
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

const backupDir = join(ROOT, '.revisions-backup-workbuddy', 'p1-prereq')
mkdirSync(backupDir, { recursive: true })
for (const t of targets) {
  const rel = t.file.replace(ROOT, '').replace(/^[\\/]/, '').replace(/[\\/]/g, '__')
  writeFileSync(join(backupDir, rel), t.original, 'utf8')
  writeFileSync(t.file, t.result, 'utf8')
  console.log(`  wrote ${t.file}`)
}
console.log(`备份：${backupDir}`)
