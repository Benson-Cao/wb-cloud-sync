# W1 Spike 报告 · 宿主接缝三问取证

> 日期：2026-11-07 ｜  Owner：ARC + HE-A（05 RACI 第 53 行）
> 门禁来源：`09_风险登记册.md` R-02（P0 门禁项）、`05_团队分工与里程碑.md` W1
> 契约参照：`01` A1、`02` §7、`03` §3.1、`04`、`06` §3.2
> 证据：`spike/evidence/host-probe.json`、`spike/evidence/check-plugin.json`

---

## 0. 一句话结论

**「手机发的那句话能不能交给宿主 owner」——能，而且宿主已经把幂等和单写者都做好了。**
三问离线取证全 PASS；据 D-01~D-07 已完成设计冻结包 v1.1 修订（10 份文档 / 34 处 + ADR-007~009）、上游 commit 锁定、可安装 bundle 发布；**真机加载、运行时事件闭环与卸载残留均已 PASS**（§4.1.2 / §4.1.3）。2026-11-10 追加 `wbsync/1 r2` 对标复核与 ADR-010（`WORKBUDDY-REFERENCE.md`）。**P0 门禁只剩四方会签**，完成前不得进入 P1 编码（详见 §5、§7 与 `SIGN-OFF.md`）。

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

#### 4.1.1 事件触发诊断（18:23 · 用户报告「发了」后复测）

复测：路由仍 **HTTP 200**、`errors: []`、`eventShapes: 0`；`probe.json` 同为 0 —— 两者一致，**排除「只看快照」的误判**，订阅回调确实一次都没被调用。

只读旁证（全部指向「消息没进入这个进程」）：

| 证据 | 数值 |
|---|---|
| `~/.dsh/sessions/**/session.v4.jsonl.zstd` 18:05 后被修改的文件 | **0**（全库最新 11-06 21:13） |
| `~/.dsh/storages/session_projcache` 最新 mtime | 16:16 |
| 18:10 后 `~/.dsh` 下的文件变动 | 仅 3 个：profile `package.json`、`probe.json`、`nas-sync/store.json` |
| 18:14 的目录变动 | nas-sync mirror 同步产生，均为 `--data-user-0-com.dsh.harness-files-home-*`（Android 路径）**空目录**，files=0 |
| DSH 主进程 | 仅 1 个（PID 2196），端口 3082 / 9230 / 50973 未变，无第二实例 |

→ **结论：截至 18:23，PC 桌面版 DSH 进程内没有任何会话事件产生**，因此「探针没收到事件」不等于「订阅失效」。待排除两种情形：① 消息发在**手机端 DSH**（18:14 同步痕迹 + Android 路径前缀），按 BR-1「同账号 ≠ 同数据、会话跟随执行位置」，PC 端探针本就收不到；② PC 端消息未成功提交（模型未配置 / 仅输入未发送 / 请求失败）。

自检（在 **PC 桌面版** 发一句话、等它开始回复后立刻跑）：

```bash
find ~/.dsh/sessions -name 'session.v4.jsonl.zstd' -mmin -5 | wc -l   # 期望 >= 1
curl --noproxy '*' -s http://127.0.0.1:50973/__wbsync/spike | grep -A4 eventShapes
```

第一条为 `0` → 消息没落到本机，与探针无关；第一条 `>= 1` 而路由仍空 → 才是订阅作用域问题，需查 Cordis context 层级。这是把「没有事件」与「没有收到」分开的最小判据。

#### 4.1.2 电脑端发言后的端到端闭环（18:34 · 全部 PASS）

用户确认 18:23 那次是**手机端**发的（BR-1 的现实版：同账号 ≠ 同数据，会话跟随执行位置），随后在 **PC 桌面版**发了一句话。结果：

| 层 | 实测 |
|---|---|
| 落盘日志 | `session-294facbd-…/session.v4.jsonl.zstd` 18:34:19 更新，**9 个 zstd 帧 / 24 条记录**（1 header + 23 事件），`seq` 0→22 连续，解码 0 错 |
| 订阅回调 | 路由 `eventShapes` **19 条**，`seq` **4→22** 连续（前 4 条早于插件加载），`errors: []` |
| 窗口比对 | 日志中 `seq 4..22` 恰好 **19 条**，类型集合与探针**完全一致** |
| 事件形状 | 日志：基础 17 条 + 带 `surfaceOp` 6 条（`append`）；`ignorable` 0 次；`sourceEventSeqs` 0 次（本轮无工具调用） |

**8/8 运行时断言 PASS**：订阅被触发、首参是 session 对象（**D-03 由源码取证升级为运行时取证**）、`subjectId` 取自 `session.header.id`、基形 `data,seq,time,type`、运行时观察到 `surfaceOp` 扩展（**D-07**）、`seq` 连续、不落事件正文（**08 §8**）、无错误。

→ **Q1 完成闭环**：宿主 emit → 插件订阅 → 落盘日志，三方 `seq` 一致。W1 Spike 三问至此全部具备运行时证据。
> `probe.json` 仍是 0 条（启动快照），路由是 19 条（实时对象）——**「快照 vs 实时」的区分被实测证实**，不再只是设计说明。

#### 4.1.3 卸载后无残留（18:41 · TC-4.10 真机 PASS）

| 检查 | 实测 |
|---|---|
| `127.0.0.1:50973/__wbsync/spike` | **HTTP 404**（此前为 200 + 完整 probe JSON） |
| profile `package.json` / `pnpm-lock.yaml` / `cordis.patch.yml` | `wb-cloud-sync-spike` 命中数均 **0** |
| `plugin-operations/operations.jsonl` | 18:41:19 `remove/started` → 18:41:20 `remove/settled`，`application=applied` |
| DSH 主进程 | **PID 2196，StartTime 14:14:00，未重启**；端口 3082 / 9230 / 50973 未变 |

→ **关键在于取证时点**：18:41 观测 404 时，主进程 PID 2196（StartTime 14:14:00）**尚未重启**，因此那是同一进程内 `ctx.effect` disposer **运行时撤回路由**的证据（P7 / TC-4.10）。

> ⚠️ **证据时效性（18:52 用户纠正后补充）**：**18:49:52 DSH 确实重启过** —— 新主进程 **PID 26668**，webServer 端口 **50973 → 55056**。重启后 `55056/__wbsync/spike` 同样是 404，但这一条**只能证明「重启后没加载已卸载的插件」，是弱证据**，不能拿来支撑「disposer 运行时撤回」。
> 两个说法都对，只是时点不同：**18:41 的强证据成立；18:52 之后的 404 不可复用该结论**。复跑时务必先查进程 StartTime 与实际端口，再判定证据等级。完整时间线见 `SIGN-OFF.md` §四。

> 顺带解开端口之谜：`3082` 的 502 响应体是 `engine-switch upstream: connect ECONNREFUSED 127.0.0.1:3080`，说明它是 `dsh-engine-switch` 的反向代理口、转发目标 3080 未启动；`9230` 是另一个内部服务；**50973 才是 `ctx.webServer`**。

**唯一残留**：`~/.dsh/wbsync-spike/probe.json`（648 B，18:10:44）仍在。它是证据**数据文件**，不是路由 / 定时器 / WS 连接，不违反 TC-4.10；但若 P1 要求「卸载后零痕迹」，产品插件需在 disposer 中定义保留 / 清理策略 —— 记为 P1 待办。

---

## 5. P0 门禁逐项判定（01 §9 / 05 P0）

| 门禁项 | 判定 | 说明 |
|---|---|---|
| 文档会签完成 | **NOT MET** | `01` §9 会签表四方均「待签」；v1.1 修订稿 + `wbsync/1 r2` + ADR-007~010（均「提议中」）待会签 |
| W1 Spike 通过 | **PASS** | 三问离线取证 + 真机加载 + **运行时事件闭环**全 PASS（§4.1 / §4.1.2）；卸载后 404 转入 M1 验收 TC-4.10 |
| pinned commit 锁定 | **MET** | `upstream_commit=66491b05…`（tag `dsh-v0.2.2-rc.1`），tag / commit / package.json 三重交叉验证；另保留 asar SHA256 作二进制指纹 |
| 协议冻结 | **待会签** | 04 已修订至 `wbsync/1 r2`（r1 按 D-01~D-07 实测澄清，r2 按 WorkBuddy 对标补状态枚举与正文可见性边界），`PROTOCOL.md` 单向同步 + CHANGELOG 齐备；ADR-007~010 仍为「提议中」 |

> **结论：W1 Spike 三问 PASS，TC-4.10 真机卸载残留亦 PASS（§4.1.3）**，P0 只剩「四方会签 + ADR 会签」一项硬阻塞。按 01 §9，会签完成前仍不得进入 P1 编码。

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
> **#2 / #3 / #4 的裁定权属于会签后的 ARC 与安全 Owner**（配对密钥涉及信任边界、白名单涉及 `08` §5 权限评审），本阶段不代签、不擅自改契约；三项已提升为 `SIGN-OFF.md` §二的「P1 开工前置清单」，会签时须显式确认由谁在 W3 前裁定。

---

## 7. 下一步（按优先级）

**已完成**：① 按 D-01~D-07 修订 10 份文档、新增 ADR-007~009；② 统一 01/02 的 Spike 三问口径；③ 上游 commit SHA 锁定；④ 发布可安装 bundle 与 `PROTOCOL.md` / `CHANGELOG.md` 同步链；⑤ **Git 仓库直装 + 真机加载 PASS + 运行时事件闭环 8/8 PASS**（§4.1 / §4.1.2）；⑥ `wbsync/1 r2` 对标复核与 ADR-010；⑦ CI 闸门接入（M6a）；⑧ 本地构建链隔离工具链 5/5 READY（M6b）。**W1 Spike 三问已判 PASS。**

剩余：

1. **P1 待办 · 卸载后证据文件清理**：TC-4.10 真机已 PASS（§4.1.3），但 `~/.dsh/wbsync-spike/probe.json` 未随卸载删除；产品插件需在 disposer 中定义保留 / 清理策略。不阻塞当前门禁。
2. **ADR-007~010 会签 + 四方文档会签**（01 §9）：协议字段变更需 ARC 会签，安全项一票否决；ADR-010 属信任边界，安全 Owner 必看 `SECURITY-REVIEW.md` 第 5 项。
3. ~~补构建链环境并接 CI~~ **已完成**：CI 接入 `sync-protocol --check` / `gate-check --check --assert-fresh` / `check-plugin` / `npm pack --dry-run`（M6a）；本地隔离工具链 Node 24.22.2 + pnpm 11.28.11 实跑全链通过，`check-env.mjs --check` 5/5 `READY`（M6b）。桌面版无独立 `dsh` CLI，E5 已按真机 GUI 安装证据判据修正。
4. **解决上表 #2 / #3 / #4**：配对密钥与账号绑定、配对状态权威归属、白名单端点覆盖。
5. 之后才按 05 W3 进入 P1 编码。

---

## 8. 边界声明（本报告**没有**证明的事）

- **已在真实 DSH 桌面版完成加载 + 事件闭环**（§4.1 / §4.1.2）：19 条运行时事件与落盘日志窗口逐条对齐。但 `apply()` 的 8 项动态断言本身仍来自 mock Context，未在真机上跑单元测试。
- 卸载验证（§4.1.3）覆盖了「路由 404 + profile 配置移除 + 进程未重启」，但**未做进程级监听 / 定时器 / WS 句柄的存活扫描**（需宿主调试接口），TC-4.10 的「无残留监听」仍只有离线 mock 的等价证据。
- 本轮会话无工具调用，`sourceEventSeqs` / `tool/call` ↔ `tool/result` 配对只在离线日志样本上验证过，未做运行时验证。
- 未验证 `prompt()` 在「执行中投递 → 进队列 → 按序处理」的完整运行时行为（FR-4.7 / TC-4.3）。
- 未验证流式 `assistant/chunk` 是否在内存中产生但不落盘（D-01 只证明日志里没有）。
- 未验证 `SessionHeader.parentSession` / `origin` 在其他会话中出现（D-05 单样本）。
- 三平台 / iOS、Android PWA 兼容性均未涉及。
