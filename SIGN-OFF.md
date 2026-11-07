# P0 设计冻结 · 会签包

> 生成日期：2026-11-07 ｜ 依据：`01` §9 会签表、`05` RACI 与 §4 协作流程、`06` §6 决策机制
> 机器可读快照：`node scripts/gate-check.mjs` → `spike/evidence/gate-check.json`

## 结论先行

**自动项 8/8 PASS；P0 唯一剩余硬阻塞是「会签」。** 会签完成前不得进入 P1 编码（`01` §9 / `05` W1）。
当前门禁状态：`BLOCKED_BY_SIGNOFF`。

## 一、自动核查（可复跑，无需人工判断）

| ID | 检查 | 结果 |
|---|---|---|
| G1 | 三问离线取证 Q1/Q2/Q3 全 PASS | PASS |
| G2 | `check-plugin.mjs` 插件加载验证 | PASS |
| G3 | 上游 commit 锁定（40 位 SHA） | PASS · `66491b05…` |
| G4 | `PROTOCOL.md` 与 `docs/04` 单向同步 | PASS |
| G5 | 真机加载 + 运行时事件闭环（REPORT §4.1.2） | PASS · 19 条 / seq 4→22 |
| G6 | TC-4.10 真机卸载残留（REPORT §4.1.3） | PASS · 404 |
| G7 | ADR-007~009 已写入 `03` | PASS · 3/3 |
| G8 | 仓库跟踪文件无 PAT / 密钥 | PASS · 0 命中 |

复跑：`node scripts/gate-check.mjs --check`（自动项全过 exit 0）；CI 用 `--check --assert-fresh`（`.github/workflows/gate.yml`）。

## 二、待签项（脚本判不了，必须由人决定）

| ID | 事项 | 状态 | Owner |
|---|---|---|---|
| M1 | 四方文档会签（PM / 架构师 / 安全 Owner / QA Owner） | **NOT MET** | PM |
| M2 | ADR-007 事件契约以宿主实测为准 | 提议中，待会签 | ARC + PM |
| M3 | ADR-008 幂等与写入权归宿主 | 提议中，待会签 | ARC + PM |
| M4 | ADR-009 `PROTOCOL.md` 为唯一契约源 | 提议中，待会签 | ARC |
| M5 | 安全项一票否决权行使（`08` / `01` §6） | 待安全 Owner | 安全 Owner |
| M6 | 构建链 Node ≥24.9 + pnpm 11 + CI 接入 | NOT MET | HE-A + BE-RL |

> M6 不阻塞会签，但阻塞 P1 构建链。注意 **DSH 进程内 Node 已是 24.21.0**，未达标的是命令行构建链，两者不要混。

## 三、会签依据索引

| 决策 | 依据文件 | 关键实测数据 |
|---|---|---|
| 事件契约（ADR-007） | `docs/04` §3、`spike/REPORT.md` D-01/D-02/D-07 | 667 条离线样本 + 19 条运行时事件；`surfaceOp` 6 条；`ignorable` 0 次；日志无 `assistant/chunk` |
| 幂等 / 写入权（ADR-008） | `docs/03` §4.2、`spike/REPORT.md` Q2 | 宿主 `prompt(request).requestId` + `hasPromptRequest()` + `SessionAlreadyOwnedError` → `session/writer-held` |
| 契约源唯一性（ADR-009） | `PROTOCOL.md`、`scripts/sync-protocol.mjs` | `--check` PASS；字段变更须同 PR 改 `04` + `PROTOCOL.md` + `CHANGELOG.md` |
| 三问门禁（R-02） | `spike/REPORT.md` §2 / §4.1 / §4.1.2 | Q1 seq 0→666 离线 + 4→22 运行时；Q2 提交入口；Q3 补齐 266/266 |
| 可逆副作用 / TC-4.10 | `spike/REPORT.md` §4.1.3 | 18:41 卸载 404（同进程，强证据） |
| 隐私与供应链 | `docs/08` §9、`spike/evidence/host-probe.json` | 证据已脱敏；全 history 密钥 0 命中；不落事件正文 |

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
| `spike/evidence/gate-check.json` | **审计快照**：会签时点的证明 | 证据输入变化时由人重跑并提交 | **仅在 `freshness.status = CURRENT` 时**；`STALE` 只能当历史 |

- 「新鲜」看**证据输入指纹**（`host-probe.json` / `check-plugin.json` / `REPORT.md` / `PROTOCOL.md` / `dist-tarball` 的 sha256），不是 git HEAD —— 只改文档或提交信息不该让快照失效。
- 兜底上限 **30 天**：即使证据没变，超过 30 天的快照也判 `STALE`。
- CI 用 `--check --assert-fresh`：快照 `STALE` 直接 exit 2，强制在 PR 里重算并提交，**防止有人拿旧绿灯当今天的准入**。
- 会签时请抄下 `capturedAt` / `git.head` / `evidenceSha256` 写进签署栏备注，事后可复核。

## 五、签署栏

| 角色 | 姓名 / 代号 | 结论（同意 / 附条件 / 否决） | 日期 | 备注 |
|---|---|---|---|---|
| 发起人 / PM | — | 待签 | — | 范围、节奏、发布 |
| 架构师（兼安全 Owner） | — | 待签 | — | 架构、ADR、协议 |
| 安全 Owner | — | 待签 | — | **一票否决权** |
| QA Owner | — | 待签 | — | 门禁与验收 |

## 六、会签规则与收尾动作

- 协议字段变更必须 **ARC 会签**；安全争议由 **安全 Owner 一票否决**（`01` §6 / `05` RACI）。
- **结论必须回写 ADR 或协议文档**，只在大群里说不算决策（`05` §4）。
- 会签后：把 `01` §9 的四行「待签」改为签署状态 → 三个 ADR 状态改为「已接受」→ `CHANGELOG.md` 记一条 → 重跑 `node scripts/gate-check.mjs` 留档。
- 全部完成后才按 `05` W3 进入 P1 编码。
