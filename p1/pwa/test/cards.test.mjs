/**
 * PWA · 协议内置卡片投递（r23 / S-8.3）
 * 覆盖 TC-5.11（live 与 replay 归一化一致）、TC-5.12（未知 kind 灰色占位、
 * 其余 UI 正常）、TC-1.12（违规标注问题数、连续违规降级）。
 * 纯逻辑测试：不启 Relay、不开 WebSocket，所有 I/O 与时钟都在此注入。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createCardDelivery } from '../src/card-delivery.js'
import { CARD_T, CARD_LIMITS, CARD_ERR, APPROVAL_ACTION_OUTCOMES, cardTarget, resolveCardAction } from '../src/cards.js'

const card = (over = {}) => ({
  t: CARD_T,
  cardId: 'artifact:report-001',
  kind: 'artifact',
  view: { title: '报告', rows: [{ name: 'a', value: 1 }] },
  actions: [{ id: 'open', label: '打开' }],
  ...over,
})
const ev = (data, seq = 1) => ({ type: 'assistant/message', seq, time: 1, data })

const harness = (over = {}) => {
  const events = []
  const cards = []
  let states = 0
  const delivery = createCardDelivery({
    now: () => 10_000,
    onEvent: (e) => events.push(e),
    onCard: (c) => cards.push(c),
    onStateChange: () => { states += 1 },
    ...over,
  })
  return { delivery, events, cards, stateCount: () => states }
}

test('P1 非卡片事件原样交给 onEvent，不触发 onCard', () => {
  const h = harness()
  const raw = ev({ text: '你好' })
  assert.equal(h.delivery.deliver({ sessionId: 's1', ev: raw, source: 'live' }), null)
  assert.equal(h.events.length, 1)
  assert.equal(h.events[0].ev, raw)
  assert.equal(h.cards.length, 0)
  assert.equal(h.stateCount(), 0)
})

test('P2 合法卡片归一化后交给 onCard，seq / source 不丢', () => {
  const h = harness()
  const payload = h.delivery.deliver({ sessionId: 's1', ev: ev(card(), 7), source: 'live' })
  assert.equal(payload.seq, 7)
  assert.equal(payload.source, 'live')
  assert.equal(payload.card.placeholder, false)
  assert.equal(payload.card.reason, null)
  assert.deepEqual(payload.card.view, card().view)
  assert.equal(h.cards.length, 1)
  assert.equal(h.stateCount(), 0)
})

test('P3 未知 kind 灰色占位、保留 rawKind，普通事件仍照常投递', () => {
  const h = harness()
  const raw = ev(card({ kind: 'chart-3d' }))
  const payload = h.delivery.deliver({ sessionId: 's1', ev: raw, source: 'live' })
  assert.equal(payload.card.placeholder, true)
  assert.equal(payload.card.kind, 'unknown')
  assert.equal(payload.card.rawKind, 'chart-3d')
  assert.equal(h.events[0].ev, raw)            // 其余 UI 不受影响
  assert.equal(h.events.length, 1)
})

test('P4 live 与 replay 两条链路的卡片模型完全一致（TC-5.11 数据层）', () => {
  const live = harness()
  const replay = harness()
  const raw = ev(card(), 3)
  const a = live.delivery.deliver({ sessionId: 's1', ev: raw, source: 'live' })
  const b = replay.delivery.deliver({ sessionId: 's1', ev: raw, source: 'replay' })
  assert.deepEqual(a.card, b.card)
  assert.equal(a.source, 'live')
  assert.equal(b.source, 'replay')
  assert.deepEqual(a.verdict, b.verdict)
})

test('P5 超限卡片：占位、正文不交给渲染器、问题数进状态通知', () => {
  const h = harness()
  const payload = h.delivery.deliver({
    sessionId: 's1',
    ev: ev(card({ view: { blob: 'x'.repeat(CARD_LIMITS.cardBytes + 64) } })),
    source: 'live',
  })
  assert.equal(payload.card.placeholder, true)
  assert.deepEqual(payload.card.view, {})
  assert.equal(payload.verdict.code, CARD_ERR.CARD_TOO_LARGE)
  assert.equal(h.stateCount(), 1)
  assert.equal(h.delivery.snapshot().problems, 1)
})

test('P6 连续 5 次违规整体降级，后续卡片也按 web 版本占位', () => {
  const h = harness()
  for (let i = 0; i < CARD_LIMITS.degradeAfter; i++) {
    h.delivery.deliver({ sessionId: 's1', ev: ev(card({ t: 'bad' }), i + 1), source: 'live' })
  }
  assert.equal(h.delivery.snapshot().degraded, true)
  const next = h.delivery.deliver({ sessionId: 's1', ev: ev(card(), 99), source: 'live' })
  assert.equal(next.verdict.code, CARD_ERR.DEGRADED)
  assert.equal(next.card.placeholder, true)
  assert.equal(next.card.reason, CARD_ERR.DEGRADED)
})

test('P7 reset() 解除降级并清空问题数', () => {
  const h = harness()
  for (let i = 0; i < 6; i++) {
    h.delivery.deliver({ sessionId: 's1', ev: ev(card({ t: 'bad' }), i + 1), source: 'live' })
  }
  assert.equal(h.delivery.snapshot().degraded, true)
  h.delivery.reset()
  assert.deepEqual(h.delivery.snapshot(), {
    schema: 'wbsync.card/1', problems: 0, consecutive: 0, degraded: false, lastCode: null,
  })
  assert.equal(h.delivery.deliver({ sessionId: 's1', ev: ev(card(), 9), source: 'live' }).card.placeholder, false)
})

test('P8 onCard 抛异常被隔离，不阻断 onEvent 与后续投递', () => {
  const h = harness({ onCard: () => { throw new Error('UI 崩了') } })
  assert.doesNotThrow(() => h.delivery.deliver({ sessionId: 's1', ev: ev(card()), source: 'live' }))
  assert.equal(h.events.length, 1)
  assert.equal(h.delivery.deliver({ sessionId: 's1', ev: ev({ text: '继续' }, 2), source: 'live' }), null)
  assert.equal(h.events.length, 2)
})

test('P9 快照只暴露计数，不含任何卡片正文', () => {
  const h = harness()
  h.delivery.deliver({ sessionId: 's1', ev: ev(card({ view: null })), source: 'live' })
  assert.deepEqual(Object.keys(h.delivery.snapshot()).sort(),
    ['consecutive', 'degraded', 'lastCode', 'problems', 'schema'])
  assert.equal(h.delivery.snapshot().lastCode, CARD_ERR.BAD_VIEW)
})

test('P10 approval 卡（cardId=approval:<id>）解析出回传目标并随投递载荷下发', () => {
  const h = harness()
  const payload = h.delivery.deliver({
    sessionId: 's1',
    ev: ev(card({ kind: 'approval', cardId: 'approval:appr-77', actions: [{ id: 'allow', label: '允许' }, { id: 'deny', label: '拒绝' }] })),
    source: 'live',
  })
  assert.deepEqual(payload.target, { type: 'approval', approvalId: 'appr-77' })
  assert.deepEqual(cardTarget(payload.card), { type: 'approval', approvalId: 'appr-77' })
})

test('P11 allow/deny 映射到 $events/result 的 outcome，未知 actionId 不映射', () => {
  const model = cardTarget({ kind: 'approval', cardId: 'approval:appr-77' })
  assert.deepEqual(resolveCardAction({ kind: 'approval', cardId: 'approval:appr-77' }, 'allow'),
    { type: 'approval', approvalId: 'appr-77', outcome: APPROVAL_ACTION_OUTCOMES.allow })
  assert.equal(APPROVAL_ACTION_OUTCOMES.allow, 'allowed-once')
  assert.equal(APPROVAL_ACTION_OUTCOMES.deny, 'rejected')
  assert.deepEqual(resolveCardAction({ kind: 'approval', cardId: 'approval:appr-77' }, 'deny'),
    { type: 'approval', approvalId: 'appr-77', outcome: 'rejected' })
  assert.equal(resolveCardAction({ kind: 'approval', cardId: 'approval:appr-77' }, 'later'), null)
})

test('P12 approval 前缀后为空 → 无回传目标（不给 UI 猜的口子）', () => {
  assert.equal(cardTarget({ kind: 'approval', cardId: 'approval:' }), null)
  assert.equal(resolveCardAction({ kind: 'approval', cardId: 'approval:' }, 'allow'), null)
})

test('P13 artifact 卡（cardId=artifact:<id>）解析出产物目标，动作不限 id', () => {
  const m = { kind: 'artifact', cardId: 'artifact:file-42' }
  assert.deepEqual(cardTarget(m), { type: 'artifact', artifactId: 'file-42' })
  assert.deepEqual(resolveCardAction(m, 'preview'), { type: 'artifact', artifactId: 'file-42' })
  assert.deepEqual(resolveCardAction(m, 'save'), { type: 'artifact', artifactId: 'file-42' })
})

test('P14 metric / table / 未知 kind 与无前缀 cardId 都无回传目标', () => {
  for (const m of [
    { kind: 'metric', cardId: 'metric:cpu' },
    { kind: 'table', cardId: 'table:rows' },
    { kind: 'unknown', cardId: 'approval:appr-77', placeholder: true },
    { kind: 'approval', cardId: 'plain-77' },
    { kind: 'artifact', cardId: 'file-42' },
    null,
  ]) {
    assert.equal(cardTarget(m), null, JSON.stringify(m))
  }
})

test('P15 resolveCardAction 对空 actionId 返回 null', () => {
  assert.equal(resolveCardAction({ kind: 'artifact', cardId: 'artifact:file-42' }, ''), null)
  assert.equal(resolveCardAction({ kind: 'artifact', cardId: 'artifact:file-42' }, null), null)
})
