# P0 设计冻结 · 会签包

> 生成日期：2026-11-07 ｜ 依据：`01` §9 会签表、`05` RACI 与 §4 协作流程、`06` §6 决策机制
> 机器可读快照：`node scripts/gate-check.mjs` → `spike/evidence/gate-check.json`

## 结论先行

**自动项 9/9 PASS；四方会签已由发起人于 2026-11-10 永久取消**（`SIGNOFF-WAIVER.md`），不再是 P0 / GA 阻塞项。
当前门禁状态：`PASS`（自动项全过时输出）。原会签要求、`SIGN-OFF-PROCEDURE.md` 流程与 `BLOCKED_BY_SIGNOFF` 状态一并废止；**原签署栏未填写、ADR-007~010 仍为「提议中」，不伪造签字**。其余 GA 门禁（`00` 成功指标、`07` M3 验收、`08` §10 合规检查单、P3 W10 出网流量镜像审计）照旧，不因本裁定免除。

## 零、剩余工作盘点（2026-11-10 09:3x 复核 · 发起人豁免开发期会签）

**仓库状态**（2026-11-10 19:5x 复核）：工作区干净；门禁自动项 9/9 PASS、**`gate: PASS`**、快照 `CURRENT`、CI 绿灯。**发起人已永久取消四方会签**（`SIGNOFF-WAIVER.md`），`SIGN-OFF-PROCEDURE.md` 同步废止；原签署栏未填写、ADR-007~010 仍为「提议中」，不伪造签字。P1 W3 手机 ↔ PC 全链路（配对 / 列表 / 新建 / 第一句话 / 事件流 / 取消）已真机验收，`p1/` 合计 **163/163 单测**。其余 GA 门禁（`00` 成功指标、`07` M3、`08` §10、P3 W10 出网审计）照旧。

| 层级 | 已完成 | 剩余 | 阻塞性质 |
|---|---|---|---|
| **P0 自动项** | **9/9 PASS**（G1~G9，含 G9 解包比对）；`gate: PASS` | 0 | — |
| **P0 人工项** | M6a CI 接入 MET、M6b 构建链 5/5 READY | **四方会签要求已取消**（发起人裁定）；M2~M4 / M7 按默认口径落地，M5 责任由发起人承接 | 不再是阻塞 |
| **P1 开工前置** | 4 项按推荐方案作默认实现口径落地（发起人裁定采纳，可回滚） | 改口径时走变更单 | 非阻塞 |
| **P1 W3 手机 ↔ PC** | **真机全链路验收通过**；`p1/` **163/163** 单测；0.1.7 包 | W4–W6 其余项 | 工程推进 |
| **P2（W7–W9）** | deviceId 持久化、索引增量 diff、PC 侧主动吊销 UI 已落地 | 附件上行（`attachments/*`，需协议 r3 + 宿主 `fileUploads` 取证）及其余 P2 端点 | 独立设计轮次 |
| **P3（W10–W12）** | 出网审计**静态 + 运行时**双半边就绪（31 文件 `external` 0；Relay 进程实时连接 `external` 0） | 抓包级全量镜像（`pktmon`，覆盖 DSH 进程组与依赖包内部请求）及 W10–W12 其余项 | GA 门禁照旧 |

**量化结论**：自动项与快照 100% 完成；四方会签已由发起人取消，不再是 P0 / GA 阻塞。P1 W3 全链路真机可用，P2 三项工程改进已落地。附件上行等 P2 端点需独立协议变更与宿主取证；P3 W10 出网审计仍是 GA 前必做项。

**M6b 现状**：`node scripts/check-env.mjs --check` → **5/5 `READY`，exit 0**（证据 `spike/evidence/env-check.json`，schema `wbsync-env-check/2`）。

| 检查 | 结果 | 依据 |
|---|---|---|
| E1 构建链 Node ≥24.9 | **PASS** | 隔离工具链 **v24.22.2**（当前进程仍是 WorkBuddy 自带的 22.22.2） |
| E2 pnpm 11.x | **PASS** | 隔离工具链 **11.28.11** |
| E3 Corepack | **PASS** | PATH shim 存在（0.34.6） |
| E4 `NODE_OPTIONS` 无 strip-types 守卫 | **PASS** | 当前环境变量 |
| E5 DSH 插件安装通道 | **PASS** | 桌面版 GUI 插件管理器 + 11-07 真机加载快照 `errors=[]` |

- 工具链位置 `../.wbsync-tools/`（**仓库外、不入库**），Node 24 LTS 的 SHA256 与官方 `SHASUMS256.txt` 核对一致；**未覆盖系统 Node、未改全局 PATH**。`source scripts/toolchain-env.sh` 只在当前 shell 前置 PATH。
- 已用 Node 24 实跑整条链：`sync-protocol --check`、`gate-check --check --assert-fresh`（9/9）、`check-plugin`（PASS）、`npm pack --dry-run`、`check-env --check`（5/5）全绿。
- **E5 判据修正**：桌面版 DSH 没有独立 `dsh` CLI，真机插件经 GUI 插件管理器安装并成功加载；原「dsh CLI 在 PATH」判据过窄，改为「插件安装通道可用」，以真机加载快照作通道证据（历史证据，仅证明链路存在，不证明当前仍装着我们这个插件）。依据写进 `env-check.json` 的 `basis` 字段，可复核。
- 三分注意区分：当前进程 Node 22.22.2 / 隔离构建链 24.22.2 / DSH 宿主进程 24.21.0（11-07 历史证据），三者不是一回事。

## 一、自动核查（可复跑，无需人工判断）

| ID | 检查 | 结果 |
|---|---|---|
| G1 | 三问离线取证 Q1/Q2/Q3 全 PASS | PASS |
| G2 | `check-plugin.mjs` 插件加载验证 | PASS |
| G3 | 上游 commit 锁定（40 位 SHA） | PASS · `66491b05…` |
| G4 | `PROTOCOL.md` 与 `docs/04` 单向同步 | PASS |
| G5 | 真机加载 + 运行时事件闭环（REPORT §4.1.2） | PASS · 19 条 / seq 4→22 |
| G6 | TC-4.10 真机卸载残留（REPORT §4.1.3） | PASS · 404 |
| G7 | ADR-007~010 已写入 `03` | PASS · 4/4 |
| G8 | 工作区（含未跟踪文件）多形态密钥扫描 | PASS · 0 命中 / 4 类形态 |
| G9 | 发布包内容与仓库源码逐文件一致（解包比对） | PASS · 5/5 文件 |

复跑：`node scripts/gate-check.mjs --check`（自动项全过 exit 0）；CI 用 `--check --assert-fresh`（`.github/workflows/gate.yml`）。

## 二、待签项（脚本判不了，必须由人决定）

| ID | 事项 | 状态 | Owner |
|---|---|---|---|
| M1 | 四方文档会签（PM / 架构师 / 安全 Owner / QA Owner） | **NOT MET** | PM |
| M2 | ADR-007 事件契约以宿主实测为准 | 提议中，待会签 | ARC + PM |
| M3 | ADR-008 幂等与写入权归宿主 | 提议中，待会签 | ARC + PM |
| M4 | ADR-009 `PROTOCOL.md` 为唯一契约源 | 提议中，待会签 | ARC |
| M5 | 安全项一票否决权行使（`08` / `01` §6，见 §六） | 待安全 Owner · 只看 `SECURITY-REVIEW.md` | 安全 Owner |
| M6a | CI 闸门接入（GitHub Actions · `gate.yml`） | **MET** · `d4f02cb` run `42730257252` success | HE-A + BE-RL |
| M6b | 本地构建链 Node ≥24.9 + pnpm 11 | **MET · 5/5 READY**（详见 §零） | HE-A + BE-RL |
| M7 | ADR-010 正文可见性边界（信任边界，安全 Owner 必看） | 提议中，待会签 | ARC + 安全 Owner |

> M6a 已完成：CI 用 Node 24，跑 `sync-protocol --check` → `gate-check --check --assert-fresh` → `check-plugin` → `npm pack --dry-run`；`d4f02cb` 的 run `42730257252` 共 11 步全 success。
> M6b 已完成：隔离工具链 5/5 READY，不阻塞 P1 本地构建。会签终检命令：`node scripts/signoff-check.mjs`。

### P1 开工前置清单（本阶段不代签，会签时一次性裁定）

`spike/REPORT.md` §6 登记的四项契约空白，裁定权属于会签后的 ARC / 安全 Owner，**不属 P0 自动项**，也不由本轮擅自改契约。完整方案、权衡、推荐与契约影响清单见 **[`P1-PREREQUISITES.md`](P1-PREREQUISITES.md)**：

| 编号 | 缺口 | 推荐裁定 | 裁定人 / 时点 |
|---|---|---|---|
| #2 | `pairSecret` 的生成 / 分发 / 账号绑定未定义（`04` §5.1 时序里凭空出现） | per-challenge 一次性随机数 + 五条边界；带外长密钥列 v2 加固 | ARC + 安全 Owner · W3 前 |
| #3 | 配对状态在 CP / Relay / Host 本地三处无权威 | CP 管档案 / Relay 管令牌 / Host 仅缓存，补两帧时序与失败回滚 | ARC · W3 前 |
| #4 | `allowedEndpoints` 未覆盖 FR-6 附件/产物与 FR-7 定时任务 | 分阶段开放 `artifacts/*`（P1）、`attachments/*` + `schedule/*`（P2）；附件写能力单独确认 | ARC + 安全 Owner · W3 前 |
| #5b | `Cursor` 双真源（CP 表 vs 客户端 `sinceSeq`）未定 | 客户端 `sinceSeq` 唯一权威，CP `Cursor` 降为可观测性快照 | ARC · W3 前 |

> 这四项**不阻塞 P0 会签，但阻塞 W3 编码**；会签时请在签署栏备注写明裁定结论与截止时点，结论必须回写 ADR 或 `04`（`05` §4）。若四项全部采纳，预计产生 `wbsync/1 r3`，需 `PROTOCOL.md` 单向同步 + `CHANGELOG.md` 记一条。

## 三、会签依据索引

| 决策 | 依据文件 | 关键实测数据 |
|---|---|---|
| 事件契约（ADR-007） | `docs/04` §3、`spike/REPORT.md` D-01/D-02/D-07 | 667 条离线样本 + 19 条运行时事件；`surfaceOp` 6 条；`ignorable` 0 次；日志无 `assistant/chunk` |
| 幂等 / 写入权（ADR-008） | `docs/03` §4.2、`spike/REPORT.md` Q2 | 宿主 `prompt(request).requestId` + `hasPromptRequest()` + `SessionAlreadyOwnedError` → `session/writer-held` |
| 契约源唯一性（ADR-009） | `PROTOCOL.md`、`scripts/sync-protocol.mjs` | `--check` PASS；字段变更须同 PR 改 `04` + `PROTOCOL.md` + `CHANGELOG.md` |
| 三问门禁（R-02） | `spike/REPORT.md` §2 / §4.1 / §4.1.2 | Q1 seq 0→666 离线 + 4→22 运行时；Q2 提交入口；Q3 补齐 266/266 |
| 可逆副作用 / TC-4.10 | `spike/REPORT.md` §4.1.3 | 18:41 卸载 404（同进程，强证据） |
| 隐私与供应链 | `docs/08` §9、`spike/evidence/host-probe.json` | 证据已脱敏；全 history 密钥 0 命中；不落事件正文 |
| 正文可见性（ADR-010） | `docs/04` §5.4、`WORKBUDDY-REFERENCE.md` §3.1、`docs/08` §2/§6 | 上行 `session/event` 帧携带 `data` 正文；TLS 在 Relay 终止；审计目标收敛为「零落盘 / 零进 CP」 |

## 四、时间线（**防止证据误用**，务必先读）

| 时刻 | 事件 | webServer 端口 | 主进程 |
|---|---|---|---|
| 18:10:44 | 插件加载，`probe.json` 写出 | 50973 | PID 2196（14:14 启动） |
| 18:34:19 | PC 桌面版发言 → 19 条事件闭环 | 50973 | PID 2196 |
| **18:41:20** | **卸载 settled → 404（同一进程，disposer 运行时撤回，强证据）** | 50973 | PID 2196 **未重启** |
| **18:49:52** | **DSH 重启** | **→ 55056** | **PID 26668** |
| 18:52 | 新进程 404（只证明「重启后没加载已卸载插件」，**弱证据**） | 55056 | PID 26668 |

**端口会随重启变化**，不要写死。查法：

```powershell
Get-NetTCPConnection -State Listen | Where-Object {
  (Get-Process -Id $_.OwningProcess).ProcessName -match 'DeepSeek'
} | Select-Object LocalPort
```

### 快照与 CI 的使用规则（决定：两者都要，语义分开）

| 载体 | 角色 | 何时更新 | 能否作为准入依据 |
|---|---|---|---|
| CI 每次运行的 `gate-check.mjs --check` | **闸门**：永远反映当前代码 | 每次 push / PR 自动跑 | **能**，但不落盘、不留档 |
| `spike/evidence/gate-check.json` | **审计快照**：会签时点的证明 | 证据数据变化时由人重跑并提交 | **`CURRENT` 或 `DRIFTED` 可用**；`STALE` 只能当历史 |

**指纹分四组**（不按 git HEAD 判，只改提交信息不该让快照失效）：

| 组 | 文件 | 变了意味着 | 判定 |
|---|---|---|---|
| **data（事实）** | `index.js`、`cordis.patch.yml`、`package.json`、`host-probe.json`、`check-plugin.json`，以及 4 个判据脚本（`gate-check` / `check-env` / `signoff-check` / `sync-protocol`） | 运行代码、实测证据或**判据本身**已变 | **`STALE`** → CI exit 2，必须重算 |
| **signoff（会签材料）** | `SECURITY-REVIEW.md`、`SIGN-OFF.md`、`SIGN-OFF-PROCEDURE.md`、`docs/01` 会签表、`P1-PREREQUISITES.md`、`WORKBUDDY-REFERENCE.md` | **签字人实际要读的材料被改** | **`STALE`** → CI exit 2，必须重算 |
| **artifact（发布物）** | `dist/*.tgz` | 重新打包了 | **仅记录 + NOTE，不影响判定** |
| **narrative（说法）** | `REPORT.md`、`PROTOCOL.md` | 措辞 / 描述更新 | **`DRIFTED`**，放行 + NOTE |

- **为什么加 signoff 组**（2026-11-10 门禁可靠性审计）：原先会签材料不在任何指纹组里，若有人把 `SECURITY-REVIEW.md` 第 5 项从「须书面接受」改成「已通过」，快照仍 `CURRENT`、CI 仍绿灯，签字人会签在被改过的材料上。会签材料变化按 **`STALE`** 阻断处理，比 `DRIFTED` 更严。
- **为什么 artifact 不参与判定**：`npm pack` **不可复现**——同样内容两次打包 sha 不同（gzip 头带时间戳）。实测：只给 README 加一个空行再 repack，tgz sha 从 `6904a9e2…` 变成 `b8549748…`；恢复 README 再 repack 仍是新 sha。若纳入判定，每次打包都会误报。
- 三档：`CURRENT`（四组一致）／`DRIFTED`（仅描述漂移，不阻断）／`STALE`（data 或 signoff 变 / 旧格式快照 / 超期）。缺 `signoff` 组的 v3 快照按旧格式判 `STALE`，不静默放行。
- 兜底上限 **30 天**：即使数据没变，超过 30 天的快照也判 `STALE`。
- 一句话：**改错别字不拦人，重新打包不误报，运行代码、实测证据或会签材料一变就拦死。**
- ✅ 「发布物与源码是否一致」由 **G9 解包比对**覆盖：不比 tgz 本身（不可复现），而是解包后逐文件比 sha256，5/5 一致才 PASS。实测：改 `index.js` 但不 repack → G9 FAIL、自动项 8/9、exit 1。因此**保留 `dist/*.tgz` 在仓库、继续走 GitHub 分发**是安全的。
- **G8 加固**：由「只扫已跟踪文件的 `ghp_`」改为遍历工作区（含未跟踪文件）+ 4 类形态（GitHub classic / 细粒度 PAT / `sk-` 型 / 私钥头）；命中只记录路径、行号与形态，不把匹配内容写进证据。
- **P1 代码（`p1/`）不在 P0 快照内**：`data` 组只含探针插件与 P0 证据；P1 代码由 CI 的「P1 骨架冒烟测试」阻断把关（`p1/*/test/*.test.mjs`，cp + relay + host-plugin 共 92 用例），避免每次开发都让 P0 快照失效。

- 会签时请抄下 `capturedAt` / `git.head` / `fingerprints.data` / `fingerprints.signoff` 摘要写进签署栏备注，事后可复核。

## 五、签署栏

> **怎么签**：照 [`SIGN-OFF-PROCEDURE.md`](SIGN-OFF-PROCEDURE.md) 执行——会前准备、会议顺序、每人勾什么、签完 9 步回写清单，以及「架构师兼安全 Owner」这一兼任事实的处理方式。

| 角色 | 姓名 / 代号 | 结论（同意 / 附条件 / 否决） | 日期 | 备注 |
|---|---|---|---|---|
| 发起人 / PM | — | 待签 | — | 范围、节奏、发布 |
| 架构师（兼安全 Owner） | — | 待签 | — | 架构、ADR、协议 |
| 安全 Owner | — | 待签 | — | **一票否决权** |
| QA Owner | — | 待签 | — | 门禁与验收 |

## 六、会签审阅顺序（专家裁定，2026-11-10）

**裁定：安全 Owner 先看 `08_安全与隐私设计.md`，不是 ADR-008。**

| | 第一道（先问） | 第二道（后问） |
|---|---|---|
| 大白话 | 我的聊天记录和文件，会不会跑到别人服务器上？ | 两个人同时改一条消息，谁说了算？ |
| 对应 | `08` 隐私红线 / NFR-4 零字节上云 | ADR-008 幂等与写入权归宿主 |
| 答错了 | **收不回来**：数据一旦离开本机，删了也可能有副本 | 出 bug，改代码重发一版就好 |
| 谁拍板 | **安全 Owner（一票否决）** | 架构师 + PM |

一票否决权（`01` §6）是用来挡**不可逆后果**的，不是评审实现细节。所以顺序是：**先确认「东西没跑出去」，再讨论「东西怎么改」**。

已把安全 Owner 需要看的内容压成一页：[`SECURITY-REVIEW.md`](SECURITY-REVIEW.md) —— **5 行核对**，其中第 3、4 项如实标为「待验证 / 待 P3」，第 5 项如实标为「v1 已知边界，须书面接受」，**不把待办写成通过**。其余 10 份文档、CI 与端口细节不需要他审；**但 ADR-010 属信任边界，是 4 个 ADR 里唯一必须给他审的一个**。

## 七、会签规则与收尾动作

- 协议字段变更必须 **ARC 会签**；安全争议由 **安全 Owner 一票否决**（`01` §6 / `05` RACI）。
- **结论必须回写 ADR 或协议文档**，只在大群里说不算决策（`05` §4）。
- 会签后：把 `01` §9 的四行「待签」改为签署状态 → 四个 ADR（007~010）状态改为「已接受」→ `CHANGELOG.md` 记一条 → 跑 `node scripts/signoff-check.mjs` 与 `node scripts/gate-check.mjs` 留档 → 先裁定上表 #2/#3/#4，才按 `05` W3 进入 P1 编码。
- 全部完成后才按 `05` W3 进入 P1 编码。
