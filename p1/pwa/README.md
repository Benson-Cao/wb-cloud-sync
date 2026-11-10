# P1 · W3 手机侧 PWA 骨架

> 状态：**开发期骨架**，`05` W3「PWA 骨架：设备选择、会话列表、`sinceSeq` 补齐渲染」的第一块。
> 治理前提：`SIGNOFF-WAIVER.md`（发起人跳过会签，仅限 W3–W6 内部开发；GA 前必须补签）。

## 结构

```
p1/pwa/
├─ src/client.js      # 纯逻辑核心（零依赖，Node 里可对着真 Relay 跑端到端）
├─ public/index.html  # 最小 PWA 壳：会话列表 + 事件流渲染
├─ public/sw.js       # 只缓存应用外壳，业务请求（/api/*、/d/*）网络直连
├─ public/manifest.webmanifest / icon.svg
└─ test/pwa.test.mjs  # 8 用例，真实 createRelay() 端到端
```

`src/client.js` 与 UI 框架无关，`fetchImpl` / `WebSocketImpl` / `now` 全部可注入；
换 Vue/React 时只换 `public/index.html`，逻辑核心不动。

## 通信面

| 动作 | 通道 | 鉴权 |
|---|---|---|
| 会话列表 | `GET /api/sessions?deviceId=&pinned=`（协议 §4 CP API 的 W3 单机实现，Relay 代挂） | `Authorization: Bearer <deviceToken>` |
| 事件订阅 | `WS /d/<deviceId>/events/<sessionId>?token=&sinceSeq=` | 令牌走 query（浏览器 WS 不能设 Authorization 头，**不写日志**） |
| 缺口补齐 | `POST /d/<deviceId>/session/follow`（白名单 `session/*`，桥到 Host 只读回放） | Bearer 头 |

`GET /api/sessions` 由 Relay 代挂是因为 W3 的 CP 还是进程内的库对象；P2 CP 独立成
服务时这条路由整体迁走，客户端 URL 不变（协议 §4 本来就定义在 CP 名下）。

## 客户端语义（与 ADR-004 / #5b 裁定一致）

- **连续 `seq` 是唯一游标**：`ev.seq <= lastSeq` 幂等丢弃；实时流跳帧按缺口处理，
  不冒险渲染撕裂视图。
- **重连补拉**：断线按 `base×2^n`（上限 15s）退避重连，重连带本地 `lastSeq`，
  Relay 按「客户端 `sinceSeq` 唯一权威」补发 dropped 窗口。
- **缺口回 Host 补齐**：收到 `session/gap` 或 `replay(complete=false)` 时走
  `session/follow` 桥到 Host 的只读回放适配器（`p1/host-plugin/src/replay.js`），
  拿回连续前缀后关旧订阅连接、重订阅续实时流。`replay(complete=false)` 与
  `session/gap` 背靠背到达会各自触发一次补齐，`refilling` 守卫保证同一会话
  同时只有一个补齐在跑。
- **有界停止**：`hasMore` 分页最多翻 8 页；Host 日志本身有硬缺口（`complete:false`
  且无更多页）时如实停在 `gap` 并发 `refill-failed` 通知，**不跳跃、不静默、不重试风暴**。
- **只读**：客户端不做任何置顶 / 调序写操作（协议 §4：手机端对 `PATCH /api/sessions/:id` 403）。

## 运行

```bash
node --test p1/pwa/test/*.test.mjs       # 或 pnpm --dir p1/pwa test
# 壳页面（开发期）：任选静态服务器指向 p1/pwa/public 的父目录，例如
# python3 -m http.server 8088 --directory p1/pwa
# 然后手机浏览器打开 http://<电脑IP>:8088/public/（页面里填 Relay 地址 + 设备 ID + 配对令牌）
```

## 明确的边界

- **配对流程 UI 未做**：壳页面靠手填令牌；`/pair` → `/pair/verify` 的向导属下一步。
- **凭据暂存 localStorage**：开发期图方便；正式版接配对流程后不长期持有明文令牌。
- **`deviceId` 单机期 = Host 设备 ID**：令牌按 Host 的 `deviceId` 登记（单活跃令牌，
  一台 Host 一部手机），多手机 / 多设备选择器属后续。
- **`POST /api/sessions`（新建会话）、`PATCH`（置顶）未接**：分别需要 `session/*`
  桥接与 PC 侧写通道，按 `05` 排期。
- **sw.js 不缓存业务响应**：离线看到旧会话流比空页面更容易误判，数据永远网络优先。

## 测试（8 用例，真实 Relay 端到端）

- A1 `/api/sessions` 无令牌 / 错令牌 401；A2 配对令牌读索引 + `pinned` 过滤；
  A3 `/host/indexes` 配置 `adminToken` 后加锁（原先裸奔的口子收掉）。
- B1 列表刷新 + 实时事件按序；B2 断线重连带 `lastSeq` 补 dropped 窗口；
  B3 缓冲起点高于客户端位置 → gap → `session/follow` 回 Host 补齐 → 重订阅续流；
  B4 Host 硬缺口如实停 `gap`、补齐请求去重有界；B5 `unfollow` / `stop` 清理干净。
