#!/usr/bin/env node
/**
 * host-plugin 可安装 bundle 打包器
 * ---------------------------------------------------------------
 * 把 src/{index,replay,sessions,host-adapters}.js 合成**单文件自包含** `bundle/index.js`
 * （对齐 P0 探针已验证可安装的形态：单入口 + cordis.patch.yml 的 - insert: 层，
 * 不声明 dsh.client），并在外面包一层**默认配置解析**：
 *
 *   apply(ctx, config) 的 config = 代码默认 ← ~/.dsh/wbsync-host.json ← 环境变量 ← 调用方 config
 *
 * 用法：
 *   node p1/host-plugin/build-bundle.mjs           # 生成/覆盖 bundle/index.js
 *   node p1/host-plugin/build-bundle.mjs --check   # 只比对，不一致 exit 1（CI 用）
 *
 * 打包：cd p1/host-plugin/bundle && npm pack --pack-destination ../../../dist
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const checkOnly = process.argv.includes('--check')

const read = (p) => readFileSync(join(here, p), 'utf8')

/** 提取模块顶层声明名（const / let / function / class），用于冲突检测。 */
const topLevelNames = (source, label) => {
  const names = []
  for (const m of source.matchAll(/^(?:export\s+)?(?:const|let|function|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    names.push(m[1])
  }
  return [names, label]
}

const stripExports = (source) => source.replace(/^export\s+(?=const|let|function|class)/gm, '')

const [helperReplay, helperSessions, helperHostAdapters, mainSrc] = [
  read('src/replay.js'), read('src/sessions.js'), read('src/host-adapters.js'), read('src/index.js'),
]

// ---- 冲突检测：四个模块合并进同一作用域，顶层重名会静默覆盖 ----
const groups = [
  topLevelNames(helperReplay, 'replay.js'),
  topLevelNames(helperSessions, 'sessions.js'),
  topLevelNames(helperHostAdapters, 'host-adapters.js'),
  topLevelNames(mainSrc, 'index.js'),
]
const seen = new Map()
for (const [names, label] of groups) {
  for (const n of names) {
    if (seen.has(n)) throw new Error(`顶层命名冲突：${n} 同时出现在 ${seen.get(n)} 与 ${label}`)
    seen.set(n, label)
  }
}

// ---- helpers：去掉 export，原样内联 ----
const helpers = `// ===== 内联自 src/replay.js（重启后历史补齐，只读回放） =====\n${stripExports(helperReplay).trim()}
// ===== 内联自 src/sessions.js（会话索引上报） =====\n${stripExports(helperSessions).trim()}
// ===== 内联自 src/host-adapters.js（宿主真实入口：create / prompt 软探测） =====\n${stripExports(helperHostAdapters).trim()}`

// ---- 主模块：去掉相对导入；apply 改名 __apply（wrapper 接管配置合并） ----
const EXPECTED_IMPORTS = [
  /^import \{ createReplayAdapter \} from '\.\/replay\.js'$/m,
  /^import \{ createSessionIndexReporter \} from '\.\/sessions\.js'$/m,
  /^import \{ createHostAdapters \} from '\.\/host-adapters\.js'$/m,
]
for (const pattern of EXPECTED_IMPORTS) {
  if (!pattern.test(mainSrc)) throw new Error('src/index.js 的相对导入与打包器预期不一致——请同步更新本脚本')
}
const main = mainSrc
  .replace(/^import \{ createReplayAdapter \} from '\.\/replay\.js'\n/m, '')
  .replace(/^import \{ createSessionIndexReporter \} from '\.\/sessions\.js'\n/m, '')
  .replace(/^import \{ createHostAdapters \} from '\.\/host-adapters\.js'\n/m, '')
  .replace(/^export function apply\(/m, 'function __apply(')
if (!main.includes('function __apply(')) throw new Error('apply 改名失败')

const BANNER = `/**
 * dsh-wb-cloud-sync-host · P1 W3 Host 插件可安装 bundle（**自动生成，勿手改**）
 * ---------------------------------------------------------------
 * 由 p1/host-plugin/build-bundle.mjs 从 src/{index,replay,sessions,host-adapters}.js 合成：
 * 改源码后运行 \`node p1/host-plugin/build-bundle.mjs\` 重新生成（CI 有 --check 同步校验）。
 * 外层 wrapper 负责默认配置：代码默认 ← ~/.dsh/wbsync-host.json ← WBSYNC_* 环境变量 ← apply 的 config。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
`

const WRAPPER = `
// ===== bundle wrapper：稳定 deviceId + 默认配置解析 =====
const HOST_CONFIG_PATH = () =>
  process.env.WBSYNC_HOST_CONFIG || join(homedir(), '.dsh', 'wbsync-host.json')

const loadFileConfig = () => {
  try { return JSON.parse(readFileSync(HOST_CONFIG_PATH(), 'utf8')) } catch { return {} }
}

/**
 * deviceId 必须跨重启稳定：手机侧令牌按 deviceId 登记，Host 每次换 ID 会让
 * 旧令牌失效、会话索引串到另一台设备名下。
 * 优先读配置文件；缺失则生成 host-<uuid> 并以 0600 落盘；落盘失败退回主机名。
 */
const resolveStableDeviceId = (cfg) => {
  const file = HOST_CONFIG_PATH()
  if (typeof cfg.deviceId === 'string' && cfg.deviceId.trim()) return cfg.deviceId.trim()
  cfg.deviceId = 'host-' + randomUUID()
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(cfg, null, 2), { mode: 0o600 })
  } catch { cfg.deviceId = hostname() }
  return cfg.deviceId
}

const envConfig = () => Object.fromEntries(Object.entries({
  relayUrl: process.env.WBSYNC_RELAY_URL,
  deviceId: process.env.WBSYNC_DEVICE_ID,
  hostToken: process.env.WBSYNC_HOST_TOKEN,
}).filter(([, v]) => v !== undefined))

export function apply(ctx, config = {}) {
  const fileCfg = loadFileConfig()
  const env = envConfig()
  // 显式 deviceId（apply config > 环境变量）优先；否则用持久化的稳定 ID
  const explicit = config.deviceId ?? env.deviceId ?? fileCfg.deviceId
  const deviceId = (typeof explicit === 'string' && explicit.trim())
    ? explicit.trim()
    : resolveStableDeviceId(fileCfg)
  return __apply(ctx, {
    relayUrl: 'http://127.0.0.1:8787',
    hostToken: '',
    ...fileCfg, ...env, ...config,
    deviceId,
  })
}
`

const out = `${BANNER}\n${helpers}\n\n// ===== 主模块 src/index.js =====\n${main.trim()}\n${WRAPPER}`

if (checkOnly) {
  const current = read('bundle/index.js')
  if (current !== out) {
    console.error('bundle/index.js 与 src/ 不一致——运行 node p1/host-plugin/build-bundle.mjs 重新生成')
    process.exit(1)
  }
  console.log('bundle/index.js 与 src/ 一致')
} else {
  writeFileSync(join(here, 'bundle/index.js'), out)
  console.log(`bundle/index.js 已生成（${out.length} 字节，单文件自包含）`)
}
