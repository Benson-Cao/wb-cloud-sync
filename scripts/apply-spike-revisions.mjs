#!/usr/bin/env node
/**
 * 设计冻结包 v1.0 → v1.1 的文档修订脚本（W1 Spike 实测回填）
 * ---------------------------------------------------------------
 * 依据：spike/REPORT.md 的 D-01~D-07、ADR-007~009（提议中）。
 *
 * 为什么用脚本而不是逐条 Edit：改动跨 10 份文档 30 处，同一文件内多处
 * 并发修改会互相覆盖。本脚本对每份文档**串行、基于最新内容**替换，并对每个
 * old 断言「恰好 1 次命中」，任何一处不匹配立即中止，不改半份文件。
 *
 * 用法：
 *   node scripts/apply-spike-revisions.mjs [docs-dir]
 * 默认 docs-dir = C:/Users/Administrator/Desktop/wb-cloud-sync-docs
 *
 * 运行前自动把原文备份到 .revisions-backup/（已 gitignore），可回滚。
 * 幂等：第二次运行会因 old 不再命中而报错退出，不会重复写入。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const DOCS = process.argv.slice(2).find((arg) => !arg.startsWith('--')) ??
  'C:/Users/Administrator/Desktop/wb-cloud-sync-docs'
const BACKUP = 'D:/Dw phone/wb-cloud-sync/.revisions-backup'

const edits = {
  // ---------------------------------------------------------------- 00
  '00_项目总览.md': [
    [
      '| **Cursor** | 每个客户端的消费位点 `sinceSeq` |',
      '| **Cursor** | 每个客户端的消费位点 `sinceSeq` |\n' +
      '| **surfaceOp** | 宿主事件自带的投影指令（实测恒为 `append`），客户端据此更新视图 |\n' +
      '| **sourceEventSeqs** | 事件关联的源事件 seq 数组；实测仅出现在 `tool/result`，用于配对 `tool/call` |\n' +
      '| **requestId** | 宿主 `prompt(request)` 的幂等键，由 `clientMsgId` 直接映射（见 ADR-008） |\n' +
      '| **多帧 zstd** | `session.v4.jsonl.zstd` 的存储格式：每批追加写一个独立 zstd 帧，须逐帧解压；只解首帧会漏读全部事件 |',
    ],
    [
      '1. **锁定 DSH commit**：DSH 处于 Developer Preview，官方明确会有不兼容变更且无 release tag。所有开发基于同一个 pinned commit，升级走独立 ADR。',
      '1. **锁定 DSH commit**：已锁定 `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`（上游 tag `dsh-v0.2.2-rc.1`，见 `pinned-commit.txt`）。上游已开始使用 release tag，但 DSH 仍处 Developer Preview，升级一律走独立 ADR。',
    ],
  ],

  // ---------------------------------------------------------------- 01
  '01_项目章程.md': [
    [
      '| A1 | DSH 提供 `session/event` 事件订阅、`ctx.webServer` 具名路由、`ctx.effect` 可撤销副作用、`sessionPersistence.list()` | 锁 commit 后在 W1 做 Spike 验证；不满足则提 ADR 换接缝 |',
      '| A1 | DSH 提供 `session/event` 事件订阅（首参为 session 对象）、`ctx.webServer` 具名路由、`ctx.effect` 可撤销副作用、`sessionPersistence.list()/open(id,\'read\')`，以及**宿主会话 owner 的 prompt 提交入口** | 锁 commit 后按 05 W1 / 09 R-02 的**三问**做 Spike 验证；任一不过当天上报发起人，不得进入 P1 编码 |',
    ],
    [
      '批准启动。P0 阶段（W1–W2）的**唯一硬产出是设计冻结**：本套文档会签完成、Spike 验证 A1 通过、DSH commit 锁定。Spike 未通过不得进入 P1 编码。',
      '批准启动。P0 阶段（W1–W2）的**唯一硬产出是设计冻结**：本套文档会签完成、Spike 验证 A1 通过、DSH commit 锁定。Spike 未通过不得进入 P1 编码。\n\n' +
      '> 2026-11-07 W1 Spike 离线取证：三问全 PASS（见仓库 `spike/REPORT.md`），commit 已锁定至 `66491b0…`。**真机加载验证与四方会签仍待完成**，P0 门禁整体未过。本套文档据实测做了 v1.1 修订，新增 ADR-007~009 均为「提议中，待会签」。',
    ],
  ],

  // ---------------------------------------------------------------- 02
  '02_需求规格说明书.md': [
    [
      '- FR-4.2 事件字段：`type / seq / time / data / ignorable?`；未知类型带 `ignorable: true` 时客户端跳过而非整会话拒绝。',
      '- FR-4.2 事件字段：`type / seq / time / data`，可选扩展 `surfaceOp / sourceEventSeqs`。**实测宿主不下发 `ignorable` 字段**（667 条样本中 0 次），客户端一律「白名单投影 + 未知类型默认跳过」，不得因未知类型拒绝整会话。',
    ],
    [
      '- FR-4.3 手机端按 Surface 规则渲染：仅 `system/message`、`user/message`、`assistant/message`、`tool/result` 投影成消息；`turn/*`、`step/*`、`assistant/chunk`、`request/header`、`todo/write`、`hook/*` 作为结构/过程信息处理，`chunk` 需折叠成完整消息。',
      '- FR-4.3 手机端按 Surface 规则渲染：仅 `system/message`、`user/message`、`assistant/message`、`tool/result` 投影成消息；`turn/*`、`step/*`、`request/header`、`todo/write` 等作为结构/过程信息处理。**实测日志不含 `assistant/chunk`**（流式分片不落盘），无需 chunk 折叠；`tool/call` 与 `tool/result` 按 `sourceEventSeqs` 配对；宿主自带 `surfaceOp` 投影指令，客户端据此更新视图而非自行重算。',
    ],
    [
      '- FR-4.5 `session/prompt` 携带 `clientMsgId` 做幂等；重复请求返回 `duplicate`，不产生第二条 `user/message`。',
      '- FR-4.5 `session/prompt` 携带 `clientMsgId` 做幂等；**`clientMsgId` 应直接映射宿主 `prompt(request)` 的 `requestId`**，宿主已按 `message.source.rpcId` 原生去重，重复返回 `{accepted:true}` / `duplicate`，不产生第二条 `user/message`。Host 侧不再自建幂等表（ADR-008）。',
    ],
    [
      '- **BR-4 未知事件宽容**：带 `ignorable: true` 的未知事件跳过，不中断渲染。',
      '- **BR-4 未知事件宽容**：白名单之外的事件默认跳过，**不依赖服务端 `ignorable` 标记**（实测宿主不下发），不中断渲染。',
    ],
    [
      '- 锁定的 DSH commit（W1 Spike 验证 `session/event`、`ctx.webServer`、`ctx.effect`、`sessionPersistence.list()` 可用）。',
      '- 锁定的 DSH commit `66491b0…`（W1 Spike 按 09 R-02 **三问**验证：① 带连续 `seq` 的事件订阅；② 不经写句柄把用户消息交给宿主 owner；③ `sessionPersistence.list()/open(id,\'read\')` 枚举与只读回放）。2026-11-07 离线取证三问全 PASS，真机加载待补。',
    ],
    [
      '16. 文档齐全，第三方按 PROTOCOL.md 可在 1 天内写出最小客户端。',
      '16. 文档齐全，第三方按 PROTOCOL.md 可在 1 天内写出最小客户端。\n\n' +
      '### 降级验收（09 R-02 方案 B，仅在宿主提交入口不可用时启用）\n\n' +
      '若 W1 Spike 判定「宿主未暴露提交入口」，MVP 收缩为**只读镜像 + PC 端输入**：手机可看事件流与产物、可审批，但不得由手机注入 `user/message`；对应 M1 验收第 2/4/5 项改为「手机只读可见」，并在 CHANGELOG 标注能力集降级。**严禁以插件自开 `open(id,\'write\')` 绕过单写者。**',
    ],
  ],

  // ---------------------------------------------------------------- 03
  '03_系统架构设计.md': [
    [
      ' → 查幂等表；重复则 ack duplicate\n → 检查 RouteLease：会话 owner 必须是本机，否则 409\n → 交宿主会话 owner 写入 → DSH 追加 user/message(seq=N)',
      ' → clientMsgId 映射为宿主 requestId；宿主按 source.rpcId 原生去重，重复返回 {accepted:true}\n' +
      ' → 宿主会话 owner 独占 write 句柄；第二写者抛 SessionAlreadyOwnedError → 409 ROUTE_CONFLICT\n' +
      ' → owner 写入 → DSH 追加 user/message(seq=N)',
    ],
    [
      '- **后果**：iOS 后台保活与通知受限，需产品层说明；v2 评估原生。\n\n---',
      '- **后果**：iOS 后台保活与通知受限，需产品层说明；v2 评估原生。\n\n' +
      '### ADR-007 事件契约以宿主实测为准\n' +
      '- **状态**：提议中（待 ARC + PM 会签）\n' +
      '- **决策**：`04` §3 以 DSH 0.2.2-rc.1 实测为准：事件基形 `type/seq/time/data`，扩展字段 `surfaceOp`、`sourceEventSeqs` 可选；日志无 `assistant/chunk`、无 `ignorable`；客户端采用「白名单投影 + 未知默认跳过」；`sourceEventSeqs` 仅用于 `tool/result` ↔ `tool/call` 配对。\n' +
      '- **理由**：W1 Spike 在 667 条真实事件上取证，v1.0 的 chunk 折叠与 ignorable 规则与宿主不符；`surfaceOp` 是宿主自带投影指令，客户端自行重算会与之冲突。\n' +
      '- **后果**：`02` FR-4.2/4.3、`04` §3、`07` TC-1.2/1.3 同步修订；`SessionEvent` 仅新增可选字段，属兼容变更，协议仍为 `wbsync/1`。\n\n' +
      '### ADR-008 幂等与写入权归宿主\n' +
      '- **状态**：提议中（待 ARC + PM 会签）\n' +
      '- **决策**：`clientMsgId` 直接映射宿主 `prompt(request).requestId`；Host 侧不建 `Idempotency` 表、不自开 `open(id,\'write\')`；`RouteLease` 在 CP 侧仅作跨 Host 路由元数据与审计，不承担进程内写入权仲裁。\n' +
      '- **理由**：宿主 `dsh-api-session-controller` 的 `hasPromptRequest()` 按 `source.rpcId` 原生去重，`SessionAlreadyOwnedError` → `session/writer-held` 已是硬约束；平台重复实现会产生两套真源。\n' +
      '- **后果**：`04` §1/§2、`03` §4.2、`02` FR-4.5 修订；`03` §3.1 与 `06` §3.3「绝不 open(id,\'write\')」铁律保持不变。\n\n' +
      '### ADR-009 PROTOCOL.md 为唯一契约源\n' +
      '- **状态**：提议中（待 ARC 会签）\n' +
      '- **决策**：仓库根 `PROTOCOL.md` 是 `04` 的**发布副本**，由 `04` 单向同步；字段变更必须在同一 PR 同时改 `04` + `PROTOCOL.md` + `CHANGELOG.md` 并升修订号，CI 校验三者 diff 同时存在。\n' +
      '- **理由**：`01` G9、`06` §2/§9 对 PROTOCOL.md 的归属表述不一，第三方客户端（`02` §6 第 16 项）需要唯一入口。\n' +
      '- **后果**：新增 `scripts/sync-protocol.mjs` 单向同步脚本；`06` §9 补充「不得独立编辑 PROTOCOL.md」规则。\n\n---',
    ],
    [
      '| v1.0 | 2026-11-07 | 冻结，含 ADR-001~006 | 架构师 |',
      '| v1.0 | 2026-11-07 | 冻结，含 ADR-001~006 | 架构师 |\n| v1.1 | 2026-11-07 | 按 W1 Spike 实测新增 ADR-007~009（提议中，待会签）、修订 §4.2 时序 | 架构师 |',
    ],
    [
      '- **理由**：DSH 处于 Developer Preview，官方明示会有不兼容变更且无 release tag。',
      '- **理由**：DSH 处于 Developer Preview，官方明示会有不兼容变更；上游虽已开始使用 release tag，仍无稳定版承诺，且版本间可能有破坏性变更。',
    ],
  ],

  // ---------------------------------------------------------------- 04
  '04_接口协议与数据模型.md': [
    [
      '> Owner：架构师 ｜ 状态：冻结',
      '> Owner：架构师 ｜ 状态：**修订 r1（待会签）** ｜ 协议版本：`wbsync/1`（r1 为澄清 + 新增可选字段，不升主版本）',
    ],
    [
      '- 幂等键 `clientMsgId` 由客户端生成（UUID v4），服务端保留 24h 去重窗口。',
      '- 幂等键 `clientMsgId` 由客户端生成（UUID v4），**直接映射宿主 `prompt(request).requestId`**；宿主按 `message.source.rpcId` 原生去重（24h 为语义上界，实际以宿主 inbox 生命周期为准）。Host 侧不另建幂等表，见 ADR-008。',
    ],
    [
      '-- 幂等表\nIdempotency {\n  scope          text,        -- deviceId\n  clientMsgId    text,\n  result         jsonb,\n  createdAt      bigint,\n  PRIMARY KEY (scope, clientMsgId)\n}',
      '-- 幂等表（CP 侧：仅跨 Host 路由审计；进程内去重由宿主 requestId 承担，见 ADR-008）\nIdempotency {\n  scope          text,        -- deviceId\n  clientMsgId    text,        -- = 宿主 prompt(request).requestId\n  result         jsonb,\n  createdAt      bigint,\n  PRIMARY KEY (scope, clientMsgId)\n}',
    ],
    [
      'type SessionEvent = {\n  type: string          // \'user/message\' | \'assistant/chunk\' | \'tool/result\' | ...\n  seq: number           // 会话内单调递增，连续无间隙，= log.length\n  time: number          // Unix ms\n  data: unknown         // 必须可 JSON 序列化\n  ignorable?: true      // 未知类型时客户端跳过而非拒绝整会话\n}',
      'type SessionEvent = {\n' +
      '  type: string                   // 实测 32 种，如 \'user/message\' | \'tool/result\' | \'job/registered\'\n' +
      '  seq: number                    // 会话内从 0 起连续递增，无间隙，= 事件总数 - 1\n' +
      '  time: number                   // Unix ms\n' +
      '  data: unknown                  // 必须可 JSON 序列化\n' +
      '  surfaceOp?: \'append\' | string  // 宿主投影指令（实测 163 条，恒为 \'append\'）\n' +
      '  sourceEventSeqs?: number[]     // 关联源事件 seq；实测仅出现在 tool/result（73 条）\n' +
      '  ignorable?: true               // 保留字段：实测宿主不下发，客户端不得依赖\n}',
    ],
    [
      '| 类别 | 事件 | 客户端处理 |\n|---|---|---|\n| **Surface（投影成消息）** | `system/message`、`user/message`、`assistant/message`、`tool/result` | 渲染为对话消息 |\n| 流式 | `assistant/chunk` | 按 `sourceEventSeqs` 折叠成 `assistant/message`，不逐 token 刷屏 |\n| 轮次/步骤 | `turn/start`、`turn/end`、`step/start`、`step/end` | 过程条、状态点 |\n| 工具调用 | `tool/call` | 与 `tool/result` 按 `callId` 配对展示 |\n| 仅日志 | `request/header`、`todo/write`、`hook/invoked`、`hook/result`、`request/context`、`session/end-seed` | 不进消息流 |\n| 压缩 | `compaction/start`、`compaction/summary`、`compaction/end` | 遮蔽旧节点，视图缩短，**日志原文不变，禁止回写** |\n| 恢复 | `turn/end { reason: { kind: \'interrupted\' } }` | 由 resume 合成，仅崩溃恢复出现 |',
      '| 类别 | 事件 | 客户端处理 |\n|---|---|---|\n' +
      '| **Surface（投影成消息）** | `system/message`、`user/message`、`assistant/message`、`tool/result` | 渲染为对话消息 |\n' +
      '| 轮次/步骤 | `turn/start`、`turn/end`、`step/start`、`step/end` | 过程条、状态点 |\n' +
      '| 工具调用 | `tool/call` | 与 `tool/result` 按 `sourceEventSeqs`（`callId` 为辅）配对展示 |\n' +
      '| 仅日志 | `request/header`、`todo/write`、`hook/invoked`、`hook/result`、`request/context`、`session/end-seed` | 不进消息流 |\n' +
      '| 压缩 | `compaction/start`、`compaction/summary`、`compaction/end` | 遮蔽旧节点，视图缩短，**日志原文不变，禁止回写** |\n' +
      '| 恢复 | `turn/end { reason: { kind: \'interrupted\' } }` | 由 resume 合成，仅崩溃恢复出现 |\n' +
      '| **其它（默认跳过）** | 实测 20+ 种：`permission/preset`、`sandbox/mode`、`approval/*`、`job/*`、`llm/retry*`、`session/title*`、`workspace/*`、`subagent/*`、`team/*` | 白名单外一律跳过，**不依赖 `ignorable` 标记** |\n\n' +
      '**宿主实测补充（DSH 0.2.2-rc.1，667 条事件样本）**\n\n' +
      '- 事件形状三种：基础 504 条；带 `surfaceOp` 90 条；带 `surfaceOp` + `sourceEventSeqs` 73 条。\n' +
      '- **日志中不存在 `assistant/chunk`**：流式分片不落盘，落盘的是最终 `assistant/message`，无需 chunk 折叠。\n' +
      '- **`ignorable` 字段 0 次**；`sourceEventSeqs` 只出现在 `tool/result` 上，用于关联 `tool/call`，不是 chunk 折叠字段。\n' +
      '- `session.v4.jsonl.zstd` 是**多帧 zstd 拼接**：每批追加一个独立帧；只解第一帧会误判成「会话只有一条 header」。离线回放工具必须逐帧解压。\n' +
      '- `session/event` 订阅回调首参是 **session 对象**，`sessionId` 取 `session.header.id`。',
    ],
    [
      '任一步骤触顶时整轮按 `max-tokens` 计（截断事实优先于 completed）。',
      '任一步骤触顶时整轮按 `max-tokens` 计（截断事实优先于 completed）。\n\n' +
      '> `SessionHeader` 实测字段：`type / version / id / createdAt / cwd / isSeeded / delegationDepth / agentPreset`；v1.0 注释中的 `parentSession` / `origin` 在样本中未出现，按**可选字段**处理，跨设备谱系展示须做缺失兜底。',
    ],
    [
      '- 字段类型以锁定 DSH commit 为准；升级 DSH 前跑全量契约测试（见 `07`）。',
      '- 字段类型以锁定 DSH commit 为准；升级 DSH 前跑全量契约测试（见 `07`）。\n' +
      '- **r1（2026-11-07）**：按 W1 Spike 实测澄清事件契约、幂等映射与 Idempotency 归属；仅新增可选字段与说明，无删除/改名，兼容 `wbsync/1` 现有客户端；依据 ADR-007~009（待会签）。',
    ],
    [
      '| wbsync/1 | 2026-11-07 | 首版冻结 | 架构师 |',
      '| wbsync/1 | 2026-11-07 | 首版冻结 | 架构师 |\n| wbsync/1 r1 | 2026-11-07 | 按 Spike 实测修订 §1/§2/§3，新增 ADR-007~009 引用（待会签） | 架构师 |',
    ],
  ],

  // ---------------------------------------------------------------- 06
  '06_开发规范与工程约定.md': [
    [
      '| Node.js | **≥ 24.9** | 需带 TypeScript type stripping；`NODE_OPTIONS` 中**不得**含 `--no-experimental-strip-types` |',
      '| Node.js | **≥ 24.9**（构建链 / Host 插件）；**≥ 22**（Relay 运行时，用原生全局 WebSocket） | 需带 TypeScript type stripping；`NODE_OPTIONS` 中**不得**含 `--no-experimental-strip-types`；口径与 03 §6 / 10 §2 统一 |',
    ],
    [
      '    const off = ctx.on(\'session/event\', (sessionId, ev) => {\n      ws.send({ t: \'session/event\', sessionId, ev })   // 原样透传 seq\n    })',
      '    const off = ctx.on(\'session/event\', (session, ev) => {\n' +
      '      // 实测：首参是 session 对象，不是 sessionId 字符串\n' +
      '      ws.send({ t: \'session/event\', sessionId: session.header.id, ev })  // 原样透传 seq\n' +
      '    })',
    ],
    [
      '- 事件、帧、接口字段全部只读；`SessionEvent` 深冻结后透传，禁止改写 `seq` / `data`。',
      '- 事件、帧、接口字段全部只读；`SessionEvent` 深冻结后透传，禁止改写 `seq` / `data`。`session/event` 首参是 session 对象，`sessionId` 取 `session.header.id`。',
    ],
    [
      '- 代码改了 `04` 的字段 → 同 PR 必须改 `04` + `PROTOCOL.md` + CHANGELOG，CI 校验 diff 存在。',
      '- 代码改了 `04` 的字段 → 同 PR 必须改 `04` + `PROTOCOL.md` + CHANGELOG，CI 校验 diff 存在。`PROTOCOL.md` 是 `04` 的**发布副本**，单向同步，不得独立编辑（ADR-009）。',
    ],
    [
      '| DSH | **pinned commit**，记在 `pinned-commit.txt` | Developer Preview，官方明示会有不兼容变更且无 release tag |',
      '| DSH | **pinned commit**，记在 `pinned-commit.txt`（`66491b0…`） | Developer Preview，官方明示会有不兼容变更；上游已开始使用 release tag，仍锁 commit、升级单开 ADR |',
    ],
  ],

  // ---------------------------------------------------------------- 07
  '07_测试计划与验收标准.md': [
    [
      '| TC-1.2 | 注入带 `ignorable: true` 的未知事件 | 客户端跳过，不拒绝整会话 |',
      '| TC-1.2 | 注入宿主实测未分类事件（**无 `ignorable` 字段**，如 `job/registered`、`llm/retry`） | 客户端按白名单默认跳过，不拒绝整会话 |',
    ],
    [
      '| TC-1.3 | 注入 `assistant/chunk` 流 + 对应 `assistant/message` | 折叠成 1 条完整消息，不逐 token 刷屏 |',
      '| TC-1.3 | 注入带 `surfaceOp` 与 `sourceEventSeqs` 的真实事件片段 | `surfaceOp` 被正确应用；`tool/result` 按 `sourceEventSeqs` 与 `tool/call` 配对，无孤儿卡片；无 chunk 折叠逻辑 |',
    ],
    [
      '| TC-1.8 | 未知协议版本 `wbsync/99` 握手 | 明确拒绝并提示升级，不静默降级 |',
      '| TC-1.8 | 未知协议版本 `wbsync/99` 握手 | 明确拒绝并提示升级，不静默降级 |\n' +
      '| TC-1.9 | 读取多帧 zstd 的 `session.v4.jsonl.zstd` | 逐帧解压得到全部记录；只解首帧的实现必须判失败 |\n' +
      '| TC-1.10 | 订阅 `session/event` 并触发一轮 | 回调首参为 session 对象，`session.header.id` 取值正确，不以首参当字符串 |',
    ],
  ],

  // ---------------------------------------------------------------- 08
  '08_安全与隐私设计.md': [
    [
      '- 锁 DSH commit（`pinned-commit.txt`），CI 校验一致；依赖锁文件入库。',
      '- 锁 DSH commit（`pinned-commit.txt`），CI 校验一致；依赖锁文件入库。**取证脚本从宿主 `app.asar` 抽取的源码片段不得随公开仓库发布**，证据输出默认脱敏（见仓库 `spike/probe-host.mjs`）。',
    ],
  ],

  // ---------------------------------------------------------------- 09
  '09_风险登记册.md': [
    [
      '| R-01 | **DSH Developer Preview 不兼容变更**，官方明示会有 breaking changes、无 release tag；',
      '| R-01 | **DSH Developer Preview 不兼容变更**，官方明示会有 breaking changes（上游已开始使用 release tag，但无稳定版承诺）；',
    ],
    [
      '- **判定**：三问全过才进 P1。任一不过，当天上报发起人，启动方案 B（上游 issue / 收缩范围），**不允许"先写日志再说"**。',
      '- **判定**：三问全过才进 P1。任一不过，当天上报发起人，启动方案 B（上游 issue / 收缩范围），**不允许"先写日志再说"**。\n\n' +
      '- **2026-11-07 离线取证结论**：三问全 PASS —— Q1 事件 `seq` 0→666 连续；Q2 宿主 `dsh-api-session-controller.prompt(request)` 提供提交入口，自带 `requestId` 幂等与 `SessionAlreadyOwnedError` 单写者；Q3 `list()` / `open(id,access)` / `persistContiguous` 齐备，`sinceSeq=400` 补齐 266/266。证据见仓库 `spike/REPORT.md`。**真机加载验证待补**，风险暂记「待真机复核」，不关闭。',
    ],
  ],

  // ---------------------------------------------------------------- 10
  '10_部署与运维手册.md': [
    [
      '- Node.js ≥ 22（Relay 运行时，使用原生全局 WebSocket）；构建链 ≥ 24.9。',
      '- Node.js ≥ 22（**仅 Relay 运行时**，使用原生全局 WebSocket）；**构建链 / Host 插件 ≥ 24.9**（06 §1 统一口径）。Spike 取证脚本在 Node 22 上即可运行，不需 24.9。',
    ],
  ],
}

// ---------------------------------------------------------------------------
const DRY = process.argv.includes('--dry-run')
if (!DRY) mkdirSync(BACKUP, { recursive: true })
let total = 0
for (const [file, pairs] of Object.entries(edits)) {
  const path = join(DOCS, file)
  if (!existsSync(path)) throw new Error(`找不到文档：${path}`)
  const original = readFileSync(path, 'utf8')
  let text = original
  for (const [index, [from, to]] of pairs.entries()) {
    const count = text.split(from).length - 1
    if (count !== 1) {
      throw new Error(`${file} 第 ${index + 1} 处：期望 1 次命中，实际 ${count} 次\n  old = ${JSON.stringify(from.slice(0, 140))}`)
    }
    text = text.replace(from, to)
  }
  if (!DRY) {
    writeFileSync(join(BACKUP, file), original, 'utf8') // 只备份一次，不覆盖
    writeFileSync(path, text, 'utf8')
  }
  console.log(`${DRY ? 'DRY' : 'OK '} ${file.padEnd(30)} ${pairs.length} 处`)
  total += pairs.length
}
console.log(`\n共修订 ${Object.keys(edits).length} 份文档 / ${total} 处；原文备份：${BACKUP}`)
