# dsh-wb-cloud-sync-host · 可安装 bundle

> `index.js` 由 `p1/host-plugin/build-bundle.mjs` 从 `src/` **自动生成**（单文件自包含），勿手改。

## 安装

DSH → 插件 → 「添加插件」→ 选择 `dist/dsh-wb-cloud-sync-host-0.1.0.tgz`（由本目录 `npm pack` 产出）。

## 配置（缺省即可本机试跑）

| 来源 | 优先级（低→高） | 说明 |
|---|---|---|
| 代码默认 | 1 | `relayUrl: http://127.0.0.1:8787`、`deviceId: <主机名>`、`hostToken: ''` |
| `~/.dsh/wbsync-host.json` | 2 | `{ "relayUrl": "...", "deviceId": "...", "hostToken": "..." }` |
| `WBSYNC_RELAY_URL` / `WBSYNC_DEVICE_ID` / `WBSYNC_HOST_TOKEN` 环境变量 | 3 | 启动 DSH 前设置 |
| `apply(ctx, config)` 的 `config` | 4 | 宿主注入（骨架期测试用） |

本机试跑：先 `node p1/relay/run.mjs` 启动 Relay（未设令牌形态），插件装好后自动连上；
PC 打开本地路由 `http://127.0.0.1:<DSH端口>/__wbsync/pair` 生成 6 位码，手机在
`http://<局域网IP>:8787/app` 输码配对。

## 铁律（与源码一致）

- **绝不 `open(id,'write')`**：投递 / 新建 / 取消走可注入适配器，未注入回 409 `WRITER_UNAVAILABLE`
- 历史补齐绑 `sessionPersistence.open(id,'read')` **只读句柄**
- 所有注册与定时器挂 `ctx.effect`，卸载即撤回
