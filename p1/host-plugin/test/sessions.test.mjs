/**
 * W3 · 会话索引上报单测
 * ---------------------------------------------------------------
 * 假 `list()` 返回宿主真实形状的快照：`{ header, formatStatus, revision, sizeBytes }`。
 * 断言重点是三件事：**契约行字段不多不少**、`lastSeq` 只在必要时代码解码、
 * 探测失败时给 `null`（未知）而不是 0（假装没有新事件）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  createSessionIndexReporter, toHeaderRef, STATES,
  DEFAULT_LIMIT, DEFAULT_MAX_DECODE_BYTES,
} from '../src/sessions.js'

/* ---------------------------------------------------------------- 夹具 */

const CONTRACT_KEYS = [
  'sessionId', 'ownerDeviceId', 'workspace', 'title', 'pinned', 'pinnedOrder',
  'state', 'lastSeq', 'lastActiveAt', 'headerRef',
].sort()

const header = (id, extra = {}) => ({
  type: 'session', version: 4, id, createdAt: 1_700_000_000_000,
  cwd: 'C:\\work\\demo', isSeeded: false, delegationDepth: 0, agentPreset: 'standard',
  ...extra,
})

const snapshot = (id, extra = {}) => ({
  header: header(id),
  formatStatus: 'ok',
  revision: 'rev-1',
  sizeBytes: 1024,
  location: { kind: 'jsonl', path: `/tmp/${id}.jsonl.zstd` },
  ...extra,
})

const mkEvents = (count) => Array.from({ length: count }, (_, i) => ({ seq: i, time: 1_700_000_100_000 + i }))

/** 记录 open 次数的假 persistence。 */
const fakeReader = (eventsById = {}, { openError = null, readError = null } = {}) => {
  const opened = []
  const handle = (events) => ({
    closed: 0,
    async read(offset, length) {
      if (readError) throw readError
      return { eventState: 'prepared', events: events.slice(offset, offset + length) }
    },
    async close() { /* noop */ },
  })
  return {
    opened,
    open: async (id) => {
      opened.push(id)
      if (openError) throw openError
      return handle(eventsById[id] ?? [])
    },
  }
}

/* ------------------------------------------------------------ 契约形状 */

test('列表按 createdAt 倒序截断，行字段与契约一致（不多不少）', async () => {
  const list = async () => [
    snapshot('old', { header: header('old', { createdAt: 1 }) }),
    snapshot('new', { header: header('new', { createdAt: 3 }) }),
    snapshot('mid', { header: header('mid', { createdAt: 2 }) }),
  ]
  const reader = fakeReader({})
  const collect = createSessionIndexReporter({ listSessions: list, openSession: reader.open, deviceId: 'pc-1', limit: 2 })
  const { rows, stats } = await collect()

  assert.deepEqual(rows.map((r) => r.sessionId), ['new', 'mid'])
  assert.deepEqual(Object.keys(rows[0]).sort(), CONTRACT_KEYS)
  assert.equal(rows[0].ownerDeviceId, 'pc-1')
  assert.equal(rows[0].workspace, 'C:\\work\\demo')
  assert.equal(rows[0].title, null, '日志头里没有 title，不能编一个')
  assert.equal(rows[0].pinned, false)
  assert.equal(rows[0].pinnedOrder, 0)
  assert.equal(rows[0].state, 'stopped', '问不到运行态时是 stopped，不是 running')
  assert.equal(stats.total, 3)
  assert.equal(stats.reported, 2)
})

test('headerRef 只挑契约字段，不把 header 整个塞进索引', async () => {
  const list = async () => [snapshot('s1', { header: header('s1', { parentSession: 'session-p', origin: 'mobile' }) })]
  const collect = createSessionIndexReporter({ listSessions: list, openSession: fakeReader({}).open })
  const { rows } = await collect()

  assert.deepEqual(Object.keys(rows[0].headerRef).sort(),
    ['agentPreset', 'delegationDepth', 'isSeeded', 'origin', 'parentSession', 'version'])
  assert.equal(rows[0].headerRef.parentSession, 'session-p')
  assert.equal(rows[0].headerRef.origin, 'mobile')
  // cwd / title / createdAt 已经提升到行级字段，不该在 headerRef 里重复
  assert.equal('cwd' in rows[0].headerRef, false)
})

/* --------------------------------------------------------------- lastSeq */

test('lastSeq / lastActiveAt 来自日志末尾事件', async () => {
  const list = async () => [snapshot('s1')]
  const reader = fakeReader({ s1: mkEvents(4) })
  const collect = createSessionIndexReporter({ listSessions: list, openSession: reader.open })
  const { rows, stats } = await collect()

  assert.equal(rows[0].lastSeq, 3)
  assert.equal(rows[0].lastActiveAt, 1_700_000_100_003)
  assert.equal(stats.sources.decoded, 1)
  assert.deepEqual(reader.opened, ['s1'])
})

test('revision 没变就复用缓存，不再解码整份日志', async () => {
  const list = async () => [snapshot('s1')]
  const reader = fakeReader({ s1: mkEvents(5) })
  const collect = createSessionIndexReporter({ listSessions: list, openSession: reader.open })

  await collect()
  const second = await collect()
  assert.equal(reader.opened.length, 1, '第二次不该再 open')
  assert.equal(second.rows[0].lastSeq, 4)
  assert.equal(second.stats.sources.cache, 1)
})

test('revision 变了就重新探测（会话追加过事件）', async () => {
  let rev = 'rev-1'
  const events = mkEvents(3)
  const list = async () => [snapshot('s1', { revision: rev, sizeBytes: 2048 })]
  const reader = fakeReader({ s1: events })
  const collect = createSessionIndexReporter({ listSessions: list, openSession: reader.open })

  await collect()
  events.push({ seq: 3, time: 1_700_000_200_000 })
  rev = 'rev-2'
  const { rows } = await collect()

  assert.equal(reader.opened.length, 2)
  assert.equal(rows[0].lastSeq, 3)
  assert.equal(rows[0].lastActiveAt, 1_700_000_200_000)
})

test('超过解码预算的会话：lastSeq 给 null（未知），不 open 也不留旧缓存', async () => {
  let size = DEFAULT_MAX_DECODE_BYTES + 1
  const list = async () => [snapshot('big', { sizeBytes: size })]
  const reader = fakeReader({ big: mkEvents(3) })
  const collect = createSessionIndexReporter({ listSessions: list, openSession: reader.open })

  const first = await collect()
  assert.equal(first.rows[0].lastSeq, null)
  assert.equal(first.stats.sources['over-budget'], 1)
  assert.deepEqual(reader.opened, [])

  // 文件缩小（比如被归档替换）后又能探测到
  size = 1024
  const second = await collect()
  assert.equal(reader.opened.length, 1)
  assert.equal(second.rows[0].lastSeq, 2)
})

test('没有只读句柄时 rows 仍完整，lastSeq 为 null', async () => {
  const list = async () => [snapshot('s1')]
  const collect = createSessionIndexReporter({ listSessions: list })
  const { rows, stats } = await collect()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].lastSeq, null)
  assert.equal(stats.sources['no-reader'], 1)
})

test('单条 open / read 失败只影响自己，不影响别的行', async () => {
  const list = async () => [snapshot('a'), snapshot('b', { header: header('b', { createdAt: 1_600_000_000_000 }) })]
  let call = 0
  const open = async (id) => {
    call++
    if (id === 'a') throw new Error('SessionPersistenceNotFoundError')
    return { read: async () => ({ events: mkEvents(2) }), close: async () => {} }
  }
  const collect = createSessionIndexReporter({ listSessions: list, openSession: open })
  const { rows } = await collect()

  const byId = Object.fromEntries(rows.map((r) => [r.sessionId, r]))
  assert.equal(byId.a.lastSeq, null)
  assert.equal(byId.b.lastSeq, 1)
  assert.equal(call, 2)
})

/* ----------------------------------------------------------------- 状态 */

test('formatStatus=unreadable：标 unreadable 且不去解码', async () => {
  const list = async () => [snapshot('bad', { formatStatus: 'unreadable' })]
  const reader = fakeReader({ bad: mkEvents(3) })
  const collect = createSessionIndexReporter({ listSessions: list, openSession: reader.open })
  const { rows } = await collect()

  assert.equal(rows[0].state, 'unreadable')
  assert.equal(rows[0].lastSeq, null)
  assert.deepEqual(reader.opened, [])
})

test('resolveState 能问到运行态就用，问不到或非法则回落 stopped', async () => {
  const list = async () => [snapshot('a'), snapshot('b'), snapshot('c')]
  const hints = { a: 'running', b: 'nonsense' }
  const collect = createSessionIndexReporter({
    listSessions: list, resolveState: (id) => hints[id] ?? null,
  })
  const { rows } = await collect()
  const byId = Object.fromEntries(rows.map((r) => [r.sessionId, r]))

  assert.equal(byId.a.state, 'running')
  assert.equal(byId.b.state, 'stopped')
  assert.equal(byId.c.state, 'stopped')
  assert.deepEqual(STATES, ['running', 'awaiting', 'completed', 'stopped', 'failed', 'unreadable'])
})

/* ----------------------------------------------------------------- 兜底 */

test('list 抛错：返回 error 且不编造行', async () => {
  const collect = createSessionIndexReporter({
    listSessions: async () => { throw new Error('EACCES') },
  })
  const r = await collect()
  assert.deepEqual(r.rows, [])
  assert.match(r.error, /EACCES/)
})

test('缺 id 的快照被跳过；limit 缺省 50', async () => {
  const list = async () => [
    { header: {}, formatStatus: 'ok', revision: 'r' },
    ...Array.from({ length: 60 }, (_, i) => snapshot(`s${i}`)),
  ]
  const collect = createSessionIndexReporter({ listSessions: list })
  const { rows } = await collect()
  assert.equal(rows.length, DEFAULT_LIMIT)
  assert.equal(DEFAULT_LIMIT, 50)
})

test('createSessionIndexReporter 必须有 listSessions', () => {
  assert.throws(() => createSessionIndexReporter({}), /listSessions/)
})

test('toHeaderRef 对缺字段的 header 给 null，不抛错', () => {
  assert.deepEqual(toHeaderRef({ version: 4 }), {
    version: 4, parentSession: null, delegationDepth: null,
    agentPreset: null, isSeeded: null, origin: null,
  })
  assert.equal(toHeaderRef(undefined).version, null)
})
