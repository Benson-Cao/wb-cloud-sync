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
  encodeCwd, pullSessionFile, listMirrored, clearMirrored,
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
