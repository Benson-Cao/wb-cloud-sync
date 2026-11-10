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
 * 注意区分两个 Node：**当前进程（构建链）** vs **DSH 宿主进程（运行时）**。
 * 后者从真机探针的 probe.json 读取，并明确标注为历史证据、带采集时点。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
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

const nodeVersion = process.versions.node
const [major, minor] = nodeVersion.split('.').map(Number)
const meets249 = major > 24 || (major === 24 && minor >= 9)
const pnpmProbe = probe('pnpm', ['-v'])
const corepackProbe = probe('corepack', ['-v'])
const npmProbe = probe('npm', ['-v'])
const dshProbe = probe('dsh', ['--version'])
const nodeOptions = process.env.NODE_OPTIONS ?? null
const stripGuard = /--no-experimental-strip-types/.test(nodeOptions ?? '')

// 历史证据：真机探针记录的 DSH 宿主进程 Node，不是当前进程
let dshRuntime = null
const probePath = join(homedir(), '.dsh', 'wbsync-spike', 'probe.json')
if (existsSync(probePath)) {
  try {
    const probe = JSON.parse(readFileSync(probePath, 'utf8'))
    dshRuntime = {
      nodeVersion: probe.nodeVersion ?? null,
      capturedAt: probe.capturedAt ?? null,
      pluginName: probe.pluginName ?? null,
      note: '来自 2026-11-07 真机探针的启动快照，是宿主运行时而非构建链；会过期，不可当作当前环境证明',
    }
  } catch { /* 证据损坏时留 null */ }
}

const checks = [
  { id: 'E1', label: '构建链 Node ≥ 24.9', pass: meets249, observed: `v${nodeVersion}` },
  { id: 'E2', label: 'pnpm 11.x 可用', pass: /^11\./.test(pnpmProbe.value ?? ''), observed: pnpmProbe.value ?? 'NOT_INSTALLED' },
  { id: 'E3', label: 'Corepack 可用（用于启用 pnpm 11）', pass: corepackProbe.present, observed: corepackProbe.value ?? 'NOT_INSTALLED' },
  { id: 'E4', label: 'NODE_OPTIONS 不含 --no-experimental-strip-types', pass: !stripGuard, observed: nodeOptions ?? '<empty>' },
  { id: 'E5', label: 'dsh CLI 在 PATH', pass: dshProbe.present, observed: dshProbe.value ?? 'NOT_IN_PATH' },
]
const passed = checks.filter((c) => c.pass).length

const result = {
  schema: 'wbsync-env-check/1',
  capturedAt: new Date().toISOString(),
  platform: process.platform,
  scope: '构建链（当前进程），不是 DSH 宿主运行时',
  tools: {
    npm: npmProbe.value,
    pnpm: pnpmProbe.value,
    corepack: corepackProbe.value,
    dsh: dshProbe.value,
  },
  checks,
  passed,
  total: checks.length,
  verdict: passed === checks.length ? 'READY' : 'NOT_READY',
  dshRuntime,
  remediation: [
    'pnpm 11：corepack prepare pnpm@11.28.5 --activate（corepack 已装）；如需 shim 再 corepack enable',
    'Node ≥ 24.9：CI 已用 Node 24；本地请自行升级，**不要改 WorkBuddy 自带的 Node**',
    'dsh CLI：把 DSH 的 bin 加进 PATH，或直接用桌面版插件管理器（本机已验证可装）',
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
if (dshRuntime) {
  console.log(`  DSH 宿主运行时（历史证据）：Node ${dshRuntime.nodeVersion} @ ${dshRuntime.capturedAt}`)
}
if (!process.argv.includes('--check')) console.log('  证据:', out)

if (process.argv.includes('--check')) {
  process.exitCode = result.verdict === 'READY' ? 0 : 1
}
