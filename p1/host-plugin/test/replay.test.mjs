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
