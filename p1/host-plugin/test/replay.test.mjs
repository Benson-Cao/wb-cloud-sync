/**
 * W3 · 历史补齐单测（Host 只读回放）
 * ---------------------------------------------------------------
 * 全部用假句柄跑：`read(offset, length)` 返回 `{ eventState, events }`，
 * `close()` 计数。真实句柄的形状来自宿主 `dsh-session-persistence-jsonl`
 * 的实现（`open(id,'read')` → `read` / `close`），不在这里重复验证宿主行为。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { contiguousPrefix, createReplayAdapter, DEFAULT_PAGE_SIZE } from '../src/replay.js'

/* ---------------------------------------------------------------- 假句柄 */

/** 造 seq 连续的事件序列；`skip` 里的 seq 故意不产出，用来模拟日志里的洞。 */
const mkEvents = (count, { skip = [], from = 0 } = {}) =>
  Array.from({ length: count }, (_, i) => ({ seq: from + i, type: 'message/delta' }))
    .filter((e) => !skip.includes(e.seq))

const makeHandle = (events, { ignoreOffset = false, readError = null } = {}) => {
  const handle = {
    reads: [],
    closed: 0,
    async read(offset, length) {
      handle.reads.push({ offset, length })
      if (readError) throw readError
      const start = ignoreOffset ? 0 : offset
      return { eventState: 'prepared', events: events.slice(start, start + length) }
    },
    async close() { handle.closed++ },
  }
  return handle
}

const adapterOver = (events, opts = {}) => {
  const handle = makeHandle(events, opts)
  const replay = createReplayAdapter({ openSession: async () => handle, ...opts.adapter })
  return { handle, replay }
}

/* ------------------------------------------------------------ 纯函数语义 */

test('contiguousPrefix：只取连续前缀，遇缺口立即停', () => {
  const events = mkEvents(4, { skip: [2] })       // 0,1,3
  assert.deepEqual(contiguousPrefix(events, -1).events.map((e) => e.seq), [0, 1])
  assert.equal(contiguousPrefix(events, -1).expectedSeq, 2)
  assert.deepEqual(contiguousPrefix(events, 0).events.map((e) => e.seq), [1])
  assert.equal(contiguousPrefix(events, 1).expectedSeq, 2)
})

test('contiguousPrefix：seq <= sinceSeq 的重复帧幂等丢弃', () => {
  const events = [{ seq: 2 }, { seq: 3 }, { seq: 3 }, { seq: 4 }]
  assert.deepEqual(contiguousPrefix(events, 2).events.map((e) => e.seq), [3, 4])
  // 非法的 seq（字符串 / 负数 / 小数）一律跳过，不参与连续性判定
  assert.deepEqual(contiguousPrefix([{ seq: '1' }, { seq: -1 }, { seq: 1.5 }, { seq: 1 }], 0).events.map((e) => e.seq), [1])
})

/* -------------------------------------------------------------- 适配器 */

test('从 sinceSeq+1 补齐连续前缀并报告 complete', async () => {
  const { handle, replay } = adapterOver(mkEvents(10))
  const r = await replay({ sessionId: 'session-9', sinceSeq: 3 })

  assert.equal(r.ok, true)
  assert.deepEqual(r.value.events.map((e) => e.seq), [4, 5, 6, 7, 8, 9])
  assert.equal(r.value.count, 6)
  assert.equal(r.value.fromSeq, 4)
  assert.equal(r.value.toSeq, 9)
  assert.equal(r.value.complete, true)
  assert.equal(r.value.hasMore, false)
  assert.equal(r.value.expectedSeq, null)
  assert.equal(handle.closed, 1, '句柄必须释放')
})

test('sinceSeq=-1 表示从头补，读完即可', async () => {
  const { replay } = adapterOver(mkEvents(3))
  const r = await replay({ sessionId: 's', sinceSeq: -1 })
  assert.deepEqual(r.value.events.map((e) => e.seq), [0, 1, 2])
  assert.equal(r.value.complete, true)
})

test('中途有缺口：返回缺口前的部分并显式报 expectedSeq', async () => {
  const { replay } = adapterOver(mkEvents(5, { skip: [3] }))   // 0,1,2,4
  const r = await replay({ sessionId: 's', sinceSeq: 0 })

  assert.deepEqual(r.value.events.map((e) => e.seq), [1, 2])
  assert.equal(r.value.complete, false)
  assert.equal(r.value.expectedSeq, 3)
  assert.equal(r.value.hasMore, false, '缺口优先于 hasMore：先补齐再谈还有多少')
})

test('分页：单次最多 pageSize 条，hasMore 指路下一页起点', async () => {
  const handle = makeHandle(mkEvents(20))
  const replay = createReplayAdapter({ openSession: async () => handle, pageSize: 5 })

  const p1 = await replay({ sessionId: 's', sinceSeq: -1 })
  assert.deepEqual(p1.value.events.map((e) => e.seq), [0, 1, 2, 3, 4])
  assert.equal(p1.value.hasMore, true)
  assert.equal(p1.value.complete, false)
  assert.equal(p1.value.expectedSeq, 5)

  const p2 = await replay({ sessionId: 's', sinceSeq: p1.value.toSeq })
  assert.deepEqual(p2.value.events.map((e) => e.seq), [5, 6, 7, 8, 9])
  assert.equal(p2.value.expectedSeq, 10)

  // 多读一条只为判断 hasMore，不该变成「一次吐 6 条」
  assert.equal(p1.value.events.length, 5)
})

test('已到末尾：空数组 + complete，不让手机空转重试', async () => {
  const { replay } = adapterOver(mkEvents(10))
  const r = await replay({ sessionId: 's', sinceSeq: 9 })
  assert.deepEqual(r.value.events, [])
  assert.equal(r.value.complete, true)
  assert.equal(r.value.hasMore, false)
  assert.equal(r.value.toSeq, 9, '没有新事件时 toSeq 回落到请求位置')
})

test('重复请求同一 sinceSeq 不会拿到重复事件（幂等）', async () => {
  const { replay } = adapterOver(mkEvents(5), { ignoreOffset: true })  // 句柄吞掉 offset，每次从头返回
  const a = await replay({ sessionId: 's', sinceSeq: 1 })
  const b = await replay({ sessionId: 's', sinceSeq: 1 })
  assert.deepEqual(a.value.events.map((e) => e.seq), [2, 3, 4])
  assert.deepEqual(b.value.events.map((e) => e.seq), [2, 3, 4])
})

test('下标与 seq 不等时退化为从头读一次再过滤', async () => {
  const { handle, replay } = adapterOver(mkEvents(6), { ignoreOffset: true })
  const r = await replay({ sessionId: 's', sinceSeq: 2 })

  assert.deepEqual(r.value.events.map((e) => e.seq), [3, 4, 5])
  assert.equal(r.value.complete, true)
  assert.deepEqual(handle.reads.map((x) => x.offset), [3, 0], '先按 sinceSeq+1 当下标试，再回退到 0')
})

test('非法 sinceSeq 按 -1 处理，不抛错', async () => {
  const { replay } = adapterOver(mkEvents(2))
  for (const bad of [Number.NaN, -5, '3', null, undefined]) {
    const r = await replay({ sessionId: 's', sinceSeq: bad })
    assert.equal(r.ok, true)
    assert.deepEqual(r.value.events.map((e) => e.seq), [0, 1])
  }
})

test('会话不可读：SESSION_UNREADABLE，且不去 read', async () => {
  const replay = createReplayAdapter({
    openSession: async () => { throw new Error('SessionPersistenceNotFoundError: session-x') },
  })
  const r = await replay({ sessionId: 'session-x', sinceSeq: 0 })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'SESSION_UNREADABLE')
  assert.match(r.message, /SessionPersistenceNotFoundError/)
})

test('缺 sessionId：直接拒绝，不打开句柄', async () => {
  let opened = 0
  const replay = createReplayAdapter({ openSession: async () => { opened++; return makeHandle([]) } })
  const r = await replay({ sinceSeq: 0 })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'SESSION_UNREADABLE')
  assert.equal(opened, 0)
})

test('read 抛错：仍释放句柄并回 SESSION_UNREADABLE', async () => {
  const handle = makeHandle([], { readError: new Error('torn tail') })
  const replay = createReplayAdapter({ openSession: async () => handle })
  const r = await replay({ sessionId: 's', sinceSeq: -1 })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'SESSION_UNREADABLE')
  assert.match(r.message, /torn tail/)
  assert.equal(handle.closed, 1)
})

test('分页参数被夹到合法区间：上限 5000，下限 1，缺省/非法回落 500', async () => {
  assert.equal(DEFAULT_PAGE_SIZE, 500)
  const handle = makeHandle(mkEvents(10))
  const tooBig = createReplayAdapter({ openSession: async () => handle, pageSize: 99_999 })
  await tooBig({ sessionId: 's', sinceSeq: -1 })
  assert.equal(handle.reads[0].length, 5001, '夹到 5000 后再多读一条')

  // 0 / 非数字 → 按「没配」处理，回落默认 500（0 页没有意义）
  for (const bad of [0, 'abc']) {
    const h = makeHandle(mkEvents(10))
    const a = createReplayAdapter({ openSession: async () => h, pageSize: bad })
    await a({ sessionId: 's', sinceSeq: -1 })
    assert.equal(h.reads[0].length, 501, `pageSize=${String(bad)} 应回落默认`)
  }

  // 负数 → 夹到下限 1（读 2 条：1 条数据 + 1 条探测 hasMore）
  const h = makeHandle(mkEvents(10))
  const a = createReplayAdapter({ openSession: async () => h, pageSize: -3 })
  const r = await a({ sessionId: 's', sinceSeq: -1 })
  assert.equal(h.reads[0].length, 2)
  assert.equal(r.value.events.length, 1)
  assert.equal(r.value.hasMore, true)
})

test('createReplayAdapter 必须有 openSession', () => {
  assert.throws(() => createReplayAdapter({}), /openSession/)
})

/* ------------------------------------------- 真机 2026-11-11：补齐帧字节预算 */

test('B1 大正文事件按字节预算裁页：单页不超预算，hasMore 指路下一页', async () => {
  // 复刻真机尺度：每条 6 KiB，旧版 500 条一页 ≈ 3 MiB，会被 Relay WS 1009 断连
  const big = Array.from({ length: 20 }, (_, i) => ({
    seq: i, type: 'assistant/message', data: { text: 'x'.repeat(6000) },
  }))
  const h = makeHandle(big)
  const a = createReplayAdapter({ openSession: async () => h, pageSize: 500, maxBytes: 48 * 1024 })
  const r = await a({ sessionId: 's', sinceSeq: -1 })
  assert.equal(r.ok, true)
  assert.ok(r.value.count < 20, '不能一页把 20 条大正文全吐出去')
  assert.ok(r.value.count >= 1, '至少给一条，否则客户端 sinceSeq 永远推不动')
  assert.ok(r.value.bytes <= 48 * 1024, `实际 ${r.value.bytes}B 超过预算`)
  assert.equal(r.value.hasMore, true)
  assert.equal(r.value.toSeq, r.value.count - 1)
  assert.equal(r.value.expectedSeq, r.value.count, '下一页起点应是最后一条 + 1')
  assert.equal(h.closed, 1)
})

test('B2 连续翻页能收完，最后一页 hasMore=false / complete=true（不误判 gap）', async () => {
  const big = Array.from({ length: 20 }, (_, i) => ({
    seq: i, type: 'assistant/message', data: { text: 'y'.repeat(6000) },
  }))
  const a = createReplayAdapter({ openSession: async () => makeHandle(big), pageSize: 500, maxBytes: 48 * 1024 })
  let since = -1
  const got = []
  let pages = 0
  for (; pages < 10; pages++) {
    const r = await a({ sessionId: 's', sinceSeq: since })
    assert.equal(r.ok, true)
    got.push(...r.value.events)
    if (!r.value.hasMore) {
      assert.equal(r.value.complete, true, '全部翻完不能报缺口')
      break
    }
    since = r.value.toSeq
  }
  assert.deepEqual(got.map((e) => e.seq), Array.from({ length: 20 }, (_, i) => i))
  assert.ok(pages >= 2, '应该分了多页')
})

test('B3 单条就超预算：仍返回这一条并标 oversized，不空转死循环', async () => {
  const huge = [{ seq: 0, type: 'assistant/message', data: { text: 'z'.repeat(200_000) } }]
  const a = createReplayAdapter({ openSession: async () => makeHandle(huge), maxBytes: 48 * 1024 })
  const r = await a({ sessionId: 's', sinceSeq: -1 })
  assert.equal(r.value.count, 1)
  assert.equal(r.value.oversized, true)
  assert.ok(r.value.bytes > 48 * 1024)
  assert.equal(r.value.hasMore, false, '后面没有更多了')
})

test('B4 字节截断不掩盖真缺口：仍如实报 expectedSeq', async () => {
  const big = Array.from({ length: 10 }, (_, i) => ({
    seq: i === 9 ? 12 : i,   // seq 9 缺失 → 9 处是洞
    type: 'assistant/message', data: { text: 'w'.repeat(6000) },
  }))
  const a = createReplayAdapter({ openSession: async () => makeHandle(big), pageSize: 500, maxBytes: 48 * 1024 })
  const r = await a({ sessionId: 's', sinceSeq: -1 })
  assert.equal(r.value.count > 0, true)
  assert.equal(r.value.complete, false)
  // 第一页还没走到缺口，hasMore 指路；下一页会收敛到 gap
  assert.equal(r.value.hasMore, true)
})

test('B5 eventBytes 用 UTF-8 实算，中文不按字符数低估', async () => {
  const { eventBytes, pickWithinBudget } = await import('../src/replay.js')
  const ev = { seq: 0, data: { text: '中文'.repeat(1000) } }
  const expected = Buffer.byteLength(JSON.stringify(ev), 'utf8')
  assert.equal(eventBytes(ev), expected)
  const pick = pickWithinBudget([ev], 10)
  assert.equal(pick.events.length, 1)
  assert.equal(pick.oversized, true)
})

test('B6 单条超过硬上限：回明确 FRAME_TOO_LARGE，不让 WS 被 1009 静默断连', async () => {
  const monster = [{ seq: 0, type: 'assistant/message', data: { text: 'm'.repeat(900 * 1024) } }]
  const h = makeHandle(monster)
  const a = createReplayAdapter({ openSession: async () => h, maxBytes: 48 * 1024 })
  const r = await a({ sessionId: 's', sinceSeq: -1 })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'FRAME_TOO_LARGE')
  assert.match(r.message, /超过/)
  assert.equal(h.closed, 1, '失败也要还句柄')
})

/* ------------------------------------------- 首屏窗口：反向补读（2026-11-11） */

test('BF1 取窗口前面一段：返回紧邻 beforeSeq 的 50 条，并标记前面还有', async () => {
  const { createBackfillReader } = await import('../src/replay.js')
  const events = Array.from({ length: 100 }, (_, i) => ({ seq: i, type: 'assistant/message', data: { text: `第${i}条` } }))
  const h = makeHandle(events)
  const backfill = createBackfillReader({ openSession: async () => h })
  const r = await backfill({ sessionId: 's', beforeSeq: 80, limit: 50 })
  assert.equal(r.ok, true)
  assert.equal(r.value.events.length, 50)
  assert.equal(r.value.events[0].seq, 30)
  assert.equal(r.value.events.at(-1).seq, 79)
  assert.equal(r.value.hasMoreEarlier, true)
  assert.equal(r.value.fromSeq, 30)
  assert.equal(r.value.toSeq, 79)
  assert.equal(h.closed, 1, '句柄必须还回去')
})

test('BF2 已经到会话开头：hasMoreEarlier=false，不再显示「加载更早」', async () => {
  const { createBackfillReader } = await import('../src/replay.js')
  const events = Array.from({ length: 100 }, (_, i) => ({ seq: i, data: {} }))
  const backfill = createBackfillReader({ openSession: async () => makeHandle(events) })
  const r = await backfill({ sessionId: 's', beforeSeq: 10, limit: 50 })
  assert.equal(r.value.events.length, 10)
  assert.equal(r.value.events[0].seq, 0)
  assert.equal(r.value.hasMoreEarlier, false)
})

test('BF3 beforeSeq=0：直接空结果，连句柄都不打开', async () => {
  const { createBackfillReader } = await import('../src/replay.js')
  let opened = 0
  const backfill = createBackfillReader({ openSession: async () => { opened++; return makeHandle([]) } })
  const r = await backfill({ sessionId: 's', beforeSeq: 0 })
  assert.deepEqual(r.value.events, [])
  assert.equal(r.value.hasMoreEarlier, false)
  assert.equal(opened, 0, '没有可读区间就不该碰日志')
})

test('BF4 超字节预算时砍更早的、留下紧邻窗口的那几条', async () => {
  const { createBackfillReader } = await import('../src/replay.js')
  const events = Array.from({ length: 20 }, (_, i) => ({ seq: i, data: { text: 'x'.repeat(10_000) } }))
  const backfill = createBackfillReader({ openSession: async () => makeHandle(events), maxBytes: 48 * 1024 })
  const r = await backfill({ sessionId: 's', beforeSeq: 20, limit: 20 })
  // 有 8 条下限：允许超预算，但不能把 20 条全给出来，也不能超过 4× 预算
  assert.ok(r.value.events.length >= 8 && r.value.events.length < 20, `实际 ${r.value.events.length}`)
  assert.ok(r.value.bytes <= 48 * 1024 * 4, `实际 ${r.value.bytes}B`)
  assert.equal(r.value.events.at(-1).seq, 19, '最后一条必须紧邻窗口（不能砍掉最新的）')
  assert.equal(r.value.hasMoreEarlier, true)
})

test('BF5 缺 sessionId → SESSION_UNREADABLE；open 抛错也不外泄异常', async () => {
  const { createBackfillReader } = await import('../src/replay.js')
  const backfill = createBackfillReader({ openSession: async () => { throw new Error('no') } })
  assert.equal((await backfill({})).code, 'SESSION_UNREADABLE')
  const r = await backfill({ sessionId: 'gone', beforeSeq: 10 })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'SESSION_UNREADABLE')
})

test('BF6 条数下限：大事件把预算吃满时仍给到 8 条，但不超过 4× 预算', async () => {
  const { createBackfillReader } = await import('../src/replay.js')
  // 每条 5 KiB，预算 12 KiB：纯按字节只够 2 条，靠下限补到 8 条
  const events = Array.from({ length: 40 }, (_, i) => ({ seq: i, data: { text: 'y'.repeat(5000) } }))
  const backfill = createBackfillReader({ openSession: async () => makeHandle(events), maxBytes: 12 * 1024 })
  const r = await backfill({ sessionId: 's', beforeSeq: 40, limit: 40 })
  assert.equal(r.value.events.length, 8, `期望补到下限 8 条，实际 ${r.value.events.length}`)
  assert.ok(r.value.bytes > 12 * 1024, '为了凑够条数允许超预算')
  assert.ok(r.value.bytes <= 12 * 1024 * 4, '但不得超过 4× 预算')
  assert.equal(r.value.events.at(-1).seq, 39, '永远保留紧邻窗口的那条')
})

test('BF7 首屏窗口可要更大的预算，但 Host 把上限锁在 4× 页预算（挡客户端要 8 MiB）', async () => {
  const { createBackfillReader } = await import('../src/replay.js')
  const events = Array.from({ length: 100 }, (_, i) => ({ seq: i, data: { text: 'z'.repeat(10_000) } }))
  const backfill = createBackfillReader({ openSession: async () => makeHandle(events), maxBytes: 48 * 1024 })

  const normal = await backfill({ sessionId: 's', beforeSeq: 100, limit: 100 })
  const wide = await backfill({ sessionId: 's', beforeSeq: 100, limit: 100, bytes: 96 * 1024 })
  const greedy = await backfill({ sessionId: 's', beforeSeq: 100, limit: 100, bytes: 8 * 1024 * 1024 })

  assert.ok(wide.value.bytes > normal.value.bytes, '窗口预算更大应拿到更多内容')
  assert.ok(wide.value.events.length > normal.value.events.length)
  assert.ok(greedy.value.bytes <= 48 * 1024 * 4, `上限必须夹在 192 KiB，实际 ${greedy.value.bytes}`)
  for (const r of [normal, wide, greedy]) {
    assert.equal(r.value.events.at(-1).seq, 99, '永远保留紧邻窗口的那条')
    assert.equal(r.value.hasMoreEarlier, true)
  }
})
