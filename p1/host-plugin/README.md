# P1 W3 · Host 侧插件骨架（`wbsync-host-dev`）

DSH 宿主里的那一半：**主动外连 Relay**、把宿主事件原样上行、把手机投递的指令交回宿主提交入口、注册两个本地只读/代理路由。

> 这是**开发骨架**，不是可发布插件：`private: true`，包名/插件 id 都是 `wbsync-host-dev`。正式包会是 `wb-cloud-sync` / `dsh-wb-cloud-sync`，届时只换 `package.json` 与 `cordis.patch.yml` 的标识，帧语义不变。

---

## 一、铁律：不自己开写句柄

P0 Spike Q2 已取证：手机投递必须走宿主 `dsh-api-session-controller.prompt(request)`，`requestId` 原生幂等，`SessionAlreadyOwnedError` 保证单写者。**绝不 `open(id,'write')`**——那会绕开宿主的并发保护，写出双写分裂。

所以本插件把提交能力抽象成四个**可注入适配器**，自己**不碰** `sessionPersistence` 的写路径：

| 适配器 | 入参 | 返回 | 缺省行为（bundle 真机形态） |
|---|---|---|---|
| `submitPrompt` | `{sessionId, text, clientMsgId}` | `{ok:true, value}` / `{ok:false, code, message}` | **接宿主 `sessionController.prompt`**：`clientMsgId` → `requestId`，`source={kind:'user',rpcId}`，宿主原生幂等 |
| `cancelTurn` | `{sessionId}` | 同上 | 回 `WRITER_UNAVAILABLE`（409）——宿主取消入口未取证，不猜 API |
| `createSession` | `{text, cwd, clientId}` | 同上（`value.sessionId` 必备，可附 `value.index` 行） | **接宿主 `sessionController.create`**：返回 `sessionId`；`text` 非空再调 `prompt` 送第一句话 |
| `replay` | `{sessionId, sinceSeq}` | 同上（`value.events` 为连续前缀） | 绑 `sessionPersistence.open(id,'read')`；拿不到句柄回 `NOT_AVAILABLE`（501） |

`src/host-adapters.js` 负责软探测 `sessionController`（`ctx[name]` / `ctx.get(name)`，**不写进 `inject`**——cordis 缺服务会让整个插件 pending，连上行和状态路由都注册不上）。服务缺失时适配器如实回 `WRITER_UNAVAILABLE`（409），不静默降级、不自行追加日志；测试可用 `cfg.hostAdapters` 或单个适配器覆盖。`/__wbsync/status` 的 `writer: {controller, create, prompt, cancel}` 用于真机自检——装包后先看它，就能区分「服务没探测到」与「调用失败」。

**部分成功语义**：`create` 已建出会话但第一句话 `prompt` 失败时，会话已经客观存在，适配器返回**成功**并附 `prompted:false / promptError`——否则手机会以为没建、重复点「新建」造出第二个会话。

宿主入口形状（asar 字节级取证 2026-11-10）：`create(request)` 入参 `{workspaceId?, cwd?, sessionId?, agentPreset?}`（前两者互斥）、返回 `{sessionId, agentPreset?}`；`prompt(request, source)` 入参 `{requestId, sessionId, mode:'queue', content:[{type:'text',text}]}` 与 `{kind:'user', rpcId}`，`hasPromptRequest()` 按 `rpcId === requestId` 去重。

## 二、宿主接口面（只用了三个）

| 宿主能力 | 用法 | 用途 |
|---|---|---|
| `ctx.on('session/event', (session, ev) => …)` | 首参是 **session 对象**，`sessionId` 取 `session.header.id` | 事件上行 |
| `ctx.webServer.register({kind:'exact', path, handler})` | 返回 dispose | 本地路由 |
| `ctx.effect(fn, label)` | `fn` 返回 dispose | 一切注册与定时器都挂在 scope 上，**卸载即撤回** |

`inject = ['webServer', 'sessionPersistence']`。注意：`sessionPersistence` 是给**下一步只读回放**预留的；当前骨架对它的写路径零调用。若宿主只提供 `webServer`，插件仍应能加载（届时把 `sessionPersistence` 从 inject 移除，而不是靠可选服务让整个插件 pending）。

## 三、帧契约（与 `04` §5.3 一致）

Host → Relay：

```
{"t":"host/register","deviceId":"pc-1","protocol":"wbsync/1","caps":[…],"hostToken":"…"}
{"t":"host/heartbeat","ts":1730000000000}
{"t":"session/event","sessionId":"session-9","ev":{…原始事件，seq 不改不重排…}}
{"t":"http/response","reqId":"…","status":200,"body":{"ok":true,"data":{…},"protocol":"wbsync/1"}}
```

Relay → Host：

```
{"t":"host/registered","deviceId":"pc-1","protocol":"wbsync/1"}
{"t":"host/heartbeat/ack","ts":…}
{"t":"http/request","reqId":"…","method":"POST","endpoint":"session/prompt","body":{…},"sinceSeq":null}
{"t":"ack","ref":"…","status":"accepted"}
```

- **只有收到 `host/registered` 才置 `connected=true`**：TCP/WS 握手成功不等于业务可用。
- `session/event` 的 `ev` **原样透传**，`seq` 不改、不重排、不合并（ADR-004：`seq` 是唯一游标）。
- 未连接时上行事件**丢弃并计数**（`dropped`），靠 `session/follow` 补齐——补齐本身尚未实现，见「六、已知边界」。

## 四、下行分派与错误码

| 端点 | 动作 | 成功 | 失败 |
|---|---|---|---|
| `session/prompt` | `submitPrompt` | 200 + `{accepted:true}` | 适配器拒绝 → 409 + 原 `code` |
| `session/cancel` | `cancelTurn` | 200 + `{cancelled:true}` | 同上 |
| `session/create` | `createSession` | 200 + `{sessionId, …}`（Relay 据此写 CP 引导行） | 同上 |
| `session/follow` | `replay` | 200 + `{events:[…]}` | 同上 |
| 其它 | — | — | **403 `ENDPOINT_NOT_ALLOWED`** |

适配器抛异常 → **500 `NO_PROGRESS`（`retryable: true`）**，异常不逃逸、不崩连接。白名单在 Host 侧**再判一次**：Relay 判过不等于 Host 就可以不判（两层都判，任一层放水都不会扩大攻击面）。

## 五、本地路由

| 路由 | 方法 | 说明 |
|---|---|---|
| `/__wbsync/status` | GET | `connected` / `relayConfigured` / `forwarded` / `dropped` / `downlinks` / `reconnects` / `lastSeq` / `protocol` |
| `/__wbsync/pair` | GET / POST | 代理一次 `POST <relayUrl>/pair/generate`，把 6 位配对码回给本机 UI（GET 供浏览器地址栏直开，POST 供脚本调用；其余方法 405） |

`relayUrl` 配成 **http(s) base**（配对代理要用 `fetch`），WS 地址由 `toWsUrl()` 派生（`http→ws`、`https→wss`）。这样只配一处，不会出现 HTTP 用域名、WS 用 IP 的错配。

## 六、历史补齐（`src/replay.js`）

Relay 的事件缓冲在内存里，进程一重启就空；手机断线重连要补的那段历史**只能回 Host 读**，因为 `~/.dsh` 的 append-only 日志是唯一真源。

宿主 API 是从 `dsh-session-persistence-jsonl` 的实现里取证来的，不是猜的：

| 调用 | 返回 | 说明 |
|---|---|---|
| `sessionPersistence.open(id, 'read')` | handle | **只读句柄**，不含写权限 |
| `handle.read(offset, length)` | `{ eventState, events }` | `offset` 是**首条要包含的逻辑 seq**（实现上等于数组下标） |
| `handle.close()` | — | 必须释放，否则一直占着 tracker |

语义（ADR-004）：

- 只返回 **`sinceSeq + 1` 起的连续前缀**，遇缺口立刻停，绝不返回撕裂尾部；
- `seq <= sinceSeq` 的重复帧**幂等丢弃**，手机重试不会拿到重复事件；
- 缺口显式报 `complete:false` + `expectedSeq`，由手机决定重试还是报 `session/gap`；
- 单页最多 `pageSize`（默认 500，上限 5000）条，多读一条只为判断 `hasMore`，不发给手机；
- `offset` 传 `sinceSeq + 1` 是**快路径**（宿主 seam 契约：offset 是首条要包含的逻辑 seq，而逻辑 seq 从 0 连续）；一旦首条事件的 `seq` 对不上，退化为从 0 读一次再过滤——有界兜底，不是常态路径。

响应示例：

```json
{"ok":true,"data":{"sessionId":"session-9","events":[…],"count":5,"fromSeq":4,"toSeq":8,
 "complete":false,"expectedSeq":9,"hasMore":true,"eventState":"prepared"}}
```

## 七、会话索引上报（`src/sessions.js`）

手机要一份「有哪些会话、各自什么状态、最新 seq 到哪」的快照。来源是 `sessionPersistence.list()`，返回 `[{ header, formatStatus, revision, sizeBytes, location }]`；本模块把它整理成协议里的 `SessionIndex` 行，注册成功即推一次，之后按 `indexRefreshMs`（默认 60s）刷新。

两个取舍写在代码里，免得后面有人当成漏做：

1. **`lastSeq` 要解码整份日志才知道**：宿主没有「日志条数」接口，`read()` 内部是整文件解码。所以按 `revision` 缓存——文件没变就直接复用，只有真追加过才重新解。
2. **超过 `maxDecodeBytes`（默认 8 MiB）就放弃探测**：不能为了列表上一个数字，每次刷新把几十个大日志全解一遍。放弃时 `lastSeq: null`，表示**未知**，绝不写 0（0 会被手机当成「没有新事件」）。

`state` 的口径：协议六态由 `turn/end.reason` 单向下发（`r2`），这里给的是**启动引导值**——`resolveState()` 问得到运行态就用，问不到就是 `stopped`（日志已落盘、当前没有在跑的 turn），落盘格式坏了是 `unreadable`。`pinned / pinnedOrder` 是 PC 侧状态，Host 日志里没有，固定 `false / 0`（协议规定手机只读）。

行字段严格按契约 10 个：`sessionId / ownerDeviceId / workspace / title / pinned / pinnedOrder / state / lastSeq / lastActiveAt / headerRef`。「为什么 lastSeq 是空的」不进契约行，放在 `stats.sources` 里给状态路由与日志用。

## 八、已知边界（W3 剩余项）

1. **`deviceId` / `hostToken` 未落地**：当前由调用方配置，没有本机持久化与配对双绑。
2. **附件上行未做**：`caps: ['attachments', …]` 只是声明。
3. **心跳只做存活**：`host/heartbeat` 每 15s 一次，Relay 回 ack 但不参与 RTT 统计与时钟对齐。
4. **丢弃窗口靠 follow 兜底，但没人自动触发**：`dropped` 只计数，重连后主动补拉要等手机侧（PWA）发起。
5. **索引里没有 `title`**：宿主会话头里确实没有标题字段（实测只有 `version/id/createdAt/cwd/isSeeded/delegationDepth/agentPreset`），标题要由 PC 侧会话管理器补，此处给 `null` 而不是从 `cwd` 编一个。

## 九、测试（51 个用例，`node --test`）

```bash
node --test p1/host-plugin/test/*.test.mjs
```

| 组 | 覆盖 |
|---|---|
| 静态契约 | 插件名、`inject` 白名单、协议版本 |
| 未配置 Relay | 不发起连接、不空转重连、状态路由如实说明 |
| 注册 | 注册帧字段（`deviceId`/`caps`/`hostToken`）、`host/registered` 前不算连接 |
| 上行 | 事件体原样、`sessionId` 取 `session.header.id`、`seq` 不乱序、计数与 `lastSeq`、缺 id 不计数不发帧 |
| 下行 | prompt/cancel/follow 分派到各自适配器并回 `http/response`；未注入适配器 409 `WRITER_UNAVAILABLE`；白名单外 403；异常 500 且连接不崩 |
| 历史补齐（15 个） | 连续前缀、缺口截断 + `expectedSeq`、重复帧幂等丢弃、分页 `hasMore` 翻页、已到末尾不空转、下标与 `seq` 不等时回退、非法 `sinceSeq` 按 -1、会话不可读 / `read` 抛错仍释放句柄、参数夹取 |
| 补齐接线 | `session/follow` 走 `open(id,'read')`（断言 `access === 'read'`）、句柄用后即释放、无句柄时 501 `NOT_AVAILABLE` 且 `replayReady:false` |
| 会话索引（14 个） | 契约 10 字段不多不少、`headerRef` 只挑 6 个字段、`lastSeq` 取末尾事件、`revision` 命中缓存 / 变化重探、超预算给 `null`、无句柄 / open 失败 / read 失败、`unreadable` 不解码、`resolveState` 非法值回落、`list` 抛错不编造行、`limit` 截断 |
| 索引接线 | 注册后自动推 `host/sessions`、无 `list()` 不发也不谎报空表、按周期刷新、重连后重推、真 Relay 落库可查（`/host/indexes`） |
| 断线与卸载 | 退避重连并重新注册；卸载后路由注销、监听移除、不再上行、**不在背后重连** |
| 端到端（真 Relay） | 配对 → Host WS 注册 → 手机 HTTP 投递 → 适配器 → 响应回程 → 卸载后 Relay 判离线 |
| **可安装 bundle（3 个）** | 单文件 `bundle/index.js` 独立外连真 Relay、`/__wbsync/status` 如实上报（无 `sessionPersistence` 时 `indexReady:false`）、pair 路由代理真 Relay 出码、wrapper 配置链（默认 ← 文件 ← 环境变量） |
| **宿主入口适配器（9 个）** | `create` / `prompt` 参数映射、幂等 `requestId`、部分成功语义、服务软探测与缺失 409、真 Relay 端到端新建会话（src + **bundle 产物**各一例） |

宿主侧用两个替身：`createMockCtx()`（只实现三个能力 + 记录装载/拆除）和 `startFakeRelay()`（复用手写的 `upgradeToWebSocket`，可逐帧观察并可主动下发）；回放用假句柄（`read` / `close`）。端到端用例用**真 `createRelay()`**，跑真实配对与鉴权，不用 mock 绕过。

## 十、下一步

1. `deviceId` 派生 + 本机持久化 + 与配对令牌双绑（bundle 期临时用主机名）。
2. ~~手机侧（PWA）在重连后主动发 `session/follow`~~（`p1/pwa` 已落地）。
3. CP 已分离（`p1/cp` 接管索引 / 租约 / 位点 / 设备表）；剩「增量同步」——现在每次全量上报，会话多了要做 diff。
4. ~~正式包换标识，接入 `dsh.bundle` 分发给真机验证~~（`bundle/` + `dist/dsh-wb-cloud-sync-host-0.1.2.tgz` 已落地并真机装包成功，`build-bundle.mjs --check` 入 CI 防脱节）。
5. ~~真机装 bundle 跑通「配对 → 列表 → 新建 → 事件流」~~（截图已确认 11 个会话列表与实时事件流）；~~`createSession` 适配器接宿主新建会话入口~~（`host-adapters.js` 接 `sessionController.create/prompt`，0.1.2 待真机验证）。
6. `cancelTurn` 接宿主取消入口（方法名需重新取证，asar 里命中均为 ACP 示例）。
7. Relay `isOnline` 会因 CP 活跃标记**早于** WS 连接就绪而返回 true，此时 `bridge` 把帧投进降级轮询队列，而 Host 只走 WS → 504。真机常连形态下不触发，正式版应让 Host 接轮询或让 `isOnline` 只认活跃 WS。

---

零依赖：`src/` 只有 `index.js` / `replay.js` / `sessions.js` / `host-adapters.js` 四个模块、互相 import，无第三方包（WS 用 Node 内置全局 `WebSocket`），可直接 `node --test`。

## 十一、可安装 bundle（`bundle/`）

- `bundle/index.js` 由 `node p1/host-plugin/build-bundle.mjs` 从 `src/` **自动生成**（单文件自包含，顶层重名构建期即失败）；CI 用 `--check` 防「改了 src 忘了生成」。
- `npm pack` 产出 `dist/dsh-wb-cloud-sync-host-0.1.2.tgz` → DSH「添加插件」安装；`dsh` 块只声明 `bundle.patch`（host-only，写法对齐已验证的探针 / dsh-nas-sync）。
- **真机取证（2026-11-10）**：装包后插件在 PC 端 DSH 正常加载——`/__wbsync/status` 报 `connected:true`、索引 11 条已上送；DSH web 端口是**动态**的（`netstat -ano | findstr <DSH进程PID>` 查 LISTENING），浏览器地址栏 `http://127.0.0.1:<端口>/__wbsync/pair` 即可出码。
- wrapper 配置链（低→高）：代码默认（本机 Relay + 主机名 deviceId）← `~/.dsh/wbsync-host.json` ← `WBSYNC_*` 环境变量 ← `apply` 的 `config`。
- 安装 / 配置详见 `bundle/README.md`。

