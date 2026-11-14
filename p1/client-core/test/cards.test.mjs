/**
 * S-8.3 协议内置卡片（r23）· 确定性单测
 * 覆盖 v2.3 07 的 TC-1.12（限额/频率/问题数）、TC-5.12（未知 kind 灰色占位）、
 * TC-5.11 的数据层前提（卡片归一化与链路无关、不改写事件原文）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CARD_T, CARD_SCHEMA, CARD_KINDS, CARD_LIMITS, CARD_ERR,
  validateCard, normalizeCard, cardFromEvent, createCardGuard,
} from '../src/cards.js'

const card = (over = {}) => ({
  t: CARD_T,
  cardId: 'artifact:report-001',
  kind: 'artifact',
  view: { title: '报告', rows: [{ name: 'a', value: 1 }] },
  actions: [{ id: 'open', label: '打开' }],
  ...over,
})

test('C1 四种合法 kind 全部通过校验，knownKind 为真', () => {
  for (const kind of CARD_KINDS) {
    const v = validateCard(card({ kind }))
    assert.equal(v.ok, true, kind)
    assert.equal(v.knownKind, true, kind)
    assert.deepEqual(v.problems, [], kind)
    assert.equal(v.schema, CARD_SCHEMA)
    assert.equal(normalizeCard(card({ kind })).placeholder, false, kind)
  }
})

test('C2 未知 kind 不算违规，归一化出灰色占位且保留 rawKind', () => {
  const c = card({ kind: 'chart-3d' })
  const v = validateCard(c)
  assert.equal(v.ok, true)
  assert.equal(v.knownKind, false)
  const n = normalizeCard(c)
  assert.equal(n.kind, 'unknown')
  assert.equal(n.placeholder, true)
  assert.equal(n.rawKind, 'chart-3d')
  assert.equal(n.reason, 'UNKNOWN_KIND')
  assert.deepEqual(n.view, {})
})

test('C3 单张工具卡 > 8 KiB → CARD_TOO_LARGE', () => {
  const v = validateCard(card({ view: { blob: 'x'.repeat(CARD_LIMITS.cardBytes + 64) } }))
  assert.equal(v.ok, false)
  assert.ok(v.problems.includes(CARD_ERR.CARD_TOO_LARGE))
  assert.ok(v.cardBytes > CARD_LIMITS.cardBytes)
})

test('C4 面板视图 > 32 KiB → VIEW_TOO_LARGE', () => {
  const v = validateCard(card({ view: { blob: 'y'.repeat(CARD_LIMITS.viewBytes + 64) } }))
  assert.equal(v.ok, false)
  assert.ok(v.problems.includes(CARD_ERR.VIEW_TOO_LARGE))
  assert.ok(v.viewBytes > CARD_LIMITS.viewBytes)
})

test('C5 cardId 为空 / 非字符串 / 超 128 字符 → BAD_CARD_ID', () => {
  for (const cardId of ['', null, 42, 'z'.repeat(CARD_LIMITS.cardIdMax + 1)]) {
    const v = validateCard(card({ cardId }))
    assert.equal(v.ok, false)
    assert.ok(v.problems.includes(CARD_ERR.BAD_CARD_ID))
  }
})

test('C6 view 缺失或非普通对象 → BAD_VIEW', () => {
  for (const view of [undefined, null, 'text', [1, 2]]) {
    assert.ok(validateCard(card({ view })).problems.includes(CARD_ERR.BAD_VIEW))
  }
})

test('C7 actions 结构非法 / 超上限 → BAD_ACTIONS', () => {
  assert.ok(validateCard(card({ actions: 'nope' })).problems.includes(CARD_ERR.BAD_ACTIONS))
  assert.ok(validateCard(card({ actions: [{ id: 'x' }] })).problems.includes(CARD_ERR.BAD_ACTIONS))
  assert.ok(validateCard(card({
    actions: Array.from({ length: CARD_LIMITS.actionsMax + 1 }, (_, i) => ({ id: `a${i}`, label: 'A' })),
  })).problems.includes(CARD_ERR.BAD_ACTIONS))
  assert.equal(validateCard(card()).ok, true)
})

test('C8 非卡片对象 / t 不符 → BAD_SHAPE', () => {
  for (const c of [null, [], { t: 'other' }, { cardId: 'x' }]) {
    assert.ok(validateCard(c).problems.includes(CARD_ERR.BAD_SHAPE))
  }
})

test('C9 违规卡片的归一化结果不携带违规正文', () => {
  const secret = 'x'.repeat(CARD_LIMITS.cardBytes + 64)
  const n = normalizeCard(card({ view: { secret } }))
  assert.equal(n.placeholder, true)
  assert.deepEqual(n.view, {})
  assert.deepEqual(n.actions, [])
  assert.equal(n.reason, CARD_ERR.CARD_TOO_LARGE)
})

test('C10 cardFromEvent 兼容 data / 事件体 / type 三种形态', () => {
  const c = card()
  assert.equal(cardFromEvent({ type: 'assistant/message', seq: 1, data: c }), c)
  assert.equal(cardFromEvent(c), c)
  // 第三种：事件体以 type 声明时，返回值就是事件本身
  const asType = { type: CARD_T, seq: 2, cardId: 'x', kind: 'metric', view: {} }
  assert.equal(cardFromEvent(asType), asType)
})

test('C11 非卡片事件返回 null，不触发任何校验', () => {
  for (const ev of [null, {}, { type: 'user/message', data: { text: 'hi' } }, { t: 'session/event' }]) {
    assert.equal(cardFromEvent(ev), null)
  }
})

test('C12 合并频率 > 4 Hz → 第 5 次 RATE_LIMITED（时间可注入，确定性）', () => {
  let t = 10_000
  const g = createCardGuard({ now: () => t })
  for (let i = 0; i < CARD_LIMITS.mergeHz; i++) {
    assert.equal(g.check(card({ cardId: `c-${i}` })).code, null)
  }
  const limited = g.check(card({ cardId: 'c-5' }))
  assert.equal(limited.code, CARD_ERR.RATE_LIMITED)
  assert.equal(limited.problems, 1)
  t += CARD_LIMITS.rateWindowMs + 1
  assert.equal(g.check(card({ cardId: 'c-6' })).code, null)
})

test('C13 连续 5 次违规 → 整体降级为 web 版本', () => {
  let t = 0
  const g = createCardGuard({ now: () => t })
  for (let i = 1; i <= CARD_LIMITS.degradeAfter; i++) {
    t += 10
    const r = g.check(card({ t: 'bad' }))
    assert.equal(r.consecutive, i)
    assert.equal(r.degraded, i >= CARD_LIMITS.degradeAfter)
  }
  assert.equal(g.snapshot().degraded, true)
  assert.equal(g.check(card()).code, CARD_ERR.DEGRADED)
})

test('C14 一次合规把连续违规计数归零，但不解除已生效的降级', () => {
  let t = 0
  const g = createCardGuard({ now: () => (t += 10) })
  for (let i = 0; i < 4; i++) g.check(card({ t: 'bad' }))
  assert.equal(g.check(card()).consecutive, 0)
  assert.equal(g.snapshot().degraded, false)
  for (let i = 0; i < CARD_LIMITS.degradeAfter; i++) g.check(card({ t: 'bad' }))
  assert.equal(g.snapshot().degraded, true)
  assert.equal(g.check(card()).consecutive, 0)
  assert.equal(g.snapshot().degraded, true)   // 只有 reset() 能解除
})

test('C15 reset() 清空问题数并解除降级（重启引擎 / 重新启用）', () => {
  let t = 0
  const g = createCardGuard({ now: () => (t += 10) })
  for (let i = 0; i < 6; i++) g.check(card({ t: 'bad' }))
  assert.equal(g.snapshot().degraded, true)
  assert.ok(g.snapshot().problems >= 6)
  g.reset()
  assert.deepEqual(g.snapshot(), {
    schema: CARD_SCHEMA, problems: 0, consecutive: 0, degraded: false, lastCode: null,
  })
  assert.equal(g.check(card()).code, null)
})

test('C16 问题数按违规次数累计，快照只暴露计数不暴露正文', () => {
  const g = createCardGuard({ now: () => 1 })
  g.check(card({ t: 'bad' }))
  g.check(card({ view: null }))
  assert.equal(g.snapshot().problems, 2)
  assert.equal(g.snapshot().lastCode, CARD_ERR.BAD_VIEW)
  assert.deepEqual(Object.keys(g.snapshot()).sort(),
    ['consecutive', 'degraded', 'lastCode', 'problems', 'schema'])
})

test('C17 normalizeCard 是纯函数：不改入参、同输入同输出', () => {
  const c = card()
  const before = JSON.stringify(c)
  assert.deepEqual(normalizeCard(c), normalizeCard(c))
  assert.equal(JSON.stringify(c), before)
})

test('C18 枚举与限额冻结，新增 kind 必须升 schema 而不是私改数组', () => {
  assert.equal(Object.isFrozen(CARD_KINDS), true)
  assert.equal(Object.isFrozen(CARD_LIMITS), true)
  assert.equal(Object.isFrozen(CARD_ERR), true)
  assert.equal(CARD_SCHEMA, 'wbsync.card/1')
  assert.deepEqual([...CARD_KINDS], ['artifact', 'approval', 'metric', 'table'])
})
