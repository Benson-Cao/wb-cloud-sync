# 手机端集成 Spike 报告（2026-11-12）

> 目的：验证「WBSync 以**前端插件**形态集成进 DSH 手机端 App」是否可行，以及设备切换器该挂在哪。
> 结论先行：**可行，且不用改 App 一行代码。** 但有两个硬约束和一处 UX 代价。

---

## 1. 形态确认

DSH 手机端 = `com.dsh.harness`，本质是 **WebView 套壳**（页面地址 `http://127.0.0.1:3080/`，由 App 内部起 Node 服务）。

因此「集成」的落点不是原生 UI，而是 **WebView 里加载的那个 web 页面**。宿主支持**前端半边插件**：

```json
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": { "platform": "web", "immediately": true, "inject": ["@deepseek-ai/dsh-client-ui-layout"] }
},
"exports": { ".": "./index.js", "./client": "./client.js" }
```

`client.js` 用 `window.__ModuleLoader__.load({ id, factory })` 自注册，`id` **必须等于包名**。

## 2. 三条硬约束（都是踩出来的）

| 约束 | 现象 | 后果 |
|---|---|---|
| 声明了 `dsh.client` 就必须在 `exports` 里暴露 `"./client"` | `client-modules: … declares dsh.client but exports no "./client" bundle` | **DSH 直接启动失败**（`DesktopHostFatalError`），不是静默降级 |
| `client.js` 的 `id` 必须等于包名 | `duplicate factory registration for "wbsync-client"`，`web boot: 1 entry did not activate` | 插件不激活，界面无任何变化 |
| UI 插件必须是 **bundle**（有 `dsh.bundle.patch`）并登记进 `dsh.profile.bundles` | 只加 `dependencies` 时页面清单里根本没有 `client.js` | 前端半边不加载 |

## 3. 槽位契约（从宿主 asar 的 slot 契约表读出）

| 槽位 | kind | 判断 |
|---|---|---|
| `sidebar.brand.name` | single | `replaceRisk: shadows-shipped-ui` → 会**顶掉**官方品牌名，不采用 |
| `sidebar.workspaces` | single | 「declaring is claiming」，已被 `ui-workspace` 占着 → 真切换 = 接管整个浏览区（搜索/分组/右键/对话框全重写） |
| `sidebar.footer.action` | list | 追加型，安全，ownerProps `{ wide }` |
| `sidebar.panellist` | list | 每 id 对应一个 `main` 面板（nas-sync 已验证） |
| `main` | panel | 面板内容 |

## 4. 真机实测（Android，`192.168.0.100`）

在手机上装一个最小 spike 包（只含前端半边），用 WebView 远程调试读 DOM：

```
viewport 360×740, dpr 3.5
panel-icon  = 16×16 @ x=-260
device-pill = 56×17 @ x=-272
```

- **尺寸够**：切换胶囊 56×17，字 11px，不比原生控件大。
- **但在视口外**：手机是抽屉式侧栏，关闭时 x 为负。用户要看切换器得先拉开抽屉 = **多一步操作**。
- 页面启动清单里已包含 `dsh-wbsync-spike/client.js`，证明前端半边确实被加载（不是「写了没跑」）。

桌面端同一份代码实测：`vw=1280`，`device-pill=61×17`，同在侧栏底部动作区。

## 5. 结论与建议

1. **技术上可行**：协议、Relay、Host 插件全部复用，只把 PWA 那一半换成 `client.js`。
2. **切换器放 `sidebar.footer.action`**（追加、安全），不要动 `sidebar.brand.name`。
3. **「真切换」（同一列表换数据源）代价很高**：`sidebar.workspaces` 被占且是 single，接管它等于重写整个浏览区。建议先做 **panel 式**（`main` + `panellist`），把「真切换」留到有明确收益时再评估。
4. **手机上的抽屉代价要认**：切换器藏在抽屉里。若要「一眼可见」，得在 `conversation.session.header`（会话页头部）也放一个镜像胶囊。
5. 独立 PWA 不必立刻删：可作为 iOS/无 App 环境的降级入口，两者共用同一套协议。

## 6. 复现与回滚

- 桌面端：把 bundle 里的 `index.js` / `client.js` / `package.json` 覆盖到 `~/.dsh/profiles/desktop/node_modules/dsh-wb-cloud-sync-host/`，重启 DSH。
- 手机端 spike 包：`files/home/node_modules/dsh-wbsync-spike/`，profile 备份在 `files/home/.dsh/profiles/web/package.json.bak-wbsync`。
- 回滚：恢复该备份并删除 spike 目录，重启 App。
- 排错入口：`files/home/dsh-web.log`；桌面端用 `ELECTRON_ENABLE_LOGGING=1` 启动，渲染进程 console 会转进 stderr。

---

## 7. 第二轮：面板接真数据（0.1.22）

假数据已替换为真链路：**配对 → GET /api/sessions → 列表**。

### 7.1 必须先解决的跨域

独立 PWA 由 Relay 同源托管，从来不需要 CORS；嵌进 WebView 后页面来自 `http://127.0.0.1:<port>`，
Relay 在另一台机器 → **必然跨域**。Relay 现在：

- 对所有响应回显 `Access-Control-Allow-Origin`（仅本机源 `127.0.0.1` / `localhost` / `[::1]`，可加配 `corsOrigins`）；
- 处理 `OPTIONS` 预检（204）；
- 暴露 `Content-Disposition`（下载票要用）。

**不放开 `*`**：CORS 决定「谁能发起请求」，放开它等于白送一半攻击面（令牌仍需 Authorization）。

### 7.2 一个层级错误

relay 的 `GET /api/sessions` 把 `host`（`{deviceId,name,platform,online,lastSeenAt}`）放在**响应顶层**，
不是每行一份。第一版面板从 `rows[0].host` 读，结果 `undefined`，界面永远显示「离线」且不报错。
已修并加断言。

### 7.3 已做的验证

| 项 | 结果 |
|---|---|
| 配对链路 | 生成码 → `/pair` → HMAC → `/pair/verify` 拿到令牌 ✓ |
| 会话接口 | `GET /api/sessions` 200，**24 行** ✓ |
| 模块加载 | 桌面页面启动清单含 `dsh-wb-cloud-sync-host/client.js` ✓ |
| 启动告警 | 无（`ELECTRON_ENABLE_LOGGING=1` 下 stderr 干净） |

### 7.4 未做：手机端点击级验证

当时手机 `192.168.0.100` ping 不通、无线调试端口也变了，无法驱动 WebView。复验步骤：

1. `adb connect <手机>:<端口>`；`adb shell am force-stop com.dsh.harness && am start -n com.dsh.harness/.MainActivity`
2. 把 `client.js`（模块 id 改成手机包的包名）推到手机插件目录；
3. `adb shell cat /proc/net/unix | grep webview_devtools_remote` 取套接字，
   `adb forward tcp:9222 localabstract:<套接字>`，用 CDP 读 DOM / 截图；
4. 面板里填 Relay 地址（电脑局域网 IP:8787）与配对码，确认列表出现真实会话。

### 7.5 会话内视图（0.1.23 已实现，未做运行时验证）

点进会话即进入对话视图，能力与边界：

| 能力 | 走哪条通道 | 说明 |
|---|---|---|
| 读事件流 | `WS /d/<host>/events/<session>?token&sinceSeq` | 与 PWA 同一条通道；重连带 sinceSeq 交给 Relay 补齐 |
| 发消息 | `POST /d/<host>/session/prompt` | 带 `clientMsgId` 幂等键；**手机不造 user/message** |
| 答审批 | `POST /d/<host>/$events/result` | `allowed-once` / `rejected` |

**生命周期是本轮的关键差异**：组件会被卸载，所以 WS 在 cleanup 里关闭、丢弃尾包，
`lastSeq` 存模块级缓存以便重挂载续读。PWA 里这些都不需要，因为 WS 属于页面。

**尚未实现**：产物卡片与下载（协议已有一次性票据，前端未接）、定时任务、改名/置顶/归档。

### 7.6 运行时验证清单（待执行）

1. 起 Relay（`node p1/relay/run.mjs`）与 DSH；
2. 手机连上电脑（Relay 地址 + 配对码）；
3. 进会话确认：历史事件渲染、新消息实时到达、断网 10s 后恢复不丢不重、审批卡可作答；
4. 切到别的面板再回来，确认连接被收掉且不重复堆叠（模块级 lastSeq 生效）。

---

## 8. 为什么最终选了「镜像」（ADR-012）

### 8.1 先把「换数据源」排除了

要让原生列表显示电脑会话，最干净的当然是**只换数据源**。探过宿主实现后确认不可行：

- 客户端各服务的 `remote` 是**构造时由调用方注入**：`constructor(ctx, remote, model) { this.remote = remote }`；
- `TypertRemoteService.typertRemote` 是 `readonly`；
- `ctx.typert.remotes.register()` 注册的是**命名空间**（声明有哪些方法），不是新的传输通道。

结论：客户端只认一个 transport，它指向手机自己的 host。**没有「切到另一台 host」的公开接口。**

### 8.2 于是只剩镜像

把电脑的会话**原始文件**搬到手机本地会话库，登记进 `storages/workspace.json` 的 `sessionIds`。
宿主于是"真的拥有"这些会话，侧栏列表与会话页**完全是原生的**，一行 UI 都不用写。

代价：正文落盘。因此 ADR-012 把 ADR-010 改成**有条件的承诺**（默认不落盘，显式开启才落盘）。

### 8.3 本轮进度

| 步骤 | 状态 |
|---|---|
| ADR-012 决策记录 | ✓ |
| 电脑侧只读导出（`session/mirror-list` / `session/mirror-file`，分块 512 KiB） | ✓（5 条测试） |
| 手机侧落盘 + `workspace.json` 登记 | 未做（下一步） |
| 界面开关 / 体积显示 / 一键清理 | 未做 |

### 8.4 下一步的实现要点

1. 手机 host 插件拉 `mirror-list`，对每个会话按 512 KiB 分块取文件，**原子写入**
   `sessions/<cwd编码>/<sid>/`（先写 `.part` 再 rename，避免半截文件被当成合法会话）；
2. 更新 `storages/workspace.json`：把 sid 追加到独立工作区「我的电脑（镜像）」的 `sessionIds`；
3. 调 `sessions.refresh()` 让侧栏立刻出现；
4. 清理：删除该工作区目录 + 从 `sessionIds` 摘除；
5. **不要**把镜像文件当作写目标：发消息/审批仍走 `session/prompt`、`$events/result`。
