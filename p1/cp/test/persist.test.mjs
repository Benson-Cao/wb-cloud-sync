/**
 * P2 前置 · CP 落盘（单机文件版）
 * ---------------------------------------------------------------
 * 这一组用例只关心一件事：**重启之后，手机还需要不要求人重新配对**。
 * 所以每条都按「进程 A 写 → 进程 A 消失 → 进程 B 从同一个文件起来」来跑，
 * 而不是在同一个实例里自问自答。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { createControlPlane, sha256Hex } from '../src/index.js'
import { CP_SCHEMA, createFileStore } from '../src/persist.js'

const dirs = []
const tmpFile = () => {
  const dir = mkdtempSync(join(tmpdir(), 'wbsync-cp-'))
  dirs.push(dir)
  return join(dir, 'cp.json')
}
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

const clock = (start = 1_700_000_000_000) => {
  let t = start
  return { now: () => t, advance: (ms) => { t += ms } }
}

const sessionRow = (id, owner = 'pc-1') => ({
  sessionId: id,
  ownerDeviceId: owner,
  workspace: 'C:\\work\\demo',
  title: '标题',
  pinned: false,
  pinnedOrder: 0,
  state: 'stopped',
  lastSeq: 7,
  lastActiveAt: 1_700_000_000_000,
  headerRef: { version: 4, parentSession: null, delegationDepth: 0, agentPreset: 'standard', isSeeded: false, origin: null },
})

/** 起一个「进程」：同一个文件，新的 CP 实例。 */
const boot = (file, opts = {}) => {
  const c = opts.clock ?? clock()
  const store = createFileStore({ file, now: c.now, debounceMs: 0 })
  const cp = createControlPlane({ now: c.now, persist: store, ...opts })
  return { cp, store, clock: c }
}

test('D1 重启后手机不必重新配对：令牌、设备、会话都还在', () => {
  const file = tmpFile()
  const a = boot(file)
  a.cp.upsertDevice({ deviceId: 'pc-1', platform: 'windows', capabilities: ['approval'] })
  a.cp.upsertSessions('pc-1', [sessionRow('s1'), sessionRow('s2')])
  a.cp.upsertPhone({ phoneId: 'phone-aaa111', hostId: 'pc-1', label: 'Pixel' })
  a.cp.setPhoneToken('phone-aaa111', 'tok-a')
  a.cp.flush()
  assert.ok(existsSync(file), 'flush 之后文件必须真的落了')

  const b = boot(file)
  assert.deepEqual(b.cp.verifyClientToken('pc-1', 'tok-a'), { ok: true, clientId: 'phone-aaa111', legacy: false })
  assert.equal(b.cp.listPhones('pc-1').length, 1)
  assert.equal(b.cp.listSessions({ ownerDeviceId: 'pc-1' }).length, 2)
  assert.equal(b.cp.listSessions({ ownerDeviceId: 'pc-1' })[0].title, '标题', '标题等索引字段要原样回来')
  assert.equal(b.cp.restoredSnapshot.devices, 2, '一台电脑 + 一台手机')
  assert.equal(b.cp.restoredSnapshot.sessions, 2)
})

test('D2 起来时一律离线：重启那一刻谁也没连上，别报 online', () => {
  const file = tmpFile()
  const a = boot(file)
  a.cp.upsertDevice({ deviceId: 'pc-1', state: 'online' })
  a.cp.heartbeatDevice('pc-1')
  a.cp.flush()
  // 重启很快：上一次心跳还在 45s 窗口内
  const b = boot(file, { clock: { now: () => a.clock.now() + 1000, advance() {} } })
  assert.equal(b.cp.getDevice('pc-1').state, 'offline')
  assert.equal(b.cp.isDeviceAlive('pc-1', a.clock.now() + 1000), false,
    '没连上就是没连上，不能靠上次心跳的时间戳冒充在线')
})

test('D3 墓碑只留 30 天；久墓碑被清掉，新墓碑继续挡复活', () => {
  const file = tmpFile()
  const a = boot(file)
  a.cp.upsertDevice({ deviceId: 'pc-old' })
  a.cp.revokeDevice('pc-old')            // 记在 T0
  a.cp.upsertDevice({ deviceId: 'pc-new' })
  a.cp.revokeDevice('pc-new')
  a.clock.advance(31 * 24 * 60 * 60 * 1000)
  a.cp.upsertDevice({ deviceId: 'pc-live' })
  a.cp.revokeDevice('pc-live')
  a.cp.flush()

  // 模拟「31 天后重启」：旧墓碑超期，新墓碑仍在
  const b = boot(file, { clock: { now: () => a.clock.now(), advance() {} } })
  assert.equal(b.cp.getDevice('pc-old'), null, '超过 30 天的墓碑不该继续占位置')
  assert.equal(b.cp.getDevice('pc-new'), null, '同一个 clock 下 pc-new 也是 31 天前吊销的')
  assert.equal(b.cp.getDevice('pc-live').tombstone, true, '刚吊销的墓碑必须留着')
  assert.throws(() => b.cp.upsertDevice({ deviceId: 'pc-live' }), (e) => e.code === 'UNAUTHORIZED')
})

test('D4 归属设备没了的会话与手机一起丢弃（不留幽灵行）', () => {
  const file = tmpFile()
  // 直接造一份「上次没写干净」的快照：会话与手机指向一台已经不存在的电脑
  writeFileSync(file, JSON.stringify({
    schema: CP_SCHEMA,
    devices: [
      { deviceId: 'pc-1', role: 'host', tokenDigest: sha256Hex('host-tok'), state: 'offline', lastSeenAt: 1_700_000_000_000 },
      { deviceId: 'phone-orphan', role: 'phone', boundHostId: 'pc-gone', tokenDigest: sha256Hex('tok-o'), lastSeenAt: 1_700_000_000_000 },
    ],
    sessions: [
      { sessionId: 's1', ownerDeviceId: 'pc-1', state: 'stopped', lastSeq: 3 },
      { sessionId: 's-ghost', ownerDeviceId: 'pc-gone', state: 'stopped', lastSeq: 1 },
    ],
  }), 'utf8')

  const b = boot(file)
  assert.deepEqual(b.cp.listSessions({ ownerDeviceId: 'pc-1' }).map((s) => s.sessionId), ['s1'])
  assert.equal(b.cp.getSession('s-ghost'), null, '归属设备不存在的会话不许回到列表里')
  assert.equal(b.cp.getDevice('phone-orphan'), null, '宿主没了，手机行也不该留')
  assert.equal(b.cp.restoredSnapshot.droppedSessions, 1)
  assert.equal(b.cp.restoredSnapshot.droppedDevices, 1)
})

test('D5 坏文件不让进程起不来：备份成 .corrupt-* 后从空库开始', () => {
  const file = tmpFile()
  writeFileSync(file, '{ 这不是 JSON', 'utf8')
  const b = boot(file)
  assert.deepEqual(b.cp.listDevices(), [])
  const leftovers = readdirSync(join(file, '..')).filter((n) => n.includes('.corrupt-'))
  assert.equal(leftovers.length, 1, '坏文件要留证，不能悄悄覆盖掉')
})

test('D6 写入是原子的：改完后不留 .tmp 残片，文件始终是完整 JSON', () => {
  const file = tmpFile()
  const a = boot(file)
  a.cp.upsertDevice({ deviceId: 'pc-1' })
  a.cp.flush()
  const names = readdirSync(join(file, '..'))
  assert.deepEqual(names.filter((n) => n.includes('.tmp')), [], '临时文件必须被 rename 掉')
  const parsed = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(parsed.schema, CP_SCHEMA)
})

test('D7 只存事实：租约与消费位点不进快照，重启后租约自然为空', () => {
  const file = tmpFile()
  const a = boot(file)
  a.cp.upsertDevice({ deviceId: 'pc-1' })
  a.cp.upsertSessions('pc-1', [sessionRow('s1')])
  a.cp.acquireLease({ sessionId: 's1', deviceId: 'pc-1' })
  a.cp.putCursor({ clientId: 'phone-1', sessionId: 's1', sinceSeq: 5 })
  const snap = a.cp.snapshot()
  assert.deepEqual(Object.keys(snap).sort(), ['devices', 'sessions'], '快照里只能有设备与会话')
  a.cp.flush()

  const b = boot(file)
  assert.deepEqual(b.cp.listLeases(), [], '租约 30s 就过期，重启后本来就不该还在')
  assert.equal(b.cp.getCursor({ clientId: 'phone-1', sessionId: 's1' }), null, '位点由客户端 sinceSeq 权威')
})

test('D8 令牌只存摘要：文件里搜不到明文', () => {
  const file = tmpFile()
  const a = boot(file)
  a.cp.upsertDevice({ deviceId: 'pc-1' })
  a.cp.upsertPhone({ phoneId: 'phone-secret1', hostId: 'pc-1' })
  a.cp.setPhoneToken('phone-secret1', 'PLAINTEXT-TOKEN-abc')
  a.cp.flush()
  const text = readFileSync(file, 'utf8')
  assert.ok(!text.includes('PLAINTEXT-TOKEN-abc'), '明文令牌绝不落盘')
  assert.ok(text.includes(sha256Hex('PLAINTEXT-TOKEN-abc')), '落的是 SHA-256 摘要')
})

test('D9 去抖：连续多次改动只落一次盘，flush 立刻生效', async () => {
  const file = tmpFile()
  const store = createFileStore({ file, debounceMs: 50 })
  const cp = createControlPlane({ persist: store })
  for (let i = 0; i < 20; i++) cp.upsertDevice({ deviceId: 'pc-1', deviceName: `n${i}` })
  assert.equal(existsSync(file), false, '50ms 窗口内不该已经落盘')
  await new Promise((r) => setTimeout(r, 120))
  assert.ok(existsSync(file), '窗口过后自动落盘')
  const parsed = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(parsed.devices[0].deviceName, 'n19', '落的是最后一次状态')
  cp.upsertDevice({ deviceId: 'pc-1', deviceName: 'flush' })
  assert.equal(cp.flush(), true)
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).devices[0].deviceName, 'flush', 'flush 不等窗口')
})
