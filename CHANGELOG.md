# CHANGELOG

协议字段变更必须同时更新 `docs/04` → `PROTOCOL.md` → 本文件（06 §9 / ADR-009）。

---

## [P1 W6 · 修] · 2026-11-11 22:4x · 配对回给手机的地址不再是 127.0.0.1

真机取证：手机上打开 `127.0.0.1:8787` 得到 `ERR_CONNECTION_REFUSED` —— **手机上的 127.0.0.1 是手机自己**。而 `/pair/verify` 在没配 `publicBaseUrl` 时回的就是 `http://127.0.0.1`，谁信这个字段谁就踩坑（PWA 目前不读它，但协议里它是公开字段，接入方会读）。

- 改为回**这次请求所用的地址**：优先 `publicBaseUrl`，否则按 Host 头拼（反代后取 `X-Forwarded-Proto`）。Host 头由调用方自己设置、也只回给他本人，不构成反射面。
- 测试 +2（回显同一地址 / 显式配置优先）。

---

## [P1 W6 · 内测] · 2026-11-11 22:3x · 内测手册 + 环境自检

W6 的判据是「M1 六项全过」，但内测最容易发生的浪费是**带着坏环境开始记 bug**——手机连不上、relay 没起、新版没刷到，这三件事都会伪装成功能缺陷。

- 新增 **`BETA-CHECKLIST.md`**：把 M1 六项拆成「前置 / 步骤 / 期望 / 失败记什么」，外加本轮新增要验的五项（两台并存、逐台收回、重配轮换、重启不掉配对、阅读位置），以及一节**已知边界**（插件内部流量折叠、首屏按字节裁、产物只给路径……）——先分清「设计如此」与「坏了」，再决定记不记缺陷。
- 新增 **`scripts/beta-check.mjs`**：一条命令查 8 项（relay 可达、宿主在线、设备与手机清单、会话索引、CP 落盘、壳页面版本、静态资源、手机侧网络）。判定只有 PASS / FAIL / **SKIP**：**看不出证据的一律 SKIP，不许当 PASS**——这是这份工具唯一不能含糊的地方。
- 根 `package.json` 补三条命令：`npm test`（四包 282 条一条命令跑完）、`npm run beta-check`、`npm run gate`。
- 自检脚本本身也有测试（6 条）：缺凭据必须 SKIP、缺落盘文件必须 FAIL、文件写坏不许抛异常、relay 连不上要安静地 FAIL。
- 测试 282 → **288**。

---

## [P2 前置 · CP] · 2026-11-11 23:0x · CP 落盘：重启不再掉配对

多手机上线后，「重启即失忆」的代价从「麻烦一次」变成「每次动服务都得把所有手机重配一遍」。原来设备表、会话索引、令牌摘要全在进程内存里，`kill` 一下全没。

- 新增 `p1/cp/src/persist.js`：JSON 文件落盘，**临时文件 + rename** 的原子替换，写入去抖 250 ms；`SIGINT/SIGTERM` 先 `flush()` 再停，`kill -9` 最多丢最后一个窗口，不会留下半份 JSON。
- **只存事实**：设备表（含令牌 SHA-256 摘要）+ 会话索引。**租约与消费位点刻意不存**——租约 30s 本就该过期，位点由客户端 `sinceSeq` 唯一权威（#5b）；把它们写进磁盘只会制造「服务端记录比手机更权威」的错觉。
- 加载时三条判断写死：① **一律按离线起身**（重启那一刻谁也没连上，不能让上次心跳的时间戳冒充在线）；② 墓碑超 30 天的设备丢弃；③ 归属设备已不存在的会话与手机一起丢，不留幽灵行。
- 坏文件不让进程起不来：改名成 `cp.json.corrupt-<ts>` 留证，然后从空库启动。
- 默认位置 `~/.wbsync/cp.json`（`WBSYNC_CP_FILE` 可改，`:memory:` 关闭）；放用户目录而不是仓库，既躲开密钥扫描，也不会被 `git status` 带出去。POSIX 下按 `0600` 创建。
- 启动日志会打印「已恢复 N 台设备 / M 个会话」与「加载时清理」计数——重启后发生了什么，一眼看得见。
- 测试 273 → **282**（新增 `persist.test.mjs` 9 条：重启掉不掉配对、离线起身、墓碑 30 天、幽灵行、坏文件、原子写、不存租约位点、只存摘要、去抖与 flush）。
- 边界：**单实例**。同一份文件被两个 relay 同时写会互相覆盖——P2 的 Postgres 才是多实例答案。

---

## [P1 W6/W7 前置 · 协议 r9] · 2026-11-11 22:0x · 一台电脑配多台手机

第二台手机一配对，第一台就 401 —— 根因不在客户端，在**身份模型**：r8 之前令牌直接写在这台 Host 的 `tokenDigest` 上，一台电脑只有一枚活跃令牌，「单活跃令牌」同时也是「一台电脑只能一部手机」。

**手机独立成设备行**（`role='phone'` + `boundHostId`）：

- `POST /pair/verify` 请求加可选 `phoneId`（本机稳定身份）/ `clientName`（仅展示），响应加 `deviceId`（本机 phoneId）与 `hostDeviceId`（URL 里用的目标 Host）。**URL 里的 `deviceId` 仍然是目标 Host**，令牌却属于某台手机——服务端按「这台 Host 名下有没有这枚令牌」鉴权，数据面一个字节没动。
- 同一台手机重配（`phoneId` 不变）只轮换**它自己**那枚令牌；不同手机各持一枚、互不作废。`单活跃令牌` 这条规则没废，只是**逐设备**成立。
- 上限 `maxPhonesPerHost`（默认 8）→ 超限 `CLIENT_LIMIT` 409。上限的意义不是容量而是收敛：清单要能一眼看完。
- 管理台列出每台电脑名下的手机，`POST /admin/revoke-client` 单独收回一台并**断开它的长连**（只挡新请求等于没收干净）；吊销电脑则连坐名下全部手机。
- 顺带修一处越权：`Cursor.clientId` 改用**鉴权结果**里的手机身份，不再采信请求体自报的 `clientId`（原来谁都能改写别人的消费位点）。
- 兼容：旧手机令牌（落在 Host 行上）继续可用，升级不会让在用的手机掉线。
- 管理台里手机要能认得出来：PWA 配对时自报 `clientName`（按 UA 取 iPad / iPhone / Android 手机），**只做展示，不参与任何判定**。

测试 263 → **273**（CP 5 条手机模型 + 多手机端到端 5 条：并存/越界/上限/逐台收回含长连/重配轮换；`T5`、`T8`、`P8` 按新语义重写）。

---

## [P1 W6 前置 · PWA] · 2026-11-11 21:5x · 记住上次会话与阅读位置

真机上的实际读法是「点开会话 → 滑到底 → 返回 → 再点开」，每一步都在重新找位置。

- **回到上次会话**：刷新 / 重开 PWA 后自动打开上次那个会话（`wbsync.lastSession`），只做一次，且它必须还在索引里——被删了就老实停在列表。
- **按「距底距离」记忆位置**（`wbsync.gap.<sid>`）：重进会话时内容长度会变（字节窗口），绝对 `scrollTop` 没有意义；距底多少像素才是稳定的。切走前先存（DOM 一清就只剩 0），首屏画完再恢复。
- **贴底跟随**：只有本来就看着底部的人才跟着新事件滚；往上翻时不把人拽回来。补读（`replay`）不动滚动条。
- **「← 列表」返回条**：回到列表并把当前会话那一行居中，选中状态保留。
- 顺带：切走前 `saveScroll` 与 `pagehide` / 切后台都记一次，读到一半切走再回来不会跳到底。
- 静态断言 +8。SW 升 `wbsync-shell-v21`（`pairing.js` 变了，得刷两次）。

---

## [P1 W4 / PWA] · 2026-11-11 21:0x · 修重绘抹掉事件来源 + 空开关常显

上一版把 `plugin:*` 藏起来后，点一下开关（或点「加载更早」）就暴露了两个小毛病：

- **`· 补齐` 变成谎言**：`rerender()` 一律以 `source: 'replay'` 重绘，于是切换一次开关，**全部行**都被标成「· 补齐」，连实时收到的事件也这么说。来源是事件的属性，不是这次绘制的属性。新增 `evOrigin`（`seq → 'live' | 'replay'`），收到事件时记账、重绘时按 seq 取回；翻上来的补读事件标 `replay` 且不覆盖已有来源。切换会话 / 忘掉设备时一并清空。
- **空开关常显**：「显示插件事件」在没有插件事件的会话里也挂着，比隐藏更吵。改为 `!showNoise && noiseHidden === 0` 时 `hidden`——**只有真藏了东西才出现这个入口**。
- 静态断言补 3 条（来源回取、来源记账时机、空开关隐藏）。壳页面走网络优先，**手机刷新一次即生效**（SW 仍是 v20，`src/*` 未变）。

---

## [P1 W4 / PWA] · 2026-11-11 20:5x · 插件内部流量默认隐藏 + 原始事件折叠

真机截图：打开会话满屏是 `plugin:translator/request` / `plugin:translator/result` 的原始 JSON——转录做了，但这类事件不属于「对话」四类，全落进了 raw，每块还带几百字符 JSON。

- 新增 `isPluginEvent()` / `shortType()`：`plugin:*` 是**插件内部往返**（翻译请求/结果），不是对话。判定只看命名空间前缀，不猜插件语义。
- **默认隐藏，但不丢弃**：事件照旧进 `evBuf`，右上角一个开关「显示插件事件（已隐藏 N 条）」，一点就整屏重绘出来。隐藏只影响显示。
- **raw 事件改成 `<details>` 折叠**：默认只露一行 `#seq translator/request · 补齐`，想看图 JSON 再点开。折叠行合并同类型连续事件（`#914–#918 … ×5`）。
- 这样首屏回到「助手气泡 + 工具行 + 折叠的杂项」，插件往返不再抢注意力。
- 测试 262 → **263**（T9 前缀判定；静态断言补 5 条）。SW 升 `wbsync-shell-v20`。纯 PWA，刷新即可。

---

## [P1 W4 / PWA] · 2026-11-11 20:3x · 首屏只看「最近一页」+ 反向补读（协议 r8）

原方案是「最近 50 条」。写完后发现条数不是个好尺子，**改成按字节定窗口**：

- 50 条 × 40 KB 的工具结果 = **2 MB**；50 条 × 200 B 的碎片 = **10 KB**。同一个数字在两种会话里完全不是一回事。
- 现在由 **Host 按 48 KiB 字节预算**裁出「最近一页」：客户端先问一次 `openWindow`（内部走 `session/backfill`，`beforeSeq = lastSeq + 1`），拿到 `toSeq` 后再 `follow(sinceSeq: toSeq)` 接实时流。首屏仍是**一个请求 + 一个窗口**。
- **窗口预算 96 KiB（2× 页预算）**：开屏只发生一次，多给内容比多跑往返值；翻页仍是 48 KiB。客户端在请求里带 `bytes`，Host 夹在 `[4 KiB, 4× 页预算]`——要 8 MiB 也只给 192 KiB。
- **条数下限 8**：若最新几条都是巨型事件，纯按预算只剩 1~2 条，一屏都不满。不足 8 条时允许超预算，但**不超过 4× 预算**（防 8 条 × 1 MiB 把帧撑爆）。上限 200 条只是保险，真正起作用的是字节。
- 新增 `POST /d/<id>/session/backfill`（`{sessionId, beforeSeq, limit}` → `{events, fromSeq, toSeq, hasMoreEarlier, bytes}`）。**预算从后往前砍**：超预算丢更早的，绝不留掉紧邻窗口的最新几条。
- 「加载更早」按钮：`windowStart > 0` 才出现，补到 0 收起；补读后按 `seq` **整屏重绘**（往 DOM 前面插容易乱序），事件留在 `evBuf` 供重绘。
- **兼容旧 Host**：旧插件不认 `session/backfill` → 403，客户端退回「`follow` 取一页再筛」，按钮不会变砖（响应带 `via:'follow'`，D3 覆盖）。
- 协议升 **r8**（§5.7），端点落在既有 `session/*` 白名单内，无新帧。SW 升 `wbsync-shell-v18`。
- 测试 251 → **260**（BF1–BF6、P-BF1、D3/D4、5 条静态断言）。其中 BF4 因为条数下限改过预期：现在允许超预算，但必须留住最新那条。

---

## [P1 W4 / PWA] · 2026-11-11 20:0x · 修「打开老会话白屏」+ 列表标题/徽章

真机截图暴露三个问题，其中一个是功能性的。

**① 打开老会话一片空白**（`9a4c6770…`，seq 256，界面什么都没有）。根因不在 Host，在**补齐的触发条件**：

- Relay 重启后事件缓冲为空，`subscribe()` 走 else 分支，发 `{ fromSeq:-1, toSeq:-1, complete:true }`；
- 客户端只在 `complete === false`（检测到缺口）时才去 Host 补；
- 于是「Relay 没有 + 客户端不去问」= 白屏。而 Host 日志里明明有 256 条。

`complete:true` 的真实含义是「**从我这儿看，你的位置往后没有缺口**」，不是「这段历史不存在」。修法：客户端在 `complete === true && toSeq === -1 && lastSeq === -1` 时主动去 Host 补一次，并用 `bootstrapped` 标记只补一次（补齐后会重新订阅，不设限会来回循环）。空会话也只补一次就停（D2 钉住）。

**② 列表标题是一串 `session-xxxx`**：索引里 `title` 常为 null。改为「title → 工作区目录名 → 短 id」三级回退，副行给短 id + seq + 时间。

**③ 状态徽章被顶出屏幕**（截图右侧 `stopp…` 被裁）：`.row` 是 flex，内层 div 没有 `min-width:0`，长标题把徽章挤出去。补 `min-width:0` + 徽章 `white-space:nowrap`，并把 `stopped/failed/awaiting/running` 映射成中文＋配色。

- 列表渲染从 `innerHTML` 拼接改成 DOM API + `textContent`——工作区路径来自 Host，不能当 HTML。
- 测试 249 → **251**（D1 缓冲空仍能补出历史 / D2 空会话只补一次）；静态断言补 5 条（含 `min-width:0` 与标题回退）。SW 升 `wbsync-shell-v16`。
- 纯 PWA 改动，手机下拉刷新即可，不需要重启 DSH / Relay。

---

## [P1 W4 / PWA] · 2026-11-11 19:4x · 事件流从「一坨 JSON」变成能读的对话

之前在手机上看会话，看到的是 `<pre>{"type":"assistant/message","data":{...}}</pre>`——技术上没错，但拿它当遥控器读对话是不可能的。

- 新增 `p1/pwa/src/transcript.js`：四个纯函数把事件归类成可读结构（`messageText` / `roleOf` / `classifyEvent` / `toolCallLabel` / `turnEndReason`），形状取自真机 876 条事件取证（`data.message.content[]` 里挑 `type:'text'`）。
- 渲染分四类：用户/助手 → **气泡**（左右区分）；`tool/call` → 一行「⚙ 调用 xxx」；`tool/result` → **折叠**（遮住几百行输出，点开才看）；`turn/end` → 分隔线「本轮完成/已停止」。不认识的事件仍走原来的折叠 JSON，不做猜测式美化。
- **拿不到正文就退回原始 JSON**：只读不推断，宁可难看也不显示空气泡。这条有专门用例（T7）。
- 正文一律 `textContent` 渲染（事件内容来自工作区文件，绝不当 HTML 执行）。
- SW 缓存清单加 `transcript.js` 并升 `wbsync-shell-v15`；静态自洽检查（S6）会拦住「页面引用了但没进缓存清单」。
- 测试 241 → **249 全绿**（转录纯函数 T1–T8 + 静态断言 5 条）。**PWA-only 改动，手机刷新一次即生效，不需要重启 DSH 或 Relay。**

---

## [P1 W4 / 真机] · 2026-11-11 18:2x · 沿上游追同一类缺陷：帧上限、事件缓冲、关闭通知

上一轮修的是「帧太大把连接压断」。这次顺着同一条线往上游查了一遍——**同一类问题还有三处**，其中两处会以完全不同的症状出现。

**先量再说**：解码真机会话日志（479 个 zstd 帧、876 条事件），单条最大 **421 KiB**、p99 **97 KiB**、p50 0.2 KiB，**21 条超过 64 KiB**。所以协议里写的「帧 ≤64KiB」是设计愿望，不是事实——旧代码写死 1 MiB 天花板，长回复再大一点就会 1009 断连。

- **WS 单帧上限改为可配**（`maxFrameBytes`，默认 **8 MiB**，下限夹在 1 KiB）。旧值 1 MiB 是零依赖解析器的内存边界，不该由协议常量定死。真机验证：新 Relay 上发 2 MiB 帧保持 OPEN，无 close 码（旧版必 1009）。
- **Host 侧加 1 MiB 软上限，超过则「降级」而不是丢弃**：保留 `seq` / `type` / `time`，`data` 换成 `{truncated:true, reason:'EVENT_TOO_LARGE', bytes, head}`。**为什么不能丢**：丢一条会让 `seq` 出现空洞 → 客户端判缺口 → 触发补齐 → 补齐又被同一条撑爆，死循环。降级保留 `seq`，游标照常走，手机上显示「正文 N KiB 未转发，完整内容在电脑上」。
- **事件缓冲加 32 MiB 字节预算**（`eventBufferBytes`），按条数与字节双重裁剪，只裁已广播的旧条目、未广播的连续前缀一条不动。只按 1000 条裁的话，最坏 1000×421 KiB ≈ 400 MB，长会话足以把 Relay 撑爆。
- **补掉一个更隐蔽的缺陷：服务端主动关连接不发 `onClose`**。`conn.close()` 先把 `open` 置 false，随后 socket 的 `close` 事件里 `if (!open) return` 直接返回 → 设备一直留在 CP 的「在线」窗口（45s），手机请求被投进降级队列干等 10s 才 504。超限 1009、吊销、停机全踩这条路径。现在 `onClose` 只通知一次、且主动关也通知。
- PWA 侧识别降级事件并说明「正文未转发」；SW 升 `wbsync-shell-v14`。协议升 **r7**（§5.3 传输上限与降级，修订「≤64KiB」过时表述）。
- 测试 232 → **241 全绿**：hub 字节预算 H1–H4（含「宁超预算也不制造缺口」与「字节账不漂移」）、WS 上限 L1–L3、事件降级 P-EV1/P-EV2（正常事件必须原样透传）。
- **部署与代价**：Relay 已重启加载新上限；插件新 bundle 已部署（`index.js` 69734 B）。**重启 Relay 会清空内存 CP 的配对态**，手机需要重新配对——这是这轮唯一让用户承担的成本，配对码见交付说明。

---

## [P1 W4 / 真机] · 2026-11-11 16:5x · DSH 重启验收，压出补齐帧撑爆 WS 的缺陷

用户重启 DSH 后做真机验证，先确认 r5/r6 已生效，再顺手把补齐链路压了一遍——结果压出一个只有真机尺度才暴露的问题。

**版本生效的证据链**（不只比字符串，逐层证伪）：
- 部署的 `index.js` 与仓库 bundle **sha256 完全一致**；DSH 进程启动 16:47:14 晚于文件落盘 16:36:20，即重启后加载的确实是新 bundle。
- 插件本地 `/__wbsync/status`（web 端口 55088）：`connected:true`、`reconnects:0`、`indexCount:18`、`indexStats.mode:'diff'`；`/admin` 显示 `transport:'ws'`。
- 真 Relay 内直接打 `/d/<id>/session/artifacts`：**200**，扫了 875 / 667 条事件、返回元数据行（这是 DSH 进程内的真插件在应答，不是 mock）。
- 用**已部署的那份** bundle 在独立 Relay 上跑通 r5 + r6：产物 `季度报告.pdf` 正常返回、审批瀑布经 `$events/result` 收敛为 `allowed-once` 且 `next()` 零调用。

**压出的真缺陷：`session/follow` 大正文会话 504**。真机量化：`sinceSeq=800` 的 74 条事件 = **454 KiB**（平均 6.1 KiB/条，正文里带整段文件内容），按旧版固定 500 条/页推算约 **3 MiB** > Relay WS `MAX_PAYLOAD`(1 MiB) → 服务端 1009 `frame too large` 断连 → 在途请求熬到 10s 回 `NO_PROGRESS`，插件 `reconnects` 从 0 涨到 2。协议 §5.3 更要求 ≤64 KiB，差了 47 倍。

- **修法**：`replay.js` 改用 **≤48 KiB/页字节预算**裁页（UTF-8 实算，中文不低估），`hasMore` 指路下一页；至少给一条防 `sinceSeq` 死循环；单条 >768 KiB 回明确 `FRAME_TOO_LARGE` 413 而不是静默断连；新增 `bytes` / `oversized` 可观测字段。
- **连带修**：客户端补齐翻页上限 8 → 200（48 KiB/页下 874 条会话需要上百页），并加「`hasMore` 但游标不推进立刻停」兜底，防 200 次空转打 Relay。SW 升 `wbsync-shell-v13`。
- **回归**：部署产物上复刻 100 条 ×6 KiB 大正文 → **13 页收完 100 条、单页最大 47.3 KiB、WS 全程在线**。（第一次跑出「1 页 100 条」的假通过，是因为忘了先部署新 bundle 就跑 smoke，抓到后按部署顺序重跑才得到真结果。）
- **产物 `rows:[]` 也证伪过**：抽查真机 874 条会话，`deliverables/presented` 确实 0 条，`workspace/changes` 只有 `{turn:5}` 不带文件列表；事件字段 `{type,seq,time,data,...}` 与解析器一致。所以空列表是**真结果**不是解析假阴性。暂不从工具调用里猜路径，理由写进 `04` §5.6。
- 测试 224 → **232 全绿**（replay B1–B6 字节预算 / 翻页 / 硬上限；PWA C1–C2 多页补齐与无进展保护）。
- **部署状态**：新 bundle 已覆盖到已装插件目录（备份 `index.js.bak-*`）。**修复要再重启一次 DSH 才生效**——插件代码在进程内存里，不会热替换。

---

## [P2 W8] · 2026-11-11 16:4x · 产物卡片 / 列表（协议 r6，只过元数据）

继续从 asar 取证：产物在宿主里叫 `deliverables`，会话日志里有显式交付事件

```jsonc
{ "type": "deliverables/presented", "seq": 3, "data": {
  "turn": 1, "callId": "call-1", "files": [{ "path": "out/a.pdf", "description": "成品" }]
}}
```

- **为什么不让手机从事件流里攒卡片**：Relay 事件缓冲在内存里（capacity 1000），长会话会把早期交付事件裁掉；手机晚连、Relay 重启、缓冲被裁时卡片就空了。会话日志是 append-only 真源。所以新增 `POST /d/<id>/session/artifacts`（落在**既有** `session/*` 白名单内，无新帧、无新字段），Host 用 `sessionPersistence.open(id,'read')` 只读分页扫日志，返回 `{seq, turn, callId, index, path, name, description}`。和 `session/follow` 是同一条补齐逻辑。
- **扫描有界**：页数上限 20、行数上限 200、达到上限如实报 `truncated:true`；`seq` 不是连续整数时停止翻页，不靠猜 offset 继续读；句柄 `finally` 必还。畸形事件（缺 turn/callId/files、路径空白、描述非字符串）一律跳过，**不猜路径、不编文件名**。
- **边界没松**：只过元数据，**文件字节一个都不进 Relay / CP**（ADR-010 / 04 §5.4）。卡片能做的只有「看到有什么」和「复制路径」；打开/导出归桌面端。导出 PDF/DOCX/MD 与临时下载票**明确未做**，要做必须先立 ADR 处理「工作区文件是否允许经过 Relay」——不能顺手把 `rows[]` 变成文件传输通道。TC-6.2/6.4 已如实标注未做。
- PWA 侧：新增 `#artifacts` 卡片区（`#artifacts[hidden]` 同样提权，和 `[hidden]` 那个坑同源）、`client.getArtifacts()`；进会话拉一次、遇到 `deliverables/presented` 事件 300ms 合并刷新、切走会话后旧响应不盖上来、路径用 `textContent` 渲染不注入 HTML。SW 升 `wbsync-shell-v12`。
- 打包器收录 `artifacts.js`；bundle 重建并 `--check` 通过。协议升 **r6**（`docs/04` §5.6 + 变更表，`PROTOCOL.md` 同步再生）。
- 测试 213 → **224 全绿**（AF1–AF9 纯解析与分页、P-AF1–2 插件分派含「会话不可读回 404，不谎报空表」、S6 静态断言扩到产物区）。

---

## [P2 W8] · 2026-11-10 23:2x · 审批转发（协议 r5）：手机上真的能批工具调用了

先取证再动手。`app.asar` 里挖到宿主的审批契约（不是猜的）：

```ts
type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
interface ApprovalRequest { agent; toolName: string; callId?; reason?; displayReason?; signal? }
ctx.on('approval/request', (request, next) => Promise<ApprovalOutcome>)   // 瀑布
```

`next` 是「交棒给下一个应答方」。这条决定了整个设计：**手机不在线时必须 `next()`**，否则一次断网就让桌面端的工具调用卡死——手机是遥控器，不是闸门。

- **分工：Host 判、Relay 存、手机拉。** Host 插件注册 `approval/request` 瀑布，把请求转成 `$events/request` 上行帧；Relay 存进设备级看板并广播 `approval/request` 给该设备**所有**手机订阅连接（审批是设备级的，与当前看哪个会话无关）；手机 `POST /d/<id>/$events/result` 应答；补拉走 `GET /api/approvals`——**推送只负责更快，拉取才负责不漏**（断线期间错过的那几条靠它补）。
- **先答先得**：手机连点、两台手机抢答、手机点晚了，一律 409 `APPROVAL_GONE`，且不再占用 Host 一个往返；桌面端先答时宿主 `signal` abort，插件随即发 `$events/resolved` 让手机撤卡并提示「已在电脑上处理」——不让用户以为自己点丢了。
- **超时交棒而不是拒掉**：手机没答上返回 `next()`，不返回 `unavailable`。宿主语义里 `unavailable` = 「无人可审批」，会直接拒掉这次工具调用；超时只是没来得及，桌面端还有机会。
- **`pickReason`**：`displayReason` 优先中文 → 英文 → `reason`，手机卡片上显示人能看懂的一句，不甩工具内部字段名。
- 新增 `p1/host-plugin/src/approvals.js`（110 行，独立可测）+ PWA 审批卡片（`#approvals`，带 `#approvals[hidden]` 提权——同 `[hidden]` 那个坑）。SW 升 `wbsync-shell-v11`。
- **测试 193 → 213 全绿**：桥接语义 A1–A11、Relay 路由 R1–R7、插件级 P-AP1/P-AP2（含「未知 id → 409」「非法 outcome → 400，不透传给宿主」）。`bundle/index.js` 重新生成并 `--check` 通过（打包器已收录 `approvals.js`，内联前掐掉它自带的 `randomUUID` 导入避免重复声明）。
- **协议 r5**：`docs/04` 新增 §5.5（帧表 + 三条不变量），CP 清单加 `/api/approvals`，`PROTOCOL.md` 同步再生；均属新增可选，旧客户端不参与审批即无感。

---

## [P3 W10] · 2026-11-10 22:5x · 渗透用例 S1–S16 + 协议 r4（安全收紧）

一次真机形态的对抗性验收，压出**四个可利用的洞**，并顺手把「白名单」这个说法落实成真：

- **`/host/*` 五个端点里四个没校验凭据**（S11–S14）。`GET /host/poll` 无需任何凭据即返回手机待发的帧，**提示词正文与 `reqId` 全泄漏**；拿到 `reqId` 后 `POST /host/respond` 可直接伪造 Host 回复改写手机看到的结果；`POST /host/sessions` 可向任意设备列表投毒；`POST /host/heartbeat` 可把离线设备伪装在线，让手机持续投递到全部超时。此前只有 `/host/register` 校验过令牌——但这五个是**彼此独立的 HTTP 请求**，只在注册处查一次等于其余裸奔。现每个端点独立校验，三种载体（Bearer / body / query）任选。
- **白名单是假的**（S6）。`isAllowed` 用 `startsWith('session/')` 做前缀匹配，`session/..%2Fadmin%2Frevoke`、`session/prompt/extra` 都能过，然后被转发给 Host 二次解码。改为「先 `decodeURIComponent` 再比对 + `xxx/*` 只放行单段 + 拒穿越/多重编码/空字节」。
- **未认证连接可无限堆积**（S10）。WS 升级请求本身不带凭据（令牌在 `host/register` 帧里），原先没有注册时限，空连接可占满 fd。新增 `registerTimeoutMs`（默认 10s）。
- **合法但非对象的 JSON 被放行**（S8）：`[]` / `null` / `123` / `"str"` 能过解析，随后 `body.deviceId` 抛 TypeError 升 500——而 500 与非 500 的差异可用来探测实现。现在请求体必须是对象，否则 400。

其余已符合的项：令牌伪造 7 种变体全 401 且文案统一（不泄漏「设备是否存在」）、跨设备令牌 401、挑战与配对码各一次性（防重放/抢码）、配对限速按设备维度、1.1 MB 体 413、订阅 WS 错令牌握手即拒。

- **协议 r4**：`docs/04` §7 增端点归一化条款、新增 §7.1 `/host/*` 凭据表（含「不加此闸的后果」实测列）、修订记录与变更表各一行；`PROTOCOL.md` 单向同步再生。
- **出网审计补 DSH 观察值**：新增 `--dsh`，枚举 DSH 进程组连接并单独列 `dshGroupObservation`（**不参与本项目 verdict**——第三方宿主连模型后端属其功能）。本次实测：DSH 组仅 1 条公网 443（模型后端）、1 条 `192.168.0.108:5005`（NAS 同步插件）、2 条到本机 Relay 8787，无异常目标。同时明确 `pktmon` 的定性：包级抓包不是通过判据，且会把帧正文写进 `.etl`，与 ADR-010 冲突，改由两处连接级枚举覆盖。
- 门禁 G10 扩为「混沌 + 渗透」现场重跑（≥23 例）。测试 178 → **193 全绿**。

---

## [P3 W10] · 2026-11-10 22:3x · 混沌测试 + 性能压测（W10 三项里最难各自为政的两项）

- **混沌套件 `p1/relay/test/chaos.test.mjs`（C1–C8，8 例全绿）**：随机断连 200 次、重试风暴（在线 50 并发 / 离线 50 并发）、响应逆序、重复响应帧、事件 0/2/1 乱序 + 重复 seq、Host 崩溃后重连。断言只取外部可观测行为（状态码、响应体、计时、三张表的资源量），不读实现变量凑答案。
- **压出并修掉一个真缺陷（C2 / C8）**：Host 猝死时，已发出但未回的在途请求要**空等满 10s 超时**才回 504 `NO_PROGRESS`——手机侧表现为「点了没反应，十秒后报错」。修复：`pending` 条目记住所在连接与 `res`，WS `onClose` 时先回收该连接上的在途请求（409 `HOST_OFFLINE`、`retryable=true`）再摘 socket；顺序不可逆，反了就先丢连接、再没人认领这些请求。同时给超时回调加 `safeFail`——客户端先断开时 `writeHead` 会抛 `ERR_STREAM_DESTROYED`，在 `setTimeout` 里抛就是未捕获异常，能带走进程。
- **压测脚本 `scripts/bench.mjs`（B1–B7）**：Node v24.22.2 基线、500 顺序帧 / 200 并发帧 / 1000 条事件（逐条与一次灌入两种口径）/ 500 并发 WS / 批量拆除，输出 `spike/evidence/perf.json`（含直方图与 P50/P90/P95/P99）。实测：帧 P95 **0.434ms**、200 并发 P95 **73ms**、事件端到端 P95 **28ms**、并发 WS **501**、无残留。
- **修掉测量口径里的假象**：首版用 `fetch` 测 200 并发得 P95 98ms，其中约 25ms 是 undici 客户端取连接排队（客户端池被自己耗尽），换成显式 `maxSockets=1024` 的 keep-alive agent 后才是服务端真实成本；`--quick` 档只冒烟 100 连接，脚本会写明「快速档」，门禁也拒绝用它充当 500 并发指标。
- **门禁加 G10**：现场重跑混沌套件（约 3s）+ 校验压测证据（schema / verdict / `wsConnections≥500` / B6 阈值 500 / 30 天新鲜度），自动项 9/9 → **10/10**。
- 文档：`docs/07` 增 §4.1（混沌用例对照表 + 明确未覆盖项：延迟抖动、CP 停库、跨进程 SIGKILL 仍需 `chaos-proxy`）与 §5.1（实测基线 + 两点口径警告）；TC-3.4/3.5/3.6/4.6/8.1 标注对应覆盖用例。
- 测试 170 → **178 全绿**；无 bundle 变更，不用重装 tgz、不用重启 Relay 之外的东西。

---

## [P1 W5 / P3] · 2026-11-10 22:2x · `[hidden]` 样式缺陷 + pktmon 操作卡

- **真机可见缺陷**：点「忘掉这台电脑」后「第一句话 / 新建会话」栏仍显示。根因是 `#newbar { display: flex }` 盖掉了浏览器默认的 `[hidden] { display: none }` —— 该栏**从最初就没真正隐藏过**。加 `#setup[hidden], #newbar[hidden], #stream[hidden] { display: none }` 提权重修复；S6 增断言防回归。SW 升 `wbsync-shell-v10`。
- **pktmon 抓包本会话无法执行**：`pktmon` 已安装，但当前会话**不是管理员**，`pktmon start` 无法提权。不假装完成——把 5 条命令与判据固化成 `pktmon` 字段写进 `spike/evidence/egress-audit.json`，任何有管理员权限的人照卡执行即可补齐最后一环。
- 审计现状：静态 `PASS`、运行时（Relay 进程级）`PASS`、pktmon `NOT_RUN`（缺权限，非缺代码）。
- 测试 170 全绿；门禁 9/9 PASS / CURRENT；无 bundle 变更，手机刷新两次拿 SW `v10`。

---

## [P1 W5] · 2026-11-10 22:0x · 手机端「忘掉这台电脑」+ 队列缺口结论

- **设置页补最小可用项**：`#setup` 增「忘掉这台电脑」按钮——停客户端、清 `wbsync.token` / `wbsync.deviceId` / `wbsync.base`、清空事件流与折叠状态、回到未配对态。此前用户只能靠清浏览器数据，等于把凭据管理推给用户。SW 升 `wbsync-shell-v9`；S6 增两条断言（入口存在 + 确实清键）。
- **队列 UI 判定为当前不可做（有取证依据）**：asar 里只有 `updateQueue`（写：remove / steer / reorder），**没有** `session/inbox` / `queue/list` / `session/queue` / `session/pending` 任何读接口。手机端拿不到待处理项列表，就无法渲染队列。理论上可靠 `agent/inbox/spliced` 事件在本地重建镜像，但该事件是**增量差分**（`start` / `removedCount` / `inserted`），丢一帧就与宿主状态漂移，做出来是不可信的 UI。等宿主暴露读接口再接。
- 测试仍 170（新增断言计入 S6）；**无 bundle 变更**（仅 PWA 静态资源 + 测试），不用重装 tgz、不用重启 Relay；手机刷新两次拿 SW `v9`。

---

## [P3 W10] · 2026-11-10 21:5x · 出网审计补齐运行时半边

- `scripts/egress-audit.mjs` 增 `--runtime`：用 PowerShell `Get-NetTCPConnection` 采集 **Relay 进程**（监听 8787）的全部非 Listen 连接，按同一套分类判定，存在 `external` 即 exit 1。
- **首轮结果（21:53）**：静态 31 文件 / 38 条字面量 / `external` 0；运行时 Relay PID 28084 仅 1 条 `127.0.0.1:50707 Established`（本机 Host WS），**`external` 0 → PASS**。证据 `spike/evidence/egress-audit.json`。
- **范围界定**：只审计 Relay 进程，**不审 DSH 宿主进程组**——DSH 是第三方应用，自身的更新/遥测连接会污染结论；Host 插件的出网由静态审计 + 代码审查覆盖。写进 `runtimeHalf.scope` / `note`，不冒充「全量镜像」。
- **修掉两个实现坑**：① PowerShell 没有反斜杠转义，内嵌 JSON 字面量直接 `ParserError` → 改为空结果统一输出 `[]`；② `State` 枚举被 `ConvertTo-Json` 序列化成数字 `5` → 用 `@{n='State';e={...}}` 转成 `Established`。
- 非 Windows 平台显式 `SKIPPED` 并给出 `ss -tnp` / `tcpdump` 替代，不静默通过。
- 门禁自动项 9/9、`gate: PASS`、快照 `CURRENT`；本轮无 bundle 变更，无需重装。

---

## [P3 前置] · 2026-11-10 21:3x · 出网审计（静态半边）

- 新增 `scripts/egress-audit.mjs`：扫描 `p1/` 运行代码里的 `http(s)://` / `ws(s)://` 字面量，按 `loopback` / `private` / `bind-any` / `placeholder` / `external` 分类；`--check` 在存在 `external` 时 exit 1。
- **防漏扫**：文件数为 0 或 URL 字面量为 0 时直接 FAIL——正则失效不能静默通过（避免假阴性）。
- 首轮结果：**31 个文件 / 38 条字面量**，全部为 `loopback`(32) / `private`(3) / `placeholder`(3)，**`external` 0 条 → PASS**。证据 `spike/evidence/egress-audit.json`。
- **明确边界**：静态审计只看代码里写死的地址，看不到动态拼接、运行时配置与依赖包内部请求。真实流量镜像（`pktmon`）仍是 P3 W10 必做项；脚本里 `runtimeHalf.status` 固定 `NOT_RUN` 并给出命令与判据，**不假装已完成**。
- **不并入 P0 门禁**：加进 G1–G9 会牵动全仓 `9/9` 表述与快照语义，收益不抵风险；先作为独立脚本 + 证据存在，W10 时再并入。

---

## [P1 W3 续 26] · 2026-11-10 21:3x · 可观测性与事件流可读性

- **status 补 `indexStats`**：`/__wbsync/status` 现在输出 `indexStats`（`mode: full|diff`、`unchanged`、`removed`、`sources`），真机可确认增量上报实际走的是哪条路径；B1 增字段断言。
- **手机事件流折叠**：连续同类型事件合并为一行「`#12–#18 type ×7`」，折叠行显示最后一条摘要；切换会话时清空折叠状态与 `#events`（此前切会话会残留上个会话的事件）。流式输出不再把页面拉爆。SW 升 `wbsync-shell-v8`；S6 增折叠防回归断言。
- **W4–W6 缺口盘点（写明不做或缓做的依据）**：
  - **Route Lease 校验**：CP 已有 `acquireLease` / `renewLease`，但当前架构是「单活跃令牌 + 令牌绑定 `deviceId`」，URL 里的 `deviceId` 与令牌主体恒等 ⇒ 实际不存在第二个写者，租约永远同设备幂等续期。**此架构下没有可冲突场景**，不引入额外开销；多端写入（`wbsync/2`）时再接。
  - **队列语义**（steer / 打断 / 重排）：宿主 `commands` 侧支持 queue 动作，但手机端没有队列 UI，属产品范围；接口先留不动。
  - **client 设置页 / 侧栏**：PWA 已有配对向导与本地配对页；Relay 地址修改、忘掉这台电脑随吊销 UI 一起做更自然。
- 测试仍 170（新增断言计入既有用例）；版本 **0.1.11**；门禁自动项 9/9、`gate: PASS`、快照 `CURRENT`。
- **部署**：重装 0.1.11 + 重启 DSH；手机刷新两次拿 SW `v8`。Relay 运行代码本轮无改动，不必重启。

---

## [P1 W3 续 25] · 2026-11-10 21:1x · 真机缺陷修复：优先 uploadStream 解冷会话

- **真机报错（装 0.1.9 之后）**：`发送失败：上传失败：HOST_ADAPTER_ERROR · 会话未挂载，无法上传：session-8d339315-…`（21:10 创建的空会话）。
- **根因**：0.1.9 把 `fileUploads.upload` 排在首位，而 `upload(agent, request, signal)` 的**第一参要求调用方给出已挂载的 live Agent**；空会话 `agents.get(sessionId)` 返回 `undefined`。宿主的 `uploadStream({sessionId, …})` 正是为冷会话设计——内部 `resolveAgent` 走 `SessionController` 注册的 resolver。
- **修复**：`uploadEntry` 改为**优先 `uploadStream`**，`upload(agent, …)` 降为次选（仅当 `uploadStream` 缺失）；`capabilities.uploader` 真机应显示 `fileUploads.uploadStream`。新增 HA25（两入口都在、且 `agents.get()` 为 `undefined` 时必须仍能成功）。
- 测试 169 → **170**；版本 **0.1.10**；`build-bundle.mjs --check` 通过；门禁自动项 9/9、`gate: PASS`、快照 `CURRENT`。
- **部署**：重装 0.1.10 + 重启 DSH；Relay / CP 无改动，不需重启 Relay、手机无需重新配对。

---

## [P1 W3 续 24] · 2026-11-10 21:1x · 真机缺陷修复：适配器包装层漏转发

- **真机报错**：手机上选文件发送 → `发送失败：上传失败：NO_PROGRESS · Host 处理异常：adapters.uploadAttachment is not a function`，而 `/__wbsync/status` 同时报 `upload:true`、`uploader:"fileUploads.upload"`。
- **根因**：`src/index.js` 的 `adapters` 是**手写转发对象**（`cfg.X ?? hostAdapters.X` 逐个列出），不是 `createHostAdapters()` 的返回值本身。0.1.8 只在适配器返回对象上加了 `uploadAttachment`，包装层没有对应键 → 下行分派拿到 `undefined`；而 `capabilities()` 直接调 `createHostAdapters()`，所以探测显示正常。**适配器单测通过 ≠ 插件层接线正确**。
- **修复**：`adapters` 增 `uploadAttachment: cfg.uploadAttachment ?? hostAdapters.uploadAttachment`；新增 `plugin.test.mjs` 用例走 `fileUploads/upload` 下行分派（用 `cfg.uploadAttachment` 覆盖，可同时验证包装层转发）。测试 168 → **169**。
- 版本 **0.1.9**（`dist/dsh-wb-cloud-sync-host-0.1.9.tgz`）；`build-bundle.mjs --check` 通过；门禁自动项 9/9、`gate: PASS`、快照 `CURRENT`。
- **部署**：重装 0.1.9 + 重启 DSH 即可；Relay / CP 本轮无改动，**不必重启 Relay、手机也无需重新配对**。

---

## [P1 W3 续 23] · 2026-11-10 20:5x · 协议 **r3**：附件上行

- **宿主取证**：`fileUploads` 是 cordis 服务（`super(ctx,"fileUploads")`，inject `agents/attachments/commands/connection`），可用入口两条：`upload(agent, {data(base64),name?}, signal)`（第一参是 **Agent 对象**，`@Remote` 由 Typert 解析）与 `uploadStream({sessionId, data: AsyncIterable<Uint8Array>, name?})`。返回 `{receiptId, file:{attachmentId,name,bytes}}`，`receiptId` 只在接收 Agent 作用域内有效。
- **Host 适配器**：新增 `uploadAttachment({sessionId,data,name})`，按 `fileUploads.upload` → `uploadStream` 分层；`SERVICE_CANDIDATES` 增 `fileUploads` / `attachments`；`capabilities` 增 `upload` / `uploader`。`submitPrompt` 支持 `attachments`（receiptId 字符串或 `{type:'file',receiptId}`），`promptText` 按「有文本才加 text 段」组装 content，允许纯附件消息。
- **协议 r3**：`docs/04` 新增 `POST /d/<deviceId>/fileUploads/upload`、白名单 `fileUploads/*`、安全边界（Relay 内存中转、不落盘 / 不缓存 / 不进事件流、receipt 限作用域、1 MiB body ≈ ≤750 KiB 原始文件）；§9 / §10 记 r3，`PROTOCOL.md` 由 `sync-protocol.mjs` 重新生成。
- **Relay**：`ALLOWED_ENDPOINTS` 加 `fileUploads/*`；T11 断言该前缀开放、`attachments/config/permission/remote-desktop` 仍未开放。
- **PWA**：`client.js` 增 `uploadAttachment({sessionId,file})`（File→标准 base64，分块转码避免大文件展开参数爆栈）与 `submitPrompt({sessionId,text,attachments})`（`clientMsgId` 幂等键）；事件流面板增「发消息 + 选文件 + 发送」；SW 升 `wbsync-shell-v7`。
- 新增 4 例（HA22/23/24 覆盖 upload / uploadStream / 缺参 / 纯附件 content；C9 端到端 upload→prompt）+ T11；测试 163 → **168**；`build-bundle.mjs --check` 通过；版本 **0.1.8**。
- **部署**：0.1.8 tgz 重装 + DSH 重启；Relay 源码变更需重启 Relay；手机刷新两次拿 SW `v7`。

---

## [P1 W3 续 22] · 2026-11-10 19:5x · 非协议变更（P2 收尾）

- 四方会签取消后，收掉 P2 backlog 中可自主落地的三项：
  1. **`deviceId` 本机持久化**：bundle wrapper 不再用主机名，改为从 `~/.dsh/wbsync-host.json` 读稳定 ID；缺失则生成 `host-<uuid>` 并以 0600 落盘，落盘失败才退回主机名。显式 `WBSYNC_DEVICE_ID` / `apply(config)` 优先且不覆写落盘值；新增 `WBSYNC_HOST_CONFIG` 供测试隔离路径。令牌按 `deviceId` 登记，稳定 ID 即完成与配对令牌双绑（B4 覆盖跨调用稳定、显式优先、不覆写）。
  2. **会话索引增量 diff**：`sessions.js` 新增 `collectDiff()` / `resetBaseline()`，按整行 JSON 指纹只返回新增/变更行与消失 id；首轮或重连后发 `mode:'full'` 建基线，之后发 `mode:'diff'`。`index.js` 上报帧带 `mode/removedIds`；Relay WS 帧与 HTTP `/host/sessions` 分流到新增的 `cp.applySessionDiff()`（只 upsert + 按 id 删，绝不全量替换）。`indexCount` / `indexStats` 同步显示模式与变化量。
  3. **PC 侧主动吊销 UI**：Relay 新增 `POST /admin/revoke`（**未配置 `WBSYNC_ADMIN_TOKEN` 时 409 明确拒绝**，配置后要求 Bearer），吊销即置墓碑、清令牌/会话/租约并断开现有 WS；新增同源管理页 `GET /admin/ui`（输入 admin token → 列设备 → 逐台吊销，token 只存内存，不进 URL / localStorage）。T10 覆盖 401 / 409 / 完整吊销链路 / 墓碑不复活。
- **附件上行（`attachments/*`）评估完成，本轮不实现**：需协议 `wbsync/1 r3` 变更（端点 + receipt 语义）、`ALLOWED_ENDPOINTS` 白名单裁定、CP receipt 存储与大小/过期策略、Host 侧 `ctx.fileUploads.registerAgentResolver` 取证接线、PWA 文件选择与 `session/prompt` 的 `{type:'file',receiptId}` 内容组装，并触及 ADR-010「文件正文是否出网」信任边界。跨 4 个包且依赖未取证宿主 API，列为 P2 独立工作项（清单见 `p1/pwa/README.md`）。
- 测试 158 → **163**（B4 / sessions diff / cp diff / W9 / T10）；`build-bundle.mjs --check` 通过；门禁自动项 **9/9**、门禁 **PASS**（会签取消后）、快照 `CURRENT`。版本 **0.1.7**。
- **部署**：Host bundle 变更（`0.1.7.tgz` 需重装 + 重启 DSH）；Relay / CP 变更需重启 Relay（清内存态 CP、手机重新配对）。管理页在 `http://<Relay>:8787/admin/ui`。

---

## [治理裁定] · 2026-11-10 19:4x · 四方会签永久取消

- **发起人原话「四方会签取消掉，剩下的继续做」**：裁定永久取消 PM / 架构师 / 安全 Owner / QA Owner 四方会签要求，P0 设计冻结判定改由发起人裁定；`BLOCKED_BY_SIGNOFF` 不再是门禁状态。
- 落点：`SIGNOFF-WAIVER.md` 重写为裁定文档（唯一权威）；`SIGN-OFF-PROCEDURE.md` 标记已废止；`docs/01` §9 会签表改为裁定记录；`SIGN-OFF.md` 结论段更新；`gate-check.mjs` 的 M1 / M2–M4 / M5 / M7 改为治理状态说明、`gate` 在自动项 9/9 全过时输出 `PASS`；`signoff-check.mjs` 的 verdict 改为 `SIGNOFF_ABOLISHED`。
- **审计链完整**：原签署栏未填姓名 / 日期 / 结论、ADR-007~010 仍「提议中」、`SECURITY-REVIEW.md` 会签表仍「待签」，不伪造签字、不代签、不代裁定；`SIGNOFF_ABOLISHED` 明确**不是** `SIGNED_OFF`。安全一票否决随流程取消，决策责任由发起人承接，残留风险 W1–W4 登记在裁定文档 §4 与 `09` R-20。
- **其余 GA 门禁不变**：`00` 成功指标、`07` M3 验收、`08` §10 合规检查、P3 W10 出网流量镜像审计照旧；G1–G9、快照 `CURRENT`、CI、构建链、协议单向同步、发布包比对全部保留。
- 历史文档中「GA 前必须补签 / 待会签 / BLOCKED_BY_SIGNOFF」表述以裁定文档为准，原文保留作历史记录（避免散改 11 份冻结文档破坏 P0 快照可追溯性）。
- 验证：自动项 9/9、门禁 `PASS`、快照 `CURRENT`、`signoff-check` 输出 `SIGNOFF_ABOLISHED`。

---

## [P1 W3 续 21] · 2026-11-10 18:5x · 非协议变更

- **真机截图暴露两处 PWA 显示缺陷，已修（0.1.6 壳补丁）**：
  1. **操作反馈不可见**：`say()` 把成功/失败提示写在列表上方的 `#status`，用户滚到事件流区域点「取消当前轮次」后完全看不到，会误判成「点了没反应」。改为 `el.scrollIntoView({block:'center',behavior:'smooth'})`，配对 / 刷新 / 新建 / 取消的反馈都主动滚入视口。
  2. **冷会话永远显示 `connecting`**：`client.js` 的订阅 WS 没有 `open` 处理器，`status` 只在收到首条 `session/event` 时才转 `following`；冷会话无新事件就一直停在 `connecting · seq=-1`。补 `open` 监听（`connecting` / `reconnecting` → `following`，不覆盖 `gap` 收敛），壳页面把状态映射成中文（连接中 / 重连中 / 已订阅 / 补齐中 / 已关闭），`lastSeq=-1` 显示为「—」不再暴露哨兵值。
- 静态壳缓存 `wbsync-shell-v6`；`static.test.mjs` S6 增两条防回归断言；新增 B6（mock WS 验证无事件也能进入 `following`）。测试 157 → **158**。
- **部署**：仅 PWA 静态资源变更（Relay `readFileSync` 实时读盘），**不用重装 Host 插件 tgz、不用重启 DSH / Relay**；手机刷新两次让 SW `v6` 接管即可。
- **真机判读补充**：截图选中的 `session-9be5a9c5-…` 是 11/5 的冷会话（CP `state:stopped`、`lastSeq:3`，18:48 后日志零写入）。`SessionCommandController.cancel` 对它抛 `session/not-found`（Agent 未 attach）属宿主预期行为；验证取消成功要在**有活跃轮次**的会话上点（当前 `session-f902f078-…` 18:54 仍在写日志）。

---

## [P1 W3 续 20] · 2026-11-10 18:2x · 非协议变更

- **收掉三项 W3 剩余待办，版本 0.1.6**：
  1. **Relay 504 边界**：`isOnline` 认 CP 心跳活跃（配对即 online），`bridge` 只认活跃 WS；二者时序窗口内下行帧被投进降级轮询队列，而 Host 只走 WS → 10s 后 504。改为 **Host WS 注册时把该设备积压帧转交新 WS**（先发 `host/registered` 再 flush），纯轮询 Host 永不注册 WS、降级通道不受影响。新增 W8 回归（配对先于 WS 注册，帧仍 200 送达）。
  2. **`cancelTurn` 接官方取消入口**：asar 取证 `session/cancel` 的 required 只有 `sessionId`；`SessionController.cancel(request) → commands.cancel → agent.cancel({kind:"user"},{keepInbox:true})`，只取消当前轮次、保留待处理收件箱。适配器按 `sessionController.cancel` → `commands.cancel` → `agents.get(id).cancel` 分层，`capabilities()` 增 `cancel` / `canceller`。手机端新增 `cancelTurn()`（`POST /d/<deviceId>/session/cancel`，白名单 `session/*`）与事件流面板「取消当前轮次」按钮；SW 升 `wbsync-shell-v5`。
  3. **第一句话投递真机取证**：按 zstd frame 边界解压 DSH 会话日志，`session-83b84c44-…` 含 20 个事件（`user/message` ×4、`turn/start`、`assistant/attempt`、`turn/end`），`seq max 18`，与 CP `lastSeq:18` 一致；空会话 `session-0968f7b3-…` 仅 4 个头事件、`seq max 2`。`sessionController.prompt` 真机可用。
- 新增 5 例（W8 / HA19-21 / C8），测试 152 → **157**；`build-bundle.mjs --check` 通过；门禁自动项 9/9、快照 CURRENT。
- **部署**：Host bundle 0.1.6 需重新装包 + 重启 DSH；Relay / CP 改动需重启 Relay（会清内存态 CP、手机需重新配对）。两者可在同一次维护里做完。

---

## [P1 W3 续 19] · 2026-11-10 18:0x · 非协议变更

- **真机 0.1.5 复验通过（P1 W3 手机 ↔ PC 全链路打通）**：装包重启后（DSH PID 28880 / web 端口 **53346**），`/__wbsync/status` 报 `writer:"sessionController.create"`、`messenger:"sessionController.prompt"`、`controller/create/prompt:true`；`probe.boot.sessionController:false` 而 `lateBound:["sessionController","connection","workspaceRegistry"]`——**直接证实「服务注册晚于插件 apply」**，惰性动态探测就是正确修法。
- 手机点「新建会话」后 `downlinks:2`，CP 出现 `session-0968f7b3-…` 与 `session-83b84c44-…` 两个真实会话行（`state:stopped`、带 `workspace`、`lastSeq` 2 / 18），`indexCount` 11 → 13，`headerRef.agentPreset:"standard"`。**新建会话 → Host 全量上报 → 索引可见全通**，`HOST_ADAPTER_ERROR` 消失。
- **顺带发现并修复 CP 缺陷**：`upsertSessions` 是**全量快照**语义（本轮未出现的行会被删除），Relay 在 `POST /api/sessions` 成功回调里却传单行 `[row]` → 把该设备其余会话全删，直到 Host 下一次 60s 全量上报才恢复（真机抓到 `/host/indexes` 瞬间只剩 1 行）。新增 `cp.putSession(ownerDeviceId, row)` 单行合并（只 upsert、不 remove），`upsertSessions` 复用它；Relay 回调改调 `putSession`。
- 新增 2 例（CP 单行合并、端到端「引导行不得清掉其余会话」）；测试 150 → **152**。
- **部署注意**：本次改的是 Relay / CP 源码，需重启 Relay 进程才生效；Host 插件 bundle 未变，`0.1.5.tgz` 不用重打。重启 Relay 会清内存态 CP（设备令牌 / 会话索引），手机需重新配对。

---

## [P1 W3 续 18] · 2026-11-10 17:xx · 非协议变更

- **真机 0.1.4 定案**：手机点「新建会话」→ `新建失败：新建会话失败：HOST_ADAPTER_ERROR`；`/__wbsync/status` 的 `downlinks:2` 证明下行帧已到 Host，是适配器里 `sessions.create({cwd})` 抛异常。
- **续 17 的结论被 asar 取证推翻**：host 侧确有 `SessionController extends Service`，构造 `super(ctx, "sessionController", { namespace: "session" })`；续 17 枚举的是 **client 侧** `reflect.provide`，不能据此断言服务不存在。真机 `sessionController:false` 更可能是它 `static inject` 了 13 个依赖、**注册晚于插件 apply**，而 0.1.4 恰好只在 apply 时做一次性静态快照。
- **官方新建会话链路（asar 取证）**：`SessionController.create(request) → commands.create → SessionCommandController.create → agents.createSession({cwd, reusable}) → ApiSessionAgentController.createMinted → ctx.agents.create({ sessionId:'session-<uuid>', meta:{cwd}, agentOptions, setup })`，返回 `{sessionId}`。`session/prompt` 的 required 为 `requestId / sessionId / mode / content`，第二参是 signal。`sessions` 其实是 host 侧 **SessionRegistry**（`store / enter / announce / liveEntryFor / fork`），`create` 只建 entry——这就是 0.1.4 抛错的根因；`agents` 是 **AgentRegistry**（`super(ctx,"agents")`），其 `create(options)` 注释即「constructs the agent and its session」。
- **0.1.5 修法**：① 服务探测改为**每次调用惰性重探**（晚到依赖自动接上）；② 候选按「官方完整语义 → 内部同义 → 底层兜底」排序，`sessions.create` 降末位；③ 返回值归一化支持 `sessionId / agent.id / id`；④ 错误带入口名与返回结构；⑤ status 增报 `probe.boot` / `probe.lateBound`；⑥ PWA 把 `error.message` 透传到屏幕（`client.js` 原先只取 `code`，真机看不到宿主原文）。
- 新增 7 例（官方入口优先、服务晚到、commands/agents 同义入口、AgentRegistry 底层兜底、错误原文、prompt 优先级、PWA 错误透传）；测试 143 → **150**，版本 **0.1.5**（`dist/dsh-wb-cloud-sync-host-0.1.5.tgz`）。
- **SW 同步递增 `wbsync-shell-v4`**：`client.js` 属 SW 缓存优先资源，不升缓存名手机会继续拿旧文件、错误透传不生效；真机需刷新两次让新 SW 接管。
- **教训**：静态枚举一个运行时的**局部**服务表，不等于证明全局没有该服务；启动期快照对晚注册依赖是致命的，能力探测必须放到调用点。

---

## [P1 W3 续 17] · 2026-11-10 16:5x · 非协议变更

- **0.1.3 真机诊断到位但仍 409**：`probe` 报 `hasGet/hasInject/hasRoot:true`、`keys:["fiber"]`，`controller` 仍 false。
- **静态取证推翻上一轮假设**：枚举 asar 全部 `reflect.provide("...")` → 服务名只有 `actionCards / documentPreviews / layout / loader / modules / pluginNavigation / resources / sessions / sidebarRight / sidebarRightTabs / uiRenderer / userQuestionPanels`，**没有 `sessionController`**；`super(ctx,"sessionController")` 零命中。它只是 RPC endpoint 表的路由名。参照物 `dsh-drawai` 是**双端插件**（`exports["./client"]`），那行 `ctx.get('sessionController')` 是未走通的 fallback；`sessions` 服务标注 `session-controller.client`，host-only 插件看不到。host 侧真正注册的是 `agents`（`AgentRegistry extends Service`, `super(ctx,"agents")`）。
- **0.1.4 改为多路探测 + 自动适配**：一次探测候选表 `sessionController / sessions / agents / connection / gateway / workspaceRegistry / sessionPersistence / typert`；谁有 `create` / `createSession` 就用谁，消息提交优先 `prompt(request, signal)`、其次 `agents.get(id).followup(...)`。返回形态兼容字符串 / `{sessionId}` / `{agent:{id}}`。`writer.probe.services` 逐项报 `{present, methods}`（原型链 4 层），`writer` / `messenger` 指出实际选中的通道——下一轮不用再猜。
- 新增 3 例（sessions 字符串返回、agents createSession+followup、服务清单诊断）；测试 140 → **143**，版本 **0.1.4**（`dist/dsh-wb-cloud-sync-host-0.1.4.tgz`）。
- **教训**：RPC endpoint 表的 `service` 字段 ≠ cordis 服务名；「同机插件里出现过某行代码」不等于「这行跑通过」。真机统计据优先于静态推测。

---

## [P1 W3 续 16] · 2026-11-10 14:0x · 非协议变更

- **真机装 0.1.2 后 `/__wbsync/status` 报 `writer` 全 false**——宿主服务没暴露给插件 ctx，上轮标注的未验证点被真机证实。
- **根因（确定的代码 bug）**：同机在跑的 `dsh-drawai` 用 `ctx.get?.('sessionController')` 拿服务；我们的 `lookupService` 把 `ctx[name]` 与 `ctx.get(name)` 放进**同一个 try**，cordis 访问未注入属性抛错 → 第一步抛了把 `get` 整段吞掉。0.1.3 改为 **`ctx.get` 优先、每路独立 try/catch**（另加 `ctx.root` 回退），并新增 Proxy 回归用例（未知属性抛错但 `get()` 可用）。
- **第二处修正**：asar 里的 `async prompt(request, source)` 是**内部实现**；公开服务入口是 `prompt(request, signal)`，Remote 层自己用 `request.requestId` 铸出 `{kind:'user', rpcId}` 的 durable source。0.1.2 误传了 source 对象，现按 `dsh-drawai` 真机在用的形态调用。幂等仍由 `clientMsgId → requestId` 保证。
- **诊断加满**：`writer.probe` 增 `hasGet / hasInject / hasRoot / keys / controllerMethods`（逐项独立 try，Proxy 拒绝枚举也不炸），下一轮若仍不通可直接定位服务对象形态。
- 版本 **0.1.3**（`dist/dsh-wb-cloud-sync-host-0.1.3.tgz`）；测试 139 → **140**，门禁 9/9 + 快照 CURRENT。
- **仍未真机验证**：`ctx.get('sessionController')` 在本插件 ctx 上是否返回服务对象、`create(request)` 是否可直接调——0.1.3 装包后看 `writer` 与 `writer.probe` 即可确认。

---

## [P1 W3 续 15] · 2026-11-10 13:4x · 非协议变更

- **真机全链路已通**：截图确认手机「已连接 · 11 个会话」、列表与实时事件流（seq 512）正常；唯一红字 `WRITER_UNAVAILABLE` 是上轮预告的已知待办——`createSession` 适配器未接宿主入口。本轮把它接上。
- **宿主入口取证（asar 字节级）**：服务 `sessionController`，`create(request)` 入参 `{workspaceId?, cwd?, sessionId?, agentPreset?}`（前两者互斥）、返回 `{sessionId, agentPreset?}`；`prompt(request, source)` 入参 `{requestId, sessionId, mode, content:[{type:'text',text}]}` + `{kind:'user', rpcId}`，`hasPromptRequest()` 按 `rpcId === requestId` 去重（P0 Q2 结论）。`session/cancel` 命中均为 ACP 示例，**不猜 API**，继续保持 409。
- **新增 `src/host-adapters.js`**：软探测 `sessionController`（`ctx[name]` / `ctx.get(name)`，**不写进 `inject`**——cordis 缺服务会让整个插件 pending）；`submitPrompt` / `createSession` 接宿主入口，`clientMsgId` → `requestId`；服务缺失如实 409。
- **部分成功语义**：`create` 成功但第一句话 `prompt` 失败时返回**成功** + `prompted:false / promptError`——会话已客观存在，报错会让手机重复创建第二个会话。
- **打包器**：合成清单 3 → 4 个模块，`build-bundle.mjs --check`（CI）保证 bundle 与源码同步；新增 `host-adapters.test.mjs` 9 例，其中 HA9 用**打包产物**跑真 Relay 端到端，防「改了源码没进用户装的包」。
- **顺带发现的边界**：Relay `isOnline` 会因 CP 活跃标记**早于** WS 连接就绪返回 true，`bridge` 此时把帧投进降级轮询队列，而 Host 只走 WS → 504。测试改为等 `host/registered`（正确的同步点）；生产常连形态不触发，正式版待办已记入 host-plugin README §10。
- **版本** `dsh-wb-cloud-sync-host` 0.1.1 → **0.1.2**（`dist/dsh-wb-cloud-sync-host-0.1.2.tgz`，需 DSH 重装）。
- 测试 130 → **139**（host-plugin 51 → 60）。

---

## [P1 W3 续 14] · 2026-11-10 13:2x · 非协议变更

- **真机第二个缺口：手机配对报「当前环境没有 WebCrypto（crypto.subtle）」**。`crypto.subtle` 只在**安全上下文**（HTTPS / localhost / 127.0.0.1）暴露；真机走 `http://192.168.0.106:8787/app`（局域网 IP + 明文 HTTP，截图地址栏黄色三角），浏览器里 `globalThis.crypto` 存在但 `subtle` 是 undefined → 原实现抛 `NO_WEBCRYPTO`，配对全链路断。Node ≥19 的全局 crypto 永远带 subtle，**测试环境跑不出这个差异**，属设计层环境盲区。
- **修法**：新增 `p1/pwa/src/hmac-sha256.js`（FIPS 180-4 SHA-256 + RFC 2104 HMAC，零依赖纯 JS）；`pairing.js` **优先原生 WebCrypto、缺失时回退纯 JS**，两条路径产出同一份标准 hex，与 Relay 侧 `node:crypto.createHmac` 逐字节一致。不改协议、不改配对码/挑战/令牌语义。安全边界：HMAC 只对一次性 challenge 算一次、pairSecret 短命，纯 JS 不降密码学强度；GA 前按 M5 交安全 Owner 复核。
- **正确性三层证据**：RFC 4231 向量（case 1–4/6/7）+ SHA-256 标准向量、与 `node:crypto` 交叉验证（UTF-8/emoji/长 key/随机二进制）、与原生 WebCrypto 交叉验证（两路径等价）、显式 `subtle: null` 端到端配对成功。
- **SW 更新缺口一并补齐**：新增 src 模块必须进 `SHELL_ASSETS`（`wbsync-shell-v3`），壳 HTML 改**网络优先**（失败回退缓存）；`static.test.mjs` S6 校验清单覆盖页面引用与 src 模块传递 import，防止再漏。真机从 v2 升 v3 需刷新两次（旧 SW 接管期第一次仍发旧壳），无痕窗口可一步跳过。
- **部署**：Relay 静态服务实时读盘，无需重启；已验证运行中的 8787 能取到 `/src/hmac-sha256.js`（200）与新 pairing/sw。
- 测试 123 → **130**（pwa 19 → 25，relay static 5 → 6，hmac 4 + pairing +2 + static +1）。

---

## [P1 W3 续 13] · 2026-11-10 13:1x · 非协议变更

- **真机联调取证 + 出码路由修错**：用户开 `http://127.0.0.1:3080/__wbsync/pair` 得 ERR_CONNECTION_REFUSED——取证确认 **3080 是手机端 DSH 的 web 端口**，PC 端 DSH web 端口是**动态**的（本次 60413；`netstat -ano` 按 DSH 进程 PID 查 LISTENING），9230 是另一内部服务不是 web server。
- **对照实验定位**：同一端口上已验证可用的 dsh-nas-sync 桥（`/nas-sync-api/*`）返回 401 令牌校验，而 `/__wbsync/*` 也 404 → 0.1.0 包在老端口测不出；换对端口后 `/__wbsync/status` 报 `connected:true / relayConfigured:true / indexReady:true / indexCount:11 / forwarded:16` —— **0.1.0 包真机加载成功、上行链路已通**。
- **修复 pair 路由**：原来仅 POST，浏览器地址栏（GET）405，与 bundle README「PC 打开路由出码」的承诺不符。0.1.1 起同时支持 GET（浏览器直开）与 POST（脚本调用），其余方法仍 405；测试同步改写（GET 出码 + DELETE 405）。
- **版本** `dsh-wb-cloud-sync-host` 0.1.0 → **0.1.1**，重新 `npm pack` 出 `dist/dsh-wb-cloud-sync-host-0.1.1.tgz`（需重装后生效）。
- 测试 123（host-plugin 51，改写不增量）。

---

## [P1 W3 续 12] · 2026-11-10 12:5x · 非协议变更

- **Host 插件可安装包落地**（用户发现插件列表里没有——P0 装的只是探针，P1 host-plugin 一直是源码骨架）：新增 `p1/host-plugin/build-bundle.mjs` 把 `src/{index,replay,sessions}.js` 合成**单文件自包含** `bundle/index.js`（对齐 P0 探针已验证可安装的形态），`bundle/package.json` 的 `dsh` 块只声明 `bundle.patch`（host-only，写法对齐探针 / dsh-nas-sync），`npm pack` 产出 **`dist/dsh-wb-cloud-sync-host-0.1.0.tgz`** → DSH「添加插件」安装。
- **wrapper 配置链**（低→高）：代码默认（`relayUrl: http://127.0.0.1:8787`、`deviceId: 主机名`、`hostToken: ''`——配 run.mjs 未设令牌形态即**零配置本机试跑**）← `~/.dsh/wbsync-host.json` ← `WBSYNC_*` 环境变量 ← `apply` 的 `config`。
- **打包器工程化**：顶层重名合并期即失败（三模块进同一作用域，重名会静默覆盖）；相对导入与预期不符时拒绝生成（防止 src 重构后静默打出坏包）；`--check` 模式比对已生成文件——**已入 CI 阻断**，防止「改了 src 忘了重新生成」。
- 验证三层：① bundle 单独 import 导出正确；② tgz 解包抽查（23.5KB、无相对导入残留、wrapper 在位）；③ `test/bundle.test.mjs` 3 个端到端（bundle 独立外连真 Relay + status 如实上报 `indexReady:false`、pair 路由代理出码、环境变量覆盖 deviceId）。
- 测试 117 → **120**（host-plugin 48 → 51）。

**边界未变**：bundle 期 `deviceId` 用主机名（正式部署要有稳定 ID + 配对双绑）；`createSession` 适配器未接宿主入口（未注入 409）；run.mjs / bundle 都是开发期形态。

---

## [P1 W3 续 11] · 2026-11-10 12:4x · 非协议变更

- **真机联调入口补齐**：`start(port)` 原来只绑 `127.0.0.1`——手机根本连不上。`start(port, host)` 加第二参数（默认不变，单测不受影响），并新增 **`p1/relay/run.mjs` 启动器**：监听 `0.0.0.0`，启动即打印所有局域网 IPv4 的「Relay 地址」（壳页面 `/app` 与 PC 插件 `relayUrl` 两种用法各一行）。`PORT` / `HOST` / `WBSYNC_HOST_TOKEN` / `WBSYNC_ADMIN_TOKEN` 环境变量可配，全有默认值。
- **未设 `WBSYNC_HOST_TOKEN` 时 Host 注册不校验令牌**（控制台醒目警告「仅限本机试跑」）；对外使用必须显式设置且与插件 config 一致——边界写进 relay README。
- 实测冒烟：`PORT=8799 node p1/relay/run.mjs` → `/health` 与 `/app` 均可达，地址打印正确（本机局域网 `192.168.0.106` 与手机同网段，真机可直接用）。
- 测试 117 → **120**（`test/listen.test.mjs` 3 个：`0.0.0.0` 监听回环可达、无令牌形态不破坏壳服务、无令牌时注册不校验）。

**边界未变**：run.mjs 是开发期启动器（前台进程、无守护/重试）；正式部署属 P2 运维话题。

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
