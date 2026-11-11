/**
 * 事件缓冲的**字节预算**（真机 2026-11-11）
 * ---------------------------------------------------------------
 * 真机取证：874 条事件里单条最大 421 KiB、p99 97 KiB。只按条数裁（capacity=1000），
 * 最坏能吃到 400 MB —— 长会话足以把 Relay 进程撑爆。
 * 语义约束：只裁 `delivered` 之前的旧条目，未广播的连续前缀一条都不能动。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createEventHub } from '../src/events.js'

const bigEvent = (seq, bytes = 2048) => ({ seq, type: 'assistant/message', data: { text: 'x'.repeat(bytes) } })

test('H1 超过字节预算时裁掉已广播的旧条目，bufferedBytes 回落到预算内', () => {
  const hub = createEventHub({ capacity: 1000, maxBytes: 10 * 1024 })
  for (let i = 0; i < 20; i++) hub.ingest('s1', bigEvent(i))
  const snap = hub.snapshot('s1')
  assert.equal(snap.delivered, 19, '全部连续，游标推到 19')
  assert.ok(snap.bytes <= 10 * 1024, `缓冲字节 ${snap.bytes} 应 ≤ 预算`)
  assert.ok(snap.buffered < 20, '应真的裁掉了老条目')
  assert.equal(hub.stats().bufferedBytes, snap.bytes, 'stats 的字节数要与会话一致')
})

test('H2 未广播的连续前缀一条都不裁，宁可超预算也不破坏 seq 连续性', () => {
  const hub = createEventHub({ capacity: 10, maxBytes: 4 * 1024 })
  hub.ingest('s2', bigEvent(0))                 // delivered = 0
  hub.ingest('s2', bigEvent(2, 8 * 1024))       // 洞在 1：seq 2 只能挂着，未广播
  const snap = hub.snapshot('s2')
  assert.equal(snap.delivered, 0)
  assert.equal(snap.maxSeq, 2)
  assert.equal(snap.buffered, 1, '只应留下未广播的 seq 2')
  assert.ok(snap.bytes > 4 * 1024, '这一条留在预算之外是刻意的：不能为了省内存制造缺口')
})

test('H3 裁完之后字节账不漂移（等于剩余条目真实字节和）', () => {
  const hub = createEventHub({ capacity: 1000, maxBytes: 6 * 1024 })
  for (let i = 0; i < 12; i++) hub.ingest('s3', bigEvent(i, 1024))
  const snap = hub.snapshot('s3')
  const remain = hub.stats().bufferedBytes
  assert.equal(remain, snap.bytes)
  assert.ok(snap.bytes >= 0)
  // 再塞一批，账仍然自洽（不会因为重复扣减变成负数）
  for (let i = 12; i < 30; i++) hub.ingest('s3', bigEvent(i, 1024))
  const after = hub.snapshot('s3')
  assert.ok(after.bytes >= 0 && after.bytes <= 6 * 1024, `实际 ${after.bytes}`)
  assert.equal(hub.stats().bufferedBytes, after.bytes)
})

test('H4 重复 seq 幂等：字节账不重复累加', () => {
  const hub = createEventHub({ capacity: 1000, maxBytes: 64 * 1024 })
  hub.ingest('s4', bigEvent(0))
  const once = hub.snapshot('s4').bytes
  const r = hub.ingest('s4', bigEvent(0))
  assert.equal(r.rejected, 'DUPLICATE')
  assert.equal(hub.snapshot('s4').bytes, once, '重复帧不许把字节数算两遍')
})
