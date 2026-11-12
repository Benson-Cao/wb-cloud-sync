/**
 * W3 · CP 元数据存储单测
 * ---------------------------------------------------------------
 * 全程注入 `now()` 与 `newId()`，让租约过期、设备离线这类时间判定变成确定性断言，
 * 不靠 sleep、也不靠真实时钟。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  createControlPlane, ControlPlaneError, sha256Hex,
  LEASE_TTL_MS, DEVICE_OFFLINE_MS, SESSION_STATES,
} from '../src/index.js'

/* ---------------------------------------------------------------- 夹具 */

const makeClock = (start = 1_700_000_000_000) => {
  let t = start
  return { now: () => t, advance: (ms) => { t += ms }, set: (v) => { t = v } }
}

const makeCp = (opts = {}) => {
  const clock = makeClock()
  let seq = 0
  const cp = createControlPlane({ now: clock.now, newId: () => `lease-${++seq}`, ...opts })
  return { cp, clock }
}

const sessionRow = (id, extra = {}) => ({
  sessionId: id,
  ownerDeviceId: 'pc-1',
  workspace: 'C:\\work\\demo',
  title: null,
  pinned: false,
  pinnedOrder: 0,
  state: 'stopped',
  lastSeq: 3,
  lastActiveAt: 1_700_000_000_000,
  headerRef: { version: 4, parentSession: null, delegationDepth: 0, agentPreset: 'standard', isSeeded: false, origin: null },
  ...extra,
})

const device = (id = 'pc-1', extra = {}) => ({ deviceId: id, platform: 'windows', capabilities: ['attachments'], ...extra })

/* --------------------------------------------------------------- Device */

test('设备注册：令牌摘要只能由配对写入，注册不许顶掉别人的令牌', () => {
  const { cp } = makeCp()
  cp.upsertDevice(device('pc-1'))
  assert.equal(cp.getDevice('pc-1').tokenDigest, null)

  cp.setDeviceToken('pc-1', 'tok-abc')
  const digest = cp.getDevice('pc-1').tokenDigest
  assert.equal(digest, sha256Hex('tok-abc'))
  assert.notEqual(digest, 'tok-abc', '绝不存明文')

  // Host 再注册一次（带任意 tokenDigest 字段）也不能改摘要
  cp.upsertDevice({ ...device('pc-1'), tokenDigest: sha256Hex('attacker') })
  assert.equal(cp.getDevice('pc-1').tokenDigest, digest)
  assert.equal(cp.verifyDeviceToken('pc-1', 'tok-abc'), true)
  assert.equal(cp.verifyDeviceToken('pc-1', 'attacker'), false)
  assert.equal(cp.verifyDeviceToken('pc-1', ''), false)
})

test('吊销是墓碑：不复活、清令牌、连会话与租约一起清', () => {
  const { cp } = makeCp()
  cp.upsertDevice(device('pc-1'))
  cp.setDeviceToken('pc-1', 'tok')
  cp.upsertSessions('pc-1', [sessionRow('s1')])
  cp.acquireLease({ sessionId: 's1', deviceId: 'pc-1' })

  cp.revokeDevice('pc-1')
  const d = cp.getDevice('pc-1')
  assert.equal(d.tombstone, true)
  assert.equal(d.tokenDigest, null)
  assert.equal(cp.verifyDeviceToken('pc-1', 'tok'), false)
  assert.equal(cp.listSessions({ ownerDeviceId: 'pc-1' }).length, 0, '不该留幽灵会话')
  assert.deepEqual(cp.listLeases(), [])

  assert.throws(() => cp.upsertDevice(device('pc-1')), (e) => e.code === 'UNAUTHORIZED')
  assert.throws(() => cp.heartbeatDevice('pc-1'), (e) => e.code === 'HOST_OFFLINE')
})

test('心跳与离线判定按时间窗，不靠调用顺序', () => {
  const { cp, clock } = makeCp()
  cp.upsertDevice(device('pc-1'))
  cp.heartbeatDevice('pc-1')
  assert.equal(cp.isDeviceAlive('pc-1'), true)

  clock.advance(DEVICE_OFFLINE_MS - 1)
  assert.equal(cp.isDeviceAlive('pc-1'), true)
  clock.advance(2)
  assert.equal(cp.isDeviceAlive('pc-1'), false, '超 45s 判离线')

  cp.heartbeatDevice('pc-1')
  assert.equal(cp.isDeviceAlive('pc-1'), true, '心跳把它拉回来')

  cp.markDeviceOffline('pc-1')
  assert.equal(cp.isDeviceAlive('pc-1'), false, 'WS 断开立刻离线，不等时间窗')
})

test('未知设备的心跳如实报 HOST_OFFLINE 且标可重试', () => {
  const { cp } = makeCp()
  assert.throws(() => cp.heartbeatDevice('nope'), (e) => {
    assert.ok(e instanceof ControlPlaneError)
    assert.equal(e.code, 'HOST_OFFLINE')
    assert.equal(e.retryable, true)
    return true
  })
})

/* --------------------------------------------------------- SessionIndex */

test('索引按设备全量替换：本轮没出现的会话要移除', () => {
  const { cp } = makeCp()
  cp.upsertDevice(device('pc-1'))
  assert.deepEqual(cp.upsertSessions('pc-1', [sessionRow('s1'), sessionRow('s2')]), { upserted: 2, removed: 0 })
  assert.equal(cp.listSessions({ ownerDeviceId: 'pc-1' }).length, 2)

  const r = cp.upsertSessions('pc-1', [sessionRow('s1', { lastSeq: 9 })])
  assert.deepEqual(r, { upserted: 1, removed: 1 })
  assert.deepEqual(cp.listSessions({ ownerDeviceId: 'pc-1' }).map((s) => s.sessionId), ['s1'])
  assert.equal(cp.getSession('s1').lastSeq, 9)
  assert.equal(cp.getSession('s2'), null)
})

test('putSession 单行合并：不清掉同设备其他会话（真机 0.1.5 回归）', () => {
  const { cp } = makeCp()
  cp.upsertSessions('pc-1', [sessionRow('s1'), sessionRow('s2')])
  const r = cp.putSession('pc-1', {
    sessionId: 's-new', state: 'awaiting', lastActiveAt: 1_700_000_000_000,
  })
  assert.deepEqual(r, { upserted: 1, removed: 0 })
  assert.deepEqual(
    cp.listSessions({ ownerDeviceId: 'pc-1' }).map((s) => s.sessionId).sort(),
    ['s-new', 's1', 's2'],
  )
  assert.equal(cp.getSession('s-new').state, 'awaiting')
  // 后续 Host 全量上报仍能校正该行，两种语义不冲突
  assert.deepEqual(
    cp.upsertSessions('pc-1', [sessionRow('s1'), sessionRow('s2'), sessionRow('s-new')]),
    { upserted: 3, removed: 0 },
  )
  assert.equal(cp.getSession('s-new').state, 'stopped')
  assert.deepEqual(cp.putSession('pc-1', { title: '缺少 sessionId' }), { upserted: 0, removed: 0 })
})

test('applySessionDiff 只应用变化，不清掉未提及的行（增量上报）', () => {
  const { cp } = makeCp()
  cp.upsertSessions('pc-1', [sessionRow('s1'), sessionRow('s2'), sessionRow('s3')])
  const r = cp.applySessionDiff('pc-1', [sessionRow('s2', { lastSeq: 9 })], ['s3'])
  assert.deepEqual(r, { upserted: 1, removed: 1 })
  assert.equal(cp.getSession('s1').lastSeq, 3, '未提及的行必须保留')
  assert.equal(cp.getSession('s2').lastSeq, 9)
  assert.equal(cp.getSession('s3'), null)
  // 跨设备隔离：不能删别家的行
  cp.upsertSessions('pc-2', [sessionRow('s9', { ownerDeviceId: 'pc-2' })])
  assert.deepEqual(cp.applySessionDiff('pc-1', [], ['s9']), { upserted: 0, removed: 0 })
  assert.ok(cp.getSession('s9'))
  assert.throws(() => cp.applySessionDiff('', [], []), /ownerDeviceId/)
})

test('Host 上报不会覆盖 PC 侧置顶状态', () => {
  const { cp } = makeCp()
  cp.upsertSessions('pc-1', [sessionRow('s1')])
  cp.patchSession('s1', { pinned: true, pinnedOrder: 2 })

  // Host 每 60s 全量上报一次，报文里 pinned 恒为 false/0
  cp.upsertSessions('pc-1', [sessionRow('s1'), sessionRow('s2')])
  const s1 = cp.getSession('s1')
  assert.equal(s1.pinned, true, '置顶不能被刷新打回')
  assert.equal(s1.pinnedOrder, 2)
  assert.equal(cp.getSession('s2').pinned, false)
})

test('其它设备的会话不受这台设备上报影响', () => {
  const { cp } = makeCp()
  cp.upsertSessions('pc-1', [sessionRow('s1')])
  cp.upsertSessions('pc-2', [sessionRow('s9', { ownerDeviceId: 'pc-2' })])
  cp.upsertSessions('pc-1', [])
  assert.deepEqual(cp.listSessions().map((s) => s.sessionId), ['s9'])
})

test('列表排序：置顶优先 → 置顶序 → 最近活跃', () => {
  const { cp } = makeCp()
  cp.upsertSessions('pc-1', [
    sessionRow('a', { lastActiveAt: 100 }),
    sessionRow('b', { lastActiveAt: 300 }),
    sessionRow('c', { lastActiveAt: 200 }),
  ])
  assert.deepEqual(cp.listSessions().map((s) => s.sessionId), ['b', 'c', 'a'])

  cp.patchSession('a', { pinned: true, pinnedOrder: 2 })
  cp.patchSession('c', { pinned: true, pinnedOrder: 1 })
  assert.deepEqual(cp.listSessions().map((s) => s.sessionId), ['c', 'a', 'b'], '置顶在前，且按置顶序')
  assert.deepEqual(cp.listSessions({ pinned: true }).map((s) => s.sessionId), ['c', 'a'])
})

test('未知 state 一律落回 stopped，不把脏值透给手机', () => {
  const { cp } = makeCp()
  cp.upsertSessions('pc-1', [sessionRow('s1', { state: 'exploded' })])
  assert.equal(cp.getSession('s1').state, 'stopped')
  assert.deepEqual(SESSION_STATES, ['running', 'awaiting', 'completed', 'stopped', 'failed', 'unreadable'])

  cp.patchSession('s1', { state: 'running' })
  assert.equal(cp.getSession('s1').state, 'running')
  cp.patchSession('s1', { state: 'nonsense' })
  assert.equal(cp.getSession('s1').state, 'running', '非法 patch 不生效')
})

test('缺 sessionId 的行被跳过，不产生空主键', () => {
  const { cp } = makeCp()
  const r = cp.upsertSessions('pc-1', [{ sessionId: '' }, null, sessionRow('s1')])
  assert.equal(r.upserted, 1)
  assert.equal(cp.listSessions().length, 1)
})

/* ---------------------------------------------------------- RouteLease */

test('租约：同设备重复申请是续租，别家申请冲突', () => {
  const { cp } = makeCp()
  const first = cp.acquireLease({ sessionId: 's1', deviceId: 'pc-1', clientId: 'c1' })
  assert.equal(first.renewed, false)
  assert.equal(first.leaseId, 'lease-1')

  const again = cp.acquireLease({ sessionId: 's1', deviceId: 'pc-1' })
  assert.equal(again.renewed, true)
  assert.equal(again.leaseId, first.leaseId, '幂等：同一把租约')

  assert.throws(() => cp.acquireLease({ sessionId: 's1', deviceId: 'pc-2' }), (e) => {
    assert.equal(e.code, 'ROUTE_CONFLICT')
    assert.equal(e.retryable, false, '冲突不是「稍后重试」能解决的')
    return true
  })
})

test('租约过期自动释放，别家可以接手', () => {
  const { cp, clock } = makeCp()
  cp.acquireLease({ sessionId: 's1', deviceId: 'pc-1' })
  clock.advance(LEASE_TTL_MS - 1)
  assert.equal(cp.getLease('s1').deviceId, 'pc-1')

  clock.advance(2)
  assert.equal(cp.getLease('s1'), null)
  const taken = cp.acquireLease({ sessionId: 's1', deviceId: 'pc-2' })
  assert.equal(taken.deviceId, 'pc-2')
  assert.equal(cp.sweepExpired(), 0, '已经惰性清掉，扫描没有可清的')
})

test('续租与释放都校验 leaseId，错的不生效', () => {
  const { cp } = makeCp()
  const lease = cp.acquireLease({ sessionId: 's1', deviceId: 'pc-1' })

  assert.throws(() => cp.renewLease({ sessionId: 's1', leaseId: 'lease-wrong' }), (e) => e.code === 'SESSION_BUSY')
  assert.equal(cp.releaseLease({ sessionId: 's1', leaseId: 'lease-wrong' }).reason, 'LEASE_MISMATCH')
  assert.equal(cp.releaseLease({ sessionId: 's1', deviceId: 'pc-2' }).reason, 'OWNER_MISMATCH')
  assert.equal(cp.getLease('s1').leaseId, lease.leaseId, '错的释放不该动到真租约')

  assert.equal(cp.releaseLease({ sessionId: 's1', leaseId: lease.leaseId }).released, true)
  assert.equal(cp.getLease('s1'), null)
  assert.equal(cp.releaseLease({ sessionId: 's1' }).reason, 'NOT_FOUND')
})

test('续租把过期时间往后推（心跳续租语义）', () => {
  const { cp, clock } = makeCp()
  const lease = cp.acquireLease({ sessionId: 's1', deviceId: 'pc-1' })
  clock.advance(LEASE_TTL_MS - 100)
  cp.renewLease({ sessionId: 's1', leaseId: lease.leaseId })
  clock.advance(200)
  assert.equal(cp.getLease('s1').leaseId, lease.leaseId, '续租后仍然有效')
})

test('缺参数申请租约直接拒绝，不生成野租约', () => {
  const { cp } = makeCp()
  assert.throws(() => cp.acquireLease({ sessionId: 's1' }), (e) => e.code === 'UNAUTHORIZED')
  assert.throws(() => cp.acquireLease({ deviceId: 'pc-1' }), (e) => e.code === 'UNAUTHORIZED')
  assert.deepEqual(cp.listLeases(), [])
})

/* -------------------------------------------------------------- Cursor */

test('消费位点按 client × session 覆盖写，回退也如实记录（协议 #5b：客户端权威）', () => {
  const { cp, clock } = makeCp()
  cp.putCursor({ clientId: 'phone', sessionId: 's1', sinceSeq: 5 })
  assert.equal(cp.getCursor({ clientId: 'phone', sessionId: 's1' }).sinceSeq, 5)

  cp.putCursor({ clientId: 'phone', sessionId: 's1', sinceSeq: 9 })
  assert.equal(cp.getCursor({ clientId: 'phone', sessionId: 's1' }).sinceSeq, 9)

  // 位点只是可观测性快照（协议 #5b：客户端 sinceSeq 才是权威），这里如实记录回退
  clock.advance(1000)
  cp.putCursor({ clientId: 'phone', sessionId: 's1', sinceSeq: 3 })
  assert.equal(cp.getCursor({ clientId: 'phone', sessionId: 's1' }).sinceSeq, 3)

  cp.putCursor({ clientId: 'pad', sessionId: 's1', sinceSeq: 1 })
  assert.equal(cp.listCursors({ clientId: 'phone' }).length, 1)
  assert.equal(cp.listCursors().length, 2)
  assert.equal(cp.getCursor({ clientId: 'phone', sessionId: 'sX' }), null)
  assert.throws(() => cp.putCursor({ clientId: 'phone' }), (e) => e.code === 'UNAUTHORIZED')
})

/* --------------------------------------------------------------- 其它 */

test('stats 如实反映四张表的规模', () => {
  const { cp } = makeCp()
  cp.upsertDevice(device('pc-1'))
  cp.upsertSessions('pc-1', [sessionRow('s1')])
  cp.acquireLease({ sessionId: 's1', deviceId: 'pc-1' })
  cp.putCursor({ clientId: 'phone', sessionId: 's1', sinceSeq: 1 })
  assert.deepEqual(cp.stats(), { devices: 1, sessions: 1, leases: 1, cursors: 1 })
})

test('返回值是副本：改调用方拿到的对象不会污染表', () => {
  const { cp } = makeCp()
  cp.upsertDevice(device('pc-1'))
  const d = cp.getDevice('pc-1')
  d.capabilities.push('evil')
  d.state = 'online'
  assert.deepEqual(cp.getDevice('pc-1').capabilities, ['attachments'])
  assert.equal(cp.getDevice('pc-1').state, 'offline')

  cp.upsertSessions('pc-1', [sessionRow('s1')])
  const s = cp.getSession('s1')
  s.headerRef.version = 99
  assert.equal(cp.getSession('s1').headerRef.version, 4)
})

/* ------------------------------------------------- Phone（r9：多手机） */

const bindPhone = (cp, phoneId, hostId = 'pc-1', token = null, label = null) => {
  cp.upsertPhone({ phoneId, hostId, label })
  if (token) cp.setPhoneToken(phoneId, token)
}

test('两台手机各持一枚令牌，互不作废（r9 的核心动机）', () => {
  const { cp } = makeCp()
  cp.upsertDevice(device('pc-1'))
  bindPhone(cp, 'ph-a', 'pc-1', 'tok-a', 'Pixel')
  bindPhone(cp, 'ph-b', 'pc-1', 'tok-b', 'iPad')

  assert.deepEqual(cp.verifyClientToken('pc-1', 'tok-a'), { ok: true, clientId: 'ph-a', legacy: false })
  assert.deepEqual(cp.verifyClientToken('pc-1', 'tok-b'), { ok: true, clientId: 'ph-b', legacy: false })
  assert.equal(cp.listPhones('pc-1').length, 2)

  // 同一台手机重配：只作废它自己那枚（TC-5.6 的「重配即作废旧令牌」逐台成立）
  cp.setPhoneToken('ph-a', 'tok-a2')
  assert.equal(cp.verifyClientToken('pc-1', 'tok-a').ok, false, '旧令牌必须失效')
  assert.equal(cp.verifyClientToken('pc-1', 'tok-a2').ok, true)
  assert.equal(cp.verifyClientToken('pc-1', 'tok-b').ok, true, '另一台手机不受牵连')
})

test('手机令牌不能越界：换一台 Host、或改挂绑定关系一律拒绝', () => {
  const { cp } = makeCp()
  cp.upsertDevice(device('pc-1'))
  cp.upsertDevice(device('pc-2'))
  bindPhone(cp, 'ph-a', 'pc-1', 'tok-a')

  assert.equal(cp.verifyClientToken('pc-2', 'tok-a').ok, false, '同一枚令牌不能读另一台电脑')
  assert.equal(cp.verifyClientToken('nope', 'tok-a').ok, false)

  // phoneId 与一台电脑的 deviceId 撞车：不许把电脑改挂成手机
  cp.upsertDevice(device('pc-3'))
  assert.throws(() => cp.upsertPhone({ phoneId: 'pc-3', hostId: 'pc-1' }), (e) => e.code === 'UNAUTHORIZED')
  // 已绑定的手机不能改挂
  assert.throws(() => cp.upsertPhone({ phoneId: 'ph-a', hostId: 'pc-2' }), (e) => e.code === 'UNAUTHORIZED')
})

test('吊销单台手机不影响 Host 与另一台；吊销 Host 连坐名下所有手机', () => {
  const { cp } = makeCp()
  cp.upsertDevice(device('pc-1'))
  bindPhone(cp, 'ph-a', 'pc-1', 'tok-a')
  bindPhone(cp, 'ph-b', 'pc-1', 'tok-b')

  const r = cp.revokePhone('ph-a')
  assert.equal(r.tombstone, true)
  assert.equal(r.tokenDigest, null, '吊销要连摘要一起清')
  assert.equal(cp.verifyClientToken('pc-1', 'tok-a').ok, false)
  assert.equal(cp.verifyClientToken('pc-1', 'tok-b').ok, true)
  assert.equal(cp.getDevice('pc-1').tombstone, false, 'Host 不受影响')
  assert.deepEqual(cp.listPhones('pc-1').map((p) => p.deviceId), ['ph-b'])
  // 收回的手机拿着自己的身份回来**重新配对**是允许的（配对码是人工授权），
  // 但重配之前旧令牌一定是失效的——墓碑挡的是令牌复活，不是人
  assert.equal(cp.verifyClientToken('pc-1', 'tok-a').ok, false, '收回后旧令牌已失效')
  assert.equal(cp.upsertPhone({ phoneId: 'ph-a', hostId: 'pc-1' }).tombstone, false, '允许重新配对')
  assert.equal(cp.verifyClientToken('pc-1', 'tok-a').ok, false, '没发新令牌之前，旧令牌仍然无效')
  cp.setPhoneToken('ph-a', 'tok-a2')
  assert.equal(cp.verifyClientToken('pc-1', 'tok-a2').ok, true, '重新配对拿到的令牌可用')
  cp.revokePhone('ph-a')   // 复原，后面还要验 Host 连坐

  cp.revokeDevice('pc-1')
  assert.equal(cp.verifyClientToken('pc-1', 'tok-b').ok, false, 'Host 被吊销，手机令牌同时失效')
  assert.equal(cp.getDevice('ph-b')?.tokenDigest ?? null, null)
})

test('上限 N 台手机：超限 CLIENT_LIMIT，已绑定的重配不受限', () => {
  const { cp } = makeCp({ maxPhonesPerHost: 2 })
  cp.upsertDevice(device('pc-1'))
  bindPhone(cp, 'ph-a', 'pc-1', 'tok-a')
  bindPhone(cp, 'ph-b', 'pc-1', 'tok-b')
  assert.throws(() => cp.upsertPhone({ phoneId: 'ph-c', hostId: 'pc-1' }), (e) => e.code === 'CLIENT_LIMIT')
  // 已存在的手机重配不占新名额
  assert.doesNotThrow(() => bindPhone(cp, 'ph-a', 'pc-1', 'tok-a2'))
})

test('r9 之前配对的手机（令牌落在 Host 行）仍可鉴权，标记 legacy', () => {
  const { cp } = makeCp()
  cp.upsertDevice(device('pc-1'))
  cp.setDeviceToken('pc-1', 'old-host-token')
  assert.deepEqual(cp.verifyClientToken('pc-1', 'old-host-token'), { ok: true, clientId: null, legacy: true })
  assert.equal(cp.verifyClientToken('pc-1', 'whatever').ok, false)
})

test('归档是软移除（r12）：默认不进列表，显式查才看得到，可恢复', () => {
  const { cp } = makeCp()
  cp.upsertDevice(device('pc-1'))
  cp.upsertSessions('pc-1', [sessionRow('s1'), sessionRow('s2')])

  cp.patchSession('s1', { archived: true })
  assert.deepEqual(cp.listSessions({ ownerDeviceId: 'pc-1' }).map((s) => s.sessionId), ['s2'],
    '归档后不该出现在手机的默认列表')
  assert.deepEqual(cp.listSessions({ ownerDeviceId: 'pc-1', archived: true }).map((s) => s.sessionId), ['s1'],
    '但行还在，显式查能看到——这就是「可恢复」')
  assert.equal(cp.getSession('s1').archived, true)

  cp.patchSession('s1', { archived: false })
  assert.equal(cp.listSessions({ ownerDeviceId: 'pc-1' }).length, 2, '恢复后回到列表')
  assert.equal(cp.listSessions({ archived: null }).length, 2, 'null = 全回，调试用')
})
