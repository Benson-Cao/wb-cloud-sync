#!/usr/bin/env node
/**
 * WB-Cloud-Sync · check-plugin.mjs
 * ---------------------------------------------------------------
 * 对齐 06 §6「临时 DSH_HOME 里真正加载 apply(ctx) 看有没有报错」与
 * 07 TC-4.10「插件卸载后无残留路由 / 定时器 / 监听」。
 *
 * 两种模式：
 *   默认（离线）：构造隔离的临时 DSH_HOME + mock Context，真正 import 探针并调用 apply。
 *                 无需安装 DSH、无需 pnpm，可在三平台 CI 零依赖跑。
 *   --real      ：检测 dsh CLI 是否可用，只输出**待人工执行的命令**，不自动装包、
 *                 不改用户 profile、不重启 DSH（避免抢用户前台）。
 *
 * 输出：spike/evidence/check-plugin.json
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const EVIDENCE = join(HERE, 'evidence')
const PLUGIN = join(HERE, 'probe-plugin.mjs')
mkdirSync(EVIDENCE, { recursive: true })

const cmd = (file, args) => {
  try { return execFileSync(file, args, { encoding: 'utf8', timeout: 8000 }).trim() }
  catch { return null }
}

// ---------------------------------------------------------------------------
// 1. 隔离的临时 DSH_HOME（07 §2：禁止复用开发者日常 ~/.dsh）
// ---------------------------------------------------------------------------
const tempHome = mkdtempSync(join(EVIDENCE, 'dsh-home-'))
for (const dir of ['sessions', 'profiles/wbsync-spike', 'wbsync-spike']) {
  mkdirSync(join(tempHome, dir), { recursive: true })
}
writeFileSync(join(tempHome, 'profiles/wbsync-spike/cordis.yml'), '# spike-only profile\n[]\n', 'utf8')
writeFileSync(join(tempHome, 'profiles/wbsync-spike/package.json'),
  JSON.stringify({ name: 'dsh-profile-wbsync-spike', private: true, dsh: { profile: { bundles: [] } } }, null, 2), 'utf8')
process.env.DSH_HOME = tempHome
process.env.WBSYNC_SPIKE_OUT = join(EVIDENCE, 'plugin-probe.json')

// ---------------------------------------------------------------------------
// 2. 静态检查（06 §3.3 五条铁律的可自动判定部分）
// ---------------------------------------------------------------------------
const source = readFileSync(PLUGIN, 'utf8')
const rules = [
  { id: 'R1', label: '具名导出 name', pattern: /export const name\s*=/, expect: 'present' },
  { id: 'R2', label: 'inject 声明依赖', pattern: /export const inject\s*=/, expect: 'present' },
  { id: 'R3', label: '所有注册放进 ctx.effect', pattern: /ctx\.effect\s*\(/, expect: 'present' },
  { id: 'R4', label: 'effect 返回 disposer', pattern: /return\s*\(\)\s*=>/, expect: 'present' },
  { id: 'R5', label: "禁止 open(id,'write')", pattern: /\.open\s*\([^)]*['"]write['"]/, expect: 'absent' },
  { id: 'R6', label: '禁止 append 写入', pattern: /\.append\s*\(/, expect: 'absent' },
  { id: 'R7', label: '事件回调不落正文', pattern: /event\.data/, expect: 'absent' },
]
const staticResults = rules.map((r) => {
  const hit = r.pattern.test(source)
  return { ...r, pattern: r.pattern.source, verdict: (r.expect === 'present' ? hit : !hit) ? 'PASS' : 'FAIL' }
})
// R8 是产品插件铁律；探针为保持零依赖故意豁免，P1 骨架必须补上并改为强制
staticResults.push({
  id: 'R8', label: 'Config 用 Schema.object（P1 强制）',
  pattern: 'Schema\\.object\\s*\\(', expect: 'present',
  verdict: /Schema\.object\s*\(/.test(source) ? 'PASS' : 'WAIVED',
  reason: '探针插件零依赖复跑，故意不引 schemastery；P1 产品插件不得豁免',
})

// ---------------------------------------------------------------------------
// 3. 动态加载：mock Context 真正调用 apply(ctx, config)
// ---------------------------------------------------------------------------
function createMockContext() {
  const state = { listeners: new Map(), routes: new Map(), effects: [], calls: [], disposed: [] }
  const ctx = {
    on(name, cb) {
      if (!state.listeners.has(name)) state.listeners.set(name, new Set())
      state.listeners.get(name).add(cb)
      state.calls.push(`on:${name}`)
      return () => { state.listeners.get(name)?.delete(cb); state.disposed.push(`listener:${name}`) }
    },
    effect(fn, label) {
      state.calls.push(`effect:${label ?? 'anonymous'}`)
      const disposer = fn()
      if (typeof disposer === 'function') state.effects.push({ label: label ?? null, disposer })
      return () => { /* Cordis 侧由框架统一撤销 */ }
    },
    webServer: {
      register(opts) {
        const key = `${opts.kind}:${opts.path}`
        if (state.routes.has(key)) throw new Error(`重复注册同 kind+path: ${key}`) // 04 §6 契约
        state.routes.set(key, opts)
        state.calls.push(`route:${key}`)
        return () => { state.routes.delete(key); state.disposed.push(`route:${key}`) }
      },
    },
    sessionPersistence: {
      async list() { state.calls.push('persistence:list'); return [] },
      async open(id, access) { state.calls.push(`persistence:open:${id}:${access}`); return {} },
      async append() { throw new Error('SPIKE GUARD: 探针不得 append') },
      create: undefined,
    },
    get(name) { return name === 'sessionPersistence' ? ctx.sessionPersistence : undefined },
    inject(names, fn) { state.calls.push(`inject:${names.join(',')}`); return fn(ctx) },
    logger: { info() {}, warn() {}, error() {} },
  }
  return { ctx, state }
}

const dynamic = { loaded: false, checks: [], errors: [] }
let probe = null
try {
  const mod = await import(pathToFileURL(PLUGIN).href)
  const { ctx, state } = createMockContext()
  probe = mod.apply(ctx, { runList: false })

  dynamic.loaded = true
  dynamic.checks.push({ id: 'D1', label: 'apply() 不抛错', verdict: 'PASS' })
  dynamic.checks.push({ id: 'D2', label: 'name 唯一可读', verdict: mod.name === 'wbsync-spike-probe' ? 'PASS' : 'FAIL', observed: mod.name })
  const injectOk = Array.isArray(mod.inject) && ['webServer', 'sessionPersistence'].every((k) => mod.inject.includes(k))
  dynamic.checks.push({ id: 'D3', label: 'inject 含 webServer + sessionPersistence', verdict: injectOk ? 'PASS' : 'FAIL', observed: mod.inject })
  dynamic.checks.push({ id: 'D4', label: '订阅 session/event', verdict: state.listeners.has('session/event') ? 'PASS' : 'FAIL' })
  dynamic.checks.push({ id: 'D5', label: '注册 exact 路由', verdict: state.routes.has('exact:/__wbsync/spike') ? 'PASS' : 'FAIL', observed: [...state.routes.keys()] })

  // 模拟一次事件，确认探针只记录结构、不落 data 正文
  const listener = [...(state.listeners.get('session/event') ?? [])][0]
  if (listener) {
    listener({ header: { id: 'spike-session-id' } }, { type: 'user/message', seq: 7, time: 1, data: { text: 'SENSITIVE-SHOULD-NOT-APPEAR' } })
    const shape = probe.eventShapes[0] ?? {}
    dynamic.checks.push({
      id: 'D6', label: '事件回调只留结构，不落 data 正文',
      verdict: shape.type === 'user/message' && shape.seq === 7 && !JSON.stringify(probe).includes('SENSITIVE') ? 'PASS' : 'FAIL',
      observed: shape,
    })
  } else {
    dynamic.checks.push({ id: 'D6', label: '事件回调只留结构', verdict: 'FAIL', observed: 'no listener' })
  }

  // 执行全部 disposer —— TC-4.10 的离线等价验证
  for (const e of state.effects) e.disposer()
  const residualListeners = [...state.listeners.values()].reduce((n, set) => n + set.size, 0)
  dynamic.checks.push({
    id: 'D7', label: '卸载后无残留监听/路由',
    verdict: residualListeners === 0 && state.routes.size === 0 ? 'PASS' : 'FAIL',
    observed: { residualListeners, residualRoutes: state.routes.size, disposals: state.disposed },
  })
  dynamic.checks.push({
    id: 'D8', label: '证据文件写出',
    verdict: existsSync(process.env.WBSYNC_SPIKE_OUT) ? 'PASS' : 'FAIL',
    observed: process.env.WBSYNC_SPIKE_OUT,
  })
  dynamic.services = probe.services
  dynamic.calls = state.calls
} catch (error) {
  dynamic.errors.push(String(error?.stack ?? error))
}

// ---------------------------------------------------------------------------
// 4. 真机模式（只给命令，绝不自动改用户 profile / 重启 DSH）
// ---------------------------------------------------------------------------
let real = { verdict: 'NOT_REQUESTED' }
if (process.argv.includes('--real')) {
  const dsh = cmd('dsh', ['--version'])
  if (!dsh) {
    real = { verdict: 'SKIP', reason: 'dsh CLI 不在 PATH；本机无法自动做真机加载验证', dshCliDetected: null }
  } else {
    real = {
      verdict: 'MANUAL', dshCliDetected: dsh,
      reason: '真机验证需新建独立 profile 并重启 DSH，涉及用户桌面进程，本脚本不代为执行',
      commands: [
        'dsh --profile wbsync-spike --dump-config',
        'dsh plugin --profile wbsync-spike add ./spike/probe-plugin.mjs   # 或打包为 tgz',
        'dsh --profile wbsync-spike --dump-config   # 确认 wbsync-spike-probe 出现在插件树',
        '# 查看 DSH_HOME/wbsync-spike/probe.json 取得运行时接缝证据',
      ],
    }
  }
}

const requiredPass = staticResults.every((r) => r.verdict === 'PASS' || r.verdict === 'WAIVED') &&
  dynamic.loaded && dynamic.checks.every((c) => c.verdict === 'PASS')
const report = {
  schema: 'wbsync-spike-check/1',
  capturedAt: new Date().toISOString(),
  tempDshHome: tempHome,
  nodeVersion: process.versions.node,
  staticRules: staticResults,
  dynamic,
  real,
  verdict: requiredPass ? 'PASS' : 'FAIL',
}
writeFileSync(join(EVIDENCE, 'check-plugin.json'), JSON.stringify(report, null, 2), 'utf8')

console.log('check-plugin · 临时 DSH_HOME 加载验证')
console.log('  temp home   :', tempHome)
for (const r of staticResults) console.log(`  ${r.id} ${r.verdict.padEnd(6)} ${r.label}`)
for (const c of dynamic.checks) console.log(`  ${c.id} ${c.verdict.padEnd(6)} ${c.label}`)
if (dynamic.errors.length) console.log('  ERRORS      :', dynamic.errors.join('\n'))
console.log('  real mode   :', real.verdict, real.reason ?? '')
console.log('  verdict     :', report.verdict)
console.log('  evidence    :', join(EVIDENCE, 'check-plugin.json'))
process.exitCode = requiredPass ? 0 : 1
