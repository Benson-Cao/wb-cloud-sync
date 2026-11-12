/**
 * 会话镜像 · 电脑侧只读导出（ADR-012）
 * 重点不是「能不能读」，而是**读不到不该读的东西**：
 * 手机自报的 sid/文件名、`..` 逃逸、超大文件，都必须被明确拒绝。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import {
  listMirrorSessions, readSessionChunk, MIRROR_CHUNK_MAX,
} from '../src/mirror.js'

let root
const SEG = '--C-Users-me-project'
const SID = 'session-abc123'

before(() => {
  root = mkdtempSync(join(tmpdir(), 'wbsync-mirror-'))
  const dir = join(root, SEG, SID)
  mkdirSync(dir, { recursive: true })
  // 合法：会话日志（内容是二进制也无所谓，镜像只搬字节）
  writeFileSync(join(dir, 'session.v1.jsonl.zstd'), Buffer.alloc(1024, 7))
  // 干扰项：不该被列出
  writeFileSync(join(dir, 'notes.txt'), 'x')
  writeFileSync(join(dir, '.hidden.jsonl'), 'x')
  mkdirSync(join(root, '.sessions-trash'), { recursive: true })
})

after(() => { rmSync(root, { recursive: true, force: true }) })

test('M1 只列出会话文件：忽略 .txt / 隐藏文件 / 回收站', async () => {
  const rows = await listMirrorSessions(root)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].sid, SID)
  assert.equal(rows[0].dir, SEG)
  assert.deepEqual(rows[0].files.map((f) => f.name), ['session.v1.jsonl.zstd'])
  assert.equal(rows[0].bytes, 1024)
})

test('M2 分块读：offset/eof 语义可一直取到末尾', async () => {
  const first = await readSessionChunk(root, { sid: `${SEG}/${SID}`, name: 'session.v1.jsonl.zstd', offset: 0, maxBytes: 400 })
  assert.equal(first.size, 1024)
  assert.equal(first.offset, 0)
  assert.equal(first.eof, false)
  assert.equal(Buffer.from(first.bytes, 'base64').length, 400)

  const second = await readSessionChunk(root, { sid: `${SEG}/${SID}`, name: 'session.v1.jsonl.zstd', offset: 1024, maxBytes: 400 })
  assert.equal(second.eof, true, 'offset 到末尾就是 eof')
  assert.equal(Buffer.from(second.bytes, 'base64').length, 0)
})

test('M3 单块上限被强制：要再多也只给 MIRROR_CHUNK_MAX', async () => {
  const big = join(root, SEG, SID, 'session.v2.jsonl.zstd')
  writeFileSync(big, Buffer.alloc(2 * 1024 * 1024, 1))
  const r = await readSessionChunk(root, {
    sid: `${SEG}/${SID}`, name: 'session.v2.jsonl.zstd', offset: 0, maxBytes: 8 * 1024 * 1024,
  })
  assert.equal(Buffer.from(r.bytes, 'base64').length, MIRROR_CHUNK_MAX, '客户端要得再大也只能拿到一块')
  assert.equal(r.eof, false)
})

test('M4 路径越界一律拒绝（手机自报路径不可信）', async () => {
  const cases = [
    { sid: `../${SEG}/${SID}`, name: 'session.v1.jsonl.zstd', code: 'OUTSIDE_WORKSPACE' },
    { sid: `${SEG}/${SID}`, name: '../../../etc/passwd', code: 'INVALID_ARGUMENT' },
    { sid: `${SEG}/${SID}`, name: 'notes.txt', code: 'INVALID_ARGUMENT' },
    { sid: SID, name: 'session.v1.jsonl.zstd', code: 'INVALID_ARGUMENT' },
  ]
  for (const c of cases) {
    await assert.rejects(
      () => readSessionChunk(root, c),
      (e) => e.code === c.code,
      `${c.sid} / ${c.name} 应当被拒（期望 ${c.code}）`,
    )
  }
})

test('M5 不存在的会话返回空清单而不是抛错', async () => {
  assert.equal(await listSessionFilesSafe(), null)
  const rows = await listMirrorSessions(root)
  assert.equal(rows.some((r) => r.sid === 'session-nope'), false)
})

async function listSessionFilesSafe() {
  const { listSessionFiles } = await import('../src/mirror.js')
  return listSessionFiles(root, 'session-nope')
}
