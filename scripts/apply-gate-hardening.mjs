#!/usr/bin/env node
/**
 * 门禁 v4 加固后的文档同步
 * ---------------------------------------------------------------
 * 沿用前几轮纪律：每处「恰好 1 次命中」断言、同文件串行 apply 只写一次盘、
 * 原文备份到 .revisions-backup-workbuddy/gate-v4/。
 *
 *   node scripts/apply-gate-hardening.mjs --dry-run
 *   node scripts/apply-gate-hardening.mjs
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const dryRun = process.argv.includes('--dry-run')
const L = (...lines) => lines.join('\n')

const EDITS = {
  'SIGN-OFF.md': [
    [L('| G8 | 仓库跟踪文件无 PAT / 密钥 | PASS · 0 命中 |'),
     L('| G8 | 工作区（含未跟踪文件）多形态密钥扫描 | PASS · 0 命中 / 4 类形态 |')],
    [L('**指纹分三组**（不按 git HEAD 判，只改提交信息不该让快照失效）：',
       '',
       '| 组 | 文件 | 变了意味着 | 判定 |',
       '|---|---|---|---|',
       '| **data（事实）** | `index.js`、`cordis.patch.yml`、`package.json`、`host-probe.json`、`check-plugin.json` | 运行代码或实测证据已变 | **`STALE`** → CI exit 2，必须重算 |',
       '| **artifact（发布物）** | `dist/*.tgz` | 重新打包了 | **仅记录 + NOTE，不影响判定** |',
       '| **narrative（说法）** | `REPORT.md`、`PROTOCOL.md` | 措辞 / 描述更新 | **`DRIFTED`**，放行 + NOTE |',
       '',
       '- **为什么 artifact 不参与判定**：`npm pack` **不可复现**——同样内容两次打包 sha 不同（gzip 头带时间戳）。实测：只给 README 加一个空行再 repack，tgz sha 从 `6904a9e2…` 变成 `b8549748…`；恢复 README 再 repack 仍是新 sha。若纳入判定，每次打包都会误报。',
       '- 三档：`CURRENT`（data 与 narrative 一致）／`DRIFTED`（仅描述漂移，不阻断）／`STALE`（data 变 / 旧格式快照 / 超期）。',
       '- 兜底上限 **30 天**：即使数据没变，超过 30 天的快照也判 `STALE`。',
       '- 一句话：**改错别字不拦人，重新打包不误报，运行代码或实测证据一变就拦死。**',
       '- ✅ 「发布物与源码是否一致」由 **G9 解包比对**覆盖：不比 tgz 本身（不可复现），而是解包后逐文件比 sha256，5/5 一致才 PASS。实测：改 `index.js` 但不 repack → G9 FAIL、自动项 8/9、exit 1。因此**保留 `dist/*.tgz` 在仓库、继续走 GitHub 分发**是安全的。',
       '- 会签时请抄下 `capturedAt` / `git.head` / `fingerprints.data` 摘要写进签署栏备注，事后可复核。'),
     L('**指纹分四组**（不按 git HEAD 判，只改提交信息不该让快照失效）：',
       '',
       '| 组 | 文件 | 变了意味着 | 判定 |',
       '|---|---|---|---|',
       '| **data（事实）** | `index.js`、`cordis.patch.yml`、`package.json`、`host-probe.json`、`check-plugin.json` | 运行代码或实测证据已变 | **`STALE`** → CI exit 2，必须重算 |',
       '| **signoff（会签材料）** | `SECURITY-REVIEW.md`、`SIGN-OFF.md`、`docs/01` 会签表、`P1-PREREQUISITES.md`、`WORKBUDDY-REFERENCE.md` | **签字人实际要读的材料被改** | **`STALE`** → CI exit 2，必须重算 |',
       '| **artifact（发布物）** | `dist/*.tgz` | 重新打包了 | **仅记录 + NOTE，不影响判定** |',
       '| **narrative（说法）** | `REPORT.md`、`PROTOCOL.md` | 措辞 / 描述更新 | **`DRIFTED`**，放行 + NOTE |',
       '',
       '- **为什么加 signoff 组**（2026-11-10 门禁可靠性审计）：原先会签材料不在任何指纹组里，若有人把 `SECURITY-REVIEW.md` 第 5 项从「须书面接受」改成「已通过」，快照仍 `CURRENT`、CI 仍绿灯，签字人会签在被改过的材料上。会签材料变化按 **`STALE`** 阻断处理，比 `DRIFTED` 更严。',
       '- **为什么 artifact 不参与判定**：`npm pack` **不可复现**——同样内容两次打包 sha 不同（gzip 头带时间戳）。实测：只给 README 加一个空行再 repack，tgz sha 从 `6904a9e2…` 变成 `b8549748…`；恢复 README 再 repack 仍是新 sha。若纳入判定，每次打包都会误报。',
       '- 三档：`CURRENT`（四组一致）／`DRIFTED`（仅描述漂移，不阻断）／`STALE`（data 或 signoff 变 / 旧格式快照 / 超期）。缺 `signoff` 组的 v3 快照按旧格式判 `STALE`，不静默放行。',
       '- 兜底上限 **30 天**：即使数据没变，超过 30 天的快照也判 `STALE`。',
       '- 一句话：**改错别字不拦人，重新打包不误报，运行代码、实测证据或会签材料一变就拦死。**',
       '- ✅ 「发布物与源码是否一致」由 **G9 解包比对**覆盖：不比 tgz 本身（不可复现），而是解包后逐文件比 sha256，5/5 一致才 PASS。实测：改 `index.js` 但不 repack → G9 FAIL、自动项 8/9、exit 1。因此**保留 `dist/*.tgz` 在仓库、继续走 GitHub 分发**是安全的。',
       '- **G8 加固**：由「只扫已跟踪文件的 `ghp_`」改为遍历工作区（含未跟踪文件）+ 4 类形态（GitHub classic / 细粒度 PAT / `sk-` 型 / 私钥头）；命中只记录路径、行号与形态，不把匹配内容写进证据。',
       '- 会签时请抄下 `capturedAt` / `git.head` / `fingerprints.data` / `fingerprints.signoff` 摘要写进签署栏备注，事后可复核。')],
  ],

  'SECURITY-REVIEW.md': [
    [L('| 2 | 日志会不会把聊天内容、令牌、文件打出来？ | `08` §8 日志白名单 | **已验证**：真机探针的 `eventShapes` 只含 `{type, seq, subjectId, eventKeys}`，8/8 断言含「不落事件正文」（`spike/REPORT.md` §4.1.2）；证据 JSON 已脱敏，全 history 密钥扫描 0 命中。✅ |'),
     L('| 2 | 日志会不会把聊天内容、令牌、文件打出来？ | `08` §8 日志白名单 | **已验证**：真机探针的 `eventShapes` 只含 `{type, seq, subjectId, eventKeys}`，8/8 断言含「不落事件正文」（`spike/REPORT.md` §4.1.2）；证据 JSON 已脱敏。**门禁 G8 已扩展为工作区（含未跟踪文件）+ 4 类密钥形态扫描**，0 命中。✅ |')],
  ],

  'README.md': [
    [L('│  ├─ gate-check.mjs            # P0 门禁自动核查（--check 供 CI，输出证据快照）'),
     L('│  ├─ gate-check.mjs            # P0 门禁 v4（含 signoff 指纹组 + 多形态密钥扫描）')],
  ],

  'CHANGELOG.md': [
    [L('---', '', '## [P1 前置提案] · 2026-11-10 09:0x · 非协议变更'),
     L('---', '',
       '## [门禁 v4 加固] · 2026-11-10 09:1x · 非协议变更',
       '',
       '**性质**：修门禁自身的覆盖缺口，未改任何协议字段、未改会签结论。',
       '',
       '- **缺口 1（会签完整性）**：`gate-check.mjs` 的指纹只有 `data / artifact / narrative` 三组，`SECURITY-REVIEW.md`、`SIGN-OFF.md`、`docs/01` 会签表、`P1-PREREQUISITES.md`、`WORKBUDDY-REFERENCE.md` 均不在内。会签前若有人把安全一页纸第 5 项从「须书面接受」改成「已通过」，快照仍 `CURRENT`、CI 仍绿灯。**新增 `signoff` 指纹组，变化判 `STALE`（CI exit 2）**；缺该组的 v3 快照按旧格式判 `STALE`，不静默放行。schema 升 `wbsync-gate-check/4`。',
       '- **缺口 2（密钥扫描假阴性）**：G8 原用 `git grep` 只扫**已跟踪文件**、只认 `ghp_` 一种形态。改为 Node 遍历工作区（含未跟踪文件，跳过 `.git` / `node_modules` / `dist` / 备份与临时 `dsh-home-*`），覆盖 4 类形态：GitHub classic `gh[pousr]_`、细粒度 `github_pat_`、`sk-` 型、私钥头。命中只记路径 / 行号 / 形态，不落匹配内容。',
       '- **顺带修正**：`manual` 里 M6a / M6b 仍写旧的 `run 42366496926` 与 `NOT MET · 2/5`，与 `SIGN-OFF.md` 不一致，改为 `MET · 持续绿灯` / `MET · 5/5 READY`；M6a 不再写死 run 号（每次 CI 都会变）。',
       '- **负向验证（证伪自己）**：① 临时改 `SECURITY-REVIEW.md` 一行 → `--check --assert-fresh` exit **2** 且 reason 指明 `signoff` 组变化；恢复后 exit 0。② 在仓库新建含假令牌的**未跟踪**文件 → G8 FAIL、自动项 8/9、exit **1**；删除后 9/9。③ 另测 `github_pat_` 形态同样被拦。',
       '- 文档同步：`SIGN-OFF.md` §一 G8 行与 §四指纹表（三组→四组、判定说明）、`SECURITY-REVIEW.md` 第 2 项、`README.md` 目录树；新增 `scripts/apply-gate-hardening.mjs`（每处恰好 1 次命中断言 + 备份）。改 README 后重打包 `dist/*.tgz` 保 G9。',
       '',
       '**P0 门禁状态不变**：`BLOCKED_BY_SIGNOFF`；自动项仍 9/9，快照 `CURRENT`。',
       '',
       '---', '',
       '## [P1 前置提案] · 2026-11-10 09:0x · 非协议变更')],
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

const backupDir = join(ROOT, '.revisions-backup-workbuddy', 'gate-v4')
mkdirSync(backupDir, { recursive: true })
for (const t of targets) {
  const rel = t.file.replace(ROOT, '').replace(/^[\\/]/, '').replace(/[\\/]/g, '__')
  writeFileSync(join(backupDir, rel), t.original, 'utf8')
  writeFileSync(t.file, t.result, 'utf8')
  console.log(`  wrote ${t.file}`)
}
console.log(`备份：${backupDir}`)
