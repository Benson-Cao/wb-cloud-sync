#!/usr/bin/env node
/**
 * WorkBuddy 对标复核 · 设计冻结包 r2 批量修订
 * ---------------------------------------------------------------
 * 纪律（沿用 apply-spike-revisions.mjs）：
 *   - 每处替换断言「恰好命中 1 次」，0 次或多次立即 abort，不写任何文件。
 *   - 同一文件内多处替换在内存里串行 apply，最后**只写一次盘**，
 *     避免「基于旧内容回写互相覆盖」。
 *   - 原文件全量备份到 .revisions-backup-workbuddy/<tag>/ 后才覆盖。
 *
 * 用法：
 *   node scripts/apply-workbuddy-revisions.mjs                      # 仓库 docs/ + 仓库根文件
 *   node scripts/apply-workbuddy-revisions.mjs --dry-run            # 只校验命中数
 *   node scripts/apply-workbuddy-revisions.mjs "<桌面docs目录>" --docs-only
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const docsOnly = args.includes('--docs-only')
const docsDir = args.find((a) => !a.startsWith('--')) ?? join(ROOT, 'docs')

/** 把多行拼成精确文本；行内一律用 JS 单/双引号字面量，避免模板字符串里的反引号冲突。 */
const L = (...lines) => lines.join('\n')

// ─────────────────────────────────────────────────────────────
// 冻结包 11 份文档（仓库 docs/ 与桌面原稿必须同步修订）
// ─────────────────────────────────────────────────────────────
const DOCS = {
  '00_项目总览.md': [
    [L('对标体验：WorkBuddy「连接电脑」——同账号自动发现设备、一次配对永久有效、手机和电脑看到同一份会话、任务中发消息进队列、产物回传手机。但我们的实现基于 DSH 插件生态，可自托管、可审计、可 fork。'),
     L('对标体验：WorkBuddy「连接电脑」——同账号自动发现设备、登录后选中设备即建联、设备关系持久保留、手机和电脑看到同一份会话、任务中发消息进队列、远程停止、产物回传手机。官方建联流程**不要求配对码**（信任来自同账号 + 桌面端「允许移动端连接此设备」开关）；本项目是自托管实现，额外用 6 位配对码 + HMAC 挑战响应建立设备信任。完整对标与偏差登记见 `WORKBUDDY-REFERENCE.md`。我们的实现基于 DSH 插件生态，可自托管、可审计、可 fork。')],
    [L('- **不把会话正文上云**：云端只存索引与游标。'),
     L('- **不把会话正文上云**：CP 与 Relay 零正文落盘，云端只存索引与游标；会话正文仅在 Host↔手机事件流中实时转发，且 **Relay 运维可见明文帧**（边界见 `04` §5.4 / ADR-010）。')],
    [L('| **SessionEvent** | DSH append-only 事件日志中的单条记录，含 `type / seq / time / data / ignorable?` |'),
     L('| **SessionEvent** | DSH append-only 事件日志中的单条记录，基形 `type / seq / time / data`，可选扩展 `surfaceOp / sourceEventSeqs`；`ignorable` 实测不下发，客户端不得依赖（见 `04` §3） |')],
    [L('| 文件外泄 | 0 字节工作区文件上云 | 出网流量审计 |'),
     L('| 文件外泄 | 0 字节工作区文件上云 | 出网流量审计 |',
       '| 会话正文落盘 | CP / Relay 持久化层 0 条正文 | 出网流量审计 + 存储层扫描（正文经 Relay 实时转发属预期，见 `04` §5.4） |')],
    [L('3. **信任边界**：Host 主动外连 Relay，PC 不开入站端口；Relay 只做帧透传，不解析会话内容。'),
     L('3. **信任边界**：Host 主动外连 Relay，PC 不开入站端口；Relay 只做帧透传、不解析、不落盘，但 **TLS 在 Relay 终止、运维可见事件帧明文**，见 `04` §5.4 / ADR-010。')],
    [L('| 10 | 部署与运维手册 | SRE / 自托管用户 | Relay 后端 |'),
     L('| 10 | 部署与运维手册 | SRE / 自托管用户 | Relay 后端 |',
       '',
       '> 补充材料（不在冻结包编号内）：仓库根 `WORKBUDDY-REFERENCE.md`（WorkBuddy 对标复核）、`SECURITY-REVIEW.md`（安全 Owner 一页纸）、`SIGN-OFF.md`（会签包）。')],
  ],

  '01_项目章程.md': [
    [L('同时，WorkBuddy 的跨端实践给出了一条被验证的产品路径：**账号同步设置与 Memory，任务执行留在 PC，手机经加密中继把指令送回电脑**。关键认知是"同账号 ≠ 同数据"：手机 App 默认走云端沙箱的任务，电脑桌面端根本看不到；只有「连接电脑」模式才让两端看到同一份会话。'),
     L('同时，WorkBuddy 的跨端实践给出了一条被验证的产品路径：**账号同步设置与 Memory，任务执行留在 PC，手机经加密中继把指令送回电脑**。关键认知是"同账号 ≠ 同数据"：会话跟随**执行位置**而不是跟随账号；手机作为「远程控制台」时指令在桌面端执行、两端看到同一份会话，手机侧自行发起的任务桌面端看不到。本项目的 BR-1 实测是同一事实在 DSH 上的版本：手机端 DSH 发的消息不会触发 PC 端 `session/event` 探针（`spike/REPORT.md` §4.1.1）。官方功能口径以 `WORKBUDDY-REFERENCE.md` 记录的文档取证为准。')],
    [L('我们要做的，是把这条路径在 DSH 插件生态里复刻一遍，并且做到自托管、可审计。'),
     L('我们要做的，是把这条路径在 DSH 插件生态里复刻一遍，并且做到自托管、可审计；**有意偏离之处**（配对码、正文可见性边界、v1 不做的远程配置与系统通知）在 `WORKBUDDY-REFERENCE.md` 逐条登记。')],
  ],

  '02_需求规格说明书.md': [
    [L('- FR-3.3 `state` 四态：运行中（蓝）、待审批/提问（琥珀）、已完成一轮（绿，打开即清零）、不可读（红）。'),
     L('- FR-3.3 `state` 六态：运行中（蓝）、待审批/提问（琥珀）、已完成一轮（绿，打开即清零）、**已停止（灰，远程停止后已完成步骤保留）**、**失败（红，执行异常中断）**、不可读（红）。由 `turn/end.reason` 映射：`completed|max-tokens→completed`、`aborted→stopped`、`error|interrupted→failed`、`blockaded→awaiting`；日志格式不可解读时 `unreadable`。**同一会话同一时刻只显示一种状态标识**，随 `session/index` 增量帧下发，客户端不自行推断（对齐 WorkBuddy 状态标识互斥规则）。')],
    [L('- FR-4.8 `session/cancel` 后由 DSH 侧按 `aborted` 收尾；崩溃导致的悬空轮次由 resume 合成 `interrupted` 收尾，不由我们修日志。'),
     L('- FR-4.8 `session/cancel` 后由 DSH 侧按 `aborted` 收尾；崩溃导致的悬空轮次由 resume 合成 `interrupted` 收尾，不由我们修日志。`SessionIndex.state` 分别映射为 `stopped` / `failed`（FR-3.3）。')],
    [L('| NFR-4 | 隐私 | 工作区文件、会话正文、本地配置 0 上云；出网流量审计可证 |'),
     L('| NFR-4 | 隐私 | 工作区文件、本地配置 0 上云；会话正文**零落盘、零进入 CP**，仅在 Host↔手机事件流中经自托管 Relay 实时转发（**Relay 运维可见明文帧**，见 `04` §5.4 / ADR-010）；出网审计只验证「0 字节工作区文件 + 0 条正文写入持久化层」 |')],
    [L('- **BR-6 默认最小权限**：手机可控端点由 `allowedEndpoints` 白名单限制，默认仅 `session/*` 与 `$events/*`。'),
     L('- **BR-6 默认最小权限**：手机可控端点由 `allowedEndpoints` 白名单限制，默认仅 `session/*` 与 `$events/*`。',
       '- **BR-7 对标偏差显式登记**：WorkBuddy「系统任务通知」「远程配置会话」「权限模式切换」「远程桌面读屏/点按」在本项目 v1 明确不做，理由与前置条件见 `WORKBUDDY-REFERENCE.md` §4；新增上述能力必须走变更单 + 新 ADR，权限类还需安全 Owner 一票否决。')],
    [L('| v1.0 | 2026-11-07 | 立项冻结版 | PM |'),
     L('| v1.0 | 2026-11-07 | 立项冻结版 | PM |',
       '| r2 | 2026-11-10 | WorkBuddy 对标复核：FR-3.3 状态四态→六态、NFR-4 正文可见性口径、新增 BR-7 偏差登记 | 架构师 |')],
  ],

  '03_系统架构设计.md': [
    [L('**三层信任边界**：手机 ↔ CP（账号鉴权）／ CP ↔ Relay（服务间信任 + `HOST_TOKEN`）／ Relay ↔ Host（设备令牌 + 挑战响应）。Relay 跨在中间但**不理解会话内容**。'),
     L('**三层信任边界**：手机 ↔ CP（账号鉴权）／ CP ↔ Relay（服务间信任 + `HOST_TOKEN`）／ Relay ↔ Host（设备令牌 + 挑战响应）。Relay 跨在中间但**不理解会话内容**（"不解析 / 不落盘" ≠ "不可见"；TLS 在 Relay 终止，见 `04` §5.4 / ADR-010）。')],
    [L('- **后果**：新增 `scripts/sync-protocol.mjs` 单向同步脚本；`06` §9 补充「不得独立编辑 PROTOCOL.md」规则。'),
     L('- **后果**：新增 `scripts/sync-protocol.mjs` 单向同步脚本；`06` §9 补充「不得独立编辑 PROTOCOL.md」规则。',
       '',
       '### ADR-010 正文可见性边界（at-rest 与 in-transit 分开承诺）',
       '- **状态**：提议中（待 ARC + 安全 Owner 会签）',
       '- **决策**：`04` §5.3 的上行 `session/event` 帧携带 `ev.data`（会话正文），TLS 在 Relay 终止，因此 **Relay 进程可见明文事件帧**。v1 只承诺「CP 无正文表、Relay 不写盘、正文不进入任何持久化层」与「工作区文件 0 字节经过 Relay/CP」；**不承诺对 Relay 运维的机密性**。项目所有「会话正文不上云」统一按此解释。',
       '- **理由**：`wbsync/1` 事件流必须把正文送到手机才能渲染，且 Relay 需终止 TLS 做路由；把「不落盘」写成「不可见」会让 `08` §6、`07` TC-7.6 的出网审计目标必然失败，属于会签时给出的错误承诺。WorkBuddy 官方同样把「对话内容与任务记录」列为必要收集项，保护手段是传输加密（见 `WORKBUDDY-REFERENCE.md` §3.1）。',
       '- **后果**：正文机密性依赖自托管 Relay + 运维可信 + 主机加固（`10` §6），不依赖密码学隔离；`02` NFR-4、`08` §2/§6/§10、`07` TC-7.6 口径同步收敛；若要求「Relay 被攻破也拿不到正文」，须引入 Host↔手机端到端加密载荷（`enc` 字段 + 配对期密钥交换），属不兼容变更，升 `wbsync/2` 并单独立 ADR，**v1 不做**。')],
    [L('| v1.1 | 2026-11-07 | 按 W1 Spike 实测新增 ADR-007~009（提议中，待会签）、修订 §4.2 时序 | 架构师 |'),
     L('| v1.1 | 2026-11-07 | 按 W1 Spike 实测新增 ADR-007~009（提议中，待会签）、修订 §4.2 时序 | 架构师 |',
       '| r2 | 2026-11-10 | WorkBuddy 对标复核：新增 ADR-010（正文可见性边界，待会签）、§2 信任边界措辞校正 | 架构师 |')],
  ],

  '04_接口协议与数据模型.md': [
    [L('> Owner：架构师 ｜ 状态：**修订 r1（待会签）** ｜ 协议版本：`wbsync/1`（r1 为澄清 + 新增可选字段，不升主版本）'),
     L('> Owner：架构师 ｜ 状态：**修订 r2（待会签）** ｜ 协议版本：`wbsync/1`（r2 为状态枚举扩充 + 正文可见性边界澄清，不升主版本）')],
    [L("  state          text,        -- 'running' | 'awaiting' | 'completed' | 'unreadable'"),
     L("  state          text,        -- 'running' | 'awaiting' | 'completed' | 'stopped' | 'failed' | 'unreadable'")],
    [L('> `SessionHeader` 字段（DSH 侧）：`version / id / createdAt / cwd / parentSession / isSeeded / origin / delegationDepth / agentPreset`。跨设备展示工作空间与会话谱系以它为准，**不要自己猜标题或层级**。'),
     L('**`state` 映射（r2 新增）**：由 `turn/end.reason` 单向决定 —— `completed | max-tokens → completed`（`max-tokens` 附截断标记）、`aborted → stopped`（远程停止，已完成步骤保留）、`error | interrupted → failed`、`blockaded → awaiting`；日志格式不可解读时 `unreadable`。同一会话同一时刻只上报一种状态，随 `session/index` 增量帧下发，客户端不自行推断。对齐 WorkBuddy 对话级五态（运行中 / 等待输入 / 已完成 / 已停止 / 失败）。',
       '',
       '> `SessionHeader` 字段（DSH 侧）：`version / id / createdAt / cwd / parentSession / isSeeded / origin / delegationDepth / agentPreset`。跨设备展示工作空间与会话谱系以它为准，**不要自己猜标题或层级**。')],
    [L('**保序**：Relay 不重排帧；同一 `sessionId` 的 `seq` 必须单调递增到达。若检测到乱序，客户端缓存并等待缺口填补，超时按 `NO_PROGRESS` 上报。'),
     L('**保序**：Relay 不重排帧；同一 `sessionId` 的 `seq` 必须单调递增到达。若检测到乱序，客户端缓存并等待缺口填补，超时按 `NO_PROGRESS` 上报。',
       '',
       '### 5.4 正文可见性边界（r2 新增，信任边界澄清）',
       '',
       '**事实**：`session/event` 帧的 `ev.data` 就是会话正文。Relay 终止 TLS 后按 ≤64KiB 帧透传，因此 **Relay 进程可见事件帧明文**；CP 不接收该帧。',
       '',
       '| 维度 | v1 保证 | 不保证 |',
       '|---|---|---|',
       '| 落盘（at-rest） | CP 无正文表、Relay 不写盘；事件流只在内存中转发 | — |',
       '| 传输（in-transit） | Host↔Relay、Relay↔手机全链路 TLS 1.2+ | **不保证对 Relay 运维的机密性**（可见明文正文） |',
       '| 工作区文件 | 根本不经过 Relay / CP | — |',
       '',
       '- **统一口径**：项目内所有「会话正文不上云」解释为 **「零正文落盘、零正文进入 CP」**，不解释为「零正文经过 Relay」。`02` NFR-4、`08` §6、`07` TC-7.6 的出网审计目标据此收敛为「0 字节工作区文件 + 0 条正文写入持久化层」。',
       '- **依赖**：正文机密性依赖 **自托管 Relay + 运维可信 + 主机访问控制**，不依赖密码学隔离；部署方须限制 Relay 主机登录、关闭核心转储与调试抓包，见 `10` §6。',
       '- **升级路径**：若要求「即使 Relay 被攻破也拿不到正文」，须引入 Host↔手机端到端加密载荷（`enc` 字段 + 配对期密钥交换），属**不兼容变更**，升 `wbsync/2` 并单独立 ADR；v1 明确不做（ADR-010）。',
       '- 与 WorkBuddy 官方「安全中继通道加密 + 为在移动端展示而收集对话内容与任务记录」的差异见 `WORKBUDDY-REFERENCE.md` §3.1。')],
    [L('- 新增事件类型一律带 `ignorable: true`，保证旧客户端可跳过。'),
     L('- 新增事件类型一律由客户端按白名单默认跳过；**不得依赖服务端 `ignorable` 标记**（实测宿主不下发，见 §3）。')],
    [L('- **r1（2026-11-07）**：按 W1 Spike 实测澄清事件契约、幂等映射与 Idempotency 归属；仅新增可选字段与说明，无删除/改名，兼容 `wbsync/1` 现有客户端；依据 ADR-007~009（待会签）。'),
     L('- **r1（2026-11-07）**：按 W1 Spike 实测澄清事件契约、幂等映射与 Idempotency 归属；仅新增可选字段与说明，无删除/改名，兼容 `wbsync/1` 现有客户端；依据 ADR-007~009（待会签）。',
       '- **r2（2026-11-10）**：`SessionIndex.state` 扩充 `stopped` / `failed` 两个枚举值并给出 `turn/end.reason` 映射；新增 §5.4 正文可见性边界；修正「新增事件依赖 `ignorable`」的过时表述。无删除、无改名，兼容 `wbsync/1` 现有客户端；依据 WorkBuddy 对标复核与 ADR-010（待会签）。')],
    [L('| wbsync/1 r1 | 2026-11-07 | 按 Spike 实测修订 §1/§2/§3，新增 ADR-007~009 引用（待会签） | 架构师 |'),
     L('| wbsync/1 r1 | 2026-11-07 | 按 Spike 实测修订 §1/§2/§3，新增 ADR-007~009 引用（待会签） | 架构师 |',
       '| wbsync/1 r2 | 2026-11-10 | WorkBuddy 对标复核：state 扩六态、新增 §5.4 正文可见性边界、ADR-010 引用（待会签） | 架构师 |')],
  ],

  '05_团队分工与里程碑.md': [
    [L('| W7 | 多 Host 档案、设备切换、状态点四态、设备名同步 | BE-CP + FE |'),
     L('| W7 | 多 Host 档案、设备切换、状态点六态、设备名同步 | BE-CP + FE |')],
  ],

  '07_测试计划与验收标准.md': [
    [L('| TC-4.4 | 点「停止」 | 走 `session/cancel`，与队列分离，轮次按 `aborted` 收尾 |'),
     L('| TC-4.4 | 点「停止」 | 走 `session/cancel`，与队列分离，轮次按 `aborted` 收尾；索引 `state=stopped`，已完成步骤保留 |')],
    [L('| TC-4.10 | 插件卸载 / 重装 | 所有 `/__wbsync/*` 404，无残留路由、定时器、WS 连接 |'),
     L('| TC-4.10 | 插件卸载 / 重装 | 所有 `/__wbsync/*` 404，无残留路由、定时器、WS 连接 |',
       '| TC-4.11 | 轮次异常中断 / resume 合成 `interrupted` | 索引 `state=failed`，手机端显示「失败」且可查看错误原因 |')],
    [L('| TC-7.6 | 出网流量审计 | 会话正文 / 工作区文件 0 字节上云 |'),
     L('| TC-7.6 | 出网流量审计 | 工作区文件 0 字节出网；会话正文 0 条写入 CP / Relay 持久化层（正文经 Relay 实时转发属预期，见 `04` §5.4） |')],
    [L('| TC-7.8 | 高危权限默认值 | 全部关闭，需逐项显式授权 |'),
     L('| TC-7.8 | 高危权限默认值 | 全部关闭，需逐项显式授权 |',
       '| TC-7.9 | Relay 进程内存与磁盘扫描 | 0 条会话正文落盘；正文只在转发帧中出现（ADR-010 已知边界，非缺陷） |')],
  ],

  '08_安全与隐私设计.md': [
    [L('1. **机密性**：会话正文、工作区文件、本地配置绝不离开 PC；令牌不明文落盘。'),
     L('1. **机密性**：会话正文零落盘、零进入 CP（但**经 Relay 明文转发，运维可见**，见 `04` §5.4 / ADR-010）；工作区文件、本地配置绝不离开 PC；令牌不明文落盘。')],
    [L('- **Relay 是半可信**：可转发帧但不解析语义；即使 Relay 被攻破，攻击者也只能看到密文隧道内的帧结构，拿不到工作区文件（因为文件根本不经过它）。'),
     L('- **Relay 是半可信**：可转发帧、不解析语义、不写盘；但 **TLS 在 Relay 终止，Relay 进程可见事件帧明文（含会话正文）**，这是 v1 的已知边界（`04` §5.4 / ADR-010）。工作区文件根本不经过它，即使 Relay 被攻破也拿不到文件；**会话正文的机密性依赖「自托管 + 运维可信」，不依赖密码学隔离**。')],
    [L('| **I** 信息泄露 | 会话正文/文件上云 | 架构性保证：CP 无正文表、无文件接口；出网流量审计 0 字节 |'),
     L('| **I** 信息泄露 | 会话正文/文件上云 | 架构性保证：CP 无正文表、无文件接口、Relay 不写盘；出网审计验证「0 字节工作区文件 + 0 条正文写入持久化层」；**Relay 运维可见明文正文由 ADR-010 显式登记，靠自托管与主机加固缓解** |')],
    [L('| 会话事件正文 | PC `~/.dsh` | **否** |'),
     L('| 会话事件正文 | PC `~/.dsh`（唯一持久副本） | **否**（零落盘、不进 CP；仅在 Host↔手机事件流中经自托管 Relay 实时转发，运维可见明文，见 `04` §5.4） |')],
    [L('**产品层必须说清**：手机查看历史消息必须连上对应在线 PC；PC 离线时只能看索引与状态点。这不是缺陷，是"文件不出本机"的代价。'),
     L('**产品层必须说清**：手机查看历史消息必须连上对应在线 PC；PC 离线时只能看索引与状态点。这不是缺陷，是"文件不出本机"的代价。**另须说清**：会话正文本来就要经过 Relay 才能到手机，v1 保证的是「不落盘、不进 CP、文件零出网」，不保证「Relay 运维看不到正文」；因此 Relay 必须自托管，见 `04` §5.4。')],
    [L('**出网审计**：W10 用流量镜像证明 0 字节工作区文件与 0 条会话正文经过 CP/Relay；报告进 GA 门禁。'),
     L('**出网审计**：W10 用流量镜像 + 存储层扫描证明 **0 字节工作区文件出网**、**0 条会话正文写入 CP / Relay 持久化层**；报告进 GA 门禁。「正文经 Relay 实时转发」是协议既定行为（`04` §5.3），**不得**写成「0 条会话正文经过 Relay」，否则用例必然失败（ADR-010）。')],
    [L('- [ ] 出网审计：0 字节文件、0 条会话正文'),
     L('- [ ] 出网审计：0 字节工作区文件、0 条会话正文写入持久化层')],
    [L('| v1.0 | 2026-11-07 | 首版，威胁模型 + 检查单 | 架构师 |'),
     L('| v1.0 | 2026-11-07 | 首版，威胁模型 + 检查单 | 架构师 |',
       '| r2 | 2026-11-10 | WorkBuddy 对标复核：§2/§6 正文可见性口径、出网审计目标收敛为可证伪；依据 ADR-010 | 架构师 |')],
  ],

  '09_风险登记册.md': [
    [L('| R-04 | **事件正文 / 工作区文件意外上云**，破坏核心隐私承诺 | 2 | 5 | 10 | 黄 | CP 无正文表 / 无文件接口（架构性保证）；出网流量审计；日志正则扫描；产物仅元数据 + 临时票 | ARC + BE-RL | 出网字节异常、日志命中敏感正则 |'),
     L('| R-04 | **事件正文 / 工作区文件意外上云**，破坏核心隐私承诺 | 2 | 5 | 10 | 黄 | CP 无正文表 / 无文件接口 / Relay 不写盘（架构性保证）；出网流量审计；日志正则扫描；产物仅元数据 + 临时票；**正文经 Relay 实时转发属预期，审计只验「零落盘 / 零进 CP」（`04` §5.4）** | ARC + BE-RL | 出网字节异常、日志命中敏感正则 |')],
    [L('| R-18 | **用户误解"同账号 = 同数据"**，投诉历史会话看不到 | 4 | 3 | 12 | 黄 | 产品内明确区分「云端工作」与「连接电脑」；离线只能看索引；文档 00/02 反复说明 | PM + FE | 客服/issue 关键词 |'),
     L('| R-18 | **用户误解"同账号 = 同数据"**，投诉历史会话看不到 | 4 | 3 | 12 | 黄 | 产品内明确区分「云端工作」与「连接电脑」；离线只能看索引；文档 00/02 反复说明 | PM + FE | 客服/issue 关键词 |',
       '| R-19 | **"正文不上云"被误读为"Relay 也看不到"**，部署方把自托管 Relay 托管到不可信第三方 / 忽略主机访问控制，或 GA 审计按错误口径判失败 | 3 | 4 | 12 | 黄 | `04` §5.4 明确 at-rest 与 in-transit 边界；ADR-010 待 ARC + 安全 Owner 会签；`10` §6 增加 Relay 主机加固清单；`SECURITY-REVIEW.md` 第 1/5 项列为安全 Owner 必看；端到端加密列 `wbsync/2` 候选 | ARC + 安全 Owner | 部署咨询、GA 审计结论与文档口径不一致 |')],
    [L('| v1.0 | 2026-11-07 | 首版，18 项（红 3 / 黄 11 / 绿 4） | PM |'),
     L('| v1.0 | 2026-11-07 | 首版，18 项（红 3 / 黄 11 / 绿 4） | PM |',
       '| r2 | 2026-11-10 | WorkBuddy 对标复核：新增 R-19，R-04 缓解口径校正（19 项，红 3 / 黄 12 / 绿 4） | PM |')],
  ],

  '10_部署与运维手册.md': [
    [L('- 单活跃令牌状态、孤儿与 30 天前已吊销令牌加载时自动清理'),
     L('- 单活跃令牌状态、孤儿与 30 天前已吊销令牌加载时自动清理',
       '',
       '### Relay 主机加固（正文可见性补偿）',
       '',
       '`session/event` 帧含会话正文，TLS 在 Relay 终止 → **Relay 进程可见明文**（`04` §5.4 / ADR-010）。因此 Relay 必须自托管，且：',
       '',
       '- 限制 Relay 主机 SSH / 控制台登录人员，审计登录日志；不要把 Relay 托管给不可信第三方。',
       '- 关闭核心转储（core dump）、禁用生产环境调试抓包与帧内容日志；日志字段白名单见 `08` §8。',
       '- 事件帧只在内存中转发，禁止写入任何持久化层（含临时文件、消息队列、APM 请求体采集）。',
       '- 定期执行 TC-7.9：扫描 Relay 进程与磁盘，确认 0 条会话正文落盘。',
       '- 若部署方无法接受该边界，v1 无配置可解，需等待 `wbsync/2` 端到端加密载荷（见 ADR-010 升级路径）。')],
    [L('6. 文件与产物本体始终留在电脑，云端只流转元数据与临时下载票。'),
     L('6. 文件与产物本体始终留在电脑，云端只流转元数据与临时下载票。',
       '7. 聊天内容需要经 Relay 才能送到手机：v1 保证「不落盘、不进控制面、文件零出网」，但 **Relay 运维能看到明文正文**，所以 Relay 请自己部署并管好主机（`04` §5.4）。')],
    [L('| v1.0 | 2026-11-07 | 首版 | BE-RL |'),
     L('| v1.0 | 2026-11-07 | 首版 | BE-RL |',
       '| r2 | 2026-11-10 | WorkBuddy 对标复核：§6 新增 Relay 主机加固清单、§10 用户须知补正文可见性 | BE-RL |')],
  ],
}

// ─────────────────────────────────────────────────────────────
// 仓库根文件（只在 repo 模式执行）
// ─────────────────────────────────────────────────────────────
const ROOTFILES = {
  'SECURITY-REVIEW.md': [
    [L('**要确认的只有一件事：用户的数据有没有可能跑到 PC 之外。** 代码写得对不对、消息谁赢，是架构师和 PM 的事。'),
     L('**要确认的只有一件事：用户的数据有没有可能跑到 PC 之外。** 代码写得对不对、消息谁赢，是架构师和 PM 的事。2026-11-10 对标复核新增第 5 项，把「正文是否经过 Relay」单独拆出来，避免把「不落盘」误当成「不可见」。')],
    [L('| 1 | 聊天正文、工作区文件会不会上云？ | `08` §2 信任边界 / §6 数据表；`04` §2 数据模型（CP 只有元数据表） | **架构性保证**：CP 无正文表、无文件接口；Relay 只做帧透传不解析内容。✅ 已验证（设计层） |'),
     L('| 1 | 聊天正文、工作区文件会不会上云（落到别人磁盘上）？ | `08` §2 / §6；`04` §2 / **§5.4**；ADR-010 | **不落盘：架构性成立**（CP 无正文表、Relay 不写盘、文件零出网）。**但 Relay 运维可见明文正文，见第 5 项**，不能再写「✅ 已验证不可见」 |')],
    [L('| 4 | 怎么证明「零字节上云」？ | `00` 成功指标 / `08` §10 合规检查单 / `07` TC-7.6 | ⚠️ **未做**：出网流量镜像审计排在 P3（W10）。**会签时应标为「待 P3 验证」，不能勾选通过。** |'),
     L('| 4 | 怎么证明「零字节上云」？ | `00` 成功指标 / `08` §10 / `07` TC-7.6 / **TC-7.9** | ⚠️ **未做**：出网流量镜像审计排在 P3（W10）。审计目标已收敛为可证伪的「0 字节工作区文件 + 0 条正文写入持久化层」。**会签时应标为「待 P3 验证」，不能勾选通过。** |',
       '| 5 | 自托管 Relay 的运维能不能看到聊天正文？ | `04` §5.4 / ADR-010 / `10` §6 | ⚠️ **能看到明文事件帧（v1 已知边界）**：TLS 在 Relay 终止，正文要经它转发到手机；CP 与 Relay 零落盘，但机密性依赖运维可信。若不能接受，需 `wbsync/2` 端到端加密，v1 不做。**会签时必须明确接受或否决** |')],
    [L('- ADR-007（事件契约）、ADR-008（幂等与写入权）、ADR-009（PROTOCOL.md 唯一性）——技术正确性，架构师负责。'),
     L('- ADR-007（事件契约）、ADR-008（幂等与写入权）、ADR-009（PROTOCOL.md 唯一性）——技术正确性，架构师负责。**例外：ADR-010（正文可见性边界）属于信任边界，安全 Owner 必须审**。')],
    [L('| 安全 Owner | 待签 | 建议附条件：**第 4 项（出网审计）在 P3 W10 完成前不得 GA** | — |'),
     L('| 安全 Owner | 待签 | 建议附条件：**① 第 4 项（出网审计）在 P3 W10 完成前不得 GA；② 第 5 项 Relay 可见明文须书面接受，且 GA 文档必须写明「Relay 需自托管」** | — |')],
  ],

  'SIGN-OFF.md': [
    [L('**仓库状态**：本地 = 远端 `e140c70`，工作区干净，三天内无新提交；门禁快照 `CURRENT`（age 2d / 上限 30d）。三天里工作区新增的 `dsh-nas-sync` 审查/修复文档与本项目无关。'),
     L('**仓库状态**（2026-11-10 复核）：工作区干净；门禁快照按 `PROTOCOL.md` 变更重算为 `CURRENT`。本轮新增 WorkBuddy 对标复核与 `wbsync/1 r2` 修订（新增 ADR-010），详见 `WORKBUDDY-REFERENCE.md` 与 `CHANGELOG.md`。')],
    [L('| **P0 人工项** | M6a CI 接入 MET | **M1 四方会签 + M2~M4 三个 ADR + M5 安全一票否决**（本质是**一次会签**）、**M6b 本地构建链** | 人签字 / 本机环境 |'),
     L('| **P0 人工项** | M6a CI 接入 MET | **M1 四方会签 + M2~M4 / M7 四个 ADR + M5 安全一票否决**（本质是**一次会签**）、**M6b 本地构建链** | 人签字 / 本机环境 |')],
    [L('**量化结论**：P0 的技术验证、文档链路与 CI 闸门 **100% 完成**；P0 只剩 **1 次会签 + 1 项本机环境**；P1–P3 共 **10 周工作量一行代码未动，且按规程不得提前动**。'),
     L('**量化结论**：P0 的技术验证、文档链路与 CI 闸门 **100% 完成**；P0 只剩 **1 次会签 + 1 项本机环境**；P1–P3 共 **10 周工作量一行代码未动，且按规程不得提前动**。本轮（11-10 对标复核）在会签前新增 ADR-010，会签项由 3 个 ADR 增至 4 个，仍属同一次会签。')],
    [L('| G7 | ADR-007~009 已写入 `03` | PASS · 3/3 |'),
     L('| G7 | ADR-007~010 已写入 `03` | PASS · 4/4 |')],
    [L('| M6b | 本地构建链 Node ≥24.9 + pnpm 11 | **NOT MET · 2/5**（详见 §零） | HE-A + BE-RL |'),
     L('| M6b | 本地构建链 Node ≥24.9 + pnpm 11 | **NOT MET · 2/5**（详见 §零） | HE-A + BE-RL |',
       '| M7 | ADR-010 正文可见性边界（信任边界，安全 Owner 必看） | 提议中，待会签 | ARC + 安全 Owner |')],
    [L('| 隐私与供应链 | `docs/08` §9、`spike/evidence/host-probe.json` | 证据已脱敏；全 history 密钥 0 命中；不落事件正文 |'),
     L('| 隐私与供应链 | `docs/08` §9、`spike/evidence/host-probe.json` | 证据已脱敏；全 history 密钥 0 命中；不落事件正文 |',
       '| 正文可见性（ADR-010） | `docs/04` §5.4、`WORKBUDDY-REFERENCE.md` §3.1、`docs/08` §2/§6 | 上行 `session/event` 帧携带 `data` 正文；TLS 在 Relay 终止；审计目标收敛为「零落盘 / 零进 CP」 |')],
    [L('已把安全 Owner 需要看的内容压成一页：[`SECURITY-REVIEW.md`](SECURITY-REVIEW.md) —— 4 行核对，其中第 3、4 项如实标为「待验证 / 待 P3」，**不把待办写成通过**。其余 10 份文档、3 个 ADR、CI 与端口细节都不需要他审。'),
     L('已把安全 Owner 需要看的内容压成一页：[`SECURITY-REVIEW.md`](SECURITY-REVIEW.md) —— **5 行核对**，其中第 3、4 项如实标为「待验证 / 待 P3」，第 5 项如实标为「v1 已知边界，须书面接受」，**不把待办写成通过**。其余 10 份文档、CI 与端口细节不需要他审；**但 ADR-010 属信任边界，是 4 个 ADR 里唯一必须给他审的一个**。')],
    [L('- 会签后：把 `01` §9 的四行「待签」改为签署状态 → 三个 ADR 状态改为「已接受」→ `CHANGELOG.md` 记一条 → 重跑 `node scripts/gate-check.mjs` 留档。'),
     L('- 会签后：把 `01` §9 的四行「待签」改为签署状态 → 四个 ADR（007~010）状态改为「已接受」→ `CHANGELOG.md` 记一条 → 重跑 `node scripts/gate-check.mjs` 留档。')],
  ],

  'CHANGELOG.md': [
    [L('---', '', '## [真机验证] · 2026-11-07 18:10 · 非协议变更'),
     L('---', '',
       '## [wbsync/1 r2] · 2026-11-10 · WorkBuddy 手机/电脑端对标复核',
       '',
       '**性质**：会签前的口径修订。状态枚举扩充两个值 + 新增正文可见性边界澄清 + 修正三处事实/口径错误；**无删除、无改名**，兼容 `wbsync/1` 现有客户端，不升主版本。',
       '**依据**：官方文档「多端协同（连接电脑）」与英文 "Keep Tasks Moving Across Devices"（2026-11-10 取证）、本机 `app.asar` 实现线索、新增 `WORKBUDDY-REFERENCE.md`；新增 ADR-010（提议中，待 ARC + 安全 Owner 会签）。',
       '',
       '### 契约（`docs/04` / `PROTOCOL.md`）',
       '',
       '- `SessionIndex.state` 四态 → **六态**：新增 `stopped` / `failed`，并给出 `turn/end.reason` 单向映射与「同一会话只上报一种状态」互斥约束。补齐 `session/cancel` 早已有、但索引状态未定义的缺口；对齐官方「已停止 / 失败」两态。',
       '- **新增 §5.4 正文可见性边界**：`session/event` 帧的 `ev.data` 即正文，TLS 在 Relay 终止 → Relay 进程可见明文。统一「会话正文不上云」为「零落盘、零进入 CP」，出网审计目标收敛为「0 字节工作区文件 + 0 条正文写入持久化层」。端到端加密列 `wbsync/2` 候选，v1 不做。',
       '- 修正 §9「新增事件类型一律带 `ignorable: true`」——与 §3 实测（宿主不下发、客户端不得依赖）冲突，改为白名单默认跳过。',
       '',
       '### 文档（冻结包 11 份 + 会签材料）',
       '',
       '- `00` 对标体验去掉「一次配对永久有效」被误当成官方流程的写法；`01` §1 删除未经证实的「云端沙箱」表述，BR-1 证据明确指向 DSH 手机端实测。',
       '- `02` FR-3.3 / NFR-4 / FR-4.8 修订，新增 **BR-7 对标偏差显式登记**（系统通知、远程配置、权限模式切换、远程桌面读屏/点按 v1 不做）。',
       '- `03` 新增 **ADR-010**、§2 信任边界措辞校正；`08` §2/§6/§10 隐私口径与可证伪审计目标；`09` 新增 **R-19**（口径误读风险）；`07` 补 TC-4.11 / TC-7.9、改 TC-7.6；`10` §6 新增 Relay 主机加固清单、§10 用户须知第 7 条；`05` 状态点四态→六态。',
       '- `SECURITY-REVIEW.md` 第 1 行不再写「✅ 已验证不可见」，新增第 5 项「Relay 运维可见明文」并要求会签时书面接受；`SIGN-OFF.md` 新增 **M7** 与依据索引行；`gate-check.mjs` G7 从 3 个 ADR 扩到 4 个。',
       '- 新增 `scripts/apply-workbuddy-revisions.mjs`（带「每处恰好 1 次命中」断言 + 原文备份 + `--dry-run`），仓库 `docs/` 与桌面原稿同步修订，两份仍逐字节一致。',
       '',
       '**P0 门禁状态不变**：`BLOCKED_BY_SIGNOFF`；会签项由 3 个 ADR 增至 4 个，仍属同一次会签，未新增实现工作。',
       '',
       '---', '',
       '## [真机验证] · 2026-11-07 18:10 · 非协议变更')],
  ],

  'README.md': [
    [L('├─ CHANGELOG.md                 # 契约变更记录（wbsync/1 r1）'),
     L('├─ CHANGELOG.md                 # 契约变更记录（wbsync/1 r2）',
       '├─ WORKBUDDY-REFERENCE.md       # WorkBuddy 手机/电脑端对标复核（r2 修订依据）',
       '├─ SECURITY-REVIEW.md           # 安全 Owner 一页纸（5 行核对）')],
    [L('├─ SIGN-OFF.md                  # P0 会签包：自动项 9/9、待签 M1~M6、签署栏'),
     L('├─ SIGN-OFF.md                  # P0 会签包：自动项 9/9、待签 M1~M7、签署栏')],
    [L('├─ docs/                        # 设计冻结包 v1.1（11 份，含 ADR-007~009）'),
     L('├─ docs/                        # 设计冻结包（11 份，含 ADR-007~010）')],
    [L('│  ├─ sync-protocol.mjs         # ADR-009：生成 PROTOCOL.md + --check CI 校验'),
     L('│  ├─ sync-protocol.mjs         # ADR-009：生成 PROTOCOL.md + --check CI 校验',
       '│  ├─ apply-workbuddy-revisions.mjs # r2 对标复核修订（带断言与备份）')],
  ],

  'scripts/gate-check.mjs': [
    [L("  { id: 'G7', label: 'ADR-007~009 已写入 03',"),
     L("  { id: 'G7', label: 'ADR-007~010 已写入 03',")],
    [L("    pass: (arch.match(/^### ADR-00[789]/gm) ?? []).length === 3 },"),
     L("    pass: (arch.match(/^### ADR-(00[789]|010)/gm) ?? []).length === 4 },")],
    [L("  { id: 'M6b', label: '本地构建链 Node ≥24.9 + pnpm 11（见 scripts/check-env.mjs）', status: 'NOT MET · 2/5', owner: 'HE-A + BE-RL' },"),
     L("  { id: 'M6b', label: '本地构建链 Node ≥24.9 + pnpm 11（见 scripts/check-env.mjs）', status: 'NOT MET · 2/5', owner: 'HE-A + BE-RL' },",
       "  { id: 'M7', label: 'ADR-010 正文可见性边界（信任边界，安全 Owner 必看）', status: '提议中，待会签', owner: 'ARC + 安全 Owner' },")],
  ],

  '.gitignore': [
    [L('.revisions-backup-realdevice/'),
     L('.revisions-backup-realdevice/',
       '.revisions-backup-workbuddy/')],
  ],
}

// ─────────────────────────────────────────────────────────────
const targets = []
for (const [name, reps] of Object.entries(DOCS)) targets.push({ file: join(docsDir, name), reps })
if (!docsOnly) {
  for (const [name, reps] of Object.entries(ROOTFILES)) targets.push({ file: join(ROOT, name), reps })
}

// 先全量校验命中数，任何一处不合规就整体 abort（不留半套修订）
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
      console.error(`HIT ${hits} (want 1)  ${basename(t.file)}  repl#${i + 1}  ${from.slice(0, 60).replace(/\n/g, '\\n')}`)
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

const tag = docsOnly ? 'desktop' : 'repo'
const backupDir = join(ROOT, '.revisions-backup-workbuddy', tag)
mkdirSync(backupDir, { recursive: true })
for (const t of targets) {
  const rel = t.file.replace(ROOT, '').replace(/^[\\/]/, '').replace(/[\\/]/g, '__')
  writeFileSync(join(backupDir, rel), t.original, 'utf8')
  writeFileSync(t.file, t.result, 'utf8')
  console.log(`  wrote ${t.file}`)
}
console.log(`备份：${backupDir}`)
