# wb-cloud-sync · W1 Spike

**WB-Cloud-Sync 的 DSH 宿主接缝验证仓库**。根目录本身就是一个**可直接装进 DSH 的探针 bundle**（`dsh-wb-cloud-sync-spike`），用来在真机上跑 `09_风险登记册.md` R-02 的 P0 门禁三问。

> ⚠️ **这不是 P1 产品插件**，不会同步任何会话、不连 Relay、不发消息。它只读、只取证、只注册一条状态路由。
> 完整取证结论与 7 处文档偏差见 [`spike/REPORT.md`](spike/REPORT.md)。

---

## 在 DSH 里安装（三种方式）

### 方式 A · 本地 tarball（最稳，推荐）

绕开 GitHub 直装可能触发的 pnpm `allowBuilds` 拦截与 codeload 卡顿。本仓库已把打好的包放进 `dist/`。

```bash
git clone git@github.com:Benson-Cao/wb-cloud-sync.git
cd wb-cloud-sync
dsh plugin --profile web add ./dist/dsh-wb-cloud-sync-spike-0.1.0.tgz
# 完全退出 DSH 桌面版后执行，再重启桌面版
```

### 方式 B · Git 仓库直装

在 DSH 设置 → 插件管理 →「添加插件」→「Git 仓库」粘贴：

```
https://github.com/Benson-Cao/wb-cloud-sync
```

或 CLI（spec 形式视 DSH 版本而定）：

```bash
dsh plugin --profile web add git+https://github.com/Benson-Cao/wb-cloud-sync.git
```

本包**没有任何 install/postinstall 构建脚本**，纯 ESM 单文件，因此不会触发 pnpm 构建脚本授权。

### 方式 C · 只装探针、不想 clone

下载 `dist/dsh-wb-cloud-sync-spike-0.1.0.tgz`（仓库页面或 Release 附件），然后 `dsh plugin --profile web add <下载路径>`。

---

## 怎么确认装上了

**1. 插件树里能找到这一行**

```bash
dsh --profile web --dump-config | grep wb-cloud-sync-spike
```

**2. 状态路由返回探针结果**

```bash
# ⚠️ 本机若有全局 http_proxy，测 localhost 必须绕代理，否则会拿到代理的 404/502
curl --noproxy '*' -s http://127.0.0.1:3080/__wbsync/spike
```

`dsh web` 默认 3080；桌面版端口以实际为准。返回 `{"ok":true,"data":{...}}`，重点看：

| 字段 | 期望 | 说明 |
|---|---|---|
| `services.sessionPersistence.present` | `true` | Q3：持久化服务已注入 |
| `services.sessionPersistence.methods` | 含 `list` / `open` | Q3：枚举与只读回放能力 |
| `services.webServer.register` | `true` | 本地具名路由可用 |
| `eventShapes[]` | 聊一句后出现 `type/seq/data/seq` 形状 | Q1：事件订阅生效，`subjectId` 来自 `session.header.id` |

**3. 证据文件**

```
$DSH_HOME/wbsync-spike/probe.json     # 未设 DSH_HOME 时为 ~/.dsh/wbsync-spike/probe.json
```

**4. 卸载后无残留（TC-4.10）**

```bash
dsh plugin --profile web remove dsh-wb-cloud-sync-spike
curl --noproxy '*' -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3080/__wbsync/spike   # 期望 404
```

所有注册都经 `ctx.effect` 返回 disposer，卸载应撤回监听与路由。

---

## 这个仓库里有什么

```
.
├─ package.json                 # dsh.bundle manifest（根目录即插件包）
├─ cordis.patch.yml             # - insert 形式的 bundle patch
├─ index.js                     # 探针插件入口（纯 ESM，无构建、无依赖）
├─ dist/*.tgz                   # 预打好的可安装 tarball
├─ pinned-commit.txt            # DSH 锁定基线（当前 upstream_commit=UNRESOLVED）
├─ spike/
│  ├─ REPORT.md                 # W1 Spike 报告：三问判定 + 7 处文档偏差 + P0 门禁
│  ├─ README.md                 # 取证脚本运行说明
│  ├─ probe-host.mjs            # 三问离线取证（解析 app.asar + 真实会话日志）
│  ├─ check-plugin.mjs          # 隔离 DSH_HOME + mock Context 加载验证
│  ├─ probe-plugin.mjs          # 探针的离线可测副本
│  ├─ lib/                      # ASAR 读取器 / 多帧 zstd 解码器
│  └─ evidence/                 # 脱敏后的证据 JSON
└─ LICENSE (MIT)
```

---

## 三问结论速览

| 问 | 判定 | 关键证据 |
|---|---|---|
| Q1 连续 `seq` 事件订阅 | PASS | 真实日志 370 帧 → 667 事件，`seq` 0→666 连续且等于事件数 |
| Q2 不经写句柄提交用户消息 | PASS | 宿主 `dsh-api-session-controller.prompt(request)` + `requestId` 原生幂等 + `SessionAlreadyOwnedError` 单写者 |
| Q3 枚举与只读回放 | PASS | `list()` / `open(id,access)` / `persistContiguous`；`sinceSeq=400` 补齐 266/266 |

**P0 门禁整体仍未过**：真机加载待本仓库验证、`upstream_commit=UNRESOLVED`、文档会签待签、04 协议需按 D-01/02/07 回填。详见报告。

---

## 取证脚本复跑（零依赖，Node 22+）

```bash
node spike/probe-host.mjs      # 需要本机 app.asar；可用 WBSYNC_ASAR 指定路径
node spike/check-plugin.mjs    # 隔离临时 DSH_HOME，不碰真实 ~/.dsh
```

`probe-host.mjs` 只读本机 Electron 发行包与真实会话日志，**不写入任何会话数据**。所有输出只含结构元数据，不含事件正文、文件内容或令牌。

---

## 兼容性与边界

- 宿主实测：`@deepseek-ai/dsh-desktop` **0.2.2-rc.1**（`dsh.engines.dsh` 已按此声明）。DSH 处于 Developer Preview，升级前请重跑 Spike。
- 本机取证环境是 Windows；Linux / macOS 请显式传 `WBSYNC_ASAR`。
- 探针不声明 `dsh.client`：验证靠状态路由与 `probe.json`，没有设置页入口，也不受 client 元数据缓存影响。
- 仓库内 `spike/evidence/*.json` 已脱敏（去掉宿主源码片段）；完整证据保留在取证机本地。
