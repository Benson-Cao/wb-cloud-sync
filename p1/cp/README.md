# P1 W3 · 控制面（CP）元数据

Relay 以前把设备表、会话索引、位点都揣在自己进程内存里，于是「重启即失忆」「多实例各自为政」。协议 §2 把这些表定义在 CP（Postgres）上，**Relay 只做转发**。本包是单机开发期的**内存实现**，接口按 Postgres 表 1:1 设计——P2 换真库时替换实现、不动调用方。

```
p1/cp/src/index.js   createControlPlane()  ← 四张表 + 过期扫描
p1/cp/test/          18 个用例
```

## 一、四张表（字段与 `PROTOCOL.md` §2 一致）

| 表 | 主键 | 关键字段 | 本实现的处置 |
|---|---|---|---|
| `Device` | `deviceId` | `tokenDigest`、`capabilities`、`state`、`lastSeenAt`、`tombstone` | 令牌**只存 SHA-256 摘要**；吊销置墓碑，重启不复活 |
| `SessionIndex` | `sessionId` | `ownerDeviceId`、`workspace`、`state`、`lastSeq`、`headerRef` | **不含事件正文**（ADR-010）；Host 全量快照写入 |
| `RouteLease` | `sessionId` | `deviceId`、`leaseId`、`expiresAt` | 一会话一写者；过期惰性释放 |
| `Cursor` | `(clientId, sessionId)` | `sinceSeq` | 仅可观测性快照，客户端 `sinceSeq` 才是权威（#5b） |

## 二、API

```js
const cp = createControlPlane({ now, leaseTtlMs, offlineAfterMs, newId })

// Device
cp.upsertDevice({ deviceId, platform, capabilities, state, lastSeenAt })
cp.setDeviceToken(deviceId, token)        // 只由配对流程调用，存摘要
cp.verifyDeviceToken(deviceId, token)     // 定长比较，不返回摘要
cp.heartbeatDevice(deviceId, ts)          // 未知/已吊销 → HOST_OFFLINE(retryable)
cp.markDeviceOffline(deviceId)            // 传输层用：WS 断开立刻离线
cp.revokeDevice(deviceId)                 // 墓碑 + 清令牌 + 清该设备的会话与租约
cp.isDeviceAlive(deviceId, ts)            // 心跳时间窗 + 墓碑 + state
cp.listDevices()

// SessionIndex
cp.upsertSessions(ownerDeviceId, rows)    // 全量快照 → { upserted, removed }
cp.listSessions({ ownerDeviceId, pinned, accountId })
cp.getSession(id) / cp.patchSession(id, { pinned, pinnedOrder, title, state })

// RouteLease
cp.acquireLease({ sessionId, deviceId, clientId })   // 同设备幂等续期，别家 ROUTE_CONFLICT
cp.renewLease({ sessionId, leaseId }) / cp.releaseLease({ sessionId, leaseId | deviceId })
cp.getLease(sessionId) / cp.listLeases() / cp.sweepExpired()

// Cursor
cp.putCursor({ clientId, sessionId, sinceSeq }) / cp.getCursor({...}) / cp.listCursors({ clientId })

cp.stats()   // { devices, sessions, leases, cursors }
```

## 三、三条容易搞错的语义（代码里已写死并断言）

**1. Host 上报的索引是「该设备的全量快照」。** 本轮没出现的会话会被**移除**，否则删掉的会话会永远挂在手机上。其它设备的会话不受影响。

**2. `pinned / pinnedOrder` 是 PC 侧状态，Host 报文里恒为 `false / 0`。** upsert 时**不覆盖**已有值——不然 Host 每 60s 一次的全量上报会把用户置顶的会话每小时打回原位 60 次。

**3. `tokenDigest` 只能由配对写入。** `upsertDevice()` 会忽略传入的 `tokenDigest`；否则任何 Host 只要知道 `deviceId`，注册一次就能把别人的令牌顶掉。

租约的边界也说清楚：这里管的是**跨 Host 的路由归属**；会话内的单写者仍由宿主 `SessionAlreadyOwnedError` 兜底（ADR-008）。两层都要有，不能互相替代。

## 四、Relay 怎么用它

```js
const cp = options.controlPlane ?? createControlPlane({ now, offlineAfterMs })
```

- 外部传 `controlPlane` 时，**多个 Relay 实例共享同一份元数据**（`test/cp-separation.test.mjs` 起两个 Relay 验证：一边配对注册、另一边立刻能鉴权；一边报索引、另一边查得到；CP 里吊销、两边同时 401）。
- 不传就各自建一个，行为等同单机部署。
- Relay 的 `state` 只剩传输状态：`sockets` / `queue` / `pending` / `hub` / `codes` / `challenges` / `rateHits`。配对短时码与限速仍在 Relay（10 分钟 TTL 的一次性态，P2 随 CP 服务一起上收）。

错误码沿用协议：`UNAUTHORIZED` / `HOST_OFFLINE`(retryable) / `ROUTE_CONFLICT` / `SESSION_BUSY`(retryable)，由 Relay 映射成 401 / 409 / 409 可重试。

## 五、测试（18 个）

```bash
node --test p1/cp/test/*.test.mjs
```

| 组 | 覆盖 |
|---|---|
| Device | 令牌只能配对写入、注册不能顶掉摘要、吊销后不复活且清会话租约、心跳时间窗边界（44.999s 在线 / 45.001s 离线）、未知设备心跳报 `HOST_OFFLINE` |
| SessionIndex | 全量替换会移除消失的会话、不覆盖 PC 置顶、跨设备隔离、排序（置顶 → 置顶序 → 最近活跃）、非法 `state` 落回 `stopped`、空主键跳过 |
| RouteLease | 同设备幂等续租、别家 `ROUTE_CONFLICT`、过期后别人能接手、`leaseId` 不匹配的续租/释放不生效、续租推后过期时间、缺参数不生成野租约 |
| Cursor | 覆盖写、回退也如实记录（客户端权威）、按 client 过滤、缺参数拒绝 |
| 其它 | `stats()` 计数、返回值是副本（改调用方对象不污染表） |

时间类断言全部靠注入的 `now()` 推进，不 sleep。

## 六、下一步

1. P2 换 Postgres：按本文件的表结构建表，把 `createControlPlane()` 换成 SQL 实现（接口不变）。
2. 索引增量同步：现在每次全量替换，会话多起来要做 diff 推送。
3. 租约对外暴露：目前只有库调用，等 CP 独立成服务后开 `POST /api/leases/*`。
4. 多账号隔离：`Account` 表与 `accountId` 过滤已留位，尚未接 OAuth。
