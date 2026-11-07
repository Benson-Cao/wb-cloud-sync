#!/usr/bin/env node
/**
 * WB-Cloud-Sync · W1 Spike 取证主脚本
 * ---------------------------------------------------------------
 * 对应 09 风险登记册 R-02 的 P0 门禁三问：
 *   Q1 能否订阅到带连续 seq 的会话事件？
 *   Q2 能否在不打开写句柄的前提下，把一条用户消息交给当前轮次的 owner？
 *   Q3 sessionPersistence.list() / open(id,'read') 能否枚举与只读回放？
 *
 * 取证来源（全部只读）：
 *   - Electron app.asar 内的 @deepseek-ai 宿主源码（公开 npm 包内容）
 *   - DSH_HOME/sessions 下真实 append-only 日志
 *   - 进程环境与 profile 元数据
 *
 * 不做的事：不改 DSH 内核、不写会话日志、不启动 Agent、不碰用户前台。
 * 输出：spike/evidence/host-probe.json（不含任何事件正文 / 文件内容）
 *
 * 可移植性：所有路径可由环境变量覆盖，便于在 CI 三平台 / 真机复跑。
 *   WBSYNC_ASAR     app.asar 路径
 *   DSH_HOME        取证用 DSH_HOME（默认 %USERPROFILE%/.dsh）
 *   WBSYNC_OUT      证据输出目录
 */
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { openAsar } from './lib/asar.mjs'
import { decodeSessionLog, summarize, readSince, findLargestSessionLog } from './lib/session-log.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = process.env.WBSYNC_OUT ?? join(HERE, 'evidence')
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const ASAR = process.env.WBSYNC_ASAR ??
  'D:/Program AI/Deepseek Harness/resources/app.asar'

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
function sha256(path) {
  return new Promise((done, fail) => {
    const h = createHash('sha256')
    const s = createReadStream(path)
    s.on('data', (c) => h.update(c))
    s.on('end', () => done(h.digest('hex')))
    s.on('error', fail)
  })
}
function cmd(file, args) {
  try { return execFileSync(file, args, { encoding: 'utf8', timeout: 8000 }).trim() }
  catch { return null }
}
/** 在源码里找关键词，返回命中次数 + 少量脱敏上下文。 */
function scan(files, asar, needle) {
  const hits = []
  let total = 0
  for (const f of files) {
    const text = asar.read(f.path, 2_000_000)
    if (text === null) continue
    let at = text.indexOf(needle)
    while (at >= 0) {
      total++
      if (hits.length < 3) {
        hits.push({
          file: f.path.replace('/dsh/node_modules/@deepseek-ai/', ''),
          snippet: text.slice(Math.max(0, at - 100), at + 170).replace(/\s+/g, ' ').slice(0, 260),
        })
      }
      at = text.indexOf(needle, at + 1)
      if (total > 400) break
    }
    if (total > 400) break
  }
  return { total, hits }
}

// ---------------------------------------------------------------------------
// 1. 环境
// ---------------------------------------------------------------------------
const nodeVersion = process.versions.node
const nodeMajor = Number(nodeVersion.split('.')[0])
const env = {
  capturedAt: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  nodeVersion,
  nodeSatisfies249: nodeMajor > 24 || (nodeMajor === 24 && Number(nodeVersion.split('.')[1]) >= 9),
  nodeOptions: process.env.NODE_OPTIONS ?? null,
  nodeOptionsHasStripTypesGuard: /--no-experimental-strip-types/.test(process.env.NODE_OPTIONS ?? ''),
  pnpmVersion: cmd('pnpm', ['-v']),
  corepackVersion: cmd('corepack', ['-v']),
  dshCliOnPath: cmd('dsh', ['--version']),
  dshHome: DSH_HOME,
  dshHomeExists: existsSync(DSH_HOME),
  asarPath: ASAR,
  asarExists: existsSync(ASAR),
}

// ---------------------------------------------------------------------------
// 2. 打开宿主源码
// ---------------------------------------------------------------------------
if (!env.asarExists) {
  console.error(`[FATAL] 找不到 app.asar：${ASAR}\n  用 WBSYNC_ASAR=<path> 指定。`)
  process.exit(2)
}
const asar = openAsar(ASAR)
env.asarSha256 = await sha256(ASAR)
const pkg = asar.readJson('/package.json')
const dshPkg = asar.readJson('/dsh/node_modules/@deepseek-ai/dsh/package.json')
env.host = {
  desktopPackage: pkg?.name ?? null,
  version: pkg?.version ?? dshPkg?.version ?? null,
  upstreamRepo: dshPkg?.repository?.url ?? dshPkg?.repository ?? null,
  upstreamGitHead: dshPkg?.gitHead ?? null, // npm 包通常不带，需要上游仓库取 SHA
  asarFileCount: asar.fileCount,
}

const sourceFiles = asar.list(/^\/dsh\/node_modules\/@deepseek-ai\/.*\.(js|ts|mjs|cjs)$/)
  .filter((f) => f.size > 0 && f.size <= 2_000_000)

// ---------------------------------------------------------------------------
// 3. Q1 —— 事件订阅与 seq
// ---------------------------------------------------------------------------
const q1Seams = {
  'session/event': scan(sourceFiles, asar, 'session/event'),
  'ctx.on("session/event"': scan(sourceFiles, asar, 'ctx.on("session/event"'),
  "ctx.on('session/event'": scan(sourceFiles, asar, "ctx.on('session/event'"),
  'persistContiguous': scan(sourceFiles, asar, 'persistContiguous'),
}
const logSample = findLargestSessionLog(DSH_HOME)
let q1Log = null
if (logSample) {
  const raw = readFileSync(logSample.path)
  const decoded = decodeSessionLog(raw)
  const summary = summarize(decoded.records)
  const events = decoded.records.filter((r) => r && r.type !== 'session' && typeof r.seq === 'number')
  const cut = Math.max(0, Math.floor(events.length * 0.6))
  const replay = readSince(events, events[cut]?.seq ?? 0)
  q1Log = {
    file: logSample.sessionDir,
    compressedBytes: logSample.size,
    zstdFrames: decoded.frames,
    records: decoded.records.length,
    decodeErrors: decoded.errors.length,
    totalSessionLogs: logSample.totalLogs,
    ...summary,
    replay: {
      sinceSeq: events[cut]?.seq ?? 0,
      expected: events.length - cut - 1,
      ...replay,
      seqs: undefined, // 不把整段 seq 列表写进证据
    },
  }
}
const q1Pass = Boolean(
  q1Seams['session/event'].total > 0 &&
  (q1Seams['ctx.on("session/event"'].total + q1Seams["ctx.on('session/event'"].total) > 0 &&
  q1Log && q1Log.decodeErrors === 0 && q1Log.contiguous && q1Log.seqEqualsLogLength &&
  Object.keys(q1Log.eventShapes).some((k) => k === 'data,seq,time,type'),
)

// ---------------------------------------------------------------------------
// 4. Q2 —— 宿主提交入口（R-02 的决定性一问）
// ---------------------------------------------------------------------------
const q2Seams = {
  'async prompt(request': scan(sourceFiles, asar, 'async prompt(request'),
  'hasPromptRequest': scan(sourceFiles, asar, 'function hasPromptRequest'),
  'rpcId 幂等键': scan(sourceFiles, asar, 'source.rpcId === requestId'),
  'user-rpc 来源': scan(sourceFiles, asar, '"user-rpc"'),
  'SessionAlreadyOwnedError': scan(sourceFiles, asar, 'SessionAlreadyOwnedError'),
  'session/writer-held': scan(sourceFiles, asar, 'session/writer-held'),
  'open(id,\'write\') 调用': scan(sourceFiles, asar, ".open(id, 'write')"),
}
const q2Pass = Boolean(
  q2Seams['async prompt(request'].total > 0 &&
  q2Seams['hasPromptRequest'].total > 0 &&
  q2Seams['SessionAlreadyOwnedError'].total > 0,
)

// ---------------------------------------------------------------------------
// 5. Q3 —— 持久化枚举 / 只读回放
// ---------------------------------------------------------------------------
const q3Seams = {
  'async list(options': scan(sourceFiles, asar, 'async list(options'),
  'async open(id, access': scan(sourceFiles, asar, 'async open(id, access'),
  'read 句柄': scan(sourceFiles, asar, 'access === "read"'),
  'async append(events': scan(sourceFiles, asar, 'async append(events'),
  'assertOpen': scan(sourceFiles, asar, 'assertOpen('),
  'ctx.get("sessionPersistence")': scan(sourceFiles, asar, 'ctx.get("sessionPersistence")'),
}
const q3Pass = Boolean(
  q3Seams['async list(options'].total > 0 &&
  q3Seams['async open(id, access'].total > 0 &&
  q3Seams['read 句柄'].total > 0 &&
  q1Log && q1Log.replay.returned === q1Log.replay.expected,
)

// ---------------------------------------------------------------------------
// 6. 文档假设 vs 实测（不判定对错，只把差异摆出来给 ADR 会签）
// ---------------------------------------------------------------------------
const knownTypes = ['system/message', 'user/message', 'assistant/message', 'tool/result',
  'assistant/chunk', 'turn/start', 'turn/end', 'step/start', 'step/end', 'tool/call',
  'request/header', 'todo/write', 'hook/invoked', 'hook/result', 'request/context',
  'session/end-seed', 'compaction/start', 'compaction/summary', 'compaction/end']
const observedTypes = Object.keys(q1Log?.eventTypes ?? {})
const docDeltas = [
  {
    id: 'D-01', doc: '04 §3 / FR-4.3 / TC-1.3', topic: 'assistant/chunk 折叠',
    observed: { presentInLog: observedTypes.includes('assistant/chunk'), sampleEventTypes: observedTypes.length },
    note: '真实日志按最终 assistant/message 落盘；流式 chunk 是否被持久化需在真机跑一轮确认',
  },
  {
    id: 'D-02', doc: '04 §3 / FR-4.2 / BR-4 / TC-1.2', topic: '未知事件 ignorable 标记',
    observed: { ignorableFieldCount: q1Log?.ignorableFieldCount ?? null, unlistedTypes: observedTypes.filter((t) => !knownTypes.includes(t)) },
    note: '客户端会对着大量未分类事件；需明确默认跳过策略',
  },
  {
    id: 'D-03', doc: '06 §3.2 最小骨架', topic: "ctx.on('session/event') 第一参数",
    observed: { subscriptionSnippet: (q1Seams['ctx.on("session/event"'].hits[0] ?? q1Seams["ctx.on('session/event'"].hits[0])?.snippet ?? null },
    note: '宿主订阅回调首参是 session 对象，不是 sessionId 字符串；骨架里直接当 id 透传会出错',
  },
  {
    id: 'D-04', doc: '04 §2 / ADR-001', topic: '自建 Idempotency 与 RouteLease 表',
    observed: { hostNativeIdempotency: q2Seams['hasPromptRequest'].total > 0, hostNativeWriterLease: q2Seams['SessionAlreadyOwnedError'].total > 0 },
    note: '宿主已用 requestId/rpcId 幂等 + SessionAlreadyOwnedError 单写者；CP 自建表的必要性需重评',
  },
  {
    id: 'D-05', doc: '04 §2 SessionHeader 注释', topic: 'parentSession / origin 字段',
    observed: { headerKeys: q1Log?.headerKeys ?? [] },
    note: '样本 header 未出现这两个字段（可能可选，不能断言不存在）',
  },
  {
    id: 'D-06', doc: '00 / 06 §1 环境基线', topic: 'Node ≥ 24.9 与 pnpm 11',
    observed: { nodeVersion, pnpmVersion: env.pnpmVersion, dshCliOnPath: env.dshCliOnPath },
    note: '本机不满足基线；Spike 离线取证不受影响，但 P1 构建链需先补齐',
  },
  {
    id: 'D-07', doc: '04 §3 / FR-4.3 / TC-1.3', topic: 'surfaceOp 与 sourceEventSeqs 真实语义',
    observed: {
      surfaceOps: q1Log?.surfaceOps ?? {},
      sourceRefsByType: q1Log?.sourceRefsByType ?? {},
      eventShapes: q1Log?.eventShapes ?? {},
    },
    note: '宿主事件自带 surfaceOp 投影指令；sourceEventSeqs 实测只出现在 tool/result 上用于关联 tool/call，并非 chunk 折叠字段；04 §3 的折叠规则需改写',
  },
]

// ---------------------------------------------------------------------------
// 7. 结论
// ---------------------------------------------------------------------------
const verdicts = { Q1: q1Pass ? 'PASS' : 'FAIL', Q2: q2Pass ? 'PASS' : 'FAIL', Q3: q3Pass ? 'PASS' : 'FAIL' }
const spikeGate = Object.values(verdicts).every((v) => v === 'PASS')
const report = {
  schema: 'wbsync-spike/1',
  env,
  questions: {
    Q1: { verdict: verdicts.Q1, seams: q1Seams, log: q1Log },
    Q2: { verdict: verdicts.Q2, seams: q2Seams },
    Q3: { verdict: verdicts.Q3, seams: q3Seams },
  },
  documentationDeltas: docDeltas,
  gate: {
    spikesPass: spikeGate,
    blockers: [
      !env.nodeSatisfies249 && 'ENV: Node < 24.9',
      !env.pnpmVersion && 'ENV: pnpm 未安装',
      !env.dshCliOnPath && 'ENV: dsh CLI 不在 PATH，真机加载验证走离线 mock',
    ].filter(Boolean),
    notes: [
      'PIN: 上游 commit 66491b05… 已由 tag dsh-v0.2.2-rc.1 解析并交叉验证，见 pinned-commit.txt',
      !env.host.upstreamGitHead && 'INFO: npm 包元数据不带 gitHead，SHA 来源为上游 tag 而非 npm',
    ].filter(Boolean),
  },
}

mkdirSync(OUT_DIR, { recursive: true })
const outFile = join(OUT_DIR, 'host-probe.json')

// 公开仓库合规：宿主 app.asar 内的源码片段不随证据提交。
// 默认写脱敏版；--full 额外在本机写完整版（已在 .gitignore 中排除）。
if (process.argv.includes('--full')) {
  writeFileSync(join(OUT_DIR, 'host-probe.full.json'), JSON.stringify(report, null, 2), 'utf8')
}
const published = JSON.parse(JSON.stringify(report))
for (const q of ['Q1', 'Q2', 'Q3']) {
  for (const seam of Object.values(published.questions[q].seams ?? {})) {
    for (const hit of seam.hits ?? []) delete hit.snippet
  }
}
for (const delta of published.documentationDeltas ?? []) {
  if (delta.observed && 'subscriptionSnippet' in delta.observed) delete delta.observed.subscriptionSnippet
}
published.redacted = '宿主源码片段已移除；在本机运行 node probe-host.mjs --full 可生成完整证据（不入库）'
writeFileSync(outFile, JSON.stringify(published, null, 2), 'utf8')
asar.close()

console.log('W1 Spike · 三问取证')
console.log('  host        :', env.host.desktopPackage, env.host.version, '| asar sha256', env.asarSha256.slice(0, 16))
console.log('  Q1 事件/seq :', verdicts.Q1, q1Log ? `| ${q1Log.zstdFrames} 帧 / ${q1Log.eventCount} 事件 / seq ${q1Log.firstSeq}..${q1Log.lastSeq} / 连续=${q1Log.contiguous}` : '')
console.log('  Q2 提交入口 :', verdicts.Q2, '| prompt=', q2Seams['async prompt(request'].total, '幂等=', q2Seams['hasPromptRequest'].total, '单写者=', q2Seams['SessionAlreadyOwnedError'].total)
console.log('  Q3 持久化   :', verdicts.Q3, '| list=', q3Seams['async list(options'].total, 'open=', q3Seams['async open(id, access'].total, '补齐=', q1Log?.replay.returned, '/', q1Log?.replay.expected)
console.log('  P0 Spike 门禁:', spikeGate ? 'PASS（三问全过）' : 'FAIL')
console.log('  非门禁阻塞   :', report.gate.blockers.join(' / ') || '无')
console.log('  证据         :', outFile)
process.exitCode = spikeGate ? 0 : 1
