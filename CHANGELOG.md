# CHANGELOG

协议字段变更必须同时更新 `docs/04` → `PROTOCOL.md` → 本文件（06 §9 / ADR-009）。

---

## [P1 前置提案] · 2026-11-10 09:0x · 非协议变更

**性质**：把 `spike/REPORT.md` §6 的「仍未解决」整理成可会签的提案；**未修改任何契约字段、未新增 ADR、未启动 P1 编码**。

- 新增 **`P1-PREREQUISITES.md`**：四项提案（#2 `pairSecret`、#3 配对状态权威、#4 端点白名单、#5b `Cursor` 双真源），每项含问题、方案对比、推荐裁定、契约影响清单与裁定人；明确标注「提议中，待会签裁定」。
  - #2 推荐 per-challenge 一次性随机数 + 五条边界，并写明 `pairSecret` 不承担身份鉴别；带外长密钥列 v2 加固候选，PAKE 否决。
  - #3 定 CP 管档案 / Relay 管令牌 / Host 仅缓存，补 `device/paired` / `device/updated` 两帧与失败回滚。
  - #4 分阶段开放 `artifacts/*`（P1）、`attachments/*` + `schedule/*`（P2）；附件写能力须安全 Owner 单独确认；v1 不做的 `config/*` / `permission/*` / `remote-desktop/*` 不开放。
  - #5b 客户端 `sinceSeq` 唯一权威，CP `Cursor` 降为可观测性快照（避免服务端游标领先导致漏事件）。
- **会签效率**：四项并入同一次会议裁定，不增加会议次数；若全部采纳，预计 `wbsync/1 r3`（仅新增可选帧/端点前缀与说明，无删除改名）。
- 状态回填：`SIGN-OFF.md` §零进度表新增「P1 开工前置」行、§二清单由 3 项扩为 4 项并指向白皮书；`SECURITY-REVIEW.md` 新增「会签时还需裁定的两项」；`spike/REPORT.md` §6/§7 的「仍未解决」改为「提案已就绪，待会签裁定」；`README.md` 目录树与门禁段同步。
- 清掉一处过时表述：`04` 头部「标注『示意』处需在 W1 Spike 后回填精确类型」——W1 Spike 早已完成实测回填，改为「上游升级前须重跑全量契约测试」；`PROTOCOL.md` 由单向同步脚本重生成。
- `scripts/signoff-check.mjs` 升级：P1 前置计数 3→4、新增提案白皮书存在性校验，输出区分「工程就绪」与「待裁定」。
- 新增 `scripts/apply-p1-prereq-updates.mjs`（每处恰好 1 次命中断言 + 原文备份）；`docs/04` 同步回桌面原稿，11 份文档仍逐字节一致。

**P0 门禁状态不变**：`BLOCKED_BY_SIGNOFF`；工程侧 100% 完成，剩余只有一次会签。

---

## [r2 后续] · 2026-11-10 08:5x · 非协议变更

**性质**：清口径 + 闭环 M6b + 会签就绪收口，**未改任何协议字段**，`PROTOCOL.md` 无需重生成（仅 README/报告/会签材料变化）。

- **旧口径清理**：`README.md` P0 门禁段仍写「`wbsync/1 r1`、仍待真机加载验证、ADR-007~009」；`spike/REPORT.md` §0/§5/§7 同样停留在 11-07 结论；`01` §9 只提 v1.1；`SECURITY-REVIEW.md` 标题仍是「四行核对」、开头仍写「3 个 ADR」。全部改为 r2 / 4 个 ADR / 真机已 PASS / 唯一剩余是会签。
- **M6b 闭环（5/5 READY）**：隔离工具链装到工作区级 `../.wbsync-tools/`（仓库外、不入库）—— Node **v24.22.2 LTS**（SHA256 与官方 `SHASUMS256.txt` 一致）+ pnpm **11.28.11**；**未覆盖系统 Node、未改全局 PATH**。新增 `scripts/toolchain-env.sh`（source 后仅当前 shell 生效）。
- `scripts/check-env.mjs` 升 `wbsync-env-check/2`：新增隔离工具链实跑探测（不靠目录名猜版本）；**E5 判据修正**——桌面版 DSH 无独立 `dsh` CLI，真机插件经 GUI 插件管理器安装并加载，改为「插件安装通道可用」并以 `probe.json` 的 `errors=[]` + `pluginName` 作通道证据，依据写入 `checks[].basis` 可复核，不放宽到无证据即通过。
- 用 Node 24 实跑整条链全绿：`sync-protocol --check` / `gate-check --check --assert-fresh`（9/9）/ `check-plugin`（PASS）/ `npm pack --dry-run` / `check-env --check`（5/5，exit 0）。
- **P1 开工前置清单**写进 `SIGN-OFF.md` §二：`REPORT.md` §6 的 #2 `pairSecret`、#3 配对状态权威归属、#4 端点白名单覆盖，裁定权属于会签后的 ARC / 安全 Owner，本阶段不代签、不擅自改契约；会签时须写明裁定人与 W3 前截止时点。
- 新增 `scripts/signoff-check.mjs`（会签就绪终检，一条命令输出自动项 / 快照 / M6b / 4 个 ADR 状态 / 待签四方 / P1 前置），接入 `gate.yml` 作「记录、不阻断」步骤。`WORKBUDDY-REFERENCE.md` §6 去掉「可复跑 `--dry-run`」的误导命令（该脚本是一次性修订，已执行）。

**P0 门禁状态不变**：`BLOCKED_BY_SIGNOFF`；剩余只剩**一次会签**（四方 + ADR-007~010）。

---

## [wbsync/1 r2] · 2026-11-10 · WorkBuddy 手机/电脑端对标复核

**性质**：会签前的口径修订。状态枚举扩充两个值 + 新增正文可见性边界澄清 + 修正三处事实/口径错误；**无删除、无改名**，兼容 `wbsync/1` 现有客户端，不升主版本。
**依据**：官方文档「多端协同（连接电脑）」与英文 "Keep Tasks Moving Across Devices"（2026-11-10 取证）、本机 `app.asar` 实现线索、新增 `WORKBUDDY-REFERENCE.md`；新增 ADR-010（提议中，待 ARC + 安全 Owner 会签）。

### 契约（`docs/04` / `PROTOCOL.md`）

- `SessionIndex.state` 四态 → **六态**：新增 `stopped` / `failed`，并给出 `turn/end.reason` 单向映射与「同一会话只上报一种状态」互斥约束。补齐 `session/cancel` 早已有、但索引状态未定义的缺口；对齐官方「已停止 / 失败」两态。
- **新增 §5.4 正文可见性边界**：`session/event` 帧的 `ev.data` 即正文，TLS 在 Relay 终止 → Relay 进程可见明文。统一「会话正文不上云」为「零落盘、零进入 CP」，出网审计目标收敛为「0 字节工作区文件 + 0 条正文写入持久化层」。端到端加密列 `wbsync/2` 候选，v1 不做。
- 修正 §9「新增事件类型一律带 `ignorable: true`」——与 §3 实测（宿主不下发、客户端不得依赖）冲突，改为白名单默认跳过。

### 文档（冻结包 11 份 + 会签材料）

- `00` 对标体验去掉「一次配对永久有效」被误当成官方流程的写法；`01` §1 删除未经证实的「云端沙箱」表述，BR-1 证据明确指向 DSH 手机端实测。
- `02` FR-3.3 / NFR-4 / FR-4.8 修订，新增 **BR-7 对标偏差显式登记**（系统通知、远程配置、权限模式切换、远程桌面读屏/点按 v1 不做）。
- `03` 新增 **ADR-010**、§2 信任边界措辞校正；`08` §2/§6/§10 隐私口径与可证伪审计目标；`09` 新增 **R-19**（口径误读风险）；`07` 补 TC-4.11 / TC-7.9、改 TC-7.6；`10` §6 新增 Relay 主机加固清单、§10 用户须知第 7 条；`05` 状态点四态→六态。
- `SECURITY-REVIEW.md` 第 1 行不再写「✅ 已验证不可见」，新增第 5 项「Relay 运维可见明文」并要求会签时书面接受；`SIGN-OFF.md` 新增 **M7** 与依据索引行；`gate-check.mjs` G7 从 3 个 ADR 扩到 4 个。
- 新增 `scripts/apply-workbuddy-revisions.mjs`（带「每处恰好 1 次命中」断言 + 原文备份 + `--dry-run`），仓库 `docs/` 与桌面原稿同步修订，两份仍逐字节一致。

**P0 门禁状态不变**：`BLOCKED_BY_SIGNOFF`；会签项由 3 个 ADR 增至 4 个，仍属同一次会签，未新增实现工作。

---

## [真机验证] · 2026-11-07 18:10 · 非协议变更

- **Git 仓库直装成功**（方式 B，lock pinned `551778e`），**未触发 pnpm `allowBuilds` 授权**——本包无 install/postinstall 脚本，说明 06 §4 / 10 §4 的担心只针对带构建脚本的 git 依赖。
- `~/.dsh/wbsync-spike/probe.json`（648 B，`errors: []`）+ `127.0.0.1:50973/__wbsync/spike` **HTTP 200**，确认插件进入 Loader 树、`sessionPersistence` / `webServer` 注入成功、具名路由可用。DSH 进程内 Node **24.21.0**（命令行仍 22.22.2）。详见 `spike/REPORT.md` §4.1、根 README。
- 修 `index.js` 注释：`probe.json` 是 `apply()` 启动快照，实时 `eventShapes` 走状态路由（**功能未变，无需重装**）。
- 补桌面版**动态端口**查法与端口辨析（3082→502 / 9230→404 / **50973→200**），替换原先写死 3080 的示例。
- 18:23 复测：用户报告已发消息，但路由与 `probe.json` 的 `eventShapes` 均为 0；会话日志 18:05 后 0 变动、`session_projcache` 最新 16:16、DSH 仅 1 个主进程 → 判定「PC 进程内无会话事件产生」，**不是订阅失效**。诊断链与自检命令见 `spike/REPORT.md` §4.1.1。
- **18:34 端到端闭环 PASS**：用户确认前一次在**手机端**发（BR-1），改在 PC 桌面版发言后，落盘日志 9 帧 / 23 事件（`seq` 0→22）、订阅窗口 19 条（`seq` 4→22）**逐条一致**；8/8 运行时断言 PASS，D-03 首参与 D-07 `surfaceOp` 均升级为运行时取证。`probe.json` 仍 0 条而路由 19 条，实证「快照 vs 实时」。**W1 Spike 三问判 PASS**，P0 仅剩四方会签；卸载残留转 M1 / TC-4.10（详见 `spike/REPORT.md` §4.1.2）。
- **18:41 卸载残留 TC-4.10 真机 PASS**：卸载后 `50973/__wbsync/spike` → **404**，profile 三处配置命中 0，operations 日志 `remove/settled`；DSH 主进程 **未重启**（PID 2196 / 14:14 启动），证明是 `ctx.effect` disposer 运行时撤回路由，而非重启后未加载。顺带解开端口之谜：3082 是 `dsh-engine-switch` 反向代理（转发 3080 未启动故 502），9230 为另一内部服务，50973 才是 `ctx.webServer`。**P1 待办**：`~/.dsh/wbsync-spike/probe.json` 未随卸载清理，产品插件需定义保留 / 清理策略。至此 P0 只剩四方会签 + ADR 会签（详见 `spike/REPORT.md` §4.1.3）。
- **18:52 证据时效性修正**：用户指出 DSH 重启过，核实为 **18:49:52** 重启（新 PID 26668，端口 **50973 → 55056**）。18:41 的 404 观测早于重启、仍是「同进程 disposer 撤回」的强证据；重启后新端口的 404 属弱证据，不得复用该结论。时间线与查端口方法已写入新增的 `SIGN-OFF.md` §四、`REPORT.md` §4.1.3。
- 新增 `SIGN-OFF.md`（P0 会签包：自动项 8/8、待签项 M1~M6、依据索引、签署栏）与 `scripts/gate-check.mjs`（门禁自动核查，`--check` 供 CI，输出 `spike/evidence/gate-check.json`）。**P0 只剩会签**：门禁状态 `BLOCKED_BY_SIGNOFF`。
- **快照语义与 CI 闸门（19:0x）**：`gate-check.mjs` 新增 `freshness`（按证据输入 sha256 判定 `CURRENT`/`STALE`，30 天兜底）与 `--assert-fresh`；`--check` 改为只校验不写盘，避免 CI 脏 diff。新增 `.github/workflows/gate.yml`（Node 24：`sync-protocol --check` → `gate-check --check --assert-fresh` → `check-plugin` → `npm pack --dry-run`）。决策：**CI 每次重算 = 准入闸门；入库快照 = 会签时点审计**，规则写入 `SIGN-OFF.md`。
- **CI 首次绿灯（19:02）**：`gate.yml` 注册为 `active`，commit `bcefdf5` 的 run `42366496926` **conclusion=success**（11:02:54 → 11:02:59，5 秒）。M6 随之拆分为 **M6a**（CI 接入 · MET）/ **M6b**（本地构建链 Node ≥24.9 + pnpm 11 · 仍 NOT MET）。
- **指纹分两组（19:0x）**：`fingerprints` 拆成 **`data`**（`host-probe.json` / `check-plugin.json` / `dist-tarball`）与 **`narrative`**（`REPORT.md` / `PROTOCOL.md`）；快照 schema 升 `wbsync-gate-check/2`，新鲜度三档：`CURRENT` / **`DRIFTED`（仅描述漂移，放行 + NOTE）** / `STALE`（数据变 / 旧格式 / 超期 → `--assert-fresh` exit 2）。实测：只给 `REPORT.md` 加一个空行 → `DRIFTED` 且 exit 0；恢复后回到 `CURRENT`。规则写入 `SIGN-OFF.md`。
- **发布物从「事实」降为「记录」（19:1x）**：实测 `npm pack` **不可复现**（同内容两次打包 sha 不同，gzip 头带时间：`6904a9e2…` → `b8549748…`），把 `dist-tarball` 当事实指纹会让每次 repack 误报 `STALE`。改为三组：**data**（`index.js` / `cordis.patch.yml` / `package.json` / `host-probe.json` / `check-plugin.json` → `STALE`）、**artifact**（`dist/*.tgz` → 仅记录 + NOTE）、**narrative**（`REPORT.md` / `PROTOCOL.md` → `DRIFTED`）。快照 schema 升 `wbsync-gate-check/3`。实测：只改 README 后 repack → `DRIFTED`/NOTE 而非 `STALE`；只改 `index.js` → **exit 2**；恢复后 `CURRENT` exit 0。已知缺口：「发布物与源码一致」暂无自动校验，记为 P1 待办（**已于 19:5x 由 G9 补上，见下条**）。
- **G9 解包比对（19:5x）**：新增 `scripts/lib/tar.mjs`（零依赖 tar / tar.gz 解析）；`gate-check` 增加 **G9** —— 不比 tgz 本身（不可复现），而是**解包后逐文件比 sha256**，`index.js` / `cordis.patch.yml` / `package.json` / `README.md` / `LICENSE` **5/5 一致**才 PASS。实测：改 `index.js` 但不 repack → **G9 FAIL、自动项 8/9、exit 1**；恢复后 9/9、快照 `CURRENT`。自动项从 8 增至 9。决策：**保留 `dist/*.tgz` 在仓库（继续走 GitHub 分发），用 G9 保证它不与源码脱节**。
- **2026-11-10 剩余工作盘点 + M6b 量化**：新增 `scripts/check-env.mjs`（只读环境自检，不改 PATH、不装东西；`--check` 供 P1 开工前自检），输出 `spike/evidence/env-check.json`。本机 **2/5 · NOT_READY**（E1 Node 22.22.2、E2 pnpm 未装、E5 dsh CLI 不在 PATH；E3 Corepack/E4 NODE_OPTIONS 通过）。明确区分「命令行构建链」与「DSH 宿主运行时 Node 24.21.0（11-07 历史证据）」。
- 修了两个探测坑：Windows 上 `.cmd` shim 需 `cmd.exe`（沙箱禁用）→ 回落用 PATH 文件存在性判定，避免把已装的 Corepack 误报成 `NOT_INSTALLED`；`execFileSync` 不自动补 Windows 后缀。`SIGN-OFF.md` 新增「零、剩余工作盘点」：P0 自动项 9/9 完成，只剩 1 次会签 + 1 项环境；P1–P3 共 10 周未启动且按规程不得提前启动。CI 增加「环境自检（记录，不阻断）」步骤。
- **安全 Owner 会签一页纸（11-10 08:2x，专家裁定）**：会签审阅顺序定为**先审 `08` 隐私红线、再审 ADR-008 幂等/写入权** —— 前者答错了数据离开本机收不回，后者错了改代码可回滚；一票否决权是用来挡不可逆后果的。新增 `SECURITY-REVIEW.md`（4 行核对，第 3 项「令牌不明文落盘」标 **P1 待落地**、第 4 项「出网流量镜像审计」标 **P3 W10 待验证**，不把待办写成通过）；`SIGN-OFF.md` 新增 §六「会签审阅顺序」、原 §六顺延为 §七，M5 改为「只看一页纸」。

---

## [wbsync/1 r1] · 2026-11-07 · 设计冻结包 v1.1

**性质**：按 W1 Spike 宿主实测做的澄清与新增可选字段，**无删除、无改名**，兼容 `wbsync/1` 现有客户端，不升主版本。
**依据**：`spike/REPORT.md` D-01~D-07；`docs/03` ADR-007~009（状态均为「提议中，待会签」）。
**宿主基线**：`66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`（`dsh-v0.2.2-rc.1`），见 `pinned-commit.txt`。

### 契约（`docs/04` / `PROTOCOL.md`）

- **新增可选字段** `SessionEvent.surfaceOp?: string`、`sourceEventSeqs?: number[]`；`ignorable?` 保留但标注「实测宿主不下发，客户端不得依赖」。
- **改写 §3 事件分类表**：删除 `assistant/chunk` 折叠规则（实测不落盘）；`tool/call`↔`tool/result` 改按 `sourceEventSeqs` 配对；新增「其它（默认跳过）」类别覆盖实测 20+ 种未列事件。
- **新增「宿主实测补充」段**：三种事件形状计数（504 / 90 / 73）、`surfaceOp` 恒为 `append`（163 条）、日志为多帧 zstd、`session/event` 首参是 session 对象。
- **§1 幂等**：`clientMsgId` 明确映射宿主 `prompt(request).requestId`；**§2 Idempotency 表**降级为 CP 侧跨 Host 路由审计，Host 侧去重归宿主。
- **§2 SessionHeader**：`parentSession` / `origin` 标为可选，要求缺失兜底。

### 需求与架构

- `docs/02`：FR-4.2 / 4.3 / 4.5、BR-4 按实测改写；§6 新增「降级验收（09 R-02 方案 B）」；§7 前置改为三问口径。
- `docs/03`：§4.2 消息时序改为宿主原生幂等 + writer-held 冲突；新增 ADR-007（事件契约）、ADR-008（幂等与写入权归宿主）、ADR-009（PROTOCOL.md 唯一性）。
- `docs/01`：A1 补「宿主 prompt 提交入口」，与 05 W1 / 09 R-02 的三问口径统一；§9 附 Spike 结论。
- `docs/00`：术语表补 `surfaceOp` / `sourceEventSeqs` / `requestId` / 多帧 zstd；commit 锁定条目标为已锁定。

### 工程与测试

- `docs/06`：修最小骨架 `ctx.on('session/event', (session, ev) => ...)` 首参（原写成 `sessionId` 字符串，会直接导致 P1 出错）；Node 口径统一为「构建链/Host ≥24.9、Relay 运行时 ≥22」；§9 补 PROTOCOL.md 单向同步规则。
- `docs/07`：TC-1.2 / TC-1.3 按实测改写；新增 TC-1.9（多帧 zstd）、TC-1.10（首参类型）。
- `docs/08`：供应链补「宿主源码片段不得随公开仓库发布」。
- `docs/09`：R-02 记录离线取证三问全 PASS，风险暂记「待真机复核」，不关闭（此为 r1 时点状态，已于 18:34 由「真机验证」条目更新）。
- `docs/10`：Node 版本口径与 06 统一。

### 工程产物

- 新增 `scripts/apply-spike-revisions.mjs`（v1.0→v1.1 文档修订，带唯一性断言与原文备份）。
- 新增 `scripts/sync-protocol.mjs`（ADR-009 单向同步 + `--check` CI 校验）。
- 新增 `PROTOCOL.md`、`docs/`（11 份 v1.1 文档）、`CHANGELOG.md`。

### 仍待完成（P0 门禁）

- 真机在 DSH 里安装 `dsh-wb-cloud-sync-spike` 并取 `probe.json`（`dsh` CLI 不在 PATH，本机 SKIP）。
- ADR-007~009 会签、四方文档会签（01 §9）。
- 环境补齐 Node ≥24.9 + pnpm 11；CI 接入 `sync-protocol.mjs --check`。

---

## [0.1.0] · 2026-11-07 · 首版

- 可安装探针 bundle（`dsh.bundle`）、W1 Spike 三问取证脚本、隔离 `DSH_HOME` 加载验证、脱敏证据。
