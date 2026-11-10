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
 *
 * 启动后控制台会打印所有可用的「Relay 地址」（含局域网 IP）：
 *   - 手机浏览器打开  http://<局域网IP>:<PORT>/app          （PWA 壳页面）
 *   - PC 宿主插件配置 relayUrl = http://<局域网IP>:<PORT>，hostToken 同上
 */
import { createRelay } from './src/server.js'
import { networkInterfaces } from 'node:os'

const PORT = Number(process.env.PORT ?? 8787)
const HOST = process.env.HOST ?? '0.0.0.0'
const HOST_TOKEN = process.env.WBSYNC_HOST_TOKEN ?? ''
const ADMIN_TOKEN = process.env.WBSYNC_ADMIN_TOKEN ?? ''

if (!HOST_TOKEN) {
  console.warn('[wbsync] 未设置 WBSYNC_HOST_TOKEN——所有 /host/* 端点（注册 / 心跳 / 索引 / 轮询 / 应答）均不校验令牌，同网段任何人都能读帧与投毒（仅限本机试跑；对外必须显式设置）')
}

const relay = createRelay({
  hostToken: HOST_TOKEN || undefined,
  adminToken: ADMIN_TOKEN || undefined,
  requestTimeoutMs: 10_000,
})

const port = await relay.start(PORT, HOST)

const lanUrls = []
for (const nets of Object.values(networkInterfaces())) {
  for (const net of nets ?? []) {
    if (net.family !== 'IPv4' || net.internal) continue
    lanUrls.push(`http://${net.address}:${port}`)
  }
}

console.log(`[wbsync] Relay 已启动：${HOST}:${port}（协议 wbsync/1）`)
console.log('[wbsync] Relay 地址（手机 / PC 插件都用这些）：')
for (const url of lanUrls) {
  console.log(`  ${url}`)
  console.log(`    - 手机壳页面：${url}/app`)
  console.log(`    - PC 插件 relayUrl：${url}`)
}
if (!lanUrls.length) console.log('  （未发现局域网 IPv4 网卡——手机将无法访问，检查网络）')
console.log(`[wbsync] 本机回环：http://127.0.0.1:${port}/app`)
console.log('[wbsync] 健康检查：GET /health · 管理台：GET /admin' + (ADMIN_TOKEN ? '（需 Bearer）' : '（未设 adminToken，公开）'))

const shutdown = async () => {
  console.log('\n[wbsync] 正在关闭…')
  await relay.stop()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
