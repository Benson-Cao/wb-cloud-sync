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
