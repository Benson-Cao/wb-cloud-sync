/**
 * 产物索引单测（W8）
 * 宿主契约来自 app.asar 实测；这里只验「解析得对、翻页有界、句柄必还、字节不外泄」。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { basename, scanArtifacts, createArtifactIndex, MAX_ARTIFACT_ROWS } from '../src/artifacts.js'

const presented = (seq, files, over = {}) => ({
  type: 'deliverables/presented',
  seq,
  data: { turn: 1, callId: 'call-1', files, ...over },
})

test('AF1 解析一条呈现事件：路径 / 文件名 / 描述 / seq 都在，且不带字节', () => {
  const rows = scanArtifacts([
    presented(7, [
      { path: 'C:\\work\\report.docx', description: '季度报告' },
      { path: 'out/slide.pdf' },
    ]),
  ])
  assert.equal(rows.length, 2)
  assert.deepEqual(rows[0], {
    seq: 7, turn: 1, callId: 'call-1', index: 0,
    path: 'C:\\work\\report.docx', name: 'report.docx', description: '季度报告',
  })
  assert.equal(rows[1].name, 'slide.pdf')
  assert.equal(rows[1].description, null)
  for (const r of rows) {
    assert.deepEqual(Object.keys(r).sort(),
      ['callId', 'description', 'index', 'name', 'path', 'seq', 'turn'].sort(),
      '产物行不许夹带文件内容字段')
  }
})

test('AF2 畸形事件一律跳过：不猜路径、不编文件名', () => {
  const bad = [
    null, {}, { type: 'deliverables/presented' },
    presented(-1, [{ path: 'a.txt' }]),
    presented(1, [{ path: 'a.txt' }], { turn: 0 }),
    presented(1, [{ path: 'a.txt' }], { turn: 1.5 }),
    presented(1, [{ path: 'a.txt' }], { callId: '' }),
    presented(1, [{ path: '   ' }]),
    presented(1, [{ path: 'a.txt', description: 42 }]),
    presented(1, { path: 'a.txt' }),
    { type: 'tool/call', seq: 1, data: { meta: { path: 'a.txt' } } },
  ]
  assert.deepEqual(scanArtifacts(bad), [])
  // 一条合法 + 一堆畸形：只出合法的
  const rows = scanArtifacts([...bad, presented(3, [{ path: 'ok.md' }])])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].name, 'ok.md')
})

test('AF3 同一 (seq,index) 重放去重；不同 seq 的同名文件各留一行', () => {
  const ev = presented(5, [{ path: 'a.txt' }])
  assert.equal(scanArtifacts([ev, ev, ev]).length, 1)
  assert.equal(scanArtifacts([
    presented(5, [{ path: 'a.txt' }]),
    presented(9, [{ path: 'a.txt' }]),
  ]).length, 2, '两次呈现是两件事，不按路径合并')
})

test('AF4 按 seq 排序，且总行数有硬上限（长会话不许打爆帧）', () => {
  const events = []
  for (let i = 0; i < MAX_ARTIFACT_ROWS + 10; i++) {
    events.push(presented(MAX_ARTIFACT_ROWS + 10 - i, [{ path: `f${i}.txt` }]))
  }
  const rows = scanArtifacts(events)
  assert.equal(rows.length, MAX_ARTIFACT_ROWS)
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i].seq >= rows[i - 1].seq)
})

test('AF5 basename：正斜杠、反斜杠、无分隔符都正确', () => {
  assert.equal(basename('a/b/c.txt'), 'c.txt')
  assert.equal(basename('C:\\a\\b.docx'), 'b.docx')
  assert.equal(basename('plain.md'), 'plain.md')
})

/* ------------------------------------------------------- 日志只读扫描 */

const fakeHandle = (events, { pageSize = 2 } = {}) => {
  const calls = []
  let closed = false
  return {
    calls,
    get closed() { return closed },
    async read(offset, length) {
      calls.push({ offset, length })
      const win = events.slice(offset, offset + Math.min(length, pageSize))
      return { events: win, eventState: 'ok' }
    },
    async close() { closed = true },
  }
}

const logEvents = (n) => Array.from({ length: n }, (_, i) => ({
  seq: i,
  type: i === 3 ? 'deliverables/presented' : 'tool/result',
  data: i === 3
    ? { turn: 1, callId: 'c', files: [{ path: 'out/a.pdf', description: '成品' }] }
    : { ok: true },
}))

test('AF6 分页扫全日志：找到早期产物，且 read 的 offset 是「首条逻辑 seq」', async () => {
  const handle = fakeHandle(logEvents(7))
  const list = createArtifactIndex({ openSession: async () => handle, pageSize: 2, maxPages: 10 })
  const r = await list({ sessionId: 's-1' })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.value.count, 1)
  assert.equal(r.value.rows[0].name, 'a.pdf')
  assert.equal(r.value.rows[0].seq, 3)
  assert.equal(r.value.truncated, false)
  assert.deepEqual(handle.calls.map((c) => c.offset), [0, 2, 4, 6])
  assert.equal(handle.closed, true, '句柄必须还回去')
})

test('AF7 没有 sessionId 直接失败；open 抛错也不许把异常漏出去', async () => {
  const list = createArtifactIndex({ openSession: async () => { throw new Error('no session') } })
  assert.equal((await list({})).ok, false)
  const r = await list({ sessionId: 'missing' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'SESSION_UNREADABLE')
})

test('AF8 页数上限生效，且如实报 truncated（不谎报「全扫完了」）', async () => {
  const handle = fakeHandle(logEvents(30), { pageSize: 100 })
  const list = createArtifactIndex({ openSession: async () => handle, pageSize: 2, maxPages: 3 })
  const r = await list({ sessionId: 's-2' })
  assert.equal(r.ok, true)
  assert.equal(r.value.truncated, true, '只扫了 3 页必须报截断')
  assert.equal(handle.calls.length, 3)
  assert.equal(handle.closed, true)
})

test('AF9 seq 不是连续整数时停止翻页并报截断，不靠猜 offset 继续读', async () => {
  const handle = fakeHandle([{ seq: 'oops', type: 'x', data: {} }], { pageSize: 100 })
  const list = createArtifactIndex({ openSession: async () => handle, pageSize: 2 })
  const r = await list({ sessionId: 's-3' })
  assert.equal(r.value.truncated, true)
  assert.equal(handle.calls.length, 1)
  assert.equal(handle.closed, true)
})
