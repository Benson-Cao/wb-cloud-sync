#!/usr/bin/env node
/**
 * 构建链环境自检（对应 SIGN-OFF M6b）
 * ---------------------------------------------------------------
 * **只读**：不安装任何东西、不改 PATH、不动 corepack shim。
 * 目的：把「Node ≥24.9 + pnpm 11」从一句模糊的 NOT MET，变成可复跑、
 * 可量化、能贴进会签包的机器判定。
 *
 *   node scripts/check-env.mjs            # 打印 + 写 spike/evidence/env-check.json
 *   node scripts/check-env.mjs --check    # 达标 exit 0，否则 exit 1（供 P1 开工前自检）
 *
 * 注意区分三个 Node：
 *   ① 当前进程（可能是 WorkBuddy 自带的 22.x）；
 *   ② 隔离构建链（../.wbsync-tools/，不改系统 PATH）；
 *   ③ DSH 宿主进程（真机探针历史证据，会过期）。
 *
 * 2026-11-10 r2：新增 ② 的探测；修 E5 判据——桌面版 DSH 没有独立 `dsh` CLI，
 * 真机插件经 GUI 插件管理器安装并成功加载，原「dsh CLI 在 PATH」判据过窄，
 * 改为「插件安装通道可用」并写明依据，不放宽到无证据即通过。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
/** 工具链在工作区级、仓库外：不入库、不污染其它项目、不覆盖系统 node。 */
const TOOLCHAIN_ROOT = join(dirname(ROOT), '.wbsync-tools')

/** 在 PATH 里找可执行文件（含 Windows 的 .cmd / .exe 与无扩展名 wrapper）。 */
const findOnPath = (name) => {
  const sep = process.platform === 'win32' ? ';' : ':'
  const extensions = process.platform === 'win32' ? ['', '.cmd', '.exe'] : ['']
  for (const dir of (process.env.PATH ?? '').split(sep)) {
    if (!dir || dir.length < 3) continue
    for (const ext of extensions) {
      try { if (existsSync(join(dir, name + ext))) return join(dir, name + ext) }
      catch { /* PATH 里可能有非法片段，跳过 */ }
    }
  }
  return null
}

/**
 * 探测命令，返回 { value, present }。
 * Windows 上 `.cmd` shim 需要 cmd.exe，而当前沙箱禁用了它；Bash 能跑的是
 * 同目录的无扩展名 POSIX wrapper。直接执行失败时回落到「PATH 文件存在性」，
 * 避免把「已安装但读不到版本」误报成 NOT_INSTALLED。
 */
const probe = (name, args) => {
  const candidates = process.platform === 'win32' ? [name, `${name}.cmd`] : [name]
  for (const candidate of candidates) {
    try {
      return { value: execFileSync(candidate, args, { encoding: 'utf8', timeout: 8000 }).trim(), present: true }
    } catch { /* 试下一个候选 */ }
  }
  const shim = findOnPath(name)
  if (shim) return { value: `present (${shim})`, present: true }
  return { value: null, present: false }
}

const meets249 = (v) => {
  if (!v) return false
  const [major, minor] = String(v).replace(/^v/, '').split('.').map(Number)
  return major > 24 || (major === 24 && minor >= 9)
}

/** 探测隔离构建链：实际执行二进制取版本，不靠目录名猜。 */
const detectToolchain = () => {
  if (!existsSync(TOOLCHAIN_ROOT)) return null
  let nodePath = null
  try {
    const dir = readdirSync(TOOLCHAIN_ROOT).find((d) => /^node-v\d/.test(d))
    if (dir) {
      const candidate = process.platform === 'win32'
        ? join(TOOLCHAIN_ROOT, dir, 'node.exe')
        : join(TOOLCHAIN_ROOT, dir, 'bin', 'node')
      if (existsSync(candidate)) nodePath = candidate
    }
  } catch { /* 目录不可读即视为无工具链 */ }
  if (!nodePath) return null

  let nodeVersion = null
  let pnpmVersion = null
  try { nodeVersion = execFileSync(nodePath, ['-v'], { encoding: 'utf8', timeout: 8000 }).trim() }
  catch { return null }
  const pnpmCjs = join(TOOLCHAIN_ROOT, 'pnpm', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
  if (existsSync(pnpmCjs)) {
    try { pnpmVersion = execFileSync(nodePath, [pnpmCjs, '-v'], { encoding: 'utf8', timeout: 15000 }).trim() }
    catch { /* pnpm 不可用如实留 null */ }
  }
  return {
    root: TOOLCHAIN_ROOT,
    nodePath,
    nodeVersion,
    pnpmCjs: existsSync(pnpmCjs) ? pnpmCjs : null,
    pnpmVersion,
    note: '隔离构建链：只在 source scripts/toolchain-env.sh 后前置 PATH，不改系统环境变量',
  }
}

const toolchain = detectToolchain()
const nodeVersion = process.versions.node
const pnpmProbe = probe('pnpm', ['-v'])
const corepackProbe = probe('corepack', ['-v'])
const npmProbe = probe('npm', ['-v'])
const dshProbe = probe('dsh', ['--version'])
const nodeOptions = process.env.NODE_OPTIONS ?? null
const stripGuard = /--no-experimental-strip-types/.test(nodeOptions ?? '')

// E5 的第二类证据：桌面版 GUI 插件管理器曾成功加载插件（真机启动快照）。
// 只证明「安装通道存在」，不证明当前 DSH 仍装着我们这个插件。
const dshHome = join(homedir(), '.dsh')
const probePath = join(dshHome, 'wbsync-spike', 'probe.json')
let desktopInstallEvidence = null
let dshRuntime = null
if (existsSync(probePath)) {
  try {
    const evidence = JSON.parse(readFileSync(probePath, 'utf8'))
    dshRuntime = {
      nodeVersion: evidence.nodeVersion ?? null,
      capturedAt: evidence.capturedAt ?? null,
      pluginName: evidence.pluginName ?? null,
      note: '来自 2026-11-07 真机探针的启动快照，是宿主运行时而非构建链；会过期，不可当作当前环境证明',
    }
    if (Array.isArray(evidence.errors) && evidence.errors.length === 0 && evidence.pluginName) {
      desktopInstallEvidence = {
        pluginName: evidence.pluginName,
        capturedAt: evidence.capturedAt ?? null,
        note: '真机启动快照 errors=[] 且 pluginName 存在，证明桌面版插件安装/加载链路可用',
      }
    }
  } catch { /* 证据损坏时留 null */ }
}

const e1Current = meets249(nodeVersion)
const e1Toolchain = meets249(toolchain?.nodeVersion)
const e2Current = /^11\./.test(pnpmProbe.value ?? '')
const e2Toolchain = /^11\./.test(toolchain?.pnpmVersion ?? '')
const e5Pass = dshProbe.present || (existsSync(dshHome) && desktopInstallEvidence !== null)
const e5Observed = dshProbe.present
  ? dshProbe.value
  : desktopInstallEvidence
    ? `桌面版插件管理器（真机加载证据 ${desktopInstallEvidence.pluginName} @ ${desktopInstallEvidence.capturedAt}）`
    : 'NO_CHANNEL'

const checks = [
  {
    id: 'E1', label: '构建链 Node ≥ 24.9', pass: e1Current || e1Toolchain,
    observed: `当前进程 v${nodeVersion}${toolchain?.nodeVersion ? ` / 隔离工具链 ${toolchain.nodeVersion}` : ''}`,
    basis: e1Current ? '当前进程已达标' : e1Toolchain ? `隔离工具链 ${toolchain.nodePath} 实跑 -v 达标` : '未找到达标 Node',
  },
  {
    id: 'E2', label: 'pnpm 11.x 可用', pass: e2Current || e2Toolchain,
    observed: e2Toolchain ? `11.x (${toolchain.pnpmVersion}, 隔离工具链)` : (pnpmProbe.value ?? 'NOT_INSTALLED'),
    basis: e2Current ? 'PATH 中的 pnpm' : e2Toolchain ? `用隔离 Node 实跑 ${toolchain.pnpmCjs} -v` : '未找到 pnpm 11',
  },
  {
    id: 'E3', label: 'Corepack 可用（用于启用 pnpm 11）', pass: corepackProbe.present,
    observed: corepackProbe.value ?? 'NOT_INSTALLED', basis: 'PATH shim 存在性',
  },
  {
    id: 'E4', label: 'NODE_OPTIONS 不含 --no-experimental-strip-types', pass: !stripGuard,
    observed: nodeOptions ?? '<empty>', basis: '当前进程环境变量',
  },
  {
    id: 'E5', label: 'DSH 插件安装通道可用', pass: e5Pass,
    observed: e5Observed,
    basis: dshProbe.present
      ? 'dsh CLI 在 PATH'
      : desktopInstallEvidence
        ? '桌面版无独立 dsh CLI；以真机插件加载快照作通道证据（历史证据，仅证明链路存在）'
        : '无 dsh CLI，且无真机加载证据',
  },
]
const passed = checks.filter((c) => c.pass).length

const result = {
  schema: 'wbsync-env-check/2',
  capturedAt: new Date().toISOString(),
  platform: process.platform,
  scope: '构建链（当前进程 + 隔离工具链），不是 DSH 宿主运行时',
  tools: {
    npm: npmProbe.value,
    pnpm: pnpmProbe.value,
    corepack: corepackProbe.value,
    dsh: dshProbe.value,
  },
  toolchain,
  desktopInstallEvidence,
  checks,
  passed,
  total: checks.length,
  verdict: passed === checks.length ? 'READY' : 'NOT_READY',
  dshRuntime,
  remediation: [
    '启用隔离构建链：source scripts/toolchain-env.sh（只改当前 shell 的 PATH，不改系统/用户环境变量）',
    '工具链位置：../.wbsync-tools/（仓库外，不入库）；Node 24 LTS + pnpm 11，SHA256 与官方 SHASUMS256.txt 核对一致',
    'E5 判据修正：桌面版 DSH 无独立 dsh CLI，真机插件经 GUI 插件管理器安装并加载；dsh CLI 在 PATH 只是等价通道之一',
    'CI 用 actions/setup-node 24，不依赖本机工具链；本地工具链只服务 P1 开工',
  ],
}

const out = join(ROOT, 'spike/evidence/env-check.json')
if (!process.argv.includes('--check')) {
  writeFileSync(out, JSON.stringify(result, null, 2), 'utf8')
}

console.log('构建链环境自检 ·', result.capturedAt, '| scope:', result.scope)
for (const c of checks) {
  console.log(`  ${c.id} ${(c.pass ? 'PASS' : 'FAIL').padEnd(5)} ${c.label.padEnd(46)} ${c.observed}`)
}
console.log(`  ${passed}/${checks.length} | verdict: ${result.verdict}`)
if (toolchain) console.log(`  隔离工具链: ${toolchain.nodeVersion} / pnpm ${toolchain.pnpmVersion ?? 'n/a'} @ ${toolchain.root}`)
if (dshRuntime) {
  console.log(`  DSH 宿主运行时（历史证据）：Node ${dshRuntime.nodeVersion} @ ${dshRuntime.capturedAt}`)
}
if (!process.argv.includes('--check')) console.log('  证据:', out)

if (process.argv.includes('--check')) {
  process.exitCode = result.verdict === 'READY' ? 0 : 1
}
