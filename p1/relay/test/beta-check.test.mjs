/**
 * W6 内测前置 · 自检脚本自身的测试
 * ---------------------------------------------------------------
 * 自检脚本最坏的情况不是报错，而是**报了个假的 PASS** —— 内测会因此带着坏环境开始，
 * 然后把环境问题记成功能缺陷。所以这里钉三件事：
 *   1. 缺凭据必须是 SKIP，不是 PASS（不能因为「看不出来」就当作通过）；
 *   2. 缺落盘文件、版本不一致必须是 FAIL；
 *   3. relay 根本连不上时脚本要安静地给出 FAIL，不能自己抛异常。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { createRelay } from '../../relay/src/server.js'
import { runBetaCheck } from '../../../scripts/beta-check.mjs'

const ADMIN = 'admin-secret'
let relay, port, base, dir

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wbsync-beta-'))
  relay = createRelay({ hostToken: 'host-secret', adminToken: ADMIN, requestTimeoutMs: 300 })
  port = await relay.start(0)
  base = `http://127.0.0.1:${port}`
  // 宿主注册 + 报一个会话，让 B2/B4 有东西可看
  await fetch(`${base}/host/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer host-secret' },
    body: JSON.stringify({ deviceId: 'pc-beta', caps: [] }),
  })
  await fetch(`${base}/host/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer host-secret' },
    body: JSON.stringify({ deviceId: 'pc-beta', rows: [{ sessionId: 's1', state: 'stopped', lastSeq: 2 }] }),
  })
})
after(async () => {
  await relay.stop()
  rmSync(dir, { recursive: true, force: true })
})

const byId = (checks, id) => checks.find((c) => c.id === id)

test('Y1 环境就绪：该 PASS 的 PASS，看不出证据的一律 SKIP（不是 PASS）', async () => {
  const r = await runBetaCheck({ base, cpFile: ':memory:' })
  assert.equal(r.ok, true, '没有 FAIL 才算就绪')
  assert.equal(byId(r.checks, 'B1').status, 'PASS')
  assert.equal(byId(r.checks, 'B2').status, 'PASS', '宿主已注册 → 在线')
  assert.equal(byId(r.checks, 'B3').status, 'SKIP', '没给 admin token 就数不了手机')
  assert.equal(byId(r.checks, 'B4').status, 'SKIP')
  assert.equal(byId(r.checks, 'B5').status, 'SKIP', '明确关掉落盘 = SKIP，不是 PASS')
  assert.equal(byId(r.checks, 'B6').status, 'PASS', '/app/sw.js 与仓库 sw.js 同版本')
})

test('Y2 给了 admin token：手机清单与会话索引用真实数据判定', async () => {
  const r = await runBetaCheck({ base, adminToken: ADMIN, cpFile: ':memory:' })
  const b3 = byId(r.checks, 'B3')
  assert.equal(b3.status, 'PASS')
  assert.match(b3.detail, /1 台电脑/)
  assert.equal(byId(r.checks, 'B4').status, 'PASS')
  assert.match(byId(r.checks, 'B4').detail, /1 个会话/)
})

test('Y3 没有落盘文件 = FAIL（重启会掉配对，内测不该在这种环境开始）', async () => {
  const r = await runBetaCheck({ base, adminToken: ADMIN, cpFile: join(dir, 'nope.json') })
  assert.equal(r.ok, false)
  assert.equal(byId(r.checks, 'B5').status, 'FAIL')
  assert.match(byId(r.checks, 'B5').detail, /不存在/)
})

test('Y4 落盘文件存在且格式正确 = PASS，并报出设备/会话数', async () => {
  const file = join(dir, 'cp.json')
  writeFileSync(file, JSON.stringify({
    schema: 'wbsync.cp/1',
    devices: [{ deviceId: 'pc-beta' }],
    sessions: [{ sessionId: 's1' }, { sessionId: 's2' }],
  }), 'utf8')
  const r = await runBetaCheck({ base, adminToken: ADMIN, cpFile: file })
  const b5 = byId(r.checks, 'B5')
  assert.equal(b5.status, 'PASS')
  assert.match(b5.detail, /1 台设备 \/ 2 个会话/)
})

test('Y5 文件写坏了也是 FAIL，但脚本不许抛异常', async () => {
  const file = join(dir, 'broken.json')
  writeFileSync(file, '{ 不是 JSON', 'utf8')
  const r = await runBetaCheck({ base, adminToken: ADMIN, cpFile: file })
  assert.equal(r.ok, false)
  assert.equal(byId(r.checks, 'B5').status, 'FAIL')
  assert.match(byId(r.checks, 'B5').detail, /读不动/)
})

test('Y6 relay 连不上：安静地给出 FAIL，脚本自己不炸', async () => {
  const r = await runBetaCheck({ base: 'http://127.0.0.1:1', adminToken: ADMIN, cpFile: ':memory:' })
  assert.equal(r.ok, false)
  assert.equal(byId(r.checks, 'B1').status, 'FAIL')
  assert.match(byId(r.checks, 'B1').detail, /连不上/)
  // 后面依赖 relay 的项不许因此变成 PASS
  assert.notEqual(byId(r.checks, 'B7').status, 'PASS')
})
