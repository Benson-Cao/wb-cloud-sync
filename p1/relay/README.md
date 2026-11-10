# P1 · W3 Relay 开发骨架

> 状态：**开发期骨架**，`05` W3。零依赖，Node ≥ 24.9。
> 治理前提：`SIGNOFF-WAIVER.md`（发起人跳过会签，仅限 W3–W6 内部开发；GA 前必须补签）。

## 运行

```bash
source scripts/toolchain-env.sh          # 仓库根执行，启用隔离 Node 24 / pnpm 11
pnpm --dir p1/relay test                # 或 node --test p1/relay/test/*.test.mjs
```

`createRelay(options)` 返回未监听的 `http.Server` + 内存 `state`，注入 `now()` / `randomBytes()` 可让时间与随机性确定，规则判定不靠运行时猜测。`node --test` 共 **16 个用例**：HTTP 9 个（配对码 TTL/限速、challenge 一次性与过期、HMAC 与令牌摘要、单活跃令牌、白名单、离线 409、心跳 45s、轮询桥闭环、`NO_PROGRESS` 504、`sinceSeq` 观测），WS 7 个（握手、错误 `HOST_TOKEN` 断开、心跳 ack、索引上报、HTTP 经 WS 帧往返、**多帧保序**、断连即离线、降级通道）。

## 传输形态

| 方向 | 通道 | 说明 |
|---|---|---|
| Host → Relay | **`WS /ws/host` 长连**（正式设计） | 先发 `host/register`（带 `HOST_TOKEN`），再 `host/heartbeat`、`host/sessions`、`http/response` |
| 手机 → Relay | HTTP（W3 骨架） | PWA 侧的 SSE / WS 属后续提交 |
| 手机请求 → Host | `http/request` 帧 | 同一连接按发送顺序到达，**帧序即流序** |
| 降级 | `GET /host/poll` + `POST /host/respond` | 设备没有活跃 WS 时使用，便于旧 Host 与单测 |

`src/ws.js` 是零依赖的 RFC 6455 子集：握手、单帧文本 / 关闭 / 心跳、客户端 mask 校验、1 MiB 上限；不做分片与扩展协商。换成 `ws` 或 uWebSockets 时只替换该文件，上层帧语义不变。

## 已实现

| 能力 | 对应需求 |
|---|---|
| `POST /pair/generate`（6 位码 / 10 min TTL / 设备+IP 5 次每分限速）、`POST /pair`、`POST /pair/verify`（HMAC-SHA256） | `02` FR-2.2~2.5、`04` §5.1 |
| 令牌只落 `SHA-256` 摘要、单活跃令牌、重配对作废旧令牌、墓碑不复活 | `08` §4.2 |
| `WS /ws/host` 注册 / 心跳 / 索引上报 / `http/response`；**断连立即判离线** | `04` §5.2、`03` §3.3 |
| `POST /host/register`、`/host/heartbeat`、`/host/sessions`、`GET /host/indexes`（HTTP 降级） | `04` §5.2 |
| `allowedEndpoints` 默认仅 `session/*`、`$events/*`，白名单外 403 | `04` §7、BR-6 |
| 请求超时 10s → `NO_PROGRESS` 504；Host 离线 → `HOST_OFFLINE` 409 | `04` §1 |
| `GET /admin`（`--admin-token`，含传输方式 `ws` / `http-poll`）、`GET /health`、统一响应包与 `X-Protocol-Version` | `04` §1 / §5 |

## 四项默认裁定如何落进代码

按 `SIGNOFF-WAIVER.md` §5（**未经会签，可回滚**）：

- **#2**：`pairSecret` 是 per-challenge 的 128 bit 随机数，随 `challenge` 一次性下发，验证或超时即销毁；不落盘、不复用、不参与 `deviceToken` 派生，也**不承担身份鉴别**（身份门槛是配对码 + 限速 + 主机显式开关）。
- **#3**：单机开发期以 Relay 内存表为活跃令牌、在线状态与会话索引的权威；CP / Host 分离后按 `P1-PREREQUISITES.md` §2 迁移。
- **#4**：W3 只开 `session/*` 与 `$events/*`；`artifacts/*` 留 P1 末，`attachments/*` / `schedule/*` 留 P2；`config/*`、`permission/*`、`remote-desktop/*` 不开放。
- **#5b**：客户端上报的 `sinceSeq` 是唯一权威，服务端 `state.cursors` 只作可观测性快照。

## 明确的边界

- **手机侧还没有 WS / SSE 订阅**：W3 骨架里手机用 HTTP 请求-响应，事件流订阅属后续提交。
- **CP 尚未分离**：配对码登记、设备档案、会话索引暂由 Relay 单机内存承担，不落盘、重启即清空。
- **不处理事件正文持久化**：Relay 只转发帧，不解析、不缓存、不写盘（ADR-010 / `04` §5.4）。端到端加密属 `wbsync/2`。
- **P0 快照不覆盖 `p1/`**：`gate-check` 的 `data` 组只含探针插件与 P0 证据，P1 代码由 CI 的「P1 Relay 冒烟测试」阻断把关，两者职责分开。
- 根 `package.json` 的 `files` 白名单只含 5 个文件，`p1/` 不会进入可安装探针 tarball（G9 已覆盖）。

## 下一步（`05` W3 剩余）

1. 手机侧事件流：`WS /d/<deviceId>/events/*` 或 SSE，按连续 `seq` 补齐，`seq` 缺口不渲染。
2. CP 分离：账号 / `DeviceRegistry` / `SessionIndex` / `RouteLease` / `Cursor` 四张元数据表。
3. Host 插件 bundle 最小可运行（`apply` + `inject` + `effect` + 本地具名路由）。
4. PWA 骨架：设备选择、会话列表、`sinceSeq` 补齐渲染。
