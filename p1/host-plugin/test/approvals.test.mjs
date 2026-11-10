/**
 * 审批桥单测（W8）
 * 契约来自宿主实测：`ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`，
 * `ctx.on('approval/request', (request, next) => Promise<ApprovalOutcome>)` 是瀑布。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createApprovalBridge, pickReason } from '../src/approvals.js'

/** 造一个假 request：agent.session.id + toolName + 可选 signal。 */
const mkRequest = ({ sessionId = 'session-1', toolName = 'shell_run', signal, reason } = {}) => ({
  agent: { session: { id: sessionId } },
  toolName,
  callId: 'call-42',
  ...(reason ? { reason } : {}),
  ...(signal ? { signal } : {}),
})

/** 收集上行帧的假发送器；offline=true 时模拟没连上。 */
const mkSend = (offline = false) => {
  const frames = []
  const send = (f) => { if (offline) return false; frames.push(f); return true }
  return { send, frames }
}

const nextSpy = () => {
  const calls = { n: 0 }
  const next = async () => { calls.n++; return 'unavailable' }
  return { next, calls }
}

test('A1 手机在线：请求帧带齐字段；手机允许 → 返回 allowed-once', async () => {
  const { send, frames } = mkSend()
  const bridge = createApprovalBridge({ send, timeoutMs: 5000 })
  const { next, calls } = nextSpy()

  const p = bridge.onRequest(mkRequest(), next)
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(frames.length, 1)
  const f = frames[0]
  assert.equal(f.t, '$events/request')
  assert.equal(f.sessionId, 'session-1')
  assert.equal(f.toolName, 'shell_run')
  assert.equal(f.callId, 'call-42')
  assert.ok(f.approvalId && typeof f.approvalId === 'string')
  assert.ok(f.expiresAt > Date.now())

  const r = bridge.answer({ approvalId: f.approvalId, outcome: 'allowed-once' })
  assert.deepEqual(r, { ok: true, outcome: 'allowed-once' })
  assert.equal(await p, 'allowed-once')
  assert.equal(calls.n, 0, '手机答了就不该再交棒')
  assert.equal(bridge.pending.size, 0)
  // 撤卡通知也要发出去，否则手机界面停在「待审批」
  assert.equal(frames.at(-1).t, '$events/resolved')
  assert.equal(frames.at(-1).outcome, 'allowed-once')
})

test('A2 手机拒绝 → rejected（不是 cancelled，也不是 unavailable）', async () => {
  const { send, frames } = mkSend()
  const bridge = createApprovalBridge({ send, timeoutMs: 5000 })
  const { next } = nextSpy()
  const p = bridge.onRequest(mkRequest(), next)
  await new Promise((r) => setTimeout(r, 5))
  bridge.answer({ approvalId: frames[0].approvalId, outcome: 'rejected' })
  assert.equal(await p, 'rejected')
})

test('A3 手机离线 → 立刻 next()，不许占着这单（桌面端不能被手机拖住）', async () => {
  const { send } = mkSend(true)
  const bridge = createApprovalBridge({ send, timeoutMs: 5000 })
  const { next, calls } = nextSpy()
  const r = await bridge.onRequest(mkRequest(), next)
  assert.equal(r, 'unavailable', '离线时应返回 next() 的结果')
  assert.equal(calls.n, 1)
  assert.equal(bridge.pending.size, 0)
  assert.equal(bridge.stats.delegatedOffline, 1)
})

test('A4 超时 → next() 交棒桌面端，且发出撤卡通知（超时不是 unavailable）', async () => {
  const { send, frames } = mkSend()
  const bridge = createApprovalBridge({ send, timeoutMs: 30 })
  const { next, calls } = nextSpy()
  const r = await bridge.onRequest(mkRequest(), next)
  assert.equal(r, 'unavailable')
  assert.equal(calls.n, 1, '超时后必须交棒')
  assert.equal(bridge.pending.size, 0, '超时的单子要从账本摘掉，否则手机列表永远挂着')
  assert.equal(frames.at(-1).t, '$events/resolved')
  assert.equal(frames.at(-1).by, 'timeout')
})

test('A5 宿主 abort（桌面端先答）→ 撤卡、交棒，手机再答算 stale', async () => {
  const { send, frames } = mkSend()
  const bridge = createApprovalBridge({ send, timeoutMs: 5000 })
  const { next, calls } = nextSpy()
  const ac = new AbortController()
  const p = bridge.onRequest(mkRequest({ signal: ac.signal }), next)
  await new Promise((r) => setTimeout(r, 5))
  const id = frames[0].approvalId

  ac.abort()
  assert.equal(await p, 'unavailable')
  assert.equal(calls.n, 1)
  assert.equal(bridge.pending.size, 0)
  assert.equal(frames.at(-1).by, 'host')

  const late = bridge.answer({ approvalId: id, outcome: 'allowed-once' })
  assert.deepEqual(late, { ok: false, code: 'APPROVAL_GONE' }, '先答先得：abort 之后手机再答必须被拒')
  assert.equal(bridge.stats.staleAnswers, 1)
})

test('A6 手机连点两次：第二次 APPROVAL_GONE，不会二次 resolve', async () => {
  const { send, frames } = mkSend()
  const bridge = createApprovalBridge({ send, timeoutMs: 5000 })
  const { next } = nextSpy()
  const p = bridge.onRequest(mkRequest(), next)
  await new Promise((r) => setTimeout(r, 5))
  const id = frames[0].approvalId
  assert.equal(bridge.answer({ approvalId: id, outcome: 'allowed-once' }).ok, true)
  assert.deepEqual(bridge.answer({ approvalId: id, outcome: 'rejected' }), { ok: false, code: 'APPROVAL_GONE' })
  assert.equal(await p, 'allowed-once', '结果必须是第一次那个')
})

test('A7 非法 outcome 一律拒（不把手机传来的任意串透给宿主）', () => {
  const { send } = mkSend()
  const bridge = createApprovalBridge({ send })
  for (const bad of ['allowed', 'ALLOWED-ONCE', 'unavailable', '', null, undefined, 1]) {
    assert.deepEqual(bridge.answer({ approvalId: 'x', outcome: bad }), { ok: false, code: 'INVALID_OUTCOME' })
  }
})

test('A8 没有会话 id 的审批不接管（无从对应手机上的会话）', async () => {
  const { send, frames } = mkSend()
  const bridge = createApprovalBridge({ send })
  const { next, calls } = nextSpy()
  const r = await bridge.onRequest({ toolName: 'x' }, next)
  assert.equal(r, 'unavailable')
  assert.equal(calls.n, 1)
  assert.equal(frames.length, 0)
})

test('A9 多张卡并存：list() 能给手机拉全量，答案各归各的', async () => {
  const { send, frames } = mkSend()
  const bridge = createApprovalBridge({ send, timeoutMs: 5000 })
  const { next } = nextSpy()
  const p1 = bridge.onRequest(mkRequest({ sessionId: 's-1', toolName: 'shell_run' }), next)
  const p2 = bridge.onRequest(mkRequest({ sessionId: 's-2', toolName: 'file_write' }), next)
  await new Promise((r) => setTimeout(r, 10))
  const listed = bridge.list()
  assert.equal(listed.length, 2)
  assert.deepEqual(listed.map((x) => x.toolName).sort(), ['file_write', 'shell_run'])

  bridge.answer({ approvalId: listed.find((x) => x.sessionId === 's-2').approvalId, outcome: 'rejected' })
  assert.equal(await p2, 'rejected')
  assert.equal(bridge.pending.size, 1)

  bridge.answer({ approvalId: bridge.list()[0].approvalId, outcome: 'allowed-once' })
  assert.equal(await p1, 'allowed-once')
  assert.equal(bridge.pending.size, 0)
})

test('A10 dispose（插件卸载）→ 未决单全部 cancelled 并通知手机', async () => {
  const { send, frames } = mkSend()
  const bridge = createApprovalBridge({ send, timeoutMs: 5000 })
  const { next } = nextSpy()
  const p = bridge.onRequest(mkRequest(), next)
  await new Promise((r) => setTimeout(r, 5))
  bridge.dispose()
  assert.equal(await p, 'cancelled')
  assert.equal(bridge.pending.size, 0)
  assert.equal(frames.at(-1).outcome, 'cancelled')
  assert.equal(frames.at(-1).by, 'shutdown')
})

test('A11 displayReason 取值：中文优先 → en → reason → null', () => {
  assert.equal(pickReason({ displayReason: { en: 'Write file', zh: '写入文件' } }), '写入文件')
  assert.equal(pickReason({ displayReason: { en: 'Write file' } }), 'Write file')
  assert.equal(pickReason({ reason: 'needs write' }), 'needs write')
  assert.equal(pickReason({}), null)
  assert.equal(pickReason({ displayReason: { zh: '   ' }, reason: '  ' }), null)
})
