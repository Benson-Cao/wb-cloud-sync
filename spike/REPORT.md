# W1 Spike 报告 · 宿主接缝三问取证

> 日期：2026-11-07 ｜  Owner：ARC + HE-A（05 RACI 第 53 行）
> 门禁来源：`09_风险登记册.md` R-02（P0 门禁项）、`05_团队分工与里程碑.md` W1
> 契约参照：`01` A1、`02` §7、`03` §3.1、`04`、`06` §3.2
> 证据：`spike/evidence/host-probe.json`、`spike/evidence/check-plugin.json`

---

## 0. 一句话结论

**「手机发的那句话能不能交给宿主 owner」——能，而且宿主已经把幂等和单写者都做好了。**
三问离线取证全 PASS；但 **P0 门禁整体仍未通过**，不得进入 P1 编码（详见 §5）。

---

## 1. 取证对象与方法

| 项 | 值 |
|---|---|
| 宿主 | `@deepseek-ai/dsh-desktop` **0.2.2-rc.1** |
| 源码来源 | `D:/Program AI/Deepseek Harness/resources/app.asar`（22,102 个文件，扫描 5,322 个 `@deepseek-ai` JS/TS，<2MB） |
| 构建指纹 | `app.asar` SHA256 `5fa8a6b21bceb8f3e99e30efa2270efd0cc773a11e42aa0488f804a64b34e637` |
| 会话样本 | `~/.dsh/sessions` 下最大一份真实 `session.v4.jsonl.zstd`（21 份中取 1，只读） |
| 上游仓库 | `git+https://github.com/deepseek-ai/deepseek-harness.git`（npm 包**不含 gitHead**） |

方法：只读解析 Electron ASAR 头部 → 在宿主源码里检索接缝标识符 → 逐帧解压真实日志核对 `SessionEvent` 契约 → 用 `mock Context` 在隔离 `DSH_HOME` 里真正 `import` 并 `apply()` 探针插件。
**全程未启动 Agent、未写入任何会话日志、未修改用户 profile、未碰前台。**

---

## 2. 三问判定（R-02 的 P0 门禁）

| 问 | 判定 | 硬证据 |
|---|---|---|
| **Q1** 能否订阅到带连续 `seq` 的会话事件？ | **PASS** | `ctx.on("session/event", (session, event) => ...)` 在宿主源码命中 79 处；真实日志 370 个 zstd 帧 → 668 条记录（1 header + 667 事件），`seq` 0→666 **连续无间隙且等于事件数**，解码 0 失败 |
| **Q2** 能否不打开写句柄，把用户消息交给当前轮次 owner？ | **PASS** | `dsh-api-session-controller` 暴露 `async prompt(request, source)`（11 处）；请求自带 `requestId`；`hasPromptRequest()` 按 `source.rpcId === requestId` 原生去重，重复直接返回 `{accepted:true}`；`SessionAlreadyOwnedError` 16 处 → 映射为 `RemoteError("session/writer-held")` 8 处 |
| **Q3** `list()` / `open(id,'read')` 能否枚举与只读回放？ | **PASS** | `dsh-session-persistence-jsonl` 有 `async list(options)`、`async open(id, access, options)`、`async append(events)` + `persistContiguous(batch)` + `assertOpen`；在真实日志上模拟 `sinceSeq=400` 补齐，返回 `401..666` 共 **266/266** 条，遇缺口即截断（04 ADR-004 成立） |

### Q2 的实际含义（对设计影响最大）

宿主已经有 `prompt(request)` 这条公开接缝，且把三件事都包了：**幂等**（`requestId` / `rpcId`）、**写入权**（owner 持有 write 句柄，第二个写者抛 `SessionAlreadyOwnedError`）、**轮次接纳**（`{accepted:true}`）。
因此 04 §2 里的 `Idempotency` 表、03 §4.2 的「Host 查幂等表 / 检查 RouteLease」、FR-4.5 的自建 `clientMsgId` 去重，**在 Host 侧是重复建设**。建议把 `clientMsgId` 直接映射为宿主 `requestId`，CP 侧只保留跨 Host 的路由元数据。

> 措辞边界：Q2 的 PASS 指「插件不需要自开写句柄」，**不是**「宿主不用 write 句柄」——`open(id,'write')` 能力确实存在（Q3 已取到 `read` 分支），只是由宿主 owner 独占。03 §3.1 / 06 §3.3 的「绝不 `open(id,'write')`」铁律依然成立。

---

## 3. 实测与文档的 7 处偏差（需 ADR 会签后回填 04）

| ID | 文档 | 实测 | 建议动作 |
|---|---|---|---|
| **D-01** | 04 §3 / FR-4.3 / TC-1.3 围绕 `assistant/chunk` 折叠 | 真实日志 32 种事件类型里**没有 `assistant/chunk`**，落盘的是 `assistant/message` | 先确认真机流式是否落盘；若不落盘，删掉 chunk 折叠规则，改写 TC-1.3 |
| **D-02** | 04 §3 / FR-4.2 / BR-4：未知事件带 `ignorable: true` 才跳过 | 667 条事件里 **`ignorable` 字段 0 次**；未列入 04 的类型有 20+ 种（`permission/preset`、`sandbox/mode`、`job/registered`、`llm/retry`、`approval/asked`、`workspace/*`…） | 客户端改为「白名单投影 + 默认跳过」，别依赖服务端标记；补 TC-1.2 |
| **D-03** | 06 §3.2 骨架：`ctx.on('session/event', (sessionId, ev) => ...)` | 首参是 **session 对象**，实测源码用 `session.header.id` | 修最小骨架为 `(session, ev) => ({ sessionId: session.header.id, ev })`，否则 P1 一接就错 |
| **D-04** | 04 §2 / ADR-001：CP 自建 `Idempotency` + `RouteLease` | 宿主原生有 `requestId` 幂等 + writer-held 冲突 | 重评两张表的归属：Host 侧去掉，CP 侧只留路由；更新 03 §4.2 时序 |
| **D-05** | 04 §2 注释：`SessionHeader` 含 `parentSession` / `origin` | 样本 header 仅 `type,version,id,createdAt,cwd,isSeeded,delegationDepth,agentPreset` | 标为可选字段；不能断言不存在，需跨样本再验 |
| **D-06** | 00 / 06 §1：Node ≥ 24.9、pnpm 11.x | 本机 Node **22.22.2**、pnpm **未安装**、`dsh` CLI 不在 PATH | 补齐环境；离线 Spike 不受影响，但 P1 构建链会被卡 |
| **D-07** | 04 §3：`assistant/chunk` 按 `sourceEventSeqs` 折叠 | 事件有 3 种形状：基础 `type,seq,time,data` 504 条、带 `surfaceOp` 90 条、带 `surfaceOp`+`sourceEventSeqs` 73 条；`surfaceOp` 恒为 `"append"` 共 163 条；**`sourceEventSeqs` 只出现在 `tool/result` 上**（关联 `tool/call`） | 04 §3 折叠规则写错了；`surfaceOp` 是宿主投影指令，文档完全未覆盖，需新增一节 + 定客户端策略 |

**附带的格式发现**：`session.v4.jsonl.zstd` 是**多帧 zstd 拼接**（每追加一批写一个独立帧）。直接 `zstdDecompressSync(整个文件)` 只解第一帧，会把有 668 条记录的会话误判成「只有一条 header」。任何离线读取/回放工具必须按帧边界逐帧解（`lib/session-log.mjs` 已实现）。

---

## 4. 插件加载验证（check-plugin.mjs）

隔离 `DSH_HOME` 建于 `spike/evidence/dsh-home-*`，不复用用户日常 `~/.dsh`（07 §2）。

- 静态铁律：R1–R7 全 **PASS**（具名导出、`inject`、`ctx.effect`、disposer、禁 `open(...,'write')`、禁 `append`、不落事件正文）；R8「Config 用 `Schema.object`」**WAIVED** —— 探针为三平台零依赖复跑故意不引 schemastery，**P1 产品插件不得豁免**。
- 动态：D1–D8 全 **PASS** —— `apply()` 不抛错、`inject` 含 `webServer`+`sessionPersistence`、订阅 `session/event`、注册 `exact:/__wbsync/spike`、模拟事件只留结构、`disposer` 全执行后残留监听 0 / 路由 0（TC-4.10 离线等价）、证据落盘。
- **真机模式 SKIP**：`dsh` CLI 不在 PATH。脚本只输出待人工执行的命令，**不自动装包、不改用户 profile、不重启 DSH**。

---

## 5. P0 门禁逐项判定（01 §9 / 05 P0）

| 门禁项 | 判定 | 说明 |
|---|---|---|
| 文档会签完成 | **NOT MET** | `01` §9 会签表 PM / ARC / 安全 / QA 四方均「待签」 |
| W1 Spike 通过 | **PARTIAL** | 三问离线取证 **PASS**，但 09 R-02 要求的「可运行证据」含真机加载；本机 `dsh` CLI 缺失，真机部分 SKIP |
| pinned commit 锁定 | **NOT MET** | `pinned-commit.txt` 中 `upstream_commit=UNRESOLVED`；只有发行版本 + asar SHA256，CI 无法执行 06 §8 的 checkout 校验 |
| 协议冻结 | **NOT MET** | 04 自标「冻结」，但 D-01 / D-02 / D-07 三处契约描述与实测不符，冻结前必须回填 |

> **结论：按 05 W1「Spike 未通过不得进入编码」与 01 §9「P0 唯一硬产出是设计冻结」，当前不得进入 P1 编码。**
> 三问本身已排除 R-02 这个最大红色风险，可以据 D-01~D-07 直接改 04 / 06 并会签，无需再等真机。

---

## 6. 与上一轮「冻结前 6 处」的对应关系

| 上轮编号 | 本轮进展 |
|---|---|
| #1 Spike 门禁口径不一致 | **已证实**：01 A1 / 02 §7 漏了「宿主提交入口」，05 W1 / 09 R-02 才写；本次按后者取证才问出 Q2。建议本轮把 01 A1 / 02 §7 补齐 |
| #2 `pairSecret` 未定义 | 未触及（属配对协议，非 Spike 范围），仍需 ARC 补 |
| #3 配对状态三处归属 | 未触及 |
| #4 白名单 vs FR-6/FR-7 | 未触及 |
| #5 幂等表 / RouteLease / Cursor | **已证实重复建设**（D-04），且 Host→CP 查询端点依然缺失 |
| #6 PROTOCOL.md 唯一性 | 未触及；另新增 D-07 说明 04 §3 本身需改 |

---

## 7. 下一步（按优先级）

1. **回填 04 / 06**：按 D-01、D-02、D-03、D-07 改事件契约与最小骨架；按 D-04 重评 `Idempotency` / `RouteLease` 归属 → 走 ADR 会签（05 规则：协议字段变更必须 ARC 会签）。
2. **补 `01` A1 与 `02` §7**：把「宿主提交入口是否存在」写进 Spike 清单，三问口径统一。
3. **取上游 commit SHA**：从 `deepseek-ai/deepseek-harness` 对应 `0.2.2-rc.1` 的 tag/commit 回填 `pinned-commit.txt`；CI 加 checkout 校验。
4. **补环境**：Node ≥ 24.9 + pnpm 11（Corepack），并把 `dsh` CLI 加进 PATH 后跑 `node check-plugin.mjs --real` 的真机命令。
5. 之后才按 05 W3 进入 P1 编码。

---

## 8. 边界声明（本报告**没有**证明的事）

- 未在真实 DSH 进程里安装并加载探针；`apply()` 的 PASS 来自 mock Context。
- 未验证 `prompt()` 在「执行中投递 → 进队列 → 按序处理」的完整运行时行为（FR-4.7 / TC-4.3）。
- 未验证流式 `assistant/chunk` 是否在内存中产生但不落盘（D-01 只证明日志里没有）。
- 未验证 `SessionHeader.parentSession` / `origin` 在其他会话中出现（D-05 单样本）。
- 三平台 / iOS、Android PWA 兼容性均未涉及。
