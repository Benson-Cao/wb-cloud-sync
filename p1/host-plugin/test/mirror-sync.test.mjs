/**
 * 会话镜像 · 手机侧落盘（ADR-012 第二步）
 * 重点验三件事：分块能拼回原样、写不成不能留半截、尺寸不符必须报错。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import {
  encodeCwd, pullSessionFile, listMirrored, clearMirrored, upsertMirrorWorkspace, removeMirrorWorkspace, writeProjectionStub, clearProjectionStubs,
} from '../src/mirror-sync.js'

let root
const CWD = 'C:\\Users\\me\\我的项目'
const SID = 'session-mirror01'

before(() => { root = mkdtempSync(join(tmpdir(), 'wbsync-msync-')) })
after(() => { rmSync(root, { recursive: true, force: true }) })

/** 把一段 buffer 变成按 offset 分块的假 fetchChunk。 */
const chunker = (buf, chunkSize = 100) => async ({ offset, maxBytes }) => {
  const size = Math.min(chunkSize, maxBytes ?? chunkSize)
  const slice = buf.subarray(offset, offset + size)
  return { bytes: slice.toString('base64'), eof: offset + slice.length >= buf.length }
}

test('S1 路径编码与宿主一致（非 ASCII 转 ~XXXX）', () => {
  assert.equal(encodeCwd('C:\\Users\\me\\proj'), '--C-Users-me-proj--')
  // 中文按码点转义，且分隔符统一变 -
  assert.match(encodeCwd(CWD), /^--C-Users-me-.*--$/)
  assert.ok(encodeCwd(CWD).includes('~'), '非 ASCII 要转成 ~XXXX')
})

test('S2 分块拉取能拼回原始字节，且不留 .part', async () => {
  const buf = Buffer.from('x'.repeat(1024))
  const r = await pullSessionFile({
    fetchChunk: chunker(buf, 300),
    sessionsRoot: root, cwdPath: CWD, sid: SID, name: 'session.v1.jsonl.zstd',
  })
  assert.equal(r.bytes, 1024)
  assert.deepEqual(readFileSync(r.path), buf)
  assert.equal(existsSync(`${r.path}.part`), false, '落盘后不能残留 .part')
})

test('S3 分块为空但未结束：明确报错，不留半截文件', async () => {
  const calls = []
  const fetchChunk = async ({ offset }) => {
    calls.push(offset)
    if (calls.length === 1) return { bytes: Buffer.from('abc').toString('base64'), eof: false }
    return { bytes: '', eof: false }      // 对端卡住：既没数据也不说结束
  }
  await assert.rejects(
    () => pullSessionFile({ fetchChunk, sessionsRoot: root, cwdPath: CWD, sid: 'session-bad', name: 'session.v1.jsonl.zstd' }),
    (e) => e.code === 'MIRROR_TRUNCATED',
  )
  const dir = join(root, encodeCwd(CWD), 'session-bad')
  assert.equal(readdirSync(dir).filter((n) => n.endsWith('.part')).length, 0, '失败后不能留下 .part')
})

test('S4 超过总量上限：拒绝并清理', async () => {
  const buf = Buffer.alloc(2048, 1)
  await assert.rejects(
    () => pullSessionFile({
      fetchChunk: chunker(buf, 512),
      sessionsRoot: root, cwdPath: CWD, sid: 'session-huge',
      name: 'session.v1.jsonl.zstd', maxTotal: 1024,
    }),
    (e) => e.code === 'MIRROR_TOO_LARGE',
  )
})

test('S5 列出与清理：只统计真实文件，.part 不算', async () => {
  const dir = join(root, encodeCwd(CWD), 'session-list')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.v1.jsonl.zstd'), Buffer.alloc(10))
  writeFileSync(join(dir, 'session.v2.jsonl.zstd.part'), Buffer.alloc(99))

  const rows = await listMirrored({ sessionsRoot: root, cwdPath: CWD })
  const hit = rows.find((r) => r.sid === 'session-list')
  assert.ok(hit, '应能列出该会话')
  assert.equal(hit.bytes, 10, '.part 不计入占用')

  const cleared = await clearMirrored({ sessionsRoot: root, cwdPath: CWD })
  assert.equal(cleared.removed, true)
  assert.equal((await listMirrored({ sessionsRoot: root, cwdPath: CWD })).length, 0, '清理后应彻底消失')
})

// ---------- 注册表：只增不删、绝不重建 ----------

const REG = (extra = {}) => ({
  unit: { name: 'workspace', version: 2 },
  global: {
    initialized: true,
    defaultWorkspaceId: 'ws-a',
    workspaceIds: ['ws-a'],
    archivedSessionIds: [],
  },
  tables: {
    workspaces: {
      'ws-a': {
        path: '/data/home/wstest', title: 'wstest',
        sessionIds: ['session-keep'], createdAt: '2026-11-05T00:00:00.000Z', updatedAt: '2026-11-05T00:00:00.000Z',
      },
    },
  },
  ...extra,
})

const tmpReg = (obj) => {
  const dir = mkdtempSync(join(tmpdir(), 'wbsync-reg-'))
  const p = join(dir, 'workspace.json')
  writeFileSync(p, JSON.stringify(obj, null, 2))
  return p
}

test('R6 首次登记：新建工作区，标题用电脑名，且不动别人的条目', async () => {
  const p = tmpReg(REG())
  const before = JSON.parse(readFileSync(p, 'utf8'))
  const r = await upsertMirrorWorkspace({
    registryPath: p, workspacePath: '/data/home/mirror/Benson', title: 'Benson',
    sids: ['session-a', 'session-b'], makeId: () => 'ws-mirror',
  })
  assert.equal(r.created, true)
  assert.equal(r.added, 2)
  const after = JSON.parse(readFileSync(p, 'utf8'))
  assert.deepEqual(after.tables.workspaces['ws-mirror'].sessionIds, ['session-a', 'session-b'])
  assert.equal(after.tables.workspaces['ws-mirror'].title, 'Benson')
  assert.ok(after.global.workspaceIds.includes('ws-mirror'), '要进 workspaceIds 才显示在侧栏')
  assert.deepEqual(after.tables.workspaces['ws-a'], before.tables.workspaces['ws-a'], '别的工作区必须一字节不动')
  assert.equal(after.global.defaultWorkspaceId, 'ws-a', '不能抢默认工作区')
})

test('R7 再次登记：不重复、不重建，重复 sid 只加一次；改电脑名会跟着更新', async () => {
  const p = tmpReg(REG())
  await upsertMirrorWorkspace({ registryPath: p, workspacePath: '/m', title: 'Benson', sids: ['session-a'], makeId: () => 'ws-m' })
  const r2 = await upsertMirrorWorkspace({ registryPath: p, workspacePath: '/m', title: 'Benson-新名', sids: ['session-a', 'session-b'] })
  assert.equal(r2.created, false)
  assert.equal(r2.added, 1, '只应新增 session-b')
  assert.equal(r2.total, 2)
  const after = JSON.parse(readFileSync(p, 'utf8'))
  assert.equal(after.tables.workspaces['ws-m'].title, 'Benson-新名')
  assert.equal(Object.keys(after.tables.workspaces).length, 2, '不能凭空多出工作区')
})

test('R8 注册表读不到/坏掉：拒绝改动（绝不重建）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wbsync-reg-bad-'))
  const missing = join(dir, 'nope.json')
  await assert.rejects(
    () => upsertMirrorWorkspace({ registryPath: missing, workspacePath: '/m', title: 'x', sids: [] }),
    (e) => e.code === 'REGISTRY_UNREADABLE',
  )
  assert.equal(existsSync(missing), false, '不许因为读不到就建一个')

  const broken = join(dir, 'broken.json')
  writeFileSync(broken, '{ not json')
  await assert.rejects(
    () => upsertMirrorWorkspace({ registryPath: broken, workspacePath: '/m', title: 'x', sids: [] }),
    (e) => e.code === 'REGISTRY_INVALID',
  )
  assert.equal(readFileSync(broken, 'utf8'), '{ not json', '坏文件不许被覆盖')
})

test('R9 首次改动会留 .bak 备份', async () => {
  const p = tmpReg(REG())
  const original = readFileSync(p, 'utf8')
  await upsertMirrorWorkspace({ registryPath: p, workspacePath: '/m', title: 'x', sids: ['session-a'], makeId: () => 'ws-m' })
  assert.equal(readFileSync(`${p}.wbsync.bak`, 'utf8'), original, '备份应是最初那份')
})

test('R10 清理：摘掉自己那一条，别人不受影响', async () => {
  const p = tmpReg(REG())
  await upsertMirrorWorkspace({ registryPath: p, workspacePath: '/m', title: 'x', sids: ['session-a'], makeId: () => 'ws-m' })
  const r = await removeMirrorWorkspace({ registryPath: p, workspacePath: '/m' })
  assert.equal(r.removed, true)
  const after = JSON.parse(readFileSync(p, 'utf8'))
  assert.equal(after.tables.workspaces['ws-m'], undefined)
  assert.ok(after.tables.workspaces['ws-a'], '原生工作区必须还在')
  assert.deepEqual(after.global.workspaceIds, ['ws-a'])
})

test('R11 他处已登记的会话绝不抢：否则宿主会判「域不一致」并整体失败', async () => {
  // 真机事故复现：wstest 里已有 session-keep，镜像再登记同一个 sid
  const p = tmpReg(REG())
  const r = await upsertMirrorWorkspace({
    registryPath: p, workspacePath: '/m', title: 'Benson',
    sids: ['session-keep', 'session-new'], makeId: () => 'ws-m',
  })
  assert.equal(r.added, 1, '只应登记 session-new')
  assert.deepEqual(r.skipped, ['session-keep'], '被别的工作区占用的要如实报出来')
  const after = JSON.parse(readFileSync(p, 'utf8'))
  assert.deepEqual(after.tables.workspaces['ws-m'].sessionIds, ['session-new'])
  assert.deepEqual(after.tables.workspaces['ws-a'].sessionIds, ['session-keep'], '原归属不能被动')
})

// ---------- 投影缓存：只新增、只 identity、只删自己写的 ----------

test('P1 写最小 identity：cwd 指向镜像目录，rows 为空（不伪造投影）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wbsync-proj-'))
  const r = await writeProjectionStub({ projRoot: dir, sid: 'session-p1', cwd: '/m', createdAt: 123 })
  assert.equal(r.written, true)
  const j = JSON.parse(readFileSync(join(dir, 'session-p1.json'), 'utf8'))
  assert.equal(j.version, 7)
  assert.equal(j.record.identity.cwd, '/m')
  assert.equal(j.record.identity.createdAt, 123)
  assert.deepEqual(j.record.rows, {}, '投影行交给宿主重建，不许自己编')
})

test('P2 目标已存在就跳过：本机会话的条目绝不能被覆盖', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wbsync-proj2-'))
  const target = join(dir, 'session-local.json')
  writeFileSync(target, JSON.stringify({ version: 7, record: { identity: { cwd: '/local' }, rows: { a: 1 } } }))
  const r = await writeProjectionStub({ projRoot: dir, sid: 'session-local', cwd: '/m' })
  assert.equal(r.written, false)
  assert.equal(r.reason, 'EXISTS')
  const j = JSON.parse(readFileSync(target, 'utf8'))
  assert.equal(j.record.identity.cwd, '/local', '原条目必须原样保留')
  assert.deepEqual(j.record.rows, { a: 1 })
})

test('P3 清理只删 cwd 指向镜像目录的条目（sid 撞车时保护本机）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wbsync-proj3-'))
  writeFileSync(join(dir, 'session-mine.json'), JSON.stringify({ version: 7, record: { identity: { cwd: '/m' }, rows: {} } }))
  writeFileSync(join(dir, 'session-local.json'), JSON.stringify({ version: 7, record: { identity: { cwd: '/local' }, rows: {} } }))

  const r = await clearProjectionStubs({ projRoot: dir, sids: ['session-mine', 'session-local'], cwd: '/m' })
  assert.equal(r.removed, 1, '只应删掉自己的那条')
  assert.equal(existsSync(join(dir, 'session-mine.json')), false)
  assert.equal(existsSync(join(dir, 'session-local.json')), true, '本机条目必须留下')
})
