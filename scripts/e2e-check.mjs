#!/usr/bin/env node
/**
 * W6 内测 · A3/A4/A5 端到端取证
 * ---------------------------------------------------------------
 * 这三条（断线补齐 / 幂等 / 队列顺序）都要**真的发消息**才有事件流，难点不在判据而在
 * 「谁来发、发到哪个会话」。这里用一个**临时会话**跑完整流程，跑完在 PC 上删掉即可。
 *
 *   node scripts/e2e-check.mjs --admin <token>
 *   node scripts/e2e-check.mjs --base http://192.168.0.103:8787 --admin <token>
 *
 * 判据：
 *   A4 同一个 clientMsgId 发 5 次 → 会话里只有 1 条对应的 user/message
 *   A5 执行中连发 3 条 → 3 条都在、顺序与发送一致、每条之后都有 turn/end
 *   A3 断开期间发的 1 条 → 用 sinceSeq 重连后补齐，且与已收到的 seq 无重叠（不重不丢）
 *
 * 退出码：0 = 三条全过；1 = 有 FAIL。
 *
 * 踩过的坑（写在这里省下一次调试）：
 *   1. **不能按「几秒没新事件」判完成**——LLM 思考期间就是没有事件，会提前收工，
 *      于是「0 条 user/message」这种假 FAIL 就出来了。要等 **turn/end** 或等会话索引的
 *      lastSeq 真的前进。
 *   2. user/message 的正文在 `data.content[].text`（不是 data.message.content），
 *      判定要跟 transcript.js 用同一条取文路径。
 */
import { createPwaClient } from '../p1/pwa/src/client.js'
import { pairWithRelay } from '../p1/pwa/src/pairing.js'

const argOf = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const BASE = argOf('base', process.env.WBSYNC_BASE ?? 'http://127.0.0.1:8787').replace(/\/$/, '')
const ADMIN = argOf('admin', process.env.WBSYNC_ADMIN_TOKEN ?? '')
const PHONE_ID = 'phone-e2e00001'
const TURN_TIMEOUT = 240_000
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const results = []
const add = (id, label, status, detail) => {
  results.push({ id, label, status, detail })
  const mark = { PASS: 'PASS', FAIL: 'FAIL', BLOCKED: 'BLOCK', SKIP: 'SKIP' }[status]
  console.log(`  ${id} ${mark}  ${label} — ${detail}`)
}

/**
 * 收尾：打印临时会话与判定。
 * BLOCKED = 环境/宿主让判据不成立（例如宿主连不上模型），**不是**功能的锅；
 * 退出码 2 与 FAIL(1) 分开，免得 CI 把「环境没准备好」记成「代码坏了」。
 */
const summarize = (sessionId) => {
  const fails = results.filter((r) => r.status === 'FAIL')
  const blocked = results.filter((r) => r.status === 'BLOCKED')
  if (sessionId) console.log(`\n临时会话：${sessionId}（在 PC 的会话列表里删掉即可）`)
  if (fails.length) {
    console.log(`\n判定：**${fails.length} 项 FAIL**（${fails.map((f) => f.id).join(', ')}）`)
    process.exitCode = 1
  } else if (blocked.length) {
    console.log(`\n判定：**环境阻塞**（${blocked.map((b) => b.id).join(', ')}）—— 功能未取证，先修宿主`)
    process.exitCode = 2
  } else {
    console.log('\n判定：**A3 / A4 / A5 三项全过**')
    process.exitCode = 0
  }
}

/** 轮询到条件成立；超时返回 false（由断言决定怎么记）。 */
const waitFor = async (fn, timeoutMs = TURN_TIMEOUT) => {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (await fn()) return true
    await sleep(400)
  }
  return false
}

/** 与 transcript.js 同一条取文路径：data.message.content 优先，其次 data.content。 */
const textOf = (ev) => {
  const content = ev?.data?.message?.content ?? ev?.data?.content
  if (!Array.isArray(content)) return typeof ev?.data?.text === 'string' ? ev.data.text : ''
  return content.filter((p) => p?.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('\n')
}

const post = async (path, body) => {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  return r.json().catch(() => null)
}

const findHost = async () => {
  if (!ADMIN) return null
  const r = await fetch(`${BASE}/admin`, { headers: { Authorization: `Bearer ${ADMIN}` } })
  const j = await r.json().catch(() => null)
  return (j?.data?.rows ?? []).find((x) => x.role !== 'phone' && x.state === 'online')?.deviceId ?? null
}

const cleanupPhone = async (hostId) => {
  if (!hostId || !ADMIN) return
  await fetch(`${BASE}/admin/revoke-client`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN}` },
    body: JSON.stringify({ deviceId: hostId, clientId: PHONE_ID }),
  }).catch(() => null)
}

const main = async () => {
  console.log(`WBSync 内测端到端 · ${BASE}`)
  const hostId = await findHost()
  if (!hostId) {
    add('E0', '定位在线 Host', 'FAIL', ADMIN ? '没有在线 Host（先确认 DSH 与插件在跑）' : '需要 --admin 才能定位 Host')
    return
  }
  add('E0', '定位在线 Host', 'PASS', hostId)

  const g = await post('/pair/generate', { deviceId: hostId })
  if (!g?.data?.code) {
    add('E1', '配对临时手机', 'FAIL', `拿不到配对码：${JSON.stringify(g?.error ?? g)}`)
    return
  }
  const pair = await pairWithRelay({ baseUrl: BASE, code: g.data.code, phoneId: PHONE_ID, clientName: '内测脚本' })
  add('E1', '配对临时手机', 'PASS', `${pair.phoneId}`)

  const events = []
  const seen = new Set()
  let dup = 0
  const client = createPwaClient({
    baseUrl: BASE,
    deviceId: pair.deviceId,
    token: pair.deviceToken,
    onEvent: ({ ev }) => {
      if (!Number.isInteger(ev?.seq)) return
      if (seen.has(ev.seq)) dup++
      seen.add(ev.seq)
      events.push({ seq: ev.seq, type: ev.type, text: textOf(ev), reason: ev.data?.reason ?? null })
    },
  })
  const userCount = (needle) => events.filter((e) => e.type === 'user/message' && e.text.includes(needle)).length
  // 宿主这一轮是「跑完了」还是「跑挂了」——后者说明内测前提不成立，不能算功能 FAIL
  const turnFailed = () => {
    const bad = events.find((e) => e.type === 'turn/end' && e.reason?.kind === 'error')
    return bad ? (bad.reason?.error?.message ?? 'turn/end error') : null
  }
  const turnEnds = () => events.filter((e) => e.type === 'turn/end').length

  const marker = `内测-${Date.now().toString(36)}`
  let sessionId
  try {
    const created = await client.createSession({ text: `${marker}-建会话：只回复 OK，不要调用任何工具。` })
    sessionId = created?.sessionId
  } catch (e) {
    add('E2', '新建临时会话', 'FAIL', e.message)
    client.stop(); await cleanupPhone(hostId); return
  }
  add('E2', '新建临时会话', 'PASS', sessionId)

  client.follow(sessionId, { sinceSeq: -1 })
  // 会话的**第一轮**必须真的结束，否则后面所有发送都只是在往 inbox 里塞
  if (!await waitFor(() => turnEnds() >= 1)) {
    add('E3', '首轮完成', 'FAIL', '等了 4 分钟没有 turn/end：宿主没在跑，或会话没起来')
    client.stop(); await cleanupPhone(hostId); return
  }
  const hostFailure = turnFailed()
  if (hostFailure) {
    add('E3', '首轮完成', 'BLOCKED', `宿主这一轮直接失败：${hostFailure} —— A3/A4/A5 都需要一次成功的轮次，先修宿主再测`)
    client.stop(); await cleanupPhone(hostId); summarize(sessionId); return
  }
  add('E3', '首轮完成', 'PASS', `已收到 ${events.length} 条事件`)

  /* ---------------------------------------------------------- A4 幂等 */

  const idem = `${marker}-A4`
  const rid = `e2e-${Date.now().toString(36)}`
  let accepted = 0
  for (let i = 0; i < 5; i++) {
    try {
      await client.submitPrompt({ sessionId, text: `${idem}：只回复 A4，不要调用任何工具。`, clientMsgId: rid })
      accepted++
    } catch (e) {
      add('A4', '同一 clientMsgId 发 5 次', 'FAIL', `第 ${i + 1} 次发送失败：${e.message}`)
      break
    }
  }
  if (accepted === 5) {
    const appeared = await waitFor(() => userCount(idem) >= 1)
    await sleep(6000)   // 再等一会儿，看会不会冒出第二条
    const n = userCount(idem)
    add('A4', '同一 clientMsgId 发 5 次', appeared && n === 1 ? 'PASS' : 'FAIL',
      `5 次请求均被受理；会话里出现 ${n} 条对应的 user/message（期望 1）`)
  }

  /* -------------------------------------------------------- A5 队列顺序 */

  const msgs = [`${marker}-A5a`, `${marker}-A5b`, `${marker}-A5c`]
  let sent = 0
  for (const m of msgs) {
    try {
      await client.submitPrompt({ sessionId, text: `${m}：只回复 OK，不要调用任何工具。` })
      sent++
    } catch (e) {
      add('A5', '执行中连发 3 条', 'FAIL', `发送 ${m} 失败：${e.message}`)
      break
    }
  }
  if (sent === 3) {
    const allIn = await waitFor(() => msgs.every((m) => userCount(m) >= 1))
    await sleep(4000)
    const idx = msgs.map((m) => events.findIndex((e) => e.type === 'user/message' && e.text.includes(m)))
    const inOrder = allIn && idx[0] < idx[1] && idx[1] < idx[2]
    // 每条之后都要有一次 turn/end：进了队列但没人处理，等于丢
    const turnsAfter = idx.map((i) => (i === -1 ? 0 : events.slice(i).filter((e) => e.type === 'turn/end').length))
    add('A5', '执行中连发 3 条', inOrder && turnsAfter.every((n) => n >= 1) ? 'PASS' : 'FAIL',
      allIn
        ? `3 条都进了会话；顺序${inOrder ? '与发送一致' : '错乱'}；各自之后 turn/end 次数 ${turnsAfter.join('/')}`
        : `有 ${msgs.filter((m) => userCount(m) === 0).length} 条没出现在会话里（4 分钟超时）`)
  }

  /* -------------------------------------------------------- A3 断线补齐 */

  const lastSeq = events.length ? events[events.length - 1].seq : -1
  client.unfollow(sessionId)
  await sleep(500)
  const gapMarker = `${marker}-A3`
  let gapSent = true
  try {
    await client.submitPrompt({ sessionId, text: `${gapMarker}：只回复 OK，不要调用任何工具。` })
  } catch (e) {
    gapSent = false
    add('A3', '断线期间补齐', 'FAIL', `断线期间发送失败：${e.message}`)
  }
  if (gapSent) {
    // 断线期间不能靠 WS 判断进度，改看会话索引的 lastSeq 是否真的前进了
    const advanced = await waitFor(async () => {
      await client.refreshSessions()
      const row = client.getSession?.(sessionId)
      return Number.isInteger(row?.lastSeq) && row.lastSeq > lastSeq + 1
    }, 180_000)
    const beforeCount = events.length
    client.follow(sessionId, { sinceSeq: lastSeq })
    const filled = await waitFor(() => events.slice(beforeCount).some((e) => e.type === 'user/message' && e.text.includes(gapMarker)))
    await sleep(2000)
    const replay = events.slice(beforeCount)
    const overlap = replay.filter((e) => e.seq <= lastSeq)
    const contiguous = replay.every((e, i) => i === 0 || e.seq === replay[i - 1].seq + 1)
    add('A3', '断线期间补齐',
      advanced && filled && overlap.length === 0 && contiguous ? 'PASS' : 'FAIL',
      `索引 ${advanced ? '确认前进' : '未前进'}；重连补来 ${replay.length} 条；`
      + `与已收到的重叠 ${overlap.length} 条（期望 0）；断线那条${filled ? '已补齐' : '缺失'}；`
      + `seq${contiguous ? '连续' : '有空洞'}；重复渲染 ${dup} 次`)
  }

  client.stop()
  await cleanupPhone(hostId)
  summarize(sessionId)
}

main().catch((e) => {
  console.error('脚本异常：', e?.stack ?? e)
  process.exitCode = 1
})
