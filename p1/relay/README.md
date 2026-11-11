# P1 · W3 Relay 开发骨架

> 状态：**开发期骨架**，`05` W3。零依赖，Node ≥ 24.9。
> 治理前提：`SIGNOFF-WAIVER.md`（发起人跳过会签，仅限 W3–W6 内部开发；GA 前必须补签）。

## 运行

```bash
source scripts/toolchain-env.sh          # 仓库根执行，启用隔离 Node 24 / pnpm 11
pnpm --dir p1/relay test                # 或 node --test p1/relay/test/*.test.mjs

# 真机联调：启动 Relay（监听 0.0.0.0，控制台打印所有可用的局域网地址）
node p1/relay/run.mjs                    # PORT=8787；WBSYNC_HOST_TOKEN / WBSYNC_ADMIN_TOKEN 可选
                                         # CP 落盘默认 ~/.wbsync/cp.json（WBSYNC_CP_FILE 可改；:memory: 关闭）
# 手机浏览器打开打印出的 http://<局域网IP>:<PORT>/app 即壳页面
```

「Relay 地址」= 跑在 PC 上、手机与 PC 插件共同连着的这个进程的 `http://<局域网IP>:<端口>`；
`start(port, host)` 默认只听 `127.0.0.1`（单测/本机调试），真机联调传 `'0.0.0.0'` 或直接用 `run.mjs`。

`createRelay(options)` 返回未监听的 `http.Server` + 内存 `state`，注入 `now()` / `randomBytes()` 可让时间与随机性确定，规则判定不靠运行时猜测。`node --test` 共 **39 个用例**：HTTP 10（含 T10 主动吊销）、Host WS 9（含 W8 积压帧转交、W9 增量索引帧）、手机事件订阅 7、跨实例共享 CP 4、静态壳服务 6、监听与启动器形态 3。

## 传输形态

| 方向 | 通道 | 说明 |
|---|---|---|
| Host → Relay | **`WS /ws/host` 长连** | 先 `host/register`（带 `HOST_TOKEN`），再 `host/heartbeat`、`host/sessions`（`mode:'full'\|'diff'`）、`session/event`、`http/response` |
| 手机订阅事件 | **`WS /d/<deviceId>/events/<sessionId>?token=&sinceSeq=`** | 只下行；令牌走 query（浏览器 WebSocket 不能设 Authorization 头） |
| 手机读会话列表 | **`GET /api/sessions?deviceId=&pinned=`** | `Bearer <deviceToken>`；协议 §4 CP API 的 W3 单机实现（CP 仍在 Relay 进程内，P2 迁独立服务），测试见 `p1/pwa` A1–A3 |
| 手机新建会话 | **`POST /api/sessions`**（body 带 `deviceId`） | `Bearer <deviceToken>`；Host 离线 409 `HOST_OFFLINE`（入口置灰）；桥接白名单内 `session/create` → Host `createSession` 适配器；未注入适配器 409 透传。成功后 Relay 把**引导行**（`state:'awaiting'`）以 `cp.putSession` **单行合并**写进 CP（不走全量替换，否则会清掉该设备其余会话、手机列表闪一下），Host 下一次全量上报校正 |
| 手机发指令 | HTTP（`/d/<deviceId>/session/*`） | 走白名单 + 桥接成 `http/request` 帧 |
| 手机请求 → Host | `http/request` 帧 | 同一连接按发送顺序到达，**帧序即流序** |
| 手机打开壳页面 | **`GET /app`**（及 `/app/*`、`/src/*`） | 无鉴权静态（PWA 必需，docs/04）；`/app` → `p1/pwa/public`，`/src` → `p1/pwa/src`（页面里 `../src/client.js` 的解析目标）；单层文件名 + 解码后校验拒绝路径遍历；`staticDir: null` 关闭 |
| 降级 | `GET /host/poll` + `POST /host/respond` | 设备没有活跃 WS 时使用，便于旧 Host 与单测。**两者都必须带 `HOST_TOKEN`**（Bearer 头 / body / query 任选），否则 401——无凭据时可读到手机待发的提示词、并伪造回复（渗透用例 S11/S14） |
| Host 索引增量 | `host/sessions` 帧 / `POST /host/sessions` | `mode:'full'`（首轮 / 重连后）走 `cp.upsertSessions` 建基线；`mode:'diff'` 走 `cp.applySessionDiff`，只应用 `rows` 与 `removedIds`，不误删未提及行 |
| PC 管理台 | **`GET /admin/ui`** + `GET /admin` | 同源 HTML：输入 admin token → 列设备 → 逐台吊销；token 只存内存，不进 URL / localStorage |
| PC 主动吊销 | **`POST /admin/revoke`** | `Bearer <adminToken>`；**未配置 `WBSYNC_ADMIN_TOKEN` 时 409 拒绝写**；吊销即置墓碑、清令牌 / 会话 / 租约并断开现有 WS |

`src/ws.js` 是零依赖 RFC 6455 子集：握手、单帧文本 / 关闭 / 心跳、客户端 mask 校验、1 MiB 上限；不做分片与扩展协商。换成 `ws` 或 uWebSockets 时只替换该文件。

## 事件流语义（`src/events.js`）

- 会话内 `seq` 从 0 起连续单调，**连续 `seq` 是唯一游标**（`ADR-004`），不用时间戳。
- 上行事件按 `seq` 落缓冲，**只广播连续前缀**：收到 `0, 2, 1` 时 `2` 先到不广播，等 `1` 到达后按 `1, 2` 顺序推。
- 手机订阅带 `sinceSeq`，从 `sinceSeq+1` 起补发；补不上时发 `session/gap`（含 `expectedSeq`）让客户端重拉或降级，**不静默跳过**。
- 若客户端要的位置早于缓冲起点（会话被截断或缓冲已裁剪），**一条都不补**，直接发 `replay(complete=false)` + `gap`，避免跳跃式补发。
- 缓冲只留最近 `eventBuffer` 条（默认 1000），只裁 `delivered` 之前的老条目。
- 控制帧：`session/replay {fromSeq,toSeq,complete}`、`session/gap {expectedSeq}`。

## 已实现

| 能力 | 对应需求 |
|---|---|
| `POST /pair/generate`（6 位码 / 10 min TTL / 设备+IP 5 次每分限速）、`POST /pair`、`POST /pair/verify`（HMAC-SHA256） | `02` FR-2.2~2.5、`04` §5.1 |
| 令牌只落 `SHA-256` 摘要、单活跃令牌（**逐设备**：手机自成一设备行，r9）、重配对只轮换本机令牌、墓碑不复活 | `08` §4.2、`04` §5.1 |
| 多手机：一台 Host 可绑多台手机（上限 `maxPhonesPerHost`，默认 8）；`/admin/revoke-client` 逐台收回并断开其长连（r9） | `04` §2 手机独立成行 |
| `WS /ws/host` 注册 / 心跳 / 索引上报 / 上行事件 / `http/response`；**断连立即判离线** | `04` §5.2、`03` §3.3 |
| `WS /d/<id>/events/<sid>` 订阅 + 连续 `seq` 补齐 + `gap` 显式上报 | `04` §5.3、`ADR-004`、G4 |
| `allowedEndpoints` 默认仅 `session/*`、`$events/*`，白名单外 403 | `04` §7、BR-6 |
| 请求超时 10s → `NO_PROGRESS` 504；Host 离线 → `HOST_OFFLINE` 409 | `04` §1 |
| `POST /host/register`、`/host/heartbeat`、`/host/sessions`、`GET /host/indexes`（HTTP 降级；配置 `adminToken` 后加锁） | `04` §5.2 |
| `GET /admin`（含 `transport` `ws` / `http-poll`）、`GET /health`、统一响应包与 `X-Protocol-Version` | `04` §1 / §5 |

## 四项默认裁定如何落进代码

按 `SIGNOFF-WAIVER.md` §5（**未经会签，可回滚**）：

- **#2**：`pairSecret` 是 per-challenge 的 128 bit 随机数，随 `challenge` 一次性下发，验证或超时即销毁；不落盘、不复用、不参与 `deviceToken` 派生，也**不承担身份鉴别**。
- **#3**：**已迁 CP**（W3 本轮）。设备表、会话索引、写句柄租约、消费位点四张表在 `p1/cp`，Relay 只剩传输状态（套接字 / 待转发帧 / 事件缓冲 / 配对短时码）；令牌摘要也在 CP，Relay 通过 `verifyDeviceToken()` 校验，不再自己存。
- **#4**：W3 只开 `session/*` 与 `$events/*`；`artifacts/*` 留 P1 末，`attachments/*` / `schedule/*` 留 P2。
- **#5b**：客户端上报的 `sinceSeq` 是唯一权威，服务端只按它补发与记录观测，不替客户端决定起点。

## 明确的边界

- **配对后的 45s 活跃窗口**：`/pair/verify` 把设备记为「最近活跃」（`lastSeenAt=now`），此时可能还没有 Host WS。桥接帧先落降级轮询队列；**Host WS 注册时 Relay 会把该设备的积压帧转交给新 WS**（W8 回归），所以「配对完立刻发消息」不再等到 10s 超时回 504 `NO_PROGRESS`。若 Host 始终不连 WS，帧仍由 `/host/poll` 取走或按 10s 超时。
- **CP 尚未分离**：配对码登记、设备档案、会话索引暂由 Relay 单机内存承担，不落盘、重启即清空。
- **未设 `WBSYNC_HOST_TOKEN` 时 Host 注册不校验令牌**（run.mjs 试跑形态，控制台有醒目警告）：**对外使用必须显式设置**，且与插件 config 的 `hostToken` 一致。
- **静态壳是同步阻塞读**（`readFileSync`，开发期骨架够用）：文件都是 KB 级平铺小文件；换生产再改流式 + 缓存头策略。
- **不持久化事件**：缓冲只在内存，进程重启即丢；`~/.dsh` 日志仍是唯一真源（`03` P1），重启补齐要回 Host 读日志——属下一步。
- **不解析事件正文**：Relay 只按 `seq` 排队转发，不看 `ev.data`（ADR-010 / `04` §5.4）。端到端加密属 `wbsync/2`。
- **P0 快照不覆盖 `p1/`**：`gate-check` 的 `data` 组只含探针插件与 P0 证据，P1 代码由 CI 的「P1 骨架冒烟测试」阻断把关（`node --test p1/relay/test/*.test.mjs p1/host-plugin/test/*.test.mjs`）。
- 根 `package.json` 的 `files` 白名单只含 5 个文件，`p1/` 不会进入可安装探针 tarball（G9 已覆盖）。

## 下一步（`05` W3 剩余）

1. ~~重启后的历史补齐~~（`p1/host-plugin/src/replay.js` + 手机侧 `session/follow` 桥，已落地）。
2. ~~CP 分离~~（`p1/cp` 四张表，已落地）。
3. ~~Host 插件 bundle 最小可运行~~（`p1/host-plugin`，已落地）。
4. ~~PWA 骨架：设备选择、会话列表、`sinceSeq` 补齐渲染~~（`p1/pwa`，已落地）。
5. 剩余：附件上行（`attachments/*` 属 P2）、会话索引增量 diff、PC 侧主动吊销 UI、GA 前四方会签。
