#!/usr/bin/env node
/**
 * Relay 启动器（真机联调入口）
 * ---------------------------------------------------------------
 * 用法（仓库根）：
 *   node p1/relay/run.mjs
 *
 * 环境变量（都有默认值，真机试跑可不配）：
 *   PORT               监听端口，默认 8787
 *   HOST               监听地址，默认 0.0.0.0（手机要能访问，必须监听网卡）
 *   WBSYNC_HOST_TOKEN  Host 插件侧的注册令牌；**默认值仅限本机试跑**，
 *                      对外使用必须显式设置（插件 config 的 hostToken 与之一致）
 *   WBSYNC_ADMIN_TOKEN Relay 管理台令牌；设置后 /admin 与 /host/indexes 需 Bearer
 *   WBSYNC_CP_FILE     CP 落盘文件，默认 `~/.wbsync/cp.json`；设成 `:memory:` 关闭落盘
 *                      （关掉后重启即失忆：所有手机都得重新配对）
 *   WBSYNC_RELAY_CONFIG 配置文件，默认 `~/.wbsync/relay-config.json`
 *
 * **配置文件**（开机自启 / 计划任务用）：`{ port, host, hostToken, adminToken, cpFile }`
 * 都可省略。为什么要有它——计划任务里写密钥会跟着任务定义一起被看见，
 * 而配置文件在用户目录里、权限随用户；环境变量仍然**优先**，方便调试时临时覆盖。
 *
 * 启动后控制台会打印所有可用的「Relay 地址」（含局域网 IP）：
 *   - 手机浏览器打开  http://<局域网IP>:<PORT>/app          （PWA 壳页面）
 *   - PC 宿主插件配置 relayUrl = http://<局域网IP>:<PORT>，hostToken 同上
 */
import { createRelay, PROTOCOL } from './src/server.js'
import { createControlPlane } from '../cp/src/index.js'
import { createFileStore, defaultCpFile } from '../cp/src/persist.js'
import { readFileSync } from 'node:fs'
import { homedir, networkInterfaces } from 'node:os'
import { join } from 'node:path'

// 配置文件 → 环境变量 → 默认值（前者让自启不靠环境，后者让调试能临时覆盖）
const configFile = process.env.WBSYNC_RELAY_CONFIG ?? join(homedir(), '.wbsync', 'relay-config.json')
let fileCfg = {}
try { fileCfg = JSON.parse(readFileSync(configFile, 'utf8')) } catch { /* 没有就不读 */ }
const pick = (envKey, cfgKey, dflt) => process.env[envKey] ?? (fileCfg[cfgKey] ?? dflt)

const PORT = Number(pick('PORT', 'port', 8787))
const HOST = pick('HOST', 'host', '0.0.0.0')
const HOST_TOKEN = pick('WBSYNC_HOST_TOKEN', 'hostToken', '')
const ADMIN_TOKEN = pick('WBSYNC_ADMIN_TOKEN', 'adminToken', '')
const CP_FILE = pick('WBSYNC_CP_FILE', 'cpFile', defaultCpFile())
const CP_PERSIST = CP_FILE !== ':memory:'
// v2.3（r16）：期望的 DSH pinned commit；配置后注册帧声明的 dshCommit 不符即 COMMIT_DRIFT
const PINNED_DSH_COMMIT = pick('WBSYNC_PINNED_DSH_COMMIT', 'pinnedDshCommit', '')

if (!HOST_TOKEN) {
  console.warn('[wbsync] 未设置 WBSYNC_HOST_TOKEN——所有 /host/* 端点（注册 / 心跳 / 索引 / 轮询 / 应答）均不校验令牌，同网段任何人都能读帧与投毒（仅限本机试跑；对外必须显式设置）')
}

// 落盘：设备表与会话索引进文件，重启后手机不必重新配对。
// 租约与位点故意不存（见 p1/cp/src/persist.js 的说明）。
const store = CP_PERSIST ? createFileStore({ file: CP_FILE }) : null
const cp = createControlPlane({ persist: store, maxPhonesPerHost: Number(process.env.WBSYNC_MAX_PHONES ?? 8) })

const relay = createRelay({
  hostToken: HOST_TOKEN || undefined,
  adminToken: ADMIN_TOKEN || undefined,
  requestTimeoutMs: 10_000,
  controlPlane: cp,
  // r16：COMMIT_DRIFT 强制校验只在这里真正生效；不配 = 只落库展示不拦截
  pinnedDshCommit: PINNED_DSH_COMMIT || undefined,
})

const port = await relay.start(PORT, HOST)

const lanUrls = []
for (const nets of Object.values(networkInterfaces())) {
  for (const net of nets ?? []) {
    if (net.family !== 'IPv4' || net.internal) continue
    lanUrls.push(`http://${net.address}:${port}`)
  }
}

console.log(`[wbsync] Relay 已启动：${HOST}:${port}（协议 ${PROTOCOL}）`)
console.log('[wbsync] Relay 地址（手机 / PC 插件都用这些）：')
for (const url of lanUrls) {
  console.log(`  ${url}`)
  console.log(`    - 手机壳页面：${url}/app`)
  console.log(`    - PC 插件 relayUrl：${url}`)
}
if (!lanUrls.length) console.log('  （未发现局域网 IPv4 网卡——手机将无法访问，检查网络）')
console.log(`[wbsync] 本机回环：http://127.0.0.1:${port}/app`)
console.log('[wbsync] 健康检查：GET /health · 管理台：GET /admin' + (ADMIN_TOKEN ? '（需 Bearer）' : '（未设 adminToken，公开）'))
console.log(`[wbsync] 配置来源：${fileCfg && Object.keys(fileCfg).length ? configFile : '（仅环境变量/默认值）'} · hostToken ${HOST_TOKEN ? '已设置' : '未设置'} · pinnedDshCommit ${PINNED_DSH_COMMIT ? `已设置（COMMIT_DRIFT 拦截启用）` : '未设置（仅落库展示）'}`)
if (CP_PERSIST) {
  const r = cp.restoredSnapshot
  const tail = r ? ` 已恢复 ${r.devices} 台设备 / ${r.sessions} 个会话` : ''
  console.log(`[wbsync] CP 落盘：${CP_FILE}${tail}`)
  if (r && (r.droppedDevices || r.droppedSessions)) {
    console.log(`[wbsync] 加载时清理：丢弃设备 ${r.droppedDevices} / 会话 ${r.droppedSessions}（归属设备已不在或墓碑超 30 天）`)
  }
} else {
  console.warn('[wbsync] CP 落盘已关闭（WBSYNC_CP_FILE=:memory:）——重启会让所有手机掉配对')
}

const shutdown = async () => {
  console.log('\n[wbsync] 正在关闭…')
  cp.flush()              // 先把最后一笔改动写下去，再断连接
  await relay.stop()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
