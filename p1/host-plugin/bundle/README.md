# dsh-wb-cloud-sync-host · 可安装 bundle

> `index.js` 由 `p1/host-plugin/build-bundle.mjs` 从 `src/` **自动生成**（单文件自包含），勿手改。

## 安装

DSH → 插件 → 「添加插件」→ 选择 `dist/dsh-wb-cloud-sync-host-0.1.3.tgz`（由本目录 `npm pack` 产出）。

## 配置（缺省即可本机试跑）

| 来源 | 优先级（低→高） | 说明 |
|---|---|---|
| 代码默认 | 1 | `relayUrl: http://127.0.0.1:8787`、`deviceId: <主机名>`、`hostToken: ''` |
| `~/.dsh/wbsync-host.json` | 2 | `{ "relayUrl": "...", "deviceId": "...", "hostToken": "..." }` |
| `WBSYNC_RELAY_URL` / `WBSYNC_DEVICE_ID` / `WBSYNC_HOST_TOKEN` 环境变量 | 3 | 启动 DSH 前设置 |
| `apply(ctx, config)` 的 `config` | 4 | 宿主注入（骨架期测试用） |

本机试跑：先 `node p1/relay/run.mjs` 启动 Relay（未设令牌形态），插件装好后自动连上；
PC 浏览器地址栏打开 `http://127.0.0.1:<DSH端口>/__wbsync/pair` 生成 6 位码（DSH web
端口是动态的，用 `netstat -ano | findstr <DSH进程PID>` 查 LISTENING 行），手机在
`http://<局域网IP>:8787/app` 输码配对。

## 宿主入口（0.1.2 起）

插件软探测 `sessionController`：`create()` 负责新建会话、`prompt()` 负责发第一句话与后续投递
（`clientMsgId` → `requestId`，宿主原生幂等）。**绝不 `open(id,'write')`**。服务缺失时相关操作
如实回 409 `WRITER_UNAVAILABLE`；取消入口未取证，暂保持 409。

## 铁律（与源码一致）

- **绝不 `open(id,'write')`**：投递 / 新建走宿主入口，缺失回 409 `WRITER_UNAVAILABLE`
- 历史补齐绑 `sessionPersistence.open(id,'read')` **只读句柄**
- 所有注册与定时器挂 `ctx.effect`，卸载即撤回
