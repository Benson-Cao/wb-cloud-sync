# W1 Spike 报告 · 宿主接缝三问取证

> 日期：2026-11-07 ｜  Owner：ARC + HE-A（05 RACI 第 53 行）
> 门禁来源：`09_风险登记册.md` R-02（P0 门禁项）、`05_团队分工与里程碑.md` W1
> 契约参照：`01` A1、`02` §7、`03` §3.1、`04`、`06` §3.2
> 证据：`spike/evidence/host-probe.json`、`spike/evidence/check-plugin.json`

---

## 0. 一句话结论

**「手机发的那句话能不能交给宿主 owner」——能，而且宿主已经把幂等和单写者都做好了。**
三问离线取证全 PASS；据 D-01~D-07 已完成设计冻结包 v1.1 修订（10 份文档 / 34 处 + ADR-007~009）、上游 commit 锁定、可安装 bundle 发布。**P0 门禁仍差真机加载验证与四方会签**，完成前不得进入 P1 编码（详见 §5、§7）。

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
- **离线真机模式 SKIP**：`dsh` CLI 不在 PATH，`--real` 只输出待人工执行的命令。

### 4.1 真实 DSH 桌面版验证（2026-11-07 18:10 · Windows / DSH Desktop 0.2.2-rc.1）

用户按根 README **方式 B · Git 仓库直装**：`~/.dsh/profiles/desktop/package.json` 的 bundles 已含 `dsh-wb-cloud-sync-spike`，`pnpm-lock.yaml` pinned 到 `551778e`。**未触发 pnpm `allowBuilds` 授权**（本包无 install/postinstall 脚本），说明 06 §4 / 10 §4 的担心只针对带构建脚本的 git 依赖。

| 检查 | 实测 |
|---|---|
| `~/.dsh/wbsync-spike/probe.json` | 存在，648 B，18:10:44 生成，`errors: []` |
| `services.sessionPersistence` | `present: true`，方法 `list / open / create / flush`（`read`/`append` 在 `open()` 返回的 handle 上） |
| `services.webServer` | `present: true`、`register: true`、`routeRegistered: exact:/__wbsync/spike` |
| `ctx.effect` / `ctx.on` | 均 `true` |
| 状态路由 | `127.0.0.1:50973/__wbsync/spike` → **HTTP 200** + 完整 probe JSON |
| DSH 进程 Node | **24.21.0**（≥ 24.9）；命令行 Node 22.22.2 / pnpm 未装 / `dsh` CLI 不在 PATH |
| 端口辨析 | 3080 / 3081 / 3000 无监听；3082 → 502；9230 → 404；**50973 才是 webServer** |

→ **插件已进入 Loader 树、两个依赖服务注入成功、`ctx.effect` 注册生效、具名路由可用**，Q2/Q3 的运行时前提成立。

**未覆盖**：`eventShapes[]` 仍为空（需发一句话触发 `session/event`）；卸载后 404 未验。
> `probe.json` 是 `apply()` 的启动快照；实时 `eventShapes` 由状态路由返回同一个内存对象，不回写文件。

---

## 5. P0 门禁逐项判定（01 §9 / 05 P0）

| 门禁项 | 判定 | 说明 |
|---|---|---|
| 文档会签完成 | **NOT MET** | `01` §9 会签表四方均「待签」；v1.1 修订稿 + ADR-007~009（「提议中」）待会签 |
| W1 Spike 通过 | **PARTIAL（加载已 PASS）** | 三问离线取证 PASS + **真机加载 PASS**（§4.1）；仅剩「触发一轮事件确认回调首参与 seq」「卸载后 404」 |
| pinned commit 锁定 | **MET** | `upstream_commit=66491b05…`（tag `dsh-v0.2.2-rc.1`），tag / commit / package.json 三重交叉验证；另保留 asar SHA256 作二进制指纹 |
| 协议冻结 | **待会签** | 04 已按 D-01~D-07 修订为 `wbsync/1 r1`，`PROTOCOL.md` 单向同步 + CHANGELOG 齐备；ADR-007~009 仍为「提议中」 |

> **结论：仍不得进入 P1 编码**，阻塞点已收敛为：**一轮真机事件验证 + 卸载残留**、**四方会签**。按 05 W1 与 01 §9，完成前不得开工。

---

## 6. 与上一轮「冻结前 6 处」的对应关系

| 上轮编号 | 进展 |
|---|---|
| #1 Spike 门禁口径不一致 | **已修复**：01 A1 / 02 §7 补齐三问口径，与 05 W1 / 09 R-02 统一 |
| #2 `pairSecret` 未定义 | **仍未解决**（属配对协议，非 Spike 范围）：`pairSecret` 的生成 / 分发与 OAuth 主体绑定需 ARC 补 |
| #3 配对状态三处归属 | **仍未解决**（CP / Relay / Host 本地三处），需定权威表与时序 |
| #4 白名单 vs FR-6/FR-7 | **仍未解决**：`allowedEndpoints` 只有 `session/*`、`$events/*`，附件 / 产物 / 定时任务端点无归属 |
| #5 幂等表 / RouteLease / Cursor | **已修复（ADR-008 提议中）**：Host 侧去重归宿主 `requestId`，CP 侧 `Idempotency` 降级为路由审计；Cursor 双真源仍待定 |
| #6 PROTOCOL.md 唯一性 | **已修复（ADR-009 提议中）**：根 `PROTOCOL.md` 为 04 的单向同步发布副本，`sync-protocol.mjs --check` 供 CI 校验 |

> 另新增 D-07（`surfaceOp` / `sourceEventSeqs` 真实语义）已写入 04 §3 与 ADR-007。

---

## 7. 下一步（按优先级）

**已完成**：① 按 D-01~D-07 修订 10 份文档、新增 ADR-007~009；② 统一 01/02 的 Spike 三问口径；③ 上游 commit SHA 锁定；④ 发布可安装 bundle 与 `PROTOCOL.md` / `CHANGELOG.md` 同步链；⑤ **Git 仓库直装 + 真机加载验证 PASS**（§4.1）。

剩余：

1. **补完最后两项真机动作**：在 DSH 里发一句话 → 查 `127.0.0.1:50973/__wbsync/spike` 的 `eventShapes[]`，确认首参是 session 对象、`seq` 连续；然后卸载插件确认路由 404。完成后 W1 Spike 可判 PASS。
2. **ADR-007~009 会签 + 四方文档会签**（01 §9）：协议字段变更需 ARC 会签，安全项一票否决。
3. **补构建链环境并接 CI**：命令行 Node ≥ 24.9 + pnpm 11、`dsh` CLI 加 PATH（注意 DSH 进程内已是 24.21.0，两者不同）；CI 接入 `sync-protocol.mjs --check`、`check-plugin.mjs`、pinned commit 校验。
4. **解决上表 #2 / #3 / #4**：配对密钥与账号绑定、配对状态权威归属、白名单端点覆盖。
5. 之后才按 05 W3 进入 P1 编码。

---

## 8. 边界声明（本报告**没有**证明的事）

- **已在真实 DSH 桌面版加载探针**（§4.1），但只验证到「依赖注入 + 路由可用」，未触发一轮真实会话事件；`apply()` 的 8 项动态断言仍来自 mock Context。
- 未验证卸载后路由 404（TC-4.10 的真机部分），也未在真机上验证 `session/event` 回调的首参类型与 `seq` 连续性。
- 未验证 `prompt()` 在「执行中投递 → 进队列 → 按序处理」的完整运行时行为（FR-4.7 / TC-4.3）。
- 未验证流式 `assistant/chunk` 是否在内存中产生但不落盘（D-01 只证明日志里没有）。
- 未验证 `SessionHeader.parentSession` / `origin` 在其他会话中出现（D-05 单样本）。
- 三平台 / iOS、Android PWA 兼容性均未涉及。
