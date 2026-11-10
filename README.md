# wb-cloud-sync · W1 Spike

[![gate](https://github.com/Benson-Cao/wb-cloud-sync/actions/workflows/gate.yml/badge.svg)](https://github.com/Benson-Cao/wb-cloud-sync/actions/workflows/gate.yml)

**WB-Cloud-Sync 的 DSH 宿主接缝验证仓库**：https://github.com/Benson-Cao/wb-cloud-sync

根目录本身就是一个**可直接装进 DSH 的探针 bundle**（`dsh-wb-cloud-sync-spike`），用来在真机上跑 `09_风险登记册.md` R-02 的 P0 门禁三问。

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

tarball 有稳定的 raw 直链，一行下载后本地安装：

```bash
curl -L -o dsh-wb-cloud-sync-spike-0.1.0.tgz \
  https://raw.githubusercontent.com/Benson-Cao/wb-cloud-sync/main/dist/dsh-wb-cloud-sync-spike-0.1.0.tgz
dsh plugin --profile web add ./dsh-wb-cloud-sync-spike-0.1.0.tgz
```

也可以从仓库页面 / Release 附件下载。直链已实测可达（HTTP 200），重新打包后可用 `sha256sum` 与仓库内 tgz 比对。

---

## 怎么确认装上了

**1. 插件树里能找到这一行**

```bash
dsh --profile web --dump-config | grep wb-cloud-sync-spike
```

**2. 状态路由返回探针结果**

桌面版端口是**动态分配**的，**重启后会变**（实测 18:41 前 `50973` → 18:49 重启后 `55056`；不是 3080）。先查 DSH 进程实际监听端口：

```powershell
Get-NetTCPConnection -State Listen | Where-Object {
  (Get-Process -Id $_.OwningProcess).ProcessName -match 'DeepSeek'
} | Select-Object LocalAddress, LocalPort
```

```bash
# ⚠️ 有全局 http_proxy 时测 localhost 必须绕代理，否则拿到的是代理的 404/502
PORT=55056   # 换成上面查到的端口，别写死
curl --noproxy '*' -s http://127.0.0.1:$PORT/__wbsync/spike
```

返回 `{"ok":true,"data":{...}}`，重点看：

| 字段 | 期望 | 说明 |
|---|---|---|
| `services.sessionPersistence.present` | `true` | Q3：持久化服务已注入 |
| `services.sessionPersistence.methods` | 含 `list` / `open` | Q3：枚举与只读回放；`read`/`append` 在 `open()` 返回的 handle 上，不在服务上 |
| `services.webServer.register` | `true` | 本地具名路由可用 |
| `eventShapes[]` | 聊一句后出现 `data,seq,time,type` 形状 | Q1：事件订阅生效，`subjectId` 来自 `session.header.id` |

**3. 证据文件**

```
$DSH_HOME/wbsync-spike/probe.json     # 未设 DSH_HOME 时为 ~/.dsh/wbsync-spike/probe.json
```

> `probe.json` 是 `apply()` 时的**启动快照**，不含后续事件；实时 `eventShapes` 看第 2 步的路由（返回同一个内存对象）。

**4. 卸载后无残留（TC-4.10）**

```bash
dsh plugin --profile web remove dsh-wb-cloud-sync-spike
curl --noproxy '*' -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/__wbsync/spike   # 期望 404
```

所有注册都经 `ctx.effect` 返回 disposer，卸载应撤回监听与路由。

### 真机验证结果（2026-11-07 18:10 · DSH Desktop 0.2.2-rc.1 / Windows）

装法：**方式 B · Git 仓库直装**，`pnpm-lock.yaml` pinned 到 `551778e`。**未触发 pnpm `allowBuilds` 授权**——本包没有 install/postinstall 脚本，说明 06 §4 / 10 §4 的担心只针对带构建脚本的 git 依赖。

| 检查 | 实测 |
|---|---|
| `~/.dsh/wbsync-spike/probe.json` | 存在，648 B，`errors: []`，18:10:44 生成 |
| `sessionPersistence` | `present: true`，方法 `list / open / create / flush` |
| `webServer` | `present: true`、`register: true`，`routeRegistered: exact:/__wbsync/spike` |
| 状态路由 | `127.0.0.1:50973/__wbsync/spike` → **HTTP 200** + 完整 probe JSON |
| DSH 进程 Node | **24.21.0**（≥ 24.9）；命令行 Node 仍 22.22.2、pnpm 未装、`dsh` CLI 不在 PATH |
| 端口辨析 | 3080 / 3081 / 3000 无监听；3082 → 502；9230 → 404；**50973 才是 webServer** |

**已验证**：插件进入 Loader 树、两个依赖服务注入成功、注册经 `ctx.effect`、具名路由可用。
**运行时闭环（18:34 补充）**：在 **PC 桌面版**发一句话后，落盘日志 9 帧 / 23 事件（`seq` 0→22），路由收到 **19 条事件、`seq` 4→22 连续**，窗口逐条一致；8/8 断言 PASS，含 D-03（首参是 session 对象）、D-07（运行时 `surfaceOp`）、不落事件正文。`probe.json` 仍 0 条而路由 19 条，实证「启动快照 vs 实时对象」。

> 手机端发的消息不会触发 PC 端探针——这正是 BR-1「同账号 ≠ 同数据，会话跟随执行位置」。

**卸载验证（18:41 · TC-4.10 真机 PASS，强证据）**：卸载后 `50973/__wbsync/spike` → **404**，profile 三处配置命中数 0，operations 日志 `remove/settled`；观测时主进程 PID 2196（14:14 启动）**未重启**，故为 `ctx.effect` disposer 运行时撤回。

> ⚠️ **18:49:52 DSH 重启过**（新 PID 26668，端口 **50973 → 55056**）。重启后 `55056/__wbsync/spike` 也是 404，但只证明「重启后没加载已卸载插件」，**不可复用上面的强证据结论**。完整时间线见 `SIGN-OFF.md` §四。顺带确认 3082 是 `dsh-engine-switch` 反向代理口（转发 3080 未启动故 502）；当时 webServer 是 50973、现在是 55056。

唯一残留是历史证据文件 `~/.dsh/wbsync-spike/probe.json`（不违反 TC-4.10，P1 产品插件需定保留 / 清理策略）。**P0 门禁自动项 9/9 PASS，只剩四方会签 + ADR 会签** → 见 [`SIGN-OFF.md`](SIGN-OFF.md)（会签包）与 `node scripts/gate-check.mjs --check`（自动核查）。

---

## 这个仓库里有什么

```
.
├─ package.json                 # dsh.bundle manifest（根目录即插件包）
├─ cordis.patch.yml             # - insert 形式的 bundle patch
├─ index.js                     # 探针插件入口（纯 ESM，无构建、无依赖）
├─ dist/*.tgz                   # 预打好的可安装 tarball
├─ PROTOCOL.md                  # 04 的发布副本（sync-protocol.mjs 单向生成）
├─ CHANGELOG.md                 # 契约变更记录（wbsync/1 r2）
├─ WORKBUDDY-REFERENCE.md       # WorkBuddy 手机/电脑端对标复核（r2 修订依据）
├─ P1-PREREQUISITES.md          # P1 开工前置四项提案（提议中，待会签裁定）
├─ SECURITY-REVIEW.md           # 安全 Owner 一页纸（5 行核对）
├─ SIGN-OFF.md                  # P0 会签包：自动项 9/9、待签 M1~M7、签署栏
├─ SIGN-OFF-PROCEDURE.md       # 人的会签操作卡（顺序 / 勾选 / 回写清单）
├─ SIGNOFF-WAIVER.md           # 发起人豁免记录（开发期跳过会签，GA 前补签）
├─ pinned-commit.txt            # DSH 锁定基线 66491b0…（dsh-v0.2.2-rc.1）
├─ docs/                        # 设计冻结包（11 份，含 ADR-007~010）
├─ scripts/
│  ├─ gate-check.mjs            # P0 门禁 v4（含 signoff 指纹组 + 多形态密钥扫描）
│  ├─ check-env.mjs             # M6b 构建链自检（含隔离工具链探测）
│  ├─ lib/tar.mjs               # 零依赖 tar 解析（G9 解包比对）
│  ├─ sync-protocol.mjs         # ADR-009：生成 PROTOCOL.md + --check CI 校验
│  ├─ apply-workbuddy-revisions.mjs # r2 对标复核修订（带断言与备份）
│  ├─ apply-r2-followups.mjs    # r2 遗留口径与 M6b 结论收口（带断言）
│  ├─ apply-p1-prereq-updates.mjs # P1 前置提案状态回填（带断言）
│  ├─ apply-gate-hardening.mjs  # 门禁 v4 文档同步（带断言）
│  ├─ toolchain-env.sh          # source 后前置隔离 Node 24 / pnpm 11
│  ├─ signoff-check.mjs         # 会签就绪终检（一条命令出签字清单）
│  ├─ apply-spike-revisions.mjs # v1.0→v1.1 文档修订（带断言与原文备份）
│  └─ apply-realdevice-updates.mjs # 真机结论回填（3 处，带断言）
├─ spike/
│  ├─ REPORT.md                 # W1 Spike 报告：三问判定 + 7 处文档偏差 + P0 门禁
│  ├─ README.md                 # 取证脚本运行说明
│  ├─ probe-host.mjs            # 三问离线取证（解析 app.asar + 真实会话日志）
│  ├─ check-plugin.mjs          # 隔离 DSH_HOME + mock Context 加载验证
│  ├─ probe-plugin.mjs          # 探针的离线可测副本
│  ├─ lib/                      # ASAR 读取器 / 多帧 zstd 解码器
│  └─ evidence/                 # 脱敏后的证据 JSON
├─ p1/                          # P1 开发代码（不进探针 tarball）
│  ├─ cp/                       # W3 控制面：设备 / 会话索引 / 写句柄租约 / 位点四张表（18 用例）
│  ├─ relay/                    # W3 Relay：配对 / Host WS 长连 / 手机事件订阅 / 跨实例共享 CP（27 用例）
│  ├─ host-plugin/              # W3 Host 插件：上行 / 下行分派 / 历史补齐 / 会话索引 / 可逆卸载（47 用例）
│  └─ pwa/                      # W3 手机侧：鉴权会话列表 + 事件订阅 + 断线重连补拉 + gap 回 Host 补齐（8 用例）
└─ LICENSE (MIT)
```

---

## 三问结论速览

| 问 | 判定 | 关键证据 |
|---|---|---|
| Q1 连续 `seq` 事件订阅 | PASS | 真实日志 370 帧 → 667 事件，`seq` 0→666 连续且等于事件数 |
| Q2 不经写句柄提交用户消息 | PASS | 宿主 `dsh-api-session-controller.prompt(request)` + `requestId` 原生幂等 + `SessionAlreadyOwnedError` 单写者 |
| Q3 枚举与只读回放 | PASS | `list()` / `open(id,access)` / `persistContiguous`；`sinceSeq=400` 补齐 266/266 |

**P0 门禁**：三问离线 PASS、真机加载 + 运行时事件闭环 8/8 PASS、上游 commit 锁定（`66491b0…`）、`04` 已修订至 `wbsync/1 r2`（含 WorkBuddy 对标复核）、自动项 9/9、快照 `CURRENT`、M6b 构建链 5/5 `READY`。**唯一剩余硬阻塞是四方会签**（ADR-007~010 均为「提议中」），完成前不得进入 P1 编码。P1 开工前置四项已有提案白皮书 `P1-PREREQUISITES.md`，可并入同一次会签裁定。详见 `SIGN-OFF.md` 与 `spike/REPORT.md` §5。

`docs/` 是设计冻结包的发布副本（含 v1.1 Spike 实测修订与 `wbsync/1 r2` 对标复核），唯一契约源是 `docs/04`；根 `PROTOCOL.md` 由脚本单向生成，字段变更须在同一 PR 同时改 `04` + `PROTOCOL.md` + `CHANGELOG.md`（06 §9 / ADR-009）。对标偏差与依据见 `WORKBUDDY-REFERENCE.md`。

---

## 取证脚本复跑（零依赖，Node 22+）

```bash
node spike/probe-host.mjs      # 需要本机 app.asar；可用 WBSYNC_ASAR 指定路径
node spike/check-plugin.mjs    # 隔离临时 DSH_HOME，不碰真实 ~/.dsh
```

`probe-host.mjs` 只读本机 Electron 发行包与真实会话日志，**不写入任何会话数据**。所有输出只含结构元数据，不含事件正文、文件内容或令牌。

### 本地构建链（M6b，已 READY）

```bash
source scripts/toolchain-env.sh   # 只在当前 shell 前置 PATH，不改系统环境变量
node -v                          # v24.22.2
pnpm -v                         # 11.28.11
node scripts/check-env.mjs --check   # 5/5 READY，exit 0
```

工具链装在工作区级 `../.wbsync-tools/`（仓库外、不入库），Node 24 LTS 的 SHA256 已与官方 `SHASUMS256.txt` 核对一致；**不覆盖系统 Node、不改全局 PATH**。CI 另用 `actions/setup-node` 24，不依赖本机工具链。

---

## 兼容性与边界

- 宿主实测：`@deepseek-ai/dsh-desktop` **0.2.2-rc.1**（`dsh.engines.dsh` 已按此声明）。DSH 处于 Developer Preview，升级前请重跑 Spike。
- 本机取证环境是 Windows；Linux / macOS 请显式传 `WBSYNC_ASAR`。
- 探针不声明 `dsh.client`：验证靠状态路由与 `probe.json`，没有设置页入口，也不受 client 元数据缓存影响。
- 仓库内 `spike/evidence/*.json` 已脱敏（去掉宿主源码片段）；完整证据保留在取证机本地。
