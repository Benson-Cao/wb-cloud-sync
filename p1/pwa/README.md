# P1 · W3 手机侧 PWA 骨架

> 状态：**开发期骨架**，`05` W3「PWA 骨架：设备选择、会话列表、`sinceSeq` 补齐渲染」的第一块。
> 治理前提：`SIGNOFF-WAIVER.md`（发起人跳过会签，仅限 W3–W6 内部开发；GA 前必须补签）。

## 结构

```
p1/pwa/
├─ src/client.js      # 纯逻辑核心（零依赖，Node 里可对着真 Relay 跑端到端）
├─ src/pairing.js     # 配对向导：6 位码 → challenge/pairSecret → HMAC → deviceToken
├─ src/hmac-sha256.js # 纯 JS SHA-256 / HMAC-SHA256：无 crypto.subtle 时的回退
├─ public/index.html  # 最小 PWA 壳：配对向导 + 会话列表 + 事件流渲染
├─ public/sw.js       # 只缓存应用外壳，业务请求（/api/*、/d/*）网络直连
├─ public/manifest.webmanifest / icon.svg
└─ test/              # 29 用例（client 9 + pairing 8 + create 8 + hmac 4），真实 createRelay() 端到端
```

`src/client.js` 与 UI 框架无关，`fetchImpl` / `WebSocketImpl` / `now` 全部可注入；
换 Vue/React 时只换 `public/index.html`，逻辑核心不动。

**配对签名的环境缺口（真机取证 2026-11-10）**：`crypto.subtle` 只在**安全上下文**
（HTTPS / localhost / 127.0.0.1）可用；真机是 `http://<局域网IP>:8787/app` 这种明文
HTTP，浏览器里 `globalThis.crypto` 存在但 `subtle` 是 `undefined`，原实现会抛
`NO_WEBCRYPTO` 让整条配对链路断掉。Node 测试跑不出这个差异（Node ≥19 的全局 crypto
永远带 subtle）。现在 `pairing.js` **优先原生 WebCrypto，缺失时回退纯 JS**
（`hmac-sha256.js`，FIPS 180-4 / RFC 2104，零依赖），两条路径产出同一份标准
HMAC-SHA256 hex，与 Relay 侧 `node:crypto.createHmac` 逐字节一致。覆盖证据：
RFC 4231 向量、与 node:crypto / WebCrypto 交叉验证、显式 `subtle: null` 端到端配对。
HMAC 只对一次性 challenge 算一次，纯 JS 实现不降密码学强度；GA 前仍按 M5 交安全 Owner 复核。

## 通信面

| 动作 | 通道 | 鉴权 |
|---|---|---|
| **配对** | `POST /pair` → `POST /pair/verify`（`src/pairing.js`） | 6 位码 + per-challenge HMAC-SHA256（#2 裁定口径） |
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
- **新建会话**：`createSession({text})` → `POST /api/sessions`（body 带 `deviceId`）→
  Relay 桥接 Host `session/create` 适配器。Host 未注入适配器 → 409
  `WRITER_UNAVAILABLE`；Host 离线 → 409 `HOST_OFFLINE`（UI 置灰新建入口）。
  成功后 Relay 写 CP 引导行，客户端 `refreshSessions()` 后新会话立即可见并自动打开事件流。
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
# 壳页面已挂在 Relay 上：先启动 Relay（仓库根执行）
#   node p1/relay/run.mjs        # 控制台会打印所有可用的「Relay 地址」
# 然后手机浏览器打开打印出的 http://<局域网IP>:<端口>/app：
#   1. 填 Relay 地址；2. 在 PC 端打开宿主插件本地页 /__wbsync/pair 生成 6 位码；
#   3. 手机输码点「配对」→ 自动换取令牌并进入会话列表。
```

## 明确的边界

- **配对向导已做**：输 6 位码即完成配对（码由 PC 宿主插件本地页 `/__wbsync/pair` 生成）；配对码一次性，输错要回 PC 重新生成。已配对过的设备回访自动用已存令牌直连。
- **凭据暂存 localStorage**：配对后令牌留在本机便于回访；「换电脑 / 吊销」场景由 PC 侧单活跃令牌机制兜底（重配对即作废旧令牌）。正式版如需更严管控，加「忘掉这台电脑」入口 + PC 侧主动吊销 UI。
- **`deviceId` 单机期 = Host 设备 ID**：令牌按 Host 的 `deviceId` 登记（单活跃令牌，一台 Host 一部手机），多手机 / 多设备选择器属后续。
- **`POST /api/sessions` 已接**：新建会话链路（含 Host 适配器 409 透传与离线置灰）；0.1.5 真机已验证新建会话与第一句话投递均可用（会话日志含 `user/message` 与 `turn/end`）。
- **取消轮次已接**：事件流面板「取消当前轮次」按钮 → `client.cancelTurn()` → `POST /d/<deviceId>/session/cancel` → 宿主 `sessionController.cancel({sessionId})`；只中断当前轮次、保留待处理收件箱。依赖当前选中的会话（`activeSession`），未选中时不产生请求。
- **`PATCH /api/sessions/:id`（置顶）未接**：手机端本就 403（协议 §4），属 PC 侧功能。
- **附件上行未做**：`attachments/*` 是 P2 端点（WAIVER §5 默认口径）。
- **sw.js 不缓存业务响应**：离线看到旧会话流比空页面更容易误判，数据永远网络优先。
- **壳更新要刷两次**：SW 缓存名随清单变更递增（`wbsync-shell-v8`，因事件流折叠、订阅状态修复、`say()` 反馈可见性等壳改动递增）；旧 SW 接管期间第一次刷新仍返回旧壳，后台装好新 SW 并清掉旧缓存后，第二次刷新才拿到新壳。真机联调期如卡住，用无痕窗口或清除站点数据可一步跳过。壳 HTML 已改网络优先，新增模块不会再被旧缓存拖住；`static.test.mjs` S6 会校验清单覆盖页面与 src 模块的传递 import，防止漏缓存。
- **附件上行（`attachments/*`）未实现，列为 P2 独立工作项**：需协议 `wbsync/1 r3` 定义端点与 receipt 语义、`ALLOWED_ENDPOINTS` 加入 `attachments/*`、CP 增加 receipt 存储（大小上限 / TTL / 吊销即失效）、Host 侧取证并接 `ctx.fileUploads.registerAgentResolver` 把文件交给 Agent、PWA 增加文件选择并把 `{type:'file',receiptId}` 放进 `session/prompt` 的 content。关键是 ADR-010 信任边界：文件内容是否允许经 Relay 中转、是否计入「零正文落盘」口径，需单独裁定。当前 `session/prompt` schema 已支持 file content，但链路两端都未接，本轮不动。

## 测试（29 用例，真实 Relay 端到端）

- `test/pwa.test.mjs`（9 个）：A1 `/api/sessions` 无令牌 / 错令牌 401；A2 配对令牌读索引 + `pinned` 过滤；A3 `/host/indexes` 配置 `adminToken` 后加锁；B1 列表刷新 + 实时事件按序；B2 断线重连带 `lastSeq` 补 dropped 窗口；B3 缓冲起点高于客户端位置 → gap → `session/follow` 回 Host 补齐 → 重订阅续流；B4 Host 硬缺口如实停 `gap`、补齐请求去重有界；B5 `unfollow` / `stop` 清理干净；**B6 冷会话 WS 握手成功但无事件也进入 `following`**（真机 0.1.6 显示缺陷回归）。
- `test/pairing.test.mjs`（8 个）：正常配对换得可用令牌、错码 `PAIR_CODE_INVALID`、签名篡改 401、challenge 复用拒绝、配对码一次性、**无 WebCrypto 回退路径端到端配对**（`subtle: null` 模拟真机 HTTP 局域网）、回退签名与 `node:crypto` 等价且换得可用令牌、重配对作废旧令牌。
- `test/create.test.mjs`（8 个）：POST `/api/sessions` 鉴权 401、创建成功后 CP 立即可见引导行（`state:'awaiting'`）、适配器 409 透传且不出幽灵会话、Host 离线（推时钟过 45s 窗口）`HOST_OFFLINE`、**宿主异常原文透传**（`error.code` + `error.message` 都进 `Error`）、**引导行不得清掉 CP 其余会话**（真机 0.1.5 回归）、**`cancelTurn()` 走白名单 `session/cancel`**、客户端 `createSession()` 全链路。
- `test/hmac.test.mjs`（4 个）：SHA-256 标准向量、RFC 4231 HMAC 向量（case 1–4/6/7）、与 `node:crypto` 交叉验证（UTF-8 / emoji / 长 key / 随机二进制）、与原生 WebCrypto 交叉验证（两条签名路径等价）。
