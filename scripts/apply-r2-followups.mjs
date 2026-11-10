#!/usr/bin/env node
/**
 * r2 后续收口：清掉上一轮遗留的旧口径 + 把 M6b 结论与 P1 前置写进会签包
 * ---------------------------------------------------------------
 * 与 apply-workbuddy-revisions.mjs 同样的纪律：
 *   - 每处「恰好命中 1 次」断言，任一不符整体 abort，不写任何文件；
 *   - 同一文件多处替换在内存里串行 apply，最后只写一次盘；
 *   - 原文备份到 .revisions-backup-workbuddy/r2-followups/。
 *
 *   node scripts/apply-r2-followups.mjs --dry-run
 *   node scripts/apply-r2-followups.mjs
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const dryRun = process.argv.includes('--dry-run')
const L = (...lines) => lines.join('\n')

const EDITS = {
  'README.md': [
    [L('│  ├─ check-env.mjs             # 构建链环境自检（只读，M6b）'),
     L('│  ├─ check-env.mjs             # M6b 构建链自检（含隔离工具链探测）')],
    [L('│  ├─ apply-workbuddy-revisions.mjs # r2 对标复核修订（带断言与备份）'),
     L('│  ├─ apply-workbuddy-revisions.mjs # r2 对标复核修订（带断言与备份）',
       '│  ├─ apply-r2-followups.mjs    # r2 遗留口径与 M6b 结论收口（带断言）',
       '│  ├─ toolchain-env.sh          # source 后前置隔离 Node 24 / pnpm 11',
       '│  ├─ signoff-check.mjs         # 会签就绪终检（一条命令出签字清单）')],
    [L('**P0 门禁**：三问离线 PASS、上游 commit 已锁定（`66491b0…`）、`04` 已按 D-01~D-07 修订为 `wbsync/1 r1`；**仍待真机加载验证 + 四方会签**（ADR-007~009 均为「提议中」），完成前不得进入 P1 编码。详见 `spike/REPORT.md` §5。'),
     L('**P0 门禁**：三问离线 PASS、真机加载 + 运行时事件闭环 8/8 PASS、上游 commit 锁定（`66491b0…`）、`04` 已修订至 `wbsync/1 r2`（含 WorkBuddy 对标复核）、自动项 9/9、快照 `CURRENT`、M6b 构建链 5/5 `READY`。**唯一剩余硬阻塞是四方会签**（ADR-007~010 均为「提议中」），完成前不得进入 P1 编码。详见 `SIGN-OFF.md` 与 `spike/REPORT.md` §5。')],
    [L('`docs/` 是设计冻结包 v1.1 的发布副本，唯一契约源是 `docs/04`；根 `PROTOCOL.md` 由脚本单向生成，字段变更须在同一 PR 同时改 `04` + `PROTOCOL.md` + `CHANGELOG.md`（06 §9 / ADR-009）。'),
     L('`docs/` 是设计冻结包的发布副本（含 v1.1 Spike 实测修订与 `wbsync/1 r2` 对标复核），唯一契约源是 `docs/04`；根 `PROTOCOL.md` 由脚本单向生成，字段变更须在同一 PR 同时改 `04` + `PROTOCOL.md` + `CHANGELOG.md`（06 §9 / ADR-009）。对标偏差与依据见 `WORKBUDDY-REFERENCE.md`。')],
    [L('`probe-host.mjs` 只读本机 Electron 发行包与真实会话日志，**不写入任何会话数据**。所有输出只含结构元数据，不含事件正文、文件内容或令牌。'),
     L('`probe-host.mjs` 只读本机 Electron 发行包与真实会话日志，**不写入任何会话数据**。所有输出只含结构元数据，不含事件正文、文件内容或令牌。',
       '',
       '### 本地构建链（M6b，已 READY）',
       '',
       '```bash',
       'source scripts/toolchain-env.sh   # 只在当前 shell 前置 PATH，不改系统环境变量',
       'node -v                          # v24.22.2',
       'pnpm -v                         # 11.28.11',
       'node scripts/check-env.mjs --check   # 5/5 READY，exit 0',
       '```',
       '',
       '工具链装在工作区级 `../.wbsync-tools/`（仓库外、不入库），Node 24 LTS 的 SHA256 已与官方 `SHASUMS256.txt` 核对一致；**不覆盖系统 Node、不改全局 PATH**。CI 另用 `actions/setup-node` 24，不依赖本机工具链。')],
  ],

  'SECURITY-REVIEW.md': [
    [L('> 用途：四方会签时，**安全 Owner 只看这一页**。其余 10 份文档、3 个 ADR、CI 与端口细节不需要他审。'),
     L('> 用途：四方会签时，**安全 Owner 只看这一页**。其余 10 份文档、CI 与端口细节不需要他审；4 个 ADR 中只有 **ADR-010（正文可见性边界）** 属信任边界，必须审（见文末）。')],
    [L('## 四行核对'), L('## 五行核对')],
  ],

  'spike/REPORT.md': [
    [L('三问离线取证全 PASS；据 D-01~D-07 已完成设计冻结包 v1.1 修订（10 份文档 / 34 处 + ADR-007~009）、上游 commit 锁定、可安装 bundle 发布。**P0 门禁仍差真机加载验证与四方会签**，完成前不得进入 P1 编码（详见 §5、§7）。'),
     L('三问离线取证全 PASS；据 D-01~D-07 已完成设计冻结包 v1.1 修订（10 份文档 / 34 处 + ADR-007~009）、上游 commit 锁定、可安装 bundle 发布；**真机加载、运行时事件闭环与卸载残留均已 PASS**（§4.1.2 / §4.1.3）。2026-11-10 追加 `wbsync/1 r2` 对标复核与 ADR-010（`WORKBUDDY-REFERENCE.md`）。**P0 门禁只剩四方会签**，完成前不得进入 P1 编码（详见 §5、§7 与 `SIGN-OFF.md`）。')],
    [L('| 文档会签完成 | **NOT MET** | `01` §9 会签表四方均「待签」；v1.1 修订稿 + ADR-007~009（「提议中」）待会签 |'),
     L('| 文档会签完成 | **NOT MET** | `01` §9 会签表四方均「待签」；v1.1 修订稿 + `wbsync/1 r2` + ADR-007~010（均「提议中」）待会签 |')],
    [L('| 协议冻结 | **待会签** | 04 已按 D-01~D-07 修订为 `wbsync/1 r1`，`PROTOCOL.md` 单向同步 + CHANGELOG 齐备；ADR-007~009 仍为「提议中」 |'),
     L('| 协议冻结 | **待会签** | 04 已修订至 `wbsync/1 r2`（r1 按 D-01~D-07 实测澄清，r2 按 WorkBuddy 对标补状态枚举与正文可见性边界），`PROTOCOL.md` 单向同步 + CHANGELOG 齐备；ADR-007~010 仍为「提议中」 |')],
    [L('> 另新增 D-07（`surfaceOp` / `sourceEventSeqs` 真实语义）已写入 04 §3 与 ADR-007。'),
     L('> 另新增 D-07（`surfaceOp` / `sourceEventSeqs` 真实语义）已写入 04 §3 与 ADR-007。',
       '> **#2 / #3 / #4 的裁定权属于会签后的 ARC 与安全 Owner**（配对密钥涉及信任边界、白名单涉及 `08` §5 权限评审），本阶段不代签、不擅自改契约；三项已提升为 `SIGN-OFF.md` §二的「P1 开工前置清单」，会签时须显式确认由谁在 W3 前裁定。')],
    [L('**已完成**：① 按 D-01~D-07 修订 10 份文档、新增 ADR-007~009；② 统一 01/02 的 Spike 三问口径；③ 上游 commit SHA 锁定；④ 发布可安装 bundle 与 `PROTOCOL.md` / `CHANGELOG.md` 同步链；⑤ **Git 仓库直装 + 真机加载 PASS + 运行时事件闭环 8/8 PASS**（§4.1 / §4.1.2）。**W1 Spike 三问已判 PASS。**'),
     L('**已完成**：① 按 D-01~D-07 修订 10 份文档、新增 ADR-007~009；② 统一 01/02 的 Spike 三问口径；③ 上游 commit SHA 锁定；④ 发布可安装 bundle 与 `PROTOCOL.md` / `CHANGELOG.md` 同步链；⑤ **Git 仓库直装 + 真机加载 PASS + 运行时事件闭环 8/8 PASS**（§4.1 / §4.1.2）；⑥ `wbsync/1 r2` 对标复核与 ADR-010；⑦ CI 闸门接入（M6a）；⑧ 本地构建链隔离工具链 5/5 READY（M6b）。**W1 Spike 三问已判 PASS。**')],
    [L('2. **ADR-007~009 会签 + 四方文档会签**（01 §9）：协议字段变更需 ARC 会签，安全项一票否决。'),
     L('2. **ADR-007~010 会签 + 四方文档会签**（01 §9）：协议字段变更需 ARC 会签，安全项一票否决；ADR-010 属信任边界，安全 Owner 必看 `SECURITY-REVIEW.md` 第 5 项。')],
    [L('3. **补构建链环境并接 CI**：命令行 Node ≥ 24.9 + pnpm 11、`dsh` CLI 加 PATH（注意 DSH 进程内已是 24.21.0，两者不同）；CI 接入 `sync-protocol.mjs --check`、`check-plugin.mjs`、pinned commit 校验。'),
     L('3. ~~补构建链环境并接 CI~~ **已完成**：CI 接入 `sync-protocol --check` / `gate-check --check --assert-fresh` / `check-plugin` / `npm pack --dry-run`（M6a）；本地隔离工具链 Node 24.22.2 + pnpm 11.28.11 实跑全链通过，`check-env.mjs --check` 5/5 `READY`（M6b）。桌面版无独立 `dsh` CLI，E5 已按真机 GUI 安装证据判据修正。')],
  ],

  'docs/01_项目章程.md': [
    [L('> 2026-11-07 W1 Spike 离线取证：三问全 PASS（见仓库 `spike/REPORT.md`），commit 已锁定至 `66491b0…`。**真机加载与运行时事件闭环已于 18:34 完成全 PASS**（见仓库 `spike/REPORT.md` §4.1.2），W1 Spike 三问判 PASS；**P0 仅剩四方会签 + ADR 会签**，会签完成前仍不得进入 P1 编码。本套文档据实测做了 v1.1 修订，新增 ADR-007~009 均为「提议中，待会签」。'),
     L('> 2026-11-07 W1 Spike 离线取证：三问全 PASS（见仓库 `spike/REPORT.md`），commit 已锁定至 `66491b0…`。**真机加载与运行时事件闭环已于 18:34 完成全 PASS**（见仓库 `spike/REPORT.md` §4.1.2），W1 Spike 三问判 PASS；**P0 仅剩四方会签 + ADR 会签**，会签完成前仍不得进入 P1 编码。本套文档据实测做了 v1.1 修订（ADR-007~009），2026-11-10 又按 WorkBuddy 对标复核做了 `wbsync/1 r2` 修订并新增 ADR-010，**ADR-007~010 均为「提议中，待会签」**（见 `WORKBUDDY-REFERENCE.md`、`SIGN-OFF.md`）。')],
  ],

  'SIGN-OFF.md': [
    [L('## 零、剩余工作盘点（2026-11-10 08:1x 复核）'),
     L('## 零、剩余工作盘点（2026-11-10 08:5x 复核）')],
    [L('**仓库状态**（2026-11-10 复核）：工作区干净；门禁快照按 `PROTOCOL.md` 变更重算为 `CURRENT`。本轮新增 WorkBuddy 对标复核与 `wbsync/1 r2` 修订（新增 ADR-010），详见 `WORKBUDDY-REFERENCE.md` 与 `CHANGELOG.md`。'),
     L('**仓库状态**（2026-11-10 复核）：工作区干净；门禁快照 `CURRENT`（9/9 PASS）、`wbsync/1 r2` 已推送 `d4f02cb`、CI 绿灯。本轮（r2 后续）清掉了旧口径残留、闭环 M6b、新增会签就绪终检；详见 `WORKBUDDY-REFERENCE.md`、`CHANGELOG.md` 与 `scripts/signoff-check.mjs`。')],
    [L('| **P0 人工项** | M6a CI 接入 MET | **M1 四方会签 + M2~M4 / M7 四个 ADR + M5 安全一票否决**（本质是**一次会签**）、**M6b 本地构建链** | 人签字 / 本机环境 |'),
     L('| **P0 人工项** | M6a CI 接入 MET、**M6b 本地构建链 5/5 READY** | **M1 四方会签 + M2~M4 / M7 四个 ADR + M5 安全一票否决**（本质是**一次会签**） | 人签字 |')],
    [L('**量化结论**：P0 的技术验证、文档链路与 CI 闸门 **100% 完成**；P0 只剩 **1 次会签 + 1 项本机环境**；P1–P3 共 **10 周工作量一行代码未动，且按规程不得提前动**。本轮（11-10 对标复核）在会签前新增 ADR-010，会签项由 3 个 ADR 增至 4 个，仍属同一次会签。'),
     L('**量化结论**：P0 的技术验证、文档链路、CI 闸门与本机构建链 **100% 完成**；P0 只剩 **1 次会签**（四方 + ADR-007~010）；P1–P3 共 **10 周工作量一行代码未动，且按规程不得提前动**。11-10 对标复核在会签前新增 ADR-010，会签项由 3 个 ADR 增至 4 个，仍属同一次会签。')],
    [L('**M6b 现状**（`node scripts/check-env.mjs`，只读自检，**2/5**）：',
       '',
       '| 检查 | 结果 |',
       '|---|---|',
       '| E1 构建链 Node ≥24.9 | **FAIL** · v22.22.2 |',
       '| E2 pnpm 11.x | **FAIL** · 未装 |',
       '| E3 Corepack | **PASS** · shim 存在（沙箱内读不到版本，Bash 侧实测 0.34.6） |',
       '| E4 `NODE_OPTIONS` 无 strip-types 守卫 | **PASS** |',
       '| E5 `dsh` CLI 在 PATH | **FAIL** |',
       '',
       '> 注意区分：**DSH 宿主进程内 Node 是 24.21.0**（11-07 真机探针证据），未达标的是**命令行构建链**；CI 已用 Node 24。两者不是一回事。'),
     L('**M6b 现状**：`node scripts/check-env.mjs --check` → **5/5 `READY`，exit 0**（证据 `spike/evidence/env-check.json`，schema `wbsync-env-check/2`）。',
       '',
       '| 检查 | 结果 | 依据 |',
       '|---|---|---|',
       '| E1 构建链 Node ≥24.9 | **PASS** | 隔离工具链 **v24.22.2**（当前进程仍是 WorkBuddy 自带的 22.22.2） |',
       '| E2 pnpm 11.x | **PASS** | 隔离工具链 **11.28.11** |',
       '| E3 Corepack | **PASS** | PATH shim 存在（0.34.6） |',
       '| E4 `NODE_OPTIONS` 无 strip-types 守卫 | **PASS** | 当前环境变量 |',
       '| E5 DSH 插件安装通道 | **PASS** | 桌面版 GUI 插件管理器 + 11-07 真机加载快照 `errors=[]` |',
       '',
       '- 工具链位置 `../.wbsync-tools/`（**仓库外、不入库**），Node 24 LTS 的 SHA256 与官方 `SHASUMS256.txt` 核对一致；**未覆盖系统 Node、未改全局 PATH**。`source scripts/toolchain-env.sh` 只在当前 shell 前置 PATH。',
       '- 已用 Node 24 实跑整条链：`sync-protocol --check`、`gate-check --check --assert-fresh`（9/9）、`check-plugin`（PASS）、`npm pack --dry-run`、`check-env --check`（5/5）全绿。',
       '- **E5 判据修正**：桌面版 DSH 没有独立 `dsh` CLI，真机插件经 GUI 插件管理器安装并成功加载；原「dsh CLI 在 PATH」判据过窄，改为「插件安装通道可用」，以真机加载快照作通道证据（历史证据，仅证明链路存在，不证明当前仍装着我们这个插件）。依据写进 `env-check.json` 的 `basis` 字段，可复核。',
       '- 三分注意区分：当前进程 Node 22.22.2 / 隔离构建链 24.22.2 / DSH 宿主进程 24.21.0（11-07 历史证据），三者不是一回事。')],
    [L('| M6a | CI 闸门接入（GitHub Actions · `gate.yml`） | **MET** · run `42366496926` success | HE-A + BE-RL |'),
     L('| M6a | CI 闸门接入（GitHub Actions · `gate.yml`） | **MET** · `d4f02cb` run `42730257252` success | HE-A + BE-RL |')],
    [L('| M6b | 本地构建链 Node ≥24.9 + pnpm 11 | **NOT MET · 2/5**（详见 §零） | HE-A + BE-RL |'),
     L('| M6b | 本地构建链 Node ≥24.9 + pnpm 11 | **MET · 5/5 READY**（详见 §零） | HE-A + BE-RL |')],
    [L('> M6a 已完成：CI 用 Node 24，跑 `sync-protocol --check` → `gate-check --check --assert-fresh` → `check-plugin` → `npm pack --dry-run`，commit `bcefdf5` 首次绿灯（5 秒）。',
       '> M6b 不阻塞会签，但阻塞 P1 本地构建。注意 **DSH 进程内 Node 已是 24.21.0**，未达标的是命令行构建链，两者不要混。'),
     L('> M6a 已完成：CI 用 Node 24，跑 `sync-protocol --check` → `gate-check --check --assert-fresh` → `check-plugin` → `npm pack --dry-run`；`d4f02cb` 的 run `42730257252` 共 11 步全 success。',
       '> M6b 已完成：隔离工具链 5/5 READY，不阻塞 P1 本地构建。会签终检命令：`node scripts/signoff-check.mjs`。',
       '',
       '### P1 开工前置清单（本阶段不代签，会签时须显式确认裁定人）',
       '',
       '`spike/REPORT.md` §6 标为「仍未解决」的三项，裁定权属于会签后的 ARC / 安全 Owner，**不属 P0 自动项**，也不由本轮擅自改契约：',
       '',
       '| 编号 | 缺口 | 为何 P0 不定 | 建议裁定人 / 时点 |',
       '|---|---|---|---|',
       '| #2 | `pairSecret` 的生成、分发与账号绑定未定义（`04` §5.1 时序里凭空出现） | 涉及信任边界与密钥分发，须安全 Owner 参与；贸然写死会锁死实现 | ARC + 安全 Owner · W3 详细设计前 |',
       '| #3 | 配对状态在 CP / Relay / Host 本地三处归属未定权威 | 决定鉴权真源，属架构决策，需 ADR | ARC · W3 详细设计前 |',
       '| #4 | `allowedEndpoints` 只有 `session/*`、`$events/*`，FR-6 附件/产物与 FR-7 定时任务端点无归属 | `08` §5 规定新增端点必须走 ADR + 白名单评审，且附件上传是写能力 | ARC + 安全 Owner · W3 详细设计前 |',
       '',
       '> 这三项**不阻塞 P0 会签，但阻塞 W3 编码**；会签时请在签署栏备注写明裁定人与截止时点，避免「签完就开工」时才发现契约空白。')],
    [L('- 会签后：把 `01` §9 的四行「待签」改为签署状态 → 四个 ADR（007~010）状态改为「已接受」→ `CHANGELOG.md` 记一条 → 重跑 `node scripts/gate-check.mjs` 留档。'),
     L('- 会签后：把 `01` §9 的四行「待签」改为签署状态 → 四个 ADR（007~010）状态改为「已接受」→ `CHANGELOG.md` 记一条 → 跑 `node scripts/signoff-check.mjs` 与 `node scripts/gate-check.mjs` 留档 → 先裁定上表 #2/#3/#4，才按 `05` W3 进入 P1 编码。')],
  ],

  'CHANGELOG.md': [
    [L('---', '', '## [wbsync/1 r2] · 2026-11-10 · WorkBuddy 手机/电脑端对标复核'),
     L('---', '',
       '## [r2 后续] · 2026-11-10 08:5x · 非协议变更',
       '',
       '**性质**：清口径 + 闭环 M6b + 会签就绪收口，**未改任何协议字段**，`PROTOCOL.md` 无需重生成（仅 README/报告/会签材料变化）。',
       '',
       '- **旧口径清理**：`README.md` P0 门禁段仍写「`wbsync/1 r1`、仍待真机加载验证、ADR-007~009」；`spike/REPORT.md` §0/§5/§7 同样停留在 11-07 结论；`01` §9 只提 v1.1；`SECURITY-REVIEW.md` 标题仍是「四行核对」、开头仍写「3 个 ADR」。全部改为 r2 / 4 个 ADR / 真机已 PASS / 唯一剩余是会签。',
       '- **M6b 闭环（5/5 READY）**：隔离工具链装到工作区级 `../.wbsync-tools/`（仓库外、不入库）—— Node **v24.22.2 LTS**（SHA256 与官方 `SHASUMS256.txt` 一致）+ pnpm **11.28.11**；**未覆盖系统 Node、未改全局 PATH**。新增 `scripts/toolchain-env.sh`（source 后仅当前 shell 生效）。',
       '- `scripts/check-env.mjs` 升 `wbsync-env-check/2`：新增隔离工具链实跑探测（不靠目录名猜版本）；**E5 判据修正**——桌面版 DSH 无独立 `dsh` CLI，真机插件经 GUI 插件管理器安装并加载，改为「插件安装通道可用」并以 `probe.json` 的 `errors=[]` + `pluginName` 作通道证据，依据写入 `checks[].basis` 可复核，不放宽到无证据即通过。',
       '- 用 Node 24 实跑整条链全绿：`sync-protocol --check` / `gate-check --check --assert-fresh`（9/9）/ `check-plugin`（PASS）/ `npm pack --dry-run` / `check-env --check`（5/5，exit 0）。',
       '- **P1 开工前置清单**写进 `SIGN-OFF.md` §二：`REPORT.md` §6 的 #2 `pairSecret`、#3 配对状态权威归属、#4 端点白名单覆盖，裁定权属于会签后的 ARC / 安全 Owner，本阶段不代签、不擅自改契约；会签时须写明裁定人与 W3 前截止时点。',
       '- 新增 `scripts/signoff-check.mjs`（会签就绪终检，一条命令输出自动项 / 快照 / M6b / 4 个 ADR 状态 / 待签四方 / P1 前置），接入 `gate.yml` 作「记录、不阻断」步骤。`WORKBUDDY-REFERENCE.md` §6 去掉「可复跑 `--dry-run`」的误导命令（该脚本是一次性修订，已执行）。',
       '',
       '**P0 门禁状态不变**：`BLOCKED_BY_SIGNOFF`；剩余只剩**一次会签**（四方 + ADR-007~010）。',
       '',
       '---', '',
       '## [wbsync/1 r2] · 2026-11-10 · WorkBuddy 手机/电脑端对标复核')],
  ],

  'WORKBUDDY-REFERENCE.md': [
    [L('# 本轮文档修订复跑（带「每处恰好 1 次命中」断言 + 原文备份）',
      'node scripts/apply-workbuddy-revisions.mjs --dry-run'),
     L('# 本轮修订脚本为一次性执行（已落盘），再跑会因命中 0 次而 ABORT；改动用提交或备份目录复核',
       'git show --stat d4f02cb',
       'ls .revisions-backup-workbuddy/repo/')],
  ],

  '.github/workflows/gate.yml': [
    [L('      # 只记录不阻断：本地构建链（Node >=24.9 + pnpm 11）属人工项 M6b，',
       '      # 不应让 CI 因开发者机器差异而失败。',
       '      - name: 构建链环境自检（记录，不阻断）',
       '        run: node scripts/check-env.mjs'),
     L('      # 只记录不阻断：本地构建链（Node >=24.9 + pnpm 11）属人工项 M6b，',
       '      # 不应让 CI 因开发者机器差异而失败。',
       '      - name: 构建链环境自检（记录，不阻断）',
       '        run: node scripts/check-env.mjs',
       '',
       '      # 会签就绪终检：输出待签清单与 P1 前置，报告型，不阻断 CI。',
       '      - name: 会签就绪终检（记录，不阻断）',
       '        run: node scripts/signoff-check.mjs')],
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

const backupDir = join(ROOT, '.revisions-backup-workbuddy', 'r2-followups')
mkdirSync(backupDir, { recursive: true })
for (const t of targets) {
  const rel = t.file.replace(ROOT, '').replace(/^[\\/]/, '').replace(/[\\/]/g, '__')
  writeFileSync(join(backupDir, rel), t.original, 'utf8')
  writeFileSync(t.file, t.result, 'utf8')
  console.log(`  wrote ${t.file}`)
}
console.log(`备份：${backupDir}`)
