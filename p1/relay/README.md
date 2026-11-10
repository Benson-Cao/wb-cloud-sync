# P1 · W3 Relay 开发骨架

> 状态：**开发期骨架**，`05` W3 第一项。零依赖，Node ≥ 24.9。
> 治理前提：`SIGNOFF-WAIVER.md`（发起人跳过会签，仅限 W3–W6 内部开发；GA 前必须补签）。

## 运行

```bash
source scripts/toolchain-env.sh          # 仓库根执行，启用隔离 Node 24 / pnpm 11
pnpm --dir p1/relay test                # 或 node --test p1/relay/test/*.test.mjs
```

`createRelay(options)` 返回未监听的 `http.Server` + 内存 `state`，注入 `now()` / `randomBytes()` 可让时间与随机性确定，测试规则判定不靠运行时猜测。`node --test` 共 9 个用例，覆盖配对码 TTL/限速、challenge 一次性与过期、HMAC 与令牌摘要、单活跃令牌、白名单、离线 409、心跳 45s 超时、在线桥闭环、`NO_PROGRESS` 504、`sinceSeq` 观测语义。

## 已实现

| 能力 | 对应需求 |
|---|---|
| `POST /pair/generate`（6 位码 / 10 min TTL / 设备+IP 5 次每分限速）、`POST /pair`、`POST /pair/verify`（HMAC-SHA256） | `02` FR-2.2~2.5、`04` §5.1 |
| 令牌只落 `SHA-256` 摘要、单活跃令牌、重配对作废旧令牌、墓碑不复活 | `08` §4.2 |
| `POST /host/register` / `host/heartbeat`、> 45s 判离线、`HOST_OFFLINE` 立即 409 | `04` §5.2、`02` FR-8.3 |
| `allowedEndpoints` 默认仅 `session/*`、`$events/*`，白名单外 403 | `04` §7、BR-6 |
| `GET /host/poll` + `POST /host/respond` 轮询桥、10s `NO_PROGRESS` 504 | `04` §5.3 帧代理语义（开发期等价物） |
| `GET /admin`（`--admin-token`）、`GET /health`、统一响应包与 `X-Protocol-Version` | `04` §1 / §5 |

## 四项默认裁定如何落进代码

按 `SIGNOFF-WAIVER.md` §5（**未经会签，可回滚**）：

- **#2**：`pairSecret` 是 per-challenge 的 128 bit 随机数，随 `challenge` 一次性下发，验证或超时即销毁；不落盘、不复用、不参与 `deviceToken` 派生，也**不承担身份鉴别**（身份门槛是配对码 + 限速 + 主机显式开关）。
- **#3**：单机开发期以 Relay 内存表为活跃令牌与在线状态权威；CP / Host 分离后按 `P1-PREREQUISITES.md` §2 迁移（CP 管档案、Relay 管令牌、Host 仅展示缓存）。
- **#4**：W3 只开 `session/*` 与 `$events/*`；`artifacts/*` 留 P1 末，`attachments/*` / `schedule/*` 留 P2；`config/*`、`permission/*`、`remote-desktop/*` 不开放。
- **#5b**：客户端上报的 `sinceSeq` 是唯一权威，服务端 `state.cursors` 只作可观测性快照，不据此替客户端决定补齐起点。

## 明确的边界

- **WS 帧代理尚未实现**：正式设计是 Host 主动 WSS 外连 Relay（`04` §5.2）。本骨架用 HTTP 轮询桥作开发期等价物，帧字段与 `04` §5.3 一致；W3 下一提交替换传输层时，配对 / 鉴权 / 白名单 / 离线判定逻辑不变。
- **CP 尚未分离**：配对码登记、设备档案、会话索引暂由 Relay 单机内存承担，不落盘、重启即清空。
- **不处理事件正文持久化**：Relay 只转发帧，不解析、不缓存、不写盘（ADR-010 / `04` §5.4）。端到端加密属 `wbsync/2`。
- 根 `package.json` 的 `files` 白名单只含 5 个文件，`p1/` 不会进入可安装探针 tarball（G9 已覆盖）。

## 下一步（`05` W3 剩余）

1. 把轮询桥替换为 WSS 长连 + 帧保序 + `host/sessions` 全量索引上报。
2. CP 分离：账号 / `DeviceRegistry` / `SessionIndex` / `RouteLease` / `Cursor` 四张元数据表。
3. Host 插件 bundle 最小可运行（`apply` + `inject` + `effect` + 本地具名路由）。
4. PWA 骨架：设备选择、会话列表、`sinceSeq` 补齐渲染。
