#!/usr/bin/env node
/**
 * host-plugin 可安装 bundle 打包器
 * ---------------------------------------------------------------
 * 把 src/{index,replay,sessions}.js 合成**单文件自包含** `bundle/index.js`
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

const [helperReplay, helperSessions, mainSrc] = [read('src/replay.js'), read('src/sessions.js'), read('src/index.js')]

// ---- 冲突检测：三个模块合并进同一作用域，顶层重名会静默覆盖 ----
const groups = [topLevelNames(helperReplay, 'replay.js'), topLevelNames(helperSessions, 'sessions.js'), topLevelNames(mainSrc, 'index.js')]
const seen = new Map()
for (const [names, label] of groups) {
  for (const n of names) {
    if (seen.has(n)) throw new Error(`顶层命名冲突：${n} 同时出现在 ${seen.get(n)} 与 ${label}`)
    seen.set(n, label)
  }
}

// ---- helpers：去掉 export，原样内联 ----
const helpers = `// ===== 内联自 src/replay.js（重启后历史补齐，只读回放） =====\n${stripExports(helperReplay).trim()}
// ===== 内联自 src/sessions.js（会话索引上报） =====\n${stripExports(helperSessions).trim()}`

// ---- 主模块：去掉相对导入；apply 改名 __apply（wrapper 接管配置合并） ----
if (!/^import \{ createReplayAdapter \} from '\.\/replay\.js'$/m.test(mainSrc)
  || !/^import \{ createSessionIndexReporter \} from '\.\/sessions\.js'$/m.test(mainSrc)) {
  throw new Error('src/index.js 的相对导入与打包器预期不一致——请同步更新本脚本')
}
const main = mainSrc
  .replace(/^import \{ createReplayAdapter \} from '\.\/replay\.js'\n/m, '')
  .replace(/^import \{ createSessionIndexReporter \} from '\.\/sessions\.js'\n/m, '')
  .replace(/^export function apply\(/m, 'function __apply(')
if (!main.includes('function __apply(')) throw new Error('apply 改名失败')

const BANNER = `/**
 * dsh-wb-cloud-sync-host · P1 W3 Host 插件可安装 bundle（**自动生成，勿手改**）
 * ---------------------------------------------------------------
 * 由 p1/host-plugin/build-bundle.mjs 从 src/{index,replay,sessions}.js 合成：
 * 改源码后运行 \`node p1/host-plugin/build-bundle.mjs\` 重新生成（CI 有 --check 同步校验）。
 * 外层 wrapper 负责默认配置：代码默认 ← ~/.dsh/wbsync-host.json ← WBSYNC_* 环境变量 ← apply 的 config。
 */
import { readFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
`

const WRAPPER = `
// ===== bundle wrapper：默认配置解析（真机零配置试跑：本机 Relay + 主机名当 deviceId） =====
const BUNDLE_DEFAULTS = () => ({
  relayUrl: 'http://127.0.0.1:8787',
  deviceId: hostname(),          // 试跑期 deviceId = PC 主机名；正式部署从配置文件 / 环境变量给稳定 ID
  hostToken: '',
})
const loadFileConfig = () => {
  try { return JSON.parse(readFileSync(join(homedir(), '.dsh', 'wbsync-host.json'), 'utf8')) } catch { return {} }
}
const envConfig = () => Object.fromEntries(Object.entries({
  relayUrl: process.env.WBSYNC_RELAY_URL,
  deviceId: process.env.WBSYNC_DEVICE_ID,
  hostToken: process.env.WBSYNC_HOST_TOKEN,
}).filter(([, v]) => v !== undefined))

export function apply(ctx, config = {}) {
  return __apply(ctx, { ...BUNDLE_DEFAULTS(), ...loadFileConfig(), ...envConfig(), ...config })
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
