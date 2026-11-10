# dsh-wb-cloud-sync-host · 可安装 bundle

> `index.js` 由 `p1/host-plugin/build-bundle.mjs` 从 `src/` **自动生成**（单文件自包含），勿手改。

## 安装

DSH → 插件 → 「添加插件」→ 选择 `dist/dsh-wb-cloud-sync-host-0.1.6.tgz`（由本目录 `npm pack` 产出）。

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

## 宿主入口（0.1.6 定案）

每次调用**惰性重探**宿主服务（0.1.4 的启动期静态快照会漏掉晚注册依赖），按官方完整语义排序：

1. `sessionController.create({cwd})` —— `SessionController extends Service`，
   `super(ctx,"sessionController")`，官方「新建会话 + 侧栏可见」入口；
2. `sessionController.commands.create` / `sessionController.agents.createSession` —— 同义内部入口；
3. `agents.create({ sessionId, meta:{cwd} })` —— `AgentRegistry` 底层兜底，自铸 `session-<uuid>`；
4. `sessions.create` —— host 侧 **SessionRegistry** 的低层 entry 创建，末位；真机 0.1.4 已证实会抛
   `HOST_ADAPTER_ERROR`，保留只为如实报错。

`sessionController.prompt(request, signal)` 负责发第一句话与后续投递（`clientMsgId` →
`requestId`，宿主原生幂等）。**取消轮次**走官方 `sessionController.cancel({sessionId})`
（`session/cancel` 的 required 仅 `sessionId`，内部 `agent.cancel({kind:"user"},{keepInbox:true})`，
只中断当前轮次、保留待处理收件箱）；依次回退 `commands.cancel` / `agents.get(id).cancel`。
**绝不 `open(id,'write')`**；服务缺失时相关操作如实回 409 `WRITER_UNAVAILABLE`。

真机自检：PC 浏览器打开 `http://127.0.0.1:<DSH端口>/__wbsync/status`，看 `writer` / `messenger` /
`canceller` 与 `writer.probe`（含 `boot` 启动期快照、`lateBound` 晚到服务、逐服务 `methods` / `errors`）。
手机端新建 / 取消失败时会把宿主异常原文一并显示，不再只有一个错误码。

## 铁律（与源码一致）

- **绝不 `open(id,'write')`**：投递 / 新建 / 取消都走宿主入口，缺失回 409 `WRITER_UNAVAILABLE`
- 历史补齐绑 `sessionPersistence.open(id,'read')` **只读句柄**
- 所有注册与定时器挂 `ctx.effect`，卸载即撤回
