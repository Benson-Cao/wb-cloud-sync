#!/usr/bin/env node
/**
 * P3 W10 · 性能压测（docs/05 W10、docs/07 §8 TC-8.1 / §验收 158-161）
 * ---------------------------------------------------------------
 * 口径说明（别把这三个数混着看）：
 *   1. 帧延迟 = 手机 HTTP → Relay 帧 → 同进程 Host 应答 → HTTP 回包。衡量的是
 *      **Relay 搬运开销 + 事件循环调度**，不含跨网 RTT，所以是上界里的下限值。
 *   2. 事件端到端 = Host 打 t0 → Relay 广播 → 订阅端收到。对应 NFR-1 的
 *      「局域网 P95 < 300ms」，本机回环即局域网的最优情形。
 *   3. 并发 WS = 单实例同时挂住的 Host 长连数，对应「≥ 500」。
 *
 * 判据全部来自文档，不在这里现编：TC-8.1 P95<300ms、并发 WS≥500、10s 防悬挂。
 * 输出 spike/evidence/perf.json，PASS 退出 0，FAIL 退出 1。
 */
import { createHmac } from 'node:crypto'
import { writeFileSync, mkdirSync } from 'node:fs'
import { Agent, request as httpRequest } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cpus, platform, arch, release } from 'node:os'
import { createRelay, PROTOCOL } from '../p1/relay/src/server.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '..', 'spike', 'evidence', 'perf.json')
const args = process.argv.slice(2)
const QUICK = args.includes('--quick')

const CONFIG = {
  requestTimeoutMs: 10_000,
  frameSamples: QUICK ? 80 : 500,       // 帧延迟样本
  burstSamples: QUICK ? 40 : 200,       // 并发帧样本
  eventSamples: QUICK ? 100 : 1000,     // TC-8.1 的 1000 条
  wsConnections: QUICK ? 100 : 500,     // 并发 WS 下限
}

const LIMITS = {
  eventP95Ms: 300,      // TC-8.1 局域网 P95
  concurrentWs: 500,    // 单实例并发 WS
  hangMs: 10_000,       // 10s 防悬挂
}

const THRESHOLDS_MS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 5000, 10000]

const ms = (t) => Number(t) / 1e6
const nowMs = () => ms(process.hrtime.bigint())

const rnd = (() => {
  let n = 1
  return (size) => Buffer.alloc(size, (++n) & 0xff)
})()

const percentile = (sorted, p) => {
  if (!sorted.length) return 0
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx]
}

const round = (n, d = 3) => Number(n.toFixed(d))

export const histogram = (samples, buckets = THRESHOLDS_MS) => {
  const counts = buckets.map(() => 0)
  let overflow = 0
  for (const v of samples) {
    const i = buckets.findIndex((b) => v <= b)
    if (i < 0) overflow++
    else counts[i]++
  }
  return {
    buckets: buckets.map((b, i) => ({ leMs: b, count: counts[i] })),
    overflow,
    total: samples.length,
  }
}

export const summarize = (samples) => {
  const s = [...samples].sort((a, b) => a - b)
  return {
    count: s.length,
    minMs: round(s[0] ?? 0),
    p50Ms: round(percentile(s, 50)),
    p90Ms: round(percentile(s, 90)),
    p95Ms: round(percentile(s, 95)),
    p99Ms: round(percentile(s, 99)),
    maxMs: round(s[s.length - 1] ?? 0),
    meanMs: round(s.reduce((a, b) => a + b, 0) / (s.length || 1)),
  }
}

/* --------------------------------------------------------------- 夹具 */

/**
 * 用裸 http + 显式 keep-alive agent，不用 fetch。
 * 理由：undici 默认每 origin 只放少量连接，200 发并发会在**客户端**排队，
 * 测出来的是取连接的时间而不是 Relay 的搬运时间（实测这一项会把 P95 从
 * 个位数毫秒抬到 ~98ms，几乎全是排队尾巴）。maxSockets 给足才测得到服务端。
 */
const AGENT = new Agent({ keepAlive: true, maxSockets: 1024, maxFreeSockets: 1024 })

const makeCall = (port) => (path, { method = 'GET', body, token } = {}) => new Promise((resolve, reject) => {
  const payload = body === undefined ? null : JSON.stringify(body)
  const headers = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
  if (payload !== null) headers['Content-Length'] = Buffer.byteLength(payload)
  const req = httpRequest({ host: '127.0.0.1', port, path, method, headers, agent: AGENT }, (res) => {
    const chunks = []
    res.on('data', (c) => chunks.push(c))
    res.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      try { resolve({ status: res.statusCode, json: JSON.parse(text) }) }
      catch (e) { reject(new Error(`响应不是 JSON（${res.statusCode}）：${text.slice(0, 120)}`)) }
    })
  })
  req.on('error', reject)
  if (payload !== null) req.write(payload)
  req.end()
})

const pairDevice = async (call, deviceId) => {
  const g = await call('/pair/generate', { method: 'POST', body: { deviceId } })
  const c = await call('/pair', { method: 'POST', body: { code: g.json.data.code } })
  const sig = createHmac('sha256', c.json.data.pairSecret).update(c.json.data.challenge).digest('hex')
  const v = await call('/pair/verify', { method: 'POST', body: { challenge: c.json.data.challenge, sig, clientId: 'bench' } })
  if (v.status !== 200) throw new Error(`配对失败：${JSON.stringify(v.json)}`)
  return v.json.data.deviceToken
}

const openWs = (url) => new Promise((resolve, reject) => {
  const ws = new WebSocket(url)
  ws.addEventListener('open', () => resolve(ws), { once: true })
  ws.addEventListener('error', () => reject(new Error(`ws 连接失败：${url}`)), { once: true })
})

const closeWs = (ws) => new Promise((resolve) => {
  if (!ws || ws.readyState === WebSocket.CLOSED) return resolve()
  ws.addEventListener('close', () => resolve(), { once: true })
  ws.close()
})

/**
 * 极简订阅端：只把收到的 session/event 收进数组，不在回调里做任何耗时活，
 * 否则测到的是自己的处理时间而不是 Relay 广播延迟。
 */
const createSubscriber = (ws) => {
  const events = []
  let onEvent = null
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(String(e.data))
    if (m.t !== 'session/event') return
    events.push(m.ev)
    if (onEvent) onEvent(m.ev)
  })
  return {
    events,
    waitFor: (n, timeoutMs = CONFIG.requestTimeoutMs) => new Promise((resolve, reject) => {
      if (events.length >= n) return resolve()
      const timer = setTimeout(() => reject(new Error(`只收到 ${events.length}/${n} 条事件`)), timeoutMs)
      onEvent = () => {
        if (events.length >= n) { clearTimeout(timer); onEvent = null; resolve() }
      }
    }),
  }
}

/* --------------------------------------------------------------- 主流程 */

const run = async () => {
  const relay = createRelay({ hostToken: 'bench-secret', requestTimeoutMs: CONFIG.requestTimeoutMs, randomBytes: rnd })
  const port = await relay.start(0)
  const call = makeCall(port)
  const cases = []

  const add = (id, name, metric, value, threshold, unit = 'ms', extra = {}) => {
    const pass = extra.pass ?? (typeof threshold === 'number' ? value <= threshold : true)
    cases.push({ id, name, metric, value: round(value), threshold, unit, verdict: pass ? 'PASS' : 'FAIL', ...extra })
    return pass
  }

  /* --- B1 帧延迟（顺序）--- */
  const deviceId = 'bench-frame'
  const token = await pairDevice(call, deviceId)
  const hostWs = await openWs(`ws://127.0.0.1:${port}/ws/host`)
  const pendingFrames = []
  let responderOn = true
  hostWs.addEventListener('message', (e) => {
    const m = JSON.parse(String(e.data))
    if (m.t !== 'http/request') return
    if (!responderOn) { pendingFrames.push(m); return }
    hostWs.send(JSON.stringify({
      t: 'http/response', reqId: m.reqId, status: 200,
      body: { ok: true, data: { echo: m.body?.text ?? null }, protocol: PROTOCOL },
    }))
  })
  hostWs.send(JSON.stringify({ t: 'host/register', deviceId, hostToken: 'bench-secret' }))
  await new Promise((r) => setTimeout(r, 120))

  const frameSamples = []
  let failures = 0
  for (let i = 0; i < CONFIG.frameSamples; i++) {
    const t0 = nowMs()
    const r = await call(`/d/${deviceId}/session/prompt`, { method: 'POST', token, body: { text: `f${i}` } })
    const dt = nowMs() - t0
    if (r.status !== 200 || r.json.data.echo !== `f${i}`) failures++
    frameSamples.push(dt)
  }
  const frameStats = summarize(frameSamples)
  add('B1', '帧往返延迟（顺序）', 'P95', frameStats.p95Ms, LIMITS.eventP95Ms)
  add('B1b', '帧往返延迟（顺序）', '失败请求数', failures, 0, 'count',
    { pass: failures === 0, note: '状态码非 200 或响应串号都算失败' })

  /* --- B2 帧延迟（并发突发）--- */
  const burst = []
  for (let i = 0; i < CONFIG.burstSamples; i++) {
    const t0 = nowMs()
    burst.push(call(`/d/${deviceId}/session/prompt`, { method: 'POST', token, body: { text: `b${i}` } })
      .then((r) => ({ dt: nowMs() - t0, ok: r.status === 200 && r.json.data.echo === `b${i}` })))
  }
  const burstDone = await Promise.all(burst)
  const burstStats = summarize(burstDone.map((x) => x.dt))
  const burstBad = burstDone.filter((x) => !x.ok).length
  add('B2', `帧延迟（${CONFIG.burstSamples} 并发）`, 'P95', burstStats.p95Ms, LIMITS.eventP95Ms)
  add('B2b', `帧延迟（${CONFIG.burstSamples} 并发）`, '串号/失败数', burstBad, 0, 'count', { pass: burstBad === 0 })

  /* --- B3 事件端到端（TC-8.1 · 1000 条）--- */
  const subWs = await openWs(`ws://127.0.0.1:${port}/d/${deviceId}/events/bench-session?token=${token}&sinceSeq=-1`)
  const sub = createSubscriber(subWs)
  await new Promise((r) => setTimeout(r, 80))

  const eventSamples = []
  const sendEvent = (seq) => {
    hostWs.send(JSON.stringify({
      t: 'session/event', sessionId: 'bench-session',
      ev: { seq, kind: 'text/delta', t0: Date.now() },
    }))
  }
  // 逐条推送：贴近真实流式（每帧各自到达），不会把整批积压算进单条延迟
  for (let i = 0; i < CONFIG.eventSamples; i++) {
    sendEvent(i)
    if (i % 50 === 0) await new Promise((r) => setImmediate(r))
  }
  await sub.waitFor(CONFIG.eventSamples)
  for (const ev of sub.events) eventSamples.push(Date.now() - ev.t0)
  const eventStats = summarize(eventSamples)
  add('B3', `事件端到端（${CONFIG.eventSamples} 条 · 逐条）`, 'P95', eventStats.p95Ms, LIMITS.eventP95Ms,
    'ms', { note: 'docs/07 TC-8.1 局域网 P95 < 300ms；本机回环取最优情形' })
  add('B3b', `事件端到端（${CONFIG.eventSamples} 条 · 逐条）`, '丢帧数', CONFIG.eventSamples - sub.events.length, 0,
    'count', { pass: sub.events.length === CONFIG.eventSamples })

  /* --- B4 事件端到端（一次性灌 1000 条，最坏情形）--- */
  const blastSession = 'bench-blast'
  const sub2Ws = await openWs(`ws://127.0.0.1:${port}/d/${deviceId}/events/${blastSession}?token=${token}&sinceSeq=-1`)
  const sub2 = createSubscriber(sub2Ws)
  await new Promise((r) => setTimeout(r, 80))
  for (let i = 0; i < CONFIG.eventSamples; i++) {
    hostWs.send(JSON.stringify({
      t: 'session/event', sessionId: blastSession,
      ev: { seq: i, kind: 'text/delta', t0: Date.now() },
    }))
  }
  await sub2.waitFor(CONFIG.eventSamples)
  const blastStats = summarize(sub2.events.map((ev) => Date.now() - ev.t0))
  add('B4', `事件端到端（${CONFIG.eventSamples} 条 · 一次性灌入）`, 'P95', blastStats.p95Ms, LIMITS.eventP95Ms,
    'ms', { note: '最坏情形：不做流控一次性推完，P95 含排队时间' })

  /* --- B5 10s 防悬挂 --- */
  const allFrame = [...frameSamples, ...burstDone.map((x) => x.dt)]
  const worst = Math.max(...allFrame, ...eventSamples, ...sub2.events.map((ev) => Date.now() - ev.t0))
  add('B5', '10s 防悬挂', '最大观测延迟', worst, LIMITS.hangMs, 'ms',
    { pass: worst < LIMITS.hangMs, note: '任何一帧逼近 10s 都说明搬运路径在堆积' })

  /* --- B6 单实例并发 WS --- */
  const conns = []
  const connectStart = nowMs()
  const batch = 50
  for (let i = 0; i < CONFIG.wsConnections; i += batch) {
    const slice = Array.from({ length: Math.min(batch, CONFIG.wsConnections - i) }, (_, k) => i + k)
    conns.push(...await Promise.all(slice.map(async (n) => {
      const ws = await openWs(`ws://127.0.0.1:${port}/ws/host`)
      ws.send(JSON.stringify({ t: 'host/register', deviceId: `bench-ws-${n}`, hostToken: 'bench-secret' }))
      return ws
    })))
    await new Promise((r) => setImmediate(r))
  }
  for (let i = 0; i < 100; i++) {
    if (relay.state.sockets.size >= CONFIG.wsConnections) break
    await new Promise((r) => setTimeout(r, 20))
  }
  const held = relay.state.sockets.size
  const connectMs = nowMs() - connectStart
  // 快速档只做冒烟：阈值跟着连接数走，不拿 500 的硬指标去判 100 连接的结果（那是假阴性）
  const wsTarget = QUICK ? CONFIG.wsConnections : LIMITS.concurrentWs
  add('B6', `单实例并发 WS${QUICK ? '（快速档）' : ''}`, '同时挂住的 Host 连接', held, wsTarget, 'count',
    { pass: held >= wsTarget, note: `建连耗时 ${round(connectMs, 1)}ms` })

  // 拆掉全部连接（含基准主机与订阅端）后验证不留残骸
  await Promise.all(conns.map(closeWs))
  await closeWs(sub2Ws)
  await closeWs(subWs)
  await closeWs(hostWs)
  for (let i = 0; i < 150; i++) {
    if (relay.state.sockets.size === 0 && relay.state.pending.size === 0) break
    await new Promise((r) => setTimeout(r, 20))
  }
  const leftover = relay.state.sockets.size
  const leftoverPending = relay.state.pending.size
  add('B7', '并发连接拆除', '残留 socket', leftover, 0, 'count',
    { pass: leftover === 0, note: `残留在途请求 ${leftoverPending} 条；死连接会拖住 server.close()` })

  await relay.stop()

  const verdict = cases.every((c) => c.verdict === 'PASS') ? 'PASS' : 'FAIL'
  const evidence = {
    schema: 'wbsync-perf/1',
    capturedAt: new Date().toISOString(),
    scope: 'p1/relay 单实例 · 本机回环（不含跨网 RTT）',
    runtime: {
      node: process.version,
      platform: `${platform()} ${release()}`,
      arch: arch(),
      cpu: cpus()[0]?.model ?? 'unknown',
      cores: cpus().length,
    },
    config: CONFIG,
    limits: LIMITS,
    cases,
    latency: {
      frameSequential: frameStats,
      frameBurst: burstStats,
      eventPaced: eventStats,
      eventBlast: blastStats,
    },
    histogram: {
      frameSequential: histogram(frameSamples),
      eventPaced: histogram(eventSamples),
    },
    verdict,
    note: '帧延迟含同进程 Host 应答的事件循环调度开销；真实跨网需叠加网络 RTT，故此处是下限值而非上限。',
  }

  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, `${JSON.stringify(evidence, null, 2)}\n`)

  /* --- 控制台 --- */
  const pad = (s, n) => String(s).padEnd(n)
  console.log(`P3 W10 性能压测 · ${evidence.capturedAt}`)
  console.log(`  ${pad('用例', 34)}${pad('指标', 20)}${pad('实测', 12)}阈值`)
  for (const c of cases) {
    console.log(`  ${c.verdict === 'PASS' ? '✔' : '✘'} ${pad(c.id + ' ' + c.name, 32)}${pad(c.metric, 20)}` +
      `${pad(`${c.value}${c.unit === 'ms' ? 'ms' : ''}`, 12)}${c.threshold}${c.unit === 'ms' ? 'ms' : ''}`)
  }
  console.log(`  帧延迟 P50/P95/P99 = ${frameStats.p50Ms}/${frameStats.p95Ms}/${frameStats.p99Ms}ms`)
  console.log(`  事件 P95（逐条 / 灌入）= ${eventStats.p95Ms}ms / ${blastStats.p95Ms}ms`)
  console.log(`  直方图（帧）: ${histogram(frameSamples).buckets.map((b) => `≤${b.leMs}:${b.count}`).join(' ')}`)
  console.log(`  压测: ${verdict} | 证据: ${OUT}`)
  return verdict === 'PASS' ? 0 : 1
}

run().then((code) => process.exit(code)).catch((e) => {
  console.error('[bench] 压测异常：', e?.stack ?? e)
  process.exit(1)
})
