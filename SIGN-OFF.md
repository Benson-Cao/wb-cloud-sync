# P0 设计冻结 · 会签包

> 生成日期：2026-11-07 ｜ 依据：`01` §9 会签表、`05` RACI 与 §4 协作流程、`06` §6 决策机制
> 机器可读快照：`node scripts/gate-check.mjs` → `spike/evidence/gate-check.json`

## 结论先行

**自动项 9/9 PASS；P0 唯一剩余硬阻塞是「会签」。** 会签完成前不得进入 P1 编码（`01` §9 / `05` W1）。
当前门禁状态：`BLOCKED_BY_SIGNOFF`。

## 零、剩余工作盘点（2026-11-10 08:1x 复核）

**仓库状态**（2026-11-10 复核）：工作区干净；门禁快照按 `PROTOCOL.md` 变更重算为 `CURRENT`。本轮新增 WorkBuddy 对标复核与 `wbsync/1 r2` 修订（新增 ADR-010），详见 `WORKBUDDY-REFERENCE.md` 与 `CHANGELOG.md`。

| 层级 | 已完成 | 剩余 | 阻塞性质 |
|---|---|---|---|
| **P0 自动项** | **9/9 PASS**（G1~G9，含 G9 解包比对） | **0** | — |
| **P0 人工项** | M6a CI 接入 MET | **M1 四方会签 + M2~M4 / M7 四个 ADR + M5 安全一票否决**（本质是**一次会签**）、**M6b 本地构建链** | 人签字 / 本机环境 |
| **P1 MVP（W3–W6）** | 0 | **全部**：Relay 骨架、CP、配对、事件透传、幂等 prompt、队列、PWA 骨架、M1 验收 | 会签前**禁止启动**（01 §9 / 05 W1） |
| **P2（W7–W9）** | 0 | 全部 | 同上 |
| **P3（W10–W12）** | 0 | 全部 | 同上 |

**量化结论**：P0 的技术验证、文档链路与 CI 闸门 **100% 完成**；P0 只剩 **1 次会签 + 1 项本机环境**；P1–P3 共 **10 周工作量一行代码未动，且按规程不得提前动**。本轮（11-10 对标复核）在会签前新增 ADR-010，会签项由 3 个 ADR 增至 4 个，仍属同一次会签。

**M6b 现状**（`node scripts/check-env.mjs`，只读自检，**2/5**）：

| 检查 | 结果 |
|---|---|
| E1 构建链 Node ≥24.9 | **FAIL** · v22.22.2 |
| E2 pnpm 11.x | **FAIL** · 未装 |
| E3 Corepack | **PASS** · shim 存在（沙箱内读不到版本，Bash 侧实测 0.34.6） |
| E4 `NODE_OPTIONS` 无 strip-types 守卫 | **PASS** |
| E5 `dsh` CLI 在 PATH | **FAIL** |

> 注意区分：**DSH 宿主进程内 Node 是 24.21.0**（11-07 真机探针证据），未达标的是**命令行构建链**；CI 已用 Node 24。两者不是一回事。

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
| G8 | 仓库跟踪文件无 PAT / 密钥 | PASS · 0 命中 |
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
| M6a | CI 闸门接入（GitHub Actions · `gate.yml`） | **MET** · run `42366496926` success | HE-A + BE-RL |
| M6b | 本地构建链 Node ≥24.9 + pnpm 11 | **NOT MET · 2/5**（详见 §零） | HE-A + BE-RL |
| M7 | ADR-010 正文可见性边界（信任边界，安全 Owner 必看） | 提议中，待会签 | ARC + 安全 Owner |

> M6a 已完成：CI 用 Node 24，跑 `sync-protocol --check` → `gate-check --check --assert-fresh` → `check-plugin` → `npm pack --dry-run`，commit `bcefdf5` 首次绿灯（5 秒）。
> M6b 不阻塞会签，但阻塞 P1 本地构建。注意 **DSH 进程内 Node 已是 24.21.0**，未达标的是命令行构建链，两者不要混。

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

**指纹分三组**（不按 git HEAD 判，只改提交信息不该让快照失效）：

| 组 | 文件 | 变了意味着 | 判定 |
|---|---|---|---|
| **data（事实）** | `index.js`、`cordis.patch.yml`、`package.json`、`host-probe.json`、`check-plugin.json` | 运行代码或实测证据已变 | **`STALE`** → CI exit 2，必须重算 |
| **artifact（发布物）** | `dist/*.tgz` | 重新打包了 | **仅记录 + NOTE，不影响判定** |
| **narrative（说法）** | `REPORT.md`、`PROTOCOL.md` | 措辞 / 描述更新 | **`DRIFTED`**，放行 + NOTE |

- **为什么 artifact 不参与判定**：`npm pack` **不可复现**——同样内容两次打包 sha 不同（gzip 头带时间戳）。实测：只给 README 加一个空行再 repack，tgz sha 从 `6904a9e2…` 变成 `b8549748…`；恢复 README 再 repack 仍是新 sha。若纳入判定，每次打包都会误报。
- 三档：`CURRENT`（data 与 narrative 一致）／`DRIFTED`（仅描述漂移，不阻断）／`STALE`（data 变 / 旧格式快照 / 超期）。
- 兜底上限 **30 天**：即使数据没变，超过 30 天的快照也判 `STALE`。
- 一句话：**改错别字不拦人，重新打包不误报，运行代码或实测证据一变就拦死。**
- ✅ 「发布物与源码是否一致」由 **G9 解包比对**覆盖：不比 tgz 本身（不可复现），而是解包后逐文件比 sha256，5/5 一致才 PASS。实测：改 `index.js` 但不 repack → G9 FAIL、自动项 8/9、exit 1。因此**保留 `dist/*.tgz` 在仓库、继续走 GitHub 分发**是安全的。
- 会签时请抄下 `capturedAt` / `git.head` / `fingerprints.data` 摘要写进签署栏备注，事后可复核。

## 五、签署栏

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
- 会签后：把 `01` §9 的四行「待签」改为签署状态 → 四个 ADR（007~010）状态改为「已接受」→ `CHANGELOG.md` 记一条 → 重跑 `node scripts/gate-check.mjs` 留档。
- 全部完成后才按 `05` W3 进入 P1 编码。
