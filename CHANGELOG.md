# CHANGELOG

协议字段变更必须同时更新 `docs/04` → `PROTOCOL.md` → 本文件（06 §9 / ADR-009）。

---

## [P1 W3 续 10] · 2026-11-10 12:0x · 非协议变更

- **PWA 壳挂上 Relay**（真机联调前置）：Relay 新增零依赖静态服务——`GET /app`（及 `/app/*`）服务 `p1/pwa/public`（壳页面），`GET /src/*` 服务 `p1/pwa/src`（页面里 `../src/client.js` 从 `/app/` 的解析目标，两个根约定为兄弟目录）。手机浏览器直接打开 `http://<Relay地址>/app`，**不再需要另起静态服务器**。`staticDir: null` 显式关闭；不传时自动探测仓库内相对路径，存在才挂。
- **路径遍历从根上排除**：只允许单层文件名（两个目录约定平铺），且**先 `decodeURIComponent` 再校验**——编码形态的遍历（`%2e%2e`、`%2f`、反斜杠）解码后必带 `..` / 分隔符，一律 403。无扩展名 / 未知 MIME 404。
- **写测试抓到自己三个错**：① `readStaticFile` 漏解码——编码遍历路径落到 404 而非 403（把遍历尝试伪装成了文件不存在，语义错误）；② `/src/*` 分支最初也指向 public 根（client.js 在 src 目录，404）；③ 测试正则没匹配 ES 模块的 `from '...'` 语法（`import` 关键字后没有 `=`，`from` 与引号间是空格）。
- 无鉴权静态是 PWA 必需（docs/04），业务数据仍全走鉴权端点；`Cache-Control: no-cache` 兜底，内容更新靠 sw 版本号。
- 测试 112 → **117**（`p1/relay/test/static.test.mjs` 5 个：双路径形态、MIME、三种遍历形态拒绝、`staticDir:null` 关闭、**页面引用资源自洽检查**——壳页面里每个相对引用从 `/app/` 解析后都必须可取）。

**边界未变**：静态读取是 `readFileSync` 同步阻塞（KB 级平铺小文件，开发期够用，已在 relay README 边界写明）；sw 缓存仍是壳专用。

---

## [P1 W3 续 9] · 2026-11-10 11:5x · 非协议变更

- **新建会话链路打通**（W3 收尾项）：手机 `POST /api/sessions`（body 带 `deviceId`，Bearer 鉴权）→ Relay 桥接白名单内的 `session/create` → Host 插件新适配器 `createSession({text, cwd, clientId})`（正式实现接宿主新建会话入口）。创建成功后 Relay 通过桥接响应钩子把**引导行**（`state:'awaiting'`）写进 CP——手机不必等 Host 下一个 60s 索引刷新周期即可见；Host 全量上报随后校正 `state` / `lastSeq`。
- **错误分层照旧**：Host 离线 → 409 `HOST_OFFLINE`（retryable，协议 §4 要求手机入口置灰，UI 已照做——未连接前「新建会话」栏隐藏）；Host 未注入 `createSession` 适配器 → 409 `WRITER_UNAVAILABLE` 透传，Relay 不代造会话、CP 不出幽灵行。
- **写测试抓到自己两个错**：① `createSession` 请求体漏带 `deviceId`——令牌按 Host 设备登记，Relay 无从校验 → 401；② 最初想用「只配对不注册 Host」测离线，实际撞上「配对即视为最近活跃」的既有语义（45s 窗口），改为注入时钟推过窗口再断言——该语义在真实流程里无害（能出码即宿主在跑），已在 `p1/relay/README.md`「明确的边界」写清其表现（窗口内桥接请求走降级通道等到 10s 超时 504，不误投帧）。
- PWA 客户端新增 `createSession()`（成功后自动 `refreshSessions()` 并打开新会话事件流）；UI 加「新建会话」栏（第一句话可选）。
- 测试 106 → **112**（`p1/pwa/test/create.test.mjs` 5 个 + host-plugin `session/create` 分派 1 个）。

**边界未变**：真机需在宿主插件注入 `createSession` 适配器（接 `dsh-api-session-controller` 的新建会话入口）才会真正建会话；置顶属 PC 侧功能（手机 403）；附件上行留 P2。

---

## [P1 W3 续 8] · 2026-11-10 11:4x · 非协议变更

- **配对向导落地**：新增 `p1/pwa/src/pairing.js` + 壳页面改造——手机侧不再手填令牌，正式走「PC 宿主插件本地页 `/__wbsync/pair` 出 6 位码 → 手机输码 → `POST /pair` 换一次性 challenge + per-challenge pairSecret → HMAC-SHA256 → `POST /pair/verify` 换 deviceToken」。HMAC 用 **WebCrypto（`crypto.subtle`）**：浏览器与 Node ≥19 全局 `crypto` 同接口，实现零依赖、测试零 mock（跑的就是浏览器里的真实路径）。
- **码一次性语义透出到 UI**：配对码被 `/pair` 消费后重放即 `PAIR_CODE_INVALID`，界面提示「回 PC 重新生成」；已配对设备回访自动用已存令牌直连（配对码输入框转为「留空直接连接」），避免误触重配对把旧令牌作废。
- 配对后令牌仍存 localStorage 便于回访——边界写清：单活跃令牌机制兜底（PC 侧重配对即作废旧令牌），主动吊销 UI 属后续。
- 测试 100 → **106**（`test/pairing.test.mjs` 6 个，真实 Relay 端到端：正常配对换得可用令牌、错码、签名篡改 401、challenge 复用拒绝、码一次性、**重配对作废旧令牌**）。sw 外壳缓存版本升 v2 纳入 `pairing.js`。

**边界未变**：`POST /api/sessions`（新建会话）与 `PATCH`（置顶）未接；附件上行未做；PC 侧主动吊销 UI 未做；多手机选择器属后续。

---

## [P1 W3 续 7] · 2026-11-10 11:2x · 非协议变更

- **PWA 骨架落地**：新增 `p1/pwa/`（`@wbsync/pwa-dev`，零依赖）。手机侧三件事补齐——鉴权会话列表、事件订阅、断线重连补拉——W3「PWA 骨架：设备选择、会话列表、`sinceSeq` 补齐渲染」首次可跑通端到端。`src/client.js` 是框架无关的纯逻辑核心（`fetchImpl` / `WebSocketImpl` / `now` 全可注入，Node 里对着真 Relay 跑端到端）；`public/` 是最小 PWA 壳（会话列表 + 事件流渲染 + 只缓存外壳的 sw.js，业务请求网络直连）。
- **补上协议 §4 的手机侧 CP 读端点**：Relay 新增 `GET /api/sessions?deviceId=&pinned=`（`Bearer <deviceToken>` 鉴权）。此前手机的会话列表只能查无鉴权的 `/host/indexes`，这是本轮发现的真缺口。W3 的 CP 还是进程内库对象所以由 Relay 代挂，P2 CP 独立成服务时整体迁走，客户端 URL 不变。
- **收掉第二个裸奔口子**：`GET /host/indexes` 配置 `adminToken` 后要求 Bearer（向后兼容：未配置时行为不变）。降级通道可以简化，但不能永远无鉴权。
- **客户端语义**（ADR-004 / #5b）：连续 `seq` 唯一游标，`seq <= lastSeq` 幂等丢弃，实时跳帧按缺口处理不硬渲染；断线按 `base×2^n`（上限 15s）退避，重连带本地 `lastSeq` 由 Relay 补 dropped 窗口；收到 `session/gap` 或 `replay(complete=false)` 走白名单内 `session/follow` 桥到 Host 只读回放，拿回连续前缀后关旧订阅重订阅续流；Host 硬缺口（`complete:false`）如实停在 `gap`，**不跳跃、不静默、不重试风暴**。
- **写客户端时抓到自己三个缺陷**：① `replay(complete=false)` 与 `session/gap` 背靠背到达会各自触发一次补齐 → 并发双补齐，加 `refilling` 守卫去重；② 补齐成功后旧订阅连接不关 → 双连接重复推送，且主动 close 会触发 close 事件引发多余重连，加 `closing` 标记；③ 测试里模拟 Host 的常驻收件循环挂 60s pending timer 吊住事件循环 → 文件级测试 8s 超时，timer `unref()` + `after` 统一关 Host 连接。
- 测试 92 → **100**（`p1/pwa` 8 个，全部真实 `createRelay()` 端到端：鉴权 401 / CP 读索引 + `pinned` 过滤 / `/host/indexes` 加锁 / 实时按序 / 重连补窗口 / gap 回 Host 补齐后无缝续流 / 硬缺口有界停止 / `unfollow` 清理）。

**边界未变**：配对向导 UI 未做（壳页面手填令牌，凭据暂存 localStorage 仅开发期）；`POST /api/sessions`（新建会话）与 `PATCH`（置顶，手机 403）未接；附件上行未做；`deviceId` 单机期 = Host 设备 ID（单活跃令牌，一台 Host 一部手机）。

---

## [P1 W3 续 6] · 2026-11-10 10:24 · 非协议变更

- **CP 分离落地**：新增 `p1/cp/`（`@wbsync/cp-dev`，零依赖）。协议 §2 的四张表——`Device` / `SessionIndex` / `RouteLease` / `Cursor`——从 Relay 进程内存搬到 CP，接口按 Postgres 表 1:1 设计，P2 换真库时替换实现、不动调用方。Relay 的 `state` 只剩传输状态：套接字、待转发帧、事件缓冲、配对短时码、限速计数。
- **Relay 不再持有元数据**：`/pair/verify`、`/host/register`、`/host/heartbeat`、`/host/sessions`、`/host/indexes`、`/d/*` 鉴权、`/admin`、WS 注册与关闭全部改走 CP。`isOnline()` 改成「有 WS 连接 → 在线，否则问 CP 的心跳时间窗」。`createRelay({ controlPlane })` 传入同一实例即多 Relay 共享一份视图。
- **三条语义写死并断言**：① Host 上报是**该设备全量快照**，本轮没出现的会话要移除，否则删掉的会话永远挂在手机上；② `pinned / pinnedOrder` 是 PC 侧状态，Host 报文里恒为 false/0，**upsert 不覆盖**已有值，否则每 60s 一次上报会把用户置顶打回原位；③ `tokenDigest` **只能由配对写入**，`upsertDevice()` 忽略传入值，否则任何 Host 知道 `deviceId` 就能顶掉别人的令牌。
- **租约边界**：`RouteLease` 管的是**跨 Host 路由归属**（同设备重复申请是幂等续租，别家 `ROUTE_CONFLICT`，过期惰性释放）；会话内的单写者仍由宿主 `SessionAlreadyOwnedError` 兜底（ADR-008）。两层不能互相替代。
- **修了一个原来就写歪的位点键**：Relay 旧实现把 `Cursor` 键写成 `clientId|deviceId`，而协议的主键是 `(clientId, sessionId)`——位点会落到错误的行上。现在要求 `body.sessionId`，拿不到就不记（不用 `deviceId` 冒充会话键），T8 相应改成断言 `(clientId, sessionId)`。
- 测试 70 → **92**：CP 18 个（心跳边界 44.999s/45.001s、吊销不复活、索引全量替换、置顶不被覆盖、租约幂等与冲突、位点回退如实记录、返回值是副本），Relay 新增 `test/cp-separation.test.mjs` 4 个——**起两个 Relay 共用一个 CP**：一边配对注册另一边能鉴权、一边报索引另一边查得到、CP 吊销后两边同时 401、租约跨实例互斥。这条测试就是「状态不在 Relay」的证明。
- CI 的 P1 冒烟步骤改为 `node --test p1/*/test/*.test.mjs`，新包自动纳入阻断，不用每次手改清单。

**边界未变**：CP 是**内存实现**（重启仍会失忆，P2 换 Postgres）；配对短时码与限速仍在 Relay；索引每次全量替换、没做增量 diff；`Account` 表与 OAuth 未接；手机侧 PWA 仍未开始。

---

## [P1 W3 续 5] · 2026-11-10 10:17 · 非协议变更

- **会话索引上报落地**：新增 `p1/host-plugin/src/sessions.js`，把 `sessionPersistence.list()` 的快照整理成协议里的 `SessionIndex` 行（10 个字段，不多不少），注册成功即推一次 `host/sessions`，之后按 `indexRefreshMs`（默认 60s）刷新。Relay 侧本来就有 `state.indexes` 与 `/host/indexes` 查询，现在真有数据了。
- **两个工程取舍写进代码**：① `lastSeq` 只能靠解码整份日志得到（宿主没有条数接口），所以按 `revision` 缓存，文件没变就复用；② 超过 `maxDecodeBytes`（8 MiB）放弃探测，`lastSeq: null` 表示**未知**——绝不写 0，否则手机会把「没探测」读成「没有新事件」。
- `state` 口径写清：六态由 `turn/end.reason` 单向下发（r2），本处只给**启动引导值**——`resolveState()` 问得到运行态就用，问不到是 `stopped`，落盘格式坏是 `unreadable`。`pinned / pinnedOrder` 是 PC 侧状态，固定 `false / 0`。
- **一处事实修正**：上一轮把宿主 `read(offset, length)` 的 `offset` 说成「事件下标不是 seq」。宿主 seam 契约原文是「**首条要包含的逻辑 seq**」，实现恰好是 `events.slice(offset, …)`（因为逻辑 seq 从 0 连续、等于下标）。代码本来的快路径写法是对的，但注释与 README 的解释有偏差，已改成契约原意，并保留「首条 seq 对不上就回退到 0 重读」作为兜底。
- **标题不作假**：实测会话头只有 `version/id/createdAt/cwd/isSeeded/delegationDepth/agentPreset`，没有标题。索引里 `title: null`，不从 `cwd` 编一个出来。
- 测试 53 → **70**：新增 `test/sessions.test.mjs` 14 个（契约字段、`headerRef` 只挑 6 键、缓存命中与失效、超预算、`unreadable` 不解码、`resolveState` 非法值回落、`list` 抛错不编造行、`limit` 截断），另加 3 个接线用例（注册后自动推、无 `list()` 不发也不谎报空表、周期刷新 + 重连重推）与端到端里的一条真实链路断言（索引经真 Relay 落进 `/host/indexes` 可查）。
- `/__wbsync/status` 增加 `indexReady / indexCount / indexSentAt / indexError`；关闭连接与卸载时一并停掉索引定时器。

**边界未变**：`deviceId` / `hostToken` 未持久化与配对双绑；附件上行未做；手机侧（PWA）尚未在重连后主动 `session/follow`；CP 未分离（索引仍在 Relay 内存）。

---

## [P1 W3 续 4] · 2026-11-10 10:1x · 非协议变更

- **重启后历史补齐落地**（W3 原本最大的一块）：新增 `p1/host-plugin/src/replay.js`。Relay 的缓冲在内存里、进程重启即空，所以补历史必须回 Host 读 `~/.dsh` 的 append-only 日志——`replay` 适配器从占位变成真实现。
- **宿主 API 是取证的，不是猜的**：从 `dsh-session-persistence-jsonl` 的实现读到 `open(id, access)` 返回的句柄只有 `read(offset, length)` / `append` / `flush` / `close`，`read` 返回 `{ eventState, events }`，**`offset` 是事件下标不是 `seq`**。据此把快路径定为「按 `sinceSeq + 1` 当下标读」，并用「首条事件 `seq` 对不上就回退到 0 重读」做有界兜底（P0 实测同会话内 `seq` 连续且等于下标，所以是兜底而非常态）。
- **只读铁律不变**：`openSession` 一律 `open(id,'read')`，测试断言 `access === 'read'`；不 `append`、不 `flush`，句柄在 `finally` 里 `close()`（漏关会一直占宿主 tracker）。
- 补齐语义按 ADR-004：只返回 `sinceSeq + 1` 起的**连续前缀**、遇缺口立刻停并报 `expectedSeq`；`seq <= sinceSeq` 幂等丢弃；单页 500 条（上限 5000），**多读一条只为判断 `hasMore`、不发给手机**；参数 0/非数字回落 500、负数夹到 1。
- 错误码分层：会话不可读 → **404 `SESSION_UNREADABLE`**，没有只读句柄 → **501 `NOT_AVAILABLE`**（不假装补齐成功），其余仍是 409。`/__wbsync/status` 增加 `replayReady`。
- 测试 36 → **53**（`host-plugin` 13 → 30）：新增 `test/replay.test.mjs` 15 个（连续前缀、缺口截断、重复帧幂等、分页翻页、末尾不空转、下标错位回退、非法 `sinceSeq`、`read` 抛错仍释放句柄、参数夹取），以及 2 个接线用例（`session/follow` 真走只读句柄并断言 `access`、无句柄时 501 且 `replayReady:false`）。
- **写测试时抓到自己两个错**：① 分页第一次实现把「多读的探测条」也塞进了返回数组，`count` 会变成 `pageSize+1`；② 分页夹取把 `0` 当「没配」回落 500、负数却夹到 1，两处语义不一致——现在都用「0/非数字 = 缺省、负数 = 下限」写清并断言。

**边界未变**：`host/sessions` 会话索引未上报；`deviceId` / `hostToken` 未持久化与配对双绑；附件上行未做；**手机侧（PWA）尚未在重连后主动发 `session/follow`**，所以 `dropped` 窗口目前只是计数、没人自动补。

---

## [P1 W3 续 3] · 2026-11-10 10:0x · 非协议变更

- **Host 侧插件骨架落地**：新增 `p1/host-plugin/`（`wbsync-host-dev`，`private: true`）——`apply(ctx, config)` 做五件事：主动外连 Relay 并发 `host/register`、订阅宿主 `session/event` 原样上行、把下行 `http/request` 分派给三个适配器并回 `http/response`、注册本地路由 `/__wbsync/status` 与 `/__wbsync/pair`、所有注册与定时器挂 `ctx.effect`（卸载即撤回）。
- **铁律写进代码**：**绝不 `open(id,'write')`**。手机投递走可注入的 `submitPrompt` / `cancelTurn` / `replay` 适配器；**未注入时明确回 409 `WRITER_UNAVAILABLE`**，不静默降级、不自行追加日志。这是给正式接入宿主 `prompt(request)` 留的口子，也让骨架能离线跑单测。
- 下行错误码分三档：白名单外 **403 `ENDPOINT_NOT_ALLOWED`**（Host 侧再判一次，不因为 Relay 判过就放行）、适配器拒绝 **409**（原样透出 `code`）、适配器抛异常 **500 `NO_PROGRESS`（retryable）** 且连接不崩。
- **只有收到 `host/registered` 才置 `connected`**：WS 握手成功 ≠ 业务可用；心跳 15s、断线按 `base×2^n` 退避（上限 15s）。未连接时的上行事件丢弃并计数（`dropped`），语义上交给 `session/follow` 补齐。
- `relayUrl` 统一配 **http(s) base**（配对代理要走 `fetch`），WS 地址由 `toWsUrl()` 派生（`http→ws` / `https→wss`），避免同一端点配两遍写岔。
- 测试 23 → **36**（新增 `p1/host-plugin/test/plugin.test.mjs` 13 个）：静态契约、未配置 Relay 不空转、注册帧字段、上行原样且 `seq` 不重排、缺 `session.header.id` 不计数、prompt/cancel/follow 三路分派、未注入适配器 409、白名单外 403、异常 500、退避重连、**卸载后路由注销 + 监听移除 + 不在背后重连**、以及**真 Relay 端到端**（配对 → WS 注册 → 手机 HTTP 投递 → 适配器 → 响应回程 → 卸载后 Relay 判离线）。
- **顺手抓到自己写的半成品**：上一轮刚加 `toWsUrl()`，但 `connect()` 里仍直接拼 `relayUrl + '/ws/host'`——http base 下会连不上。写测试前统一到 `toWsUrl`，`:80/:443` 与 `https` 两种 base 现在都能连。
- CI：步骤「P1 Relay 冒烟测试」改为 **「P1 骨架冒烟测试」**，一条命令跑两个包（`node --test p1/relay/test/*.test.mjs p1/host-plugin/test/*.test.mjs`）；`p1/relay/README.md` 与 `SIGN-OFF.md` §四的引用同步改名。
- 文档：新增 `p1/host-plugin/README.md`（帧契约、适配器表、错误码、已知边界、下一步）；根 `README.md` 目录树补 `p1/host-plugin/`；`SIGN-OFF.md` §零 P1 行与仓库状态回写。改根 README 后重打包 `dist/*.tgz` 保 G9。

**边界未变**：`replay` 仍是占位（**重启后历史补齐**没接，Host 只读回放是下一步）；`host/sessions` 会话索引未上报；`deviceId` / `hostToken` 未本机持久化、未与配对双绑；附件上行未做；CP 未分离；PWA 未开始。

---

## [P1 W3 续 2] · 2026-11-10 10:1x · 非协议变更

- **手机侧事件流落地**：新增 `p1/relay/src/events.js`（事件缓冲 + 订阅广播）。`seq` 从 0 连续，**只广播连续前缀**：收到 `0, 2, 1` 时 `2` 先到不推，等 `1` 到达后按 `1, 2` 顺序推。订阅带 `sinceSeq` 补发；补不上发 `session/gap{expectedSeq}`，`session/replay{fromSeq,toSeq,complete}` 标记区间，**不静默跳过**。
- **订阅路由**：`WS /d/<deviceId>/events/<sessionId>?token=&sinceSeq=`。浏览器 WebSocket 不能设 Authorization 头，令牌走 query（注释写明不得写日志）；未鉴权 401、Host 离线 409，在握手阶段直接拒绝。
- 缓冲只留 `eventBuffer`（默认 1000）条，只裁 `delivered` 之前的老条目；不落盘、不解析 `ev.data`（ADR-010）。
- 测试 16 → **23**（新增 `test/events.test.mjs` 7 个）：实时按序到达、带 `sinceSeq` 只补未消费、**乱序只推连续前缀**、补不上报 `gap`、未鉴权 / 错令牌拒绝、Host 离线拒绝、重复 `seq` 不重复入缓冲。
- **修两个自己写出来的缺陷**：① 测试辅助 `assertNoMessage` 挂了一个未取消的 `inbox.next()`，120ms 后到达的帧被它吞掉导致断言错位 → 改为只看队列长度；② `stop()` 只关 Host 的 WS、没关手机订阅连接，`server.close()` 一直等 → 新增 `hub.closeAll()` + `closeAllConnections()` + 2s 兜底。
- 语义收紧：客户端要的位置早于缓冲起点时**一条都不补**，直接 `replay(complete=false)` + `gap`，避免跳跃式补发。
- 文档：relay README 增加「事件流语义」小节与传输形态表；`SIGN-OFF.md` §零 P1 行更新。改 README 后重打包保 G9。

**边界未变**：缓冲在内存、进程重启即丢（`~/.dsh` 日志仍是唯一真源），重启补齐要回 Host 读日志，属下一步；CP 未分离；Relay 不解析正文。

---

## [P1 W3 续] · 2026-11-10 10:0x · 非协议变更

- **Host 侧传输从「HTTP 轮询桥」升级为「主动 WS 长连」**（`04` §5.2 / `03` §3.3 的正式形态）：新增 `p1/relay/src/ws.js`——零依赖 RFC 6455 子集，握手 + 单帧文本/关闭/心跳 + 客户端 mask 校验 + 1 MiB 上限，不做分片与扩展协商。换 `ws` / uWebSockets 时只替换该文件。
- `WS /ws/host`：先 `host/register`（带 `HOST_TOKEN`，不匹配即 1008 关闭），再 `host/heartbeat` / `host/sessions`（索引上报）/ `http/response`；手机 HTTP 请求转 `http/request` 帧，**同一连接帧序即流序**。
- **断连即离线**：WS 关闭立刻置 `state='offline'` 并移出 `state.sockets`，手机请求立即 409，不再等 45s 心跳窗口；HTTP 心跳可把状态拉回 online。`/health` 与 `/admin` 增加 `sockets` 与 `transport`（`ws` / `http-poll`）字段。
- 轮询桥保留为**降级通道**（旧 Host 与单测），新增 `POST /host/sessions` 与 `GET /host/indexes` 供无 WS 场景上报与查询。
- 测试从 9 增至 **16 个**（新增 `test/ws.test.mjs` 7 个）：握手、错误 `HOST_TOKEN` 断开、心跳 ack、索引上报可查、HTTP 经 WS 帧往返闭环、**多帧保序**、断连即离线、降级通道仍可用。`node --test` 16/16 PASS。
- 文档：`p1/relay/README.md` 增加「传输形态」表与下一步；`SIGN-OFF.md` §零 P1 行与 §四补一条边界——**`p1/` 不进 P0 快照**，P1 代码由 CI 的 P1 冒烟测试把关，避免每次开发都让会签快照失效。

**边界未变**：手机侧仍用 HTTP（事件流订阅属后续提交）；CP 未分离；Relay 不解析、不缓存、不落盘正文（ADR-010）。

---

## [发起人豁免 + P1 开工] · 2026-11-10 09:3x · 非协议变更

- 用户指令「跳过会签」。**不伪造签字**：`01` §9 四行仍「待签」、ADR-007~010 仍「提议中」、`SECURITY-REVIEW.md` 会签表仍「待签」、`SIGN-OFF.md` 签署栏未动。新增 `SIGNOFF-WAIVER.md` 把流程例外回写成可审计文档（`05` §4）。
- 豁免范围：仅 W3–W6 内部开发；**GA / 对外发布 / 20 人灰度仍须补签**，`00` GA 门禁、`08` §10 合规检查单、P3 W10 出网流量镜像审计照旧。一票否决权在豁免期依然有效，任一 Owner 提出异议即暂停 P1。
- 显式接受 4 项残留风险（安全一票否决未行使 / 第 5 项未书面接受 / 第 3·4 项待验证 / P1 前置四项未裁定）；四项按 `P1-PREREQUISITES.md` 推荐方案作**默认实现口径**，标注未经会签、可回滚。`09` 新增 **R-20**（红，15 分）。
- 门禁语义：`signoff-check.mjs` verdict 改为 `DEV_PROCEED_WAIVED`（**不是** `SIGNED_OFF`），schema 升 `wbsync-signoff-readiness/3`；`gate-check.mjs` 的 `gate` 仍 `BLOCKED_BY_SIGNOFF`（自动项判定与治理状态分开）。豁免文件纳入 `signoff` 指纹组，改动即 `STALE`。
- **P1 W3 第一项落地**：新增 `p1/relay/`（零依赖、Node ≥ 24.9）——6 位码 / TTL / 限速、challenge + per-challenge `pairSecret`、HMAC 签发设备令牌（只落 SHA-256 摘要、单活跃令牌）、Host 注册 / 心跳 45s 判离线、`HOST_OFFLINE` 409、白名单 403、HTTP 轮询桥 + `NO_PROGRESS` 504、`/admin` 指纹、`sinceSeq` 仅观测。`node --test` **9/9 PASS**。
- **首个缺陷由单测抓出并修复**：`pair/verify` 用值里不存在的 `c.challenge` 算 HMAC → 500；改用 Map 键 `String(body.challenge)`，并在通用 500 分支把真实异常打到 stderr，避免根因被吞。
- 四项默认裁定直接编进代码（#2 / #3 / #4 / #5b），不是悬空文档；WS 帧代理与 CP 分离列为 W3 下一步，写在 `p1/relay/README.md`。`p1/` 不进可安装探针 tarball（根 `package.json` 的 `files` 白名单只含 5 个文件）；`gate.yml` 新增阻断步骤 `P1 Relay 冒烟测试`。
- 状态回填：`SIGN-OFF.md` §零进度表、`09` R-20、`README.md` 目录树、`CHANGELOG.md`；新增 `scripts/apply-waiver-and-p1.mjs`（断言 + 备份）。改 README 后重打包 `dist/*.tgz` 保 G9；改判据 / 会签材料后按门禁 v4 重算快照。

**P0 设计冻结仍未完成**：发起人只豁免了开发期等待，GA 前必须按 `SIGN-OFF-PROCEDURE.md` 补签。

---

## [会签操作卡] · 2026-11-10 09:2x · 非协议变更

- 新增 **`SIGN-OFF-PROCEDURE.md`**：回答「人的会签怎么做」，把 `01` §6/§9、`05` §4、`08` §3、`09` R-16、`SIGN-OFF.md` §五~§七 落成一张可执行操作卡——会前 3 条命令与材料分发、会议顺序（安全 Owner → 架构师 → PM → QA Owner）、每人勾什么与附条件示例、签完 9 步回写清单、常见误区、复核命令。
- **如实标注治理事实**：`00` / `08` 写「架构师兼安全 Owner」、`09` R-16 已登记兼任风险，但 `01` §9 / `SIGN-OFF.md` §五要求四方会签；若同一自然人兼任则实际只有 3 人，一票否决缺独立制衡。操作卡给出 A（另指定独立安全 Owner）/ B（记录兼任、单独签名独立表态）两种处理并要求写进签署栏备注；**未替人改章程、未改签署栏**。
- 强调 `05` §4「结论必须回写 ADR 或协议文档，否则视为未决策」；`SECURITY-REVIEW.md` 第 3/4 项「待验证」不得勾成通过；会签完成 ≠ 可以开工（P1 前置四项裁定 + `wbsync/1 r3` 落地后才进 W3）。
- 链接回填 `SIGN-OFF.md` §五、`README.md` 目录树。改 README 后重打包 `dist/*.tgz` 保 G9；改 `SIGN-OFF.md` 触发 `signoff` 指纹组变化，按门禁 v4 新纪律重算快照再提交。
- **顺带补两处指纹覆盖**：把新操作卡 `SIGN-OFF-PROCEDURE.md` 纳入 `signoff` 组；把 4 个判据脚本（`gate-check.mjs` / `check-env.mjs` / `signoff-check.mjs` / `sync-protocol.mjs`）纳入 `data` 组——此前改门禁判据本身不会让快照失效，等于用旧尺子量新代码。`SIGN-OFF.md` §四表格同步。
- **P0 门禁状态不变**：`BLOCKED_BY_SIGNOFF`；自动项 9/9、快照 `CURRENT`。

---

## [门禁 v4 加固] · 2026-11-10 09:1x · 非协议变更

**性质**：修门禁自身的覆盖缺口，未改任何协议字段、未改会签结论。

- **缺口 1（会签完整性）**：`gate-check.mjs` 的指纹只有 `data / artifact / narrative` 三组，`SECURITY-REVIEW.md`、`SIGN-OFF.md`、`docs/01` 会签表、`P1-PREREQUISITES.md`、`WORKBUDDY-REFERENCE.md` 均不在内。会签前若有人把安全一页纸第 5 项从「须书面接受」改成「已通过」，快照仍 `CURRENT`、CI 仍绿灯。**新增 `signoff` 指纹组，变化判 `STALE`（CI exit 2）**；缺该组的 v3 快照按旧格式判 `STALE`，不静默放行。schema 升 `wbsync-gate-check/4`。
- **缺口 2（密钥扫描假阴性）**：G8 原用 `git grep` 只扫**已跟踪文件**、只认 `ghp_` 一种形态。改为 Node 遍历工作区（含未跟踪文件，跳过 `.git` / `node_modules` / `dist` / 备份与临时 `dsh-home-*`），覆盖 4 类形态：GitHub classic `gh[pousr]_`、细粒度 `github_pat_`、`sk-` 型、私钥头。命中只记路径 / 行号 / 形态，不落匹配内容。
- **顺带修正**：`manual` 里 M6a / M6b 仍写旧的 `run 42366496926` 与 `NOT MET · 2/5`，与 `SIGN-OFF.md` 不一致，改为 `MET · 持续绿灯` / `MET · 5/5 READY`；M6a 不再写死 run 号（每次 CI 都会变）。
- **负向验证（证伪自己）**：① 临时改 `SECURITY-REVIEW.md` 一行 → `--check --assert-fresh` exit **2** 且 reason 指明 `signoff` 组变化；恢复后 exit 0。② 在仓库新建含假令牌的**未跟踪**文件 → G8 FAIL、自动项 8/9、exit **1**；删除后 9/9。③ 另测 `github_pat_` 形态同样被拦。
- 文档同步：`SIGN-OFF.md` §一 G8 行与 §四指纹表（三组→四组、判定说明）、`SECURITY-REVIEW.md` 第 2 项、`README.md` 目录树；新增 `scripts/apply-gate-hardening.mjs`（每处恰好 1 次命中断言 + 备份）。改 README 后重打包 `dist/*.tgz` 保 G9。

**P0 门禁状态不变**：`BLOCKED_BY_SIGNOFF`；自动项仍 9/9，快照 `CURRENT`。

---

## [P1 前置提案] · 2026-11-10 09:0x · 非协议变更

**性质**：把 `spike/REPORT.md` §6 的「仍未解决」整理成可会签的提案；**未修改任何契约字段、未新增 ADR、未启动 P1 编码**。

- 新增 **`P1-PREREQUISITES.md`**：四项提案（#2 `pairSecret`、#3 配对状态权威、#4 端点白名单、#5b `Cursor` 双真源），每项含问题、方案对比、推荐裁定、契约影响清单与裁定人；明确标注「提议中，待会签裁定」。
  - #2 推荐 per-challenge 一次性随机数 + 五条边界，并写明 `pairSecret` 不承担身份鉴别；带外长密钥列 v2 加固候选，PAKE 否决。
  - #3 定 CP 管档案 / Relay 管令牌 / Host 仅缓存，补 `device/paired` / `device/updated` 两帧与失败回滚。
  - #4 分阶段开放 `artifacts/*`（P1）、`attachments/*` + `schedule/*`（P2）；附件写能力须安全 Owner 单独确认；v1 不做的 `config/*` / `permission/*` / `remote-desktop/*` 不开放。
  - #5b 客户端 `sinceSeq` 唯一权威，CP `Cursor` 降为可观测性快照（避免服务端游标领先导致漏事件）。
- **会签效率**：四项并入同一次会议裁定，不增加会议次数；若全部采纳，预计 `wbsync/1 r3`（仅新增可选帧/端点前缀与说明，无删除改名）。
- 状态回填：`SIGN-OFF.md` §零进度表新增「P1 开工前置」行、§二清单由 3 项扩为 4 项并指向白皮书；`SECURITY-REVIEW.md` 新增「会签时还需裁定的两项」；`spike/REPORT.md` §6/§7 的「仍未解决」改为「提案已就绪，待会签裁定」；`README.md` 目录树与门禁段同步。
- 清掉一处过时表述：`04` 头部「标注『示意』处需在 W1 Spike 后回填精确类型」——W1 Spike 早已完成实测回填，改为「上游升级前须重跑全量契约测试」；`PROTOCOL.md` 由单向同步脚本重生成。
- `scripts/signoff-check.mjs` 升级：P1 前置计数 3→4、新增提案白皮书存在性校验，输出区分「工程就绪」与「待裁定」。
- 新增 `scripts/apply-p1-prereq-updates.mjs`（每处恰好 1 次命中断言 + 原文备份）；`docs/04` 同步回桌面原稿，11 份文档仍逐字节一致。

**P0 门禁状态不变**：`BLOCKED_BY_SIGNOFF`；工程侧 100% 完成，剩余只有一次会签。

---

## [r2 后续] · 2026-11-10 08:5x · 非协议变更

**性质**：清口径 + 闭环 M6b + 会签就绪收口，**未改任何协议字段**，`PROTOCOL.md` 无需重生成（仅 README/报告/会签材料变化）。

- **旧口径清理**：`README.md` P0 门禁段仍写「`wbsync/1 r1`、仍待真机加载验证、ADR-007~009」；`spike/REPORT.md` §0/§5/§7 同样停留在 11-07 结论；`01` §9 只提 v1.1；`SECURITY-REVIEW.md` 标题仍是「四行核对」、开头仍写「3 个 ADR」。全部改为 r2 / 4 个 ADR / 真机已 PASS / 唯一剩余是会签。
- **M6b 闭环（5/5 READY）**：隔离工具链装到工作区级 `../.wbsync-tools/`（仓库外、不入库）—— Node **v24.22.2 LTS**（SHA256 与官方 `SHASUMS256.txt` 一致）+ pnpm **11.28.11**；**未覆盖系统 Node、未改全局 PATH**。新增 `scripts/toolchain-env.sh`（source 后仅当前 shell 生效）。
- `scripts/check-env.mjs` 升 `wbsync-env-check/2`：新增隔离工具链实跑探测（不靠目录名猜版本）；**E5 判据修正**——桌面版 DSH 无独立 `dsh` CLI，真机插件经 GUI 插件管理器安装并加载，改为「插件安装通道可用」并以 `probe.json` 的 `errors=[]` + `pluginName` 作通道证据，依据写入 `checks[].basis` 可复核，不放宽到无证据即通过。
- 用 Node 24 实跑整条链全绿：`sync-protocol --check` / `gate-check --check --assert-fresh`（9/9）/ `check-plugin`（PASS）/ `npm pack --dry-run` / `check-env --check`（5/5，exit 0）。
- **P1 开工前置清单**写进 `SIGN-OFF.md` §二：`REPORT.md` §6 的 #2 `pairSecret`、#3 配对状态权威归属、#4 端点白名单覆盖，裁定权属于会签后的 ARC / 安全 Owner，本阶段不代签、不擅自改契约；会签时须写明裁定人与 W3 前截止时点。
- 新增 `scripts/signoff-check.mjs`（会签就绪终检，一条命令输出自动项 / 快照 / M6b / 4 个 ADR 状态 / 待签四方 / P1 前置），接入 `gate.yml` 作「记录、不阻断」步骤。`WORKBUDDY-REFERENCE.md` §6 去掉「可复跑 `--dry-run`」的误导命令（该脚本是一次性修订，已执行）。

**P0 门禁状态不变**：`BLOCKED_BY_SIGNOFF`；剩余只剩**一次会签**（四方 + ADR-007~010）。

---

## [wbsync/1 r2] · 2026-11-10 · WorkBuddy 手机/电脑端对标复核

**性质**：会签前的口径修订。状态枚举扩充两个值 + 新增正文可见性边界澄清 + 修正三处事实/口径错误；**无删除、无改名**，兼容 `wbsync/1` 现有客户端，不升主版本。
**依据**：官方文档「多端协同（连接电脑）」与英文 "Keep Tasks Moving Across Devices"（2026-11-10 取证）、本机 `app.asar` 实现线索、新增 `WORKBUDDY-REFERENCE.md`；新增 ADR-010（提议中，待 ARC + 安全 Owner 会签）。

### 契约（`docs/04` / `PROTOCOL.md`）

- `SessionIndex.state` 四态 → **六态**：新增 `stopped` / `failed`，并给出 `turn/end.reason` 单向映射与「同一会话只上报一种状态」互斥约束。补齐 `session/cancel` 早已有、但索引状态未定义的缺口；对齐官方「已停止 / 失败」两态。
- **新增 §5.4 正文可见性边界**：`session/event` 帧的 `ev.data` 即正文，TLS 在 Relay 终止 → Relay 进程可见明文。统一「会话正文不上云」为「零落盘、零进入 CP」，出网审计目标收敛为「0 字节工作区文件 + 0 条正文写入持久化层」。端到端加密列 `wbsync/2` 候选，v1 不做。
- 修正 §9「新增事件类型一律带 `ignorable: true`」——与 §3 实测（宿主不下发、客户端不得依赖）冲突，改为白名单默认跳过。

### 文档（冻结包 11 份 + 会签材料）

- `00` 对标体验去掉「一次配对永久有效」被误当成官方流程的写法；`01` §1 删除未经证实的「云端沙箱」表述，BR-1 证据明确指向 DSH 手机端实测。
- `02` FR-3.3 / NFR-4 / FR-4.8 修订，新增 **BR-7 对标偏差显式登记**（系统通知、远程配置、权限模式切换、远程桌面读屏/点按 v1 不做）。
- `03` 新增 **ADR-010**、§2 信任边界措辞校正；`08` §2/§6/§10 隐私口径与可证伪审计目标；`09` 新增 **R-19**（口径误读风险）；`07` 补 TC-4.11 / TC-7.9、改 TC-7.6；`10` §6 新增 Relay 主机加固清单、§10 用户须知第 7 条；`05` 状态点四态→六态。
- `SECURITY-REVIEW.md` 第 1 行不再写「✅ 已验证不可见」，新增第 5 项「Relay 运维可见明文」并要求会签时书面接受；`SIGN-OFF.md` 新增 **M7** 与依据索引行；`gate-check.mjs` G7 从 3 个 ADR 扩到 4 个。
- 新增 `scripts/apply-workbuddy-revisions.mjs`（带「每处恰好 1 次命中」断言 + 原文备份 + `--dry-run`），仓库 `docs/` 与桌面原稿同步修订，两份仍逐字节一致。

**P0 门禁状态不变**：`BLOCKED_BY_SIGNOFF`；会签项由 3 个 ADR 增至 4 个，仍属同一次会签，未新增实现工作。

---

## [真机验证] · 2026-11-07 18:10 · 非协议变更

- **Git 仓库直装成功**（方式 B，lock pinned `551778e`），**未触发 pnpm `allowBuilds` 授权**——本包无 install/postinstall 脚本，说明 06 §4 / 10 §4 的担心只针对带构建脚本的 git 依赖。
- `~/.dsh/wbsync-spike/probe.json`（648 B，`errors: []`）+ `127.0.0.1:50973/__wbsync/spike` **HTTP 200**，确认插件进入 Loader 树、`sessionPersistence` / `webServer` 注入成功、具名路由可用。DSH 进程内 Node **24.21.0**（命令行仍 22.22.2）。详见 `spike/REPORT.md` §4.1、根 README。
- 修 `index.js` 注释：`probe.json` 是 `apply()` 启动快照，实时 `eventShapes` 走状态路由（**功能未变，无需重装**）。
- 补桌面版**动态端口**查法与端口辨析（3082→502 / 9230→404 / **50973→200**），替换原先写死 3080 的示例。
- 18:23 复测：用户报告已发消息，但路由与 `probe.json` 的 `eventShapes` 均为 0；会话日志 18:05 后 0 变动、`session_projcache` 最新 16:16、DSH 仅 1 个主进程 → 判定「PC 进程内无会话事件产生」，**不是订阅失效**。诊断链与自检命令见 `spike/REPORT.md` §4.1.1。
- **18:34 端到端闭环 PASS**：用户确认前一次在**手机端**发（BR-1），改在 PC 桌面版发言后，落盘日志 9 帧 / 23 事件（`seq` 0→22）、订阅窗口 19 条（`seq` 4→22）**逐条一致**；8/8 运行时断言 PASS，D-03 首参与 D-07 `surfaceOp` 均升级为运行时取证。`probe.json` 仍 0 条而路由 19 条，实证「快照 vs 实时」。**W1 Spike 三问判 PASS**，P0 仅剩四方会签；卸载残留转 M1 / TC-4.10（详见 `spike/REPORT.md` §4.1.2）。
- **18:41 卸载残留 TC-4.10 真机 PASS**：卸载后 `50973/__wbsync/spike` → **404**，profile 三处配置命中 0，operations 日志 `remove/settled`；DSH 主进程 **未重启**（PID 2196 / 14:14 启动），证明是 `ctx.effect` disposer 运行时撤回路由，而非重启后未加载。顺带解开端口之谜：3082 是 `dsh-engine-switch` 反向代理（转发 3080 未启动故 502），9230 为另一内部服务，50973 才是 `ctx.webServer`。**P1 待办**：`~/.dsh/wbsync-spike/probe.json` 未随卸载清理，产品插件需定义保留 / 清理策略。至此 P0 只剩四方会签 + ADR 会签（详见 `spike/REPORT.md` §4.1.3）。
- **18:52 证据时效性修正**：用户指出 DSH 重启过，核实为 **18:49:52** 重启（新 PID 26668，端口 **50973 → 55056**）。18:41 的 404 观测早于重启、仍是「同进程 disposer 撤回」的强证据；重启后新端口的 404 属弱证据，不得复用该结论。时间线与查端口方法已写入新增的 `SIGN-OFF.md` §四、`REPORT.md` §4.1.3。
- 新增 `SIGN-OFF.md`（P0 会签包：自动项 8/8、待签项 M1~M6、依据索引、签署栏）与 `scripts/gate-check.mjs`（门禁自动核查，`--check` 供 CI，输出 `spike/evidence/gate-check.json`）。**P0 只剩会签**：门禁状态 `BLOCKED_BY_SIGNOFF`。
- **快照语义与 CI 闸门（19:0x）**：`gate-check.mjs` 新增 `freshness`（按证据输入 sha256 判定 `CURRENT`/`STALE`，30 天兜底）与 `--assert-fresh`；`--check` 改为只校验不写盘，避免 CI 脏 diff。新增 `.github/workflows/gate.yml`（Node 24：`sync-protocol --check` → `gate-check --check --assert-fresh` → `check-plugin` → `npm pack --dry-run`）。决策：**CI 每次重算 = 准入闸门；入库快照 = 会签时点审计**，规则写入 `SIGN-OFF.md`。
- **CI 首次绿灯（19:02）**：`gate.yml` 注册为 `active`，commit `bcefdf5` 的 run `42366496926` **conclusion=success**（11:02:54 → 11:02:59，5 秒）。M6 随之拆分为 **M6a**（CI 接入 · MET）/ **M6b**（本地构建链 Node ≥24.9 + pnpm 11 · 仍 NOT MET）。
- **指纹分两组（19:0x）**：`fingerprints` 拆成 **`data`**（`host-probe.json` / `check-plugin.json` / `dist-tarball`）与 **`narrative`**（`REPORT.md` / `PROTOCOL.md`）；快照 schema 升 `wbsync-gate-check/2`，新鲜度三档：`CURRENT` / **`DRIFTED`（仅描述漂移，放行 + NOTE）** / `STALE`（数据变 / 旧格式 / 超期 → `--assert-fresh` exit 2）。实测：只给 `REPORT.md` 加一个空行 → `DRIFTED` 且 exit 0；恢复后回到 `CURRENT`。规则写入 `SIGN-OFF.md`。
- **发布物从「事实」降为「记录」（19:1x）**：实测 `npm pack` **不可复现**（同内容两次打包 sha 不同，gzip 头带时间：`6904a9e2…` → `b8549748…`），把 `dist-tarball` 当事实指纹会让每次 repack 误报 `STALE`。改为三组：**data**（`index.js` / `cordis.patch.yml` / `package.json` / `host-probe.json` / `check-plugin.json` → `STALE`）、**artifact**（`dist/*.tgz` → 仅记录 + NOTE）、**narrative**（`REPORT.md` / `PROTOCOL.md` → `DRIFTED`）。快照 schema 升 `wbsync-gate-check/3`。实测：只改 README 后 repack → `DRIFTED`/NOTE 而非 `STALE`；只改 `index.js` → **exit 2**；恢复后 `CURRENT` exit 0。已知缺口：「发布物与源码一致」暂无自动校验，记为 P1 待办（**已于 19:5x 由 G9 补上，见下条**）。
- **G9 解包比对（19:5x）**：新增 `scripts/lib/tar.mjs`（零依赖 tar / tar.gz 解析）；`gate-check` 增加 **G9** —— 不比 tgz 本身（不可复现），而是**解包后逐文件比 sha256**，`index.js` / `cordis.patch.yml` / `package.json` / `README.md` / `LICENSE` **5/5 一致**才 PASS。实测：改 `index.js` 但不 repack → **G9 FAIL、自动项 8/9、exit 1**；恢复后 9/9、快照 `CURRENT`。自动项从 8 增至 9。决策：**保留 `dist/*.tgz` 在仓库（继续走 GitHub 分发），用 G9 保证它不与源码脱节**。
- **2026-11-10 剩余工作盘点 + M6b 量化**：新增 `scripts/check-env.mjs`（只读环境自检，不改 PATH、不装东西；`--check` 供 P1 开工前自检），输出 `spike/evidence/env-check.json`。本机 **2/5 · NOT_READY**（E1 Node 22.22.2、E2 pnpm 未装、E5 dsh CLI 不在 PATH；E3 Corepack/E4 NODE_OPTIONS 通过）。明确区分「命令行构建链」与「DSH 宿主运行时 Node 24.21.0（11-07 历史证据）」。
- 修了两个探测坑：Windows 上 `.cmd` shim 需 `cmd.exe`（沙箱禁用）→ 回落用 PATH 文件存在性判定，避免把已装的 Corepack 误报成 `NOT_INSTALLED`；`execFileSync` 不自动补 Windows 后缀。`SIGN-OFF.md` 新增「零、剩余工作盘点」：P0 自动项 9/9 完成，只剩 1 次会签 + 1 项环境；P1–P3 共 10 周未启动且按规程不得提前启动。CI 增加「环境自检（记录，不阻断）」步骤。
- **安全 Owner 会签一页纸（11-10 08:2x，专家裁定）**：会签审阅顺序定为**先审 `08` 隐私红线、再审 ADR-008 幂等/写入权** —— 前者答错了数据离开本机收不回，后者错了改代码可回滚；一票否决权是用来挡不可逆后果的。新增 `SECURITY-REVIEW.md`（4 行核对，第 3 项「令牌不明文落盘」标 **P1 待落地**、第 4 项「出网流量镜像审计」标 **P3 W10 待验证**，不把待办写成通过）；`SIGN-OFF.md` 新增 §六「会签审阅顺序」、原 §六顺延为 §七，M5 改为「只看一页纸」。

---

## [wbsync/1 r1] · 2026-11-07 · 设计冻结包 v1.1

**性质**：按 W1 Spike 宿主实测做的澄清与新增可选字段，**无删除、无改名**，兼容 `wbsync/1` 现有客户端，不升主版本。
**依据**：`spike/REPORT.md` D-01~D-07；`docs/03` ADR-007~009（状态均为「提议中，待会签」）。
**宿主基线**：`66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`（`dsh-v0.2.2-rc.1`），见 `pinned-commit.txt`。

### 契约（`docs/04` / `PROTOCOL.md`）

- **新增可选字段** `SessionEvent.surfaceOp?: string`、`sourceEventSeqs?: number[]`；`ignorable?` 保留但标注「实测宿主不下发，客户端不得依赖」。
- **改写 §3 事件分类表**：删除 `assistant/chunk` 折叠规则（实测不落盘）；`tool/call`↔`tool/result` 改按 `sourceEventSeqs` 配对；新增「其它（默认跳过）」类别覆盖实测 20+ 种未列事件。
- **新增「宿主实测补充」段**：三种事件形状计数（504 / 90 / 73）、`surfaceOp` 恒为 `append`（163 条）、日志为多帧 zstd、`session/event` 首参是 session 对象。
- **§1 幂等**：`clientMsgId` 明确映射宿主 `prompt(request).requestId`；**§2 Idempotency 表**降级为 CP 侧跨 Host 路由审计，Host 侧去重归宿主。
- **§2 SessionHeader**：`parentSession` / `origin` 标为可选，要求缺失兜底。

### 需求与架构

- `docs/02`：FR-4.2 / 4.3 / 4.5、BR-4 按实测改写；§6 新增「降级验收（09 R-02 方案 B）」；§7 前置改为三问口径。
- `docs/03`：§4.2 消息时序改为宿主原生幂等 + writer-held 冲突；新增 ADR-007（事件契约）、ADR-008（幂等与写入权归宿主）、ADR-009（PROTOCOL.md 唯一性）。
- `docs/01`：A1 补「宿主 prompt 提交入口」，与 05 W1 / 09 R-02 的三问口径统一；§9 附 Spike 结论。
- `docs/00`：术语表补 `surfaceOp` / `sourceEventSeqs` / `requestId` / 多帧 zstd；commit 锁定条目标为已锁定。

### 工程与测试

- `docs/06`：修最小骨架 `ctx.on('session/event', (session, ev) => ...)` 首参（原写成 `sessionId` 字符串，会直接导致 P1 出错）；Node 口径统一为「构建链/Host ≥24.9、Relay 运行时 ≥22」；§9 补 PROTOCOL.md 单向同步规则。
- `docs/07`：TC-1.2 / TC-1.3 按实测改写；新增 TC-1.9（多帧 zstd）、TC-1.10（首参类型）。
- `docs/08`：供应链补「宿主源码片段不得随公开仓库发布」。
- `docs/09`：R-02 记录离线取证三问全 PASS，风险暂记「待真机复核」，不关闭（此为 r1 时点状态，已于 18:34 由「真机验证」条目更新）。
- `docs/10`：Node 版本口径与 06 统一。

### 工程产物

- 新增 `scripts/apply-spike-revisions.mjs`（v1.0→v1.1 文档修订，带唯一性断言与原文备份）。
- 新增 `scripts/sync-protocol.mjs`（ADR-009 单向同步 + `--check` CI 校验）。
- 新增 `PROTOCOL.md`、`docs/`（11 份 v1.1 文档）、`CHANGELOG.md`。

### 仍待完成（P0 门禁）

- 真机在 DSH 里安装 `dsh-wb-cloud-sync-spike` 并取 `probe.json`（`dsh` CLI 不在 PATH，本机 SKIP）。
- ADR-007~009 会签、四方文档会签（01 §9）。
- 环境补齐 Node ≥24.9 + pnpm 11；CI 接入 `sync-protocol.mjs --check`。

---

## [0.1.0] · 2026-11-07 · 首版

- 可安装探针 bundle（`dsh.bundle`）、W1 Spike 三问取证脚本、隔离 `DSH_HOME` 加载验证、脱敏证据。
