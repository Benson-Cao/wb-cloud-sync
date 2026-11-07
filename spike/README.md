# W1 Spike · 宿主接缝验证骨架

给 `09` R-02 的 P0 门禁提供**可复跑的证据**，回答三问：能否订阅连续 `seq` 事件、能否不经写句柄提交用户消息、能否枚举与只读回放会话。

设计前提：**只读取证**。不改 DSH 内核、不写 `~/.dsh` 日志、不启动 Agent、不改用户 profile、不碰前台。

---

## 跑起来（零依赖，只要 Node 22+）

```bash
cd wb-cloud-sync/spike
node probe-host.mjs            # 三问取证 → evidence/host-probe.json
node check-plugin.mjs          # 隔离 DSH_HOME 加载验证 → evidence/check-plugin.json
node check-plugin.mjs --real   # 额外输出真机验证建议命令（不自动执行）
```

退出码 `0` = 三问全过 / 加载验证通过；`1` = 有 FAIL；`2` = 找不到 app.asar。
当前实例结果见 `REPORT.md`。

> Node 22 的 `zlib.zstdDecompressSync` 已够用；06 §1 的 Node ≥ 24.9 是 **P1 构建链**要求，不影响本骨架取证。

---

## 目录

```
wb-cloud-sync/
├─ pinned-commit.txt              # DSH 锁定基线（当前 upstream_commit=UNRESOLVED）
├─ .gitignore
└─ spike/
   ├─ README.md                   # 本文
   ├─ REPORT.md                   # W1 Spike 报告：三问判定 + 7 处文档偏差 + P0 门禁
   ├─ probe-host.mjs              # 主脚本：环境 / Q1 / Q2 / Q3 / 偏差清单
   ├─ probe-plugin.mjs            # 最小探针插件（非 P1 产品代码）
   ├─ check-plugin.mjs            # 临时 DSH_HOME + mock Context 加载验证
   ├─ lib/
   │  ├─ asar.mjs                # 最小 Electron ASAR 读取器（只读，零依赖）
   │  └─ session-log.mjs         # 多帧 zstd 解码 / seq 校验 / readSince 补齐
   └─ evidence/
      ├─ host-probe.json          # 三问原始证据（入库，W1 会签附件）
      ├─ check-plugin.json        # 加载验证结果（入库）
      ├─ plugin-probe.json        # 探针运行时输出（忽略）
      └─ dsh-home-*/              # 隔离的临时 DSH_HOME（忽略）
```

---

## 路径覆盖（换机器 / CI 三平台复跑）

| 变量 | 默认 | 用途 |
|---|---|---|
| `WBSYNC_ASAR` | `D:/Program AI/Deepseek Harness/resources/app.asar` | 宿主发行包位置 |
| `DSH_HOME` | `%USERPROFILE%/.dsh` | 取证用真实会话日志目录（只读） |
| `WBSYNC_OUT` | `spike/evidence` | `host-probe.json` 输出目录 |
| `WBSYNC_SPIKE_OUT` | `evidence/plugin-probe.json` | 探针运行时证据输出 |

Linux / macOS 上请显式传 `WBSYNC_ASAR`；若本机没有桌面发行包，`probe-host.mjs` 会明确报错退出 2，不会静默降级成「猜测通过」。

---

## 判定口径

| 问 | PASS 条件 |
|---|---|
| Q1 | 宿主源码存在 `session/event` 订阅 + 真实日志解码 0 错 + 事件形状含 `data,seq,time,type` + `seq` 从 0 连续且等于事件数 |
| Q2 | 源码存在 `async prompt(request` + `hasPromptRequest` 幂等 + `SessionAlreadyOwnedError` 单写者 |
| Q3 | 源码存在 `list()` / `open(id, access)` / `read` 分支 + 真实日志 `readSince` 返回数等于期望数 |

`check-plugin.mjs` 的 R8（`Schema.object` 配置）对探针 **WAIVED**，因为探针故意零依赖；**P1 产品插件必须补上并改为强制**。真机模式 `SKIP` 时报告里会记为 PARTIAL，绝不伪装成 PASS。

---

## 证据纪律（对齐 `08` §8）

所有输出只包含结构元数据：`keys / type / seq / time / 计数 / 源码片段`。
**不写事件 `data` 正文、不写文件内容、不写令牌、不写本地绝对路径到日志**；`check-plugin.mjs` 用 `SENSITIVE-SHOULD-NOT-APPEAR` 做了一次回归断言（D6）。
