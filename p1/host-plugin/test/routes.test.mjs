/**
 * 下行端点表（协议名唯一落点）
 * 这张表的意义不是"少写几行 if"，而是**协议名集中在一处**：
 * 将来若要按 ACP 命名对外，只改这张表，不用在 17 个分支里找。
 * 所以测试要盯两件事：表与适配器是否一一对上、ACP 映射是否指向真实端点。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRoutes, notAllowed, ACP_EQUIVALENT } from '../src/routes.js'

const unwrap = (r, fallback = {}) => (r?.ok === false
  ? { status: 409, body: { ok: false, error: { code: r.code } } }
  : { status: 200, body: { ok: true, data: r?.value ?? fallback } })

const errBody = (code, message) => ({ ok: false, error: { code, message } })

/** 所有适配器都记账，用来断言"每个端点都真的问到了对应的适配器"。 */
const makeAdapters = () => {
  const seen = []
  const one = (name) => async (args) => { seen.push({ name, args }); return { ok: true, value: { via: name } } }
  return {
    seen,
    submitPrompt: one('submitPrompt'),
    setPinned: one('setPinned'),
    listSchedules: one('listSchedules'),
    createSchedule: one('createSchedule'),
    runSchedule: one('runSchedule'),
    renameSession: one('renameSession'),
    createArtifactTicket: one('createArtifactTicket'),
    setArchived: one('setArchived'),
    cancelTurn: one('cancelTurn'),
    createSession: one('createSession'),
    mirrorList: one('mirrorList'),
    mirrorFile: one('mirrorFile'),
    replay: one('replay'),
    uploadAttachment: one('uploadAttachment'),
    backfill: one('backfill'),
    listArtifacts: one('listArtifacts'),
  }
}

const makeApprovals = (result) => ({ answer: () => result })

const build = (adapters, approvals) => createRoutes({
  adapters, approvals, unwrap, errBody, protocol: 'wbsync/1',
})

test('R1 每个会话端点都转发到对应适配器，并统一返回 {status,body}', async () => {
  const adapters = makeAdapters()
  const routes = build(adapters, makeApprovals({ ok: true, outcome: 'allowed-once' }))

  const cases = [
    ['session/prompt', 'submitPrompt', { sessionId: 's1', text: 'hi', clientMsgId: 'c1' }],
    ['session/pin', 'setPinned', { sessionId: 's1', pinned: true }],
    ['session/schedule-list', 'listSchedules', {}],
    ['session/schedule-create', 'createSchedule', { title: 't' }],
    ['session/schedule-run', 'runSchedule', { id: 'i1' }],
    ['session/rename', 'renameSession', { sessionId: 's1', title: 'x' }],
    ['session/artifact-ticket', 'createArtifactTicket', { sessionId: 's1', path: 'a.docx' }],
    ['session/archive', 'setArchived', { sessionId: 's1', archived: true }],
    ['session/cancel', 'cancelTurn', { sessionId: 's1' }],
    ['session/create', 'createSession', { text: 't' }],
    ['session/mirror-list', 'mirrorList', {}],
    ['session/mirror-file', 'mirrorFile', { sid: 'a/b', name: 'session.v1.jsonl.zstd' }],
    ['session/follow', 'replay', { sessionId: 's1', sinceSeq: -1 }],
    ['fileUploads/upload', 'uploadAttachment', { sessionId: 's1', name: 'a.png' }],
    ['session/backfill', 'backfill', { sessionId: 's1', beforeSeq: 10 }],
    ['session/artifacts', 'listArtifacts', { sessionId: 's1' }],
  ]

  for (const [endpoint, adapter, body] of cases) {
    const route = routes[endpoint]
    assert.equal(typeof route, 'function', `${endpoint} 必须在表里`)
    const r = await route(body)
    assert.equal(r.status, 200, `${endpoint} 应 200`)
    assert.equal(r.body.ok, true, `${endpoint} 应 ok`)
    assert.equal(adapters.seen.at(-1).name, adapter, `${endpoint} 应问到 ${adapter}`)
  }
})

test('R2 prompt 无附件时不透传 attachments 字段（参数形状兼容旧版）', async () => {
  const adapters = makeAdapters()
  const routes = build(adapters, makeApprovals({ ok: true, outcome: 'allowed-once' }))
  await routes['session/prompt']({ sessionId: 's1', text: 'x' })
  assert.equal('attachments' in adapters.seen.at(-1).args, false)
  await routes['session/prompt']({ sessionId: 's1', text: 'x', attachments: [] })
  assert.deepEqual(adapters.seen.at(-1).args.attachments, [])
})

test('R3 审批应答区分「参数错 400」与「已被答 409」', async () => {
  const adapters = makeAdapters()

  const bad = build(adapters, makeApprovals({ ok: false, code: 'INVALID_OUTCOME' }))
  const r1 = await bad['$events/result']({ approvalId: 'a', outcome: 'x' })
  assert.equal(r1.status, 400)
  assert.equal(r1.body.error.code, 'INVALID_JSON')

  const gone = build(adapters, makeApprovals({ ok: false, code: 'GONE' }))
  const r2 = await gone['$events/result']({ approvalId: 'a', outcome: 'rejected' })
  assert.equal(r2.status, 409)
  assert.equal(r2.body.error.code, 'APPROVAL_GONE')

  const okRoutes = build(adapters, makeApprovals({ ok: true, outcome: 'allowed-once' }))
  const r3 = await okRoutes['$events/result']({ approvalId: 'a', outcome: 'allowed-once' })
  assert.equal(r3.status, 200)
  assert.equal(r3.body.data.outcome, 'allowed-once')
})

test('R4 未知端点 403，且错误语义与旧实现一致', () => {
  const r = notAllowed('session/nope', errBody)
  assert.equal(r.status, 403)
  assert.equal(r.body.error.code, 'ENDPOINT_NOT_ALLOWED')
})

test('R5 ACP 映射只指向表里真实存在的端点（防止映射写空）', () => {
  const routes = build(makeAdapters(), makeApprovals({ ok: true, outcome: 'allowed-once' }))
  for (const [ours, acp] of Object.entries(ACP_EQUIVALENT)) {
    assert.equal(typeof routes[ours], 'function', `${ours} 必须真实存在（ACP 对应 ${acp}）`)
    assert.match(acp, /^(session|fs|terminal)\//, 'ACP 方法名应有命名空间前缀')
  }
})
