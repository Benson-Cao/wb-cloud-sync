# P1 W3 · Host 侧插件骨架（`wbsync-host-dev`）

DSH 宿主里的那一半：**主动外连 Relay**、把宿主事件原样上行、把手机投递的指令交回宿主提交入口、注册两个本地只读/代理路由。

> 这是**开发骨架**，不是可发布插件：`private: true`，包名/插件 id 都是 `wbsync-host-dev`。正式包会是 `wb-cloud-sync` / `dsh-wb-cloud-sync`，届时只换 `package.json` 与 `cordis.patch.yml` 的标识，帧语义不变。

---

## 一、铁律：不自己开写句柄

P0 Spike Q2 已取证：手机投递必须走宿主 `dsh-api-session-controller.prompt(request)`，`requestId` 原生幂等，`SessionAlreadyOwnedError` 保证单写者。**绝不 `open(id,'write')`**——那会绕开宿主的并发保护，写出双写分裂。

所以本插件把提交能力抽象成三个**可注入适配器**，自己**不碰** `sessionPersistence` 的写路径：

| 适配器 | 入参 | 返回 | 缺省行为 |
|---|---|---|---|
| `submitPrompt` | `{sessionId, text, clientMsgId}` | `{ok:true, value}` / `{ok:false, code, message}` | 回 `WRITER_UNAVAILABLE`（409） |
| `cancelTurn` | `{sessionId}` | 同上 | 回 `WRITER_UNAVAILABLE`（409） |
| `replay` | `{sessionId, sinceSeq}` | 同上（`value.events`） | 回 `NOT_AVAILABLE`（409） |

未注入时**明确拒绝**并说明原因，不静默降级、不自行追加日志。这条是给正式接入留的口子，也保证骨架可以离线跑单测。

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
| `session/follow` | `replay` | 200 + `{events:[…]}` | 同上 |
| 其它 | — | — | **403 `ENDPOINT_NOT_ALLOWED`** |

适配器抛异常 → **500 `NO_PROGRESS`（`retryable: true`）**，异常不逃逸、不崩连接。白名单在 Host 侧**再判一次**：Relay 判过不等于 Host 就可以不判（两层都判，任一层放水都不会扩大攻击面）。

## 五、本地路由

| 路由 | 方法 | 说明 |
|---|---|---|
| `/__wbsync/status` | GET | `connected` / `relayConfigured` / `forwarded` / `dropped` / `downlinks` / `reconnects` / `lastSeq` / `protocol` |
| `/__wbsync/pair` | POST | 代理一次 `POST <relayUrl>/pair/generate`，把 6 位配对码回给本机 UI |

`relayUrl` 配成 **http(s) base**（配对代理要用 `fetch`），WS 地址由 `toWsUrl()` 派生（`http→ws`、`https→wss`）。这样只配一处，不会出现 HTTP 用域名、WS 用 IP 的错配。

## 六、已知边界（W3 剩余项）

1. **重启后历史补齐未接**：`replay` 仍是占位。正解是 Host 只读 `sessionPersistence.open(id,'read')` 回放连续前缀 → 断线窗口内的事件从这里补，不靠 Relay 缓冲（Relay 缓冲在内存、进程重启即丢）。
2. **会话索引未上报**：`host/sessions` 帧还没发，手机的会话列表暂时无源。
3. **`deviceId` / `hostToken` 未落地**：当前由调用方配置，没有本机持久化与配对双绑。
4. **附件上行未做**：`caps: ['attachments', …]` 只是声明。
5. **心跳只做存活**：`host/heartbeat` 每 15s 一次，Relay 回 ack 但不参与 RTT 统计与时钟对齐。

## 七、测试（13 个用例，`node --test`）

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
| 断线与卸载 | 退避重连并重新注册；卸载后路由注销、监听移除、不再上行、**不在背后重连** |
| 端到端（真 Relay） | 配对 → Host WS 注册 → 手机 HTTP 投递 → 适配器 → 响应回程 → 卸载后 Relay 判离线 |

宿主侧用两个替身：`createMockCtx()`（只实现三个能力 + 记录装载/拆除）和 `startFakeRelay()`（复用手写的 `upgradeToWebSocket`，可逐帧观察并可主动下发）。端到端用例用**真 `createRelay()`**，跑真实配对与鉴权，不用 mock 绕过。

## 八、下一步

1. 接 `sessionPersistence` 只读回放，落地 `replay` 适配器（连续前缀，缺口报 `session/gap`）。
2. 启动时上报会话索引（`host/sessions`）。
3. `deviceId` 派生 + 本机持久化 + 与配对令牌双绑。
4. 正式包换标识，接入 `dsh.bundle` 分发给真机验证。

---

零依赖：`src/index.js` 没有任何 `import`（WS 用 Node 内置全局 `WebSocket`），可直接 `node --test`。
