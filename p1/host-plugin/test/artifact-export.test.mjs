/**
 * ADR-011 · 产物导出 Host 侧校验
 * ---------------------------------------------------------------
 * 这里只测「信任边界」，不测文件系统的花活：
 *   只认已呈现的路径、路径不许越出工作区、体积有硬上限、文件没了要如实说。
 * 少任何一条，Relay 就会变成任意文件读取网关。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { createArtifactExporter, mimeOfArtifact } from '../src/artifacts.js'

let root, outDir, secretFile
before(() => {
  root = mkdtempSync(join(tmpdir(), 'wbsync-art-'))
  outDir = join(root, 'out')
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'a.md'), '# 成品\n中文内容', 'utf8')
  writeFileSync(join(root, 'secret.txt'), '不该被读到')
  secretFile = join(root, 'secret.txt')
})
after(() => rmSync(root, { recursive: true, force: true }))

/** 假产物索引：只认 out/a.md 与一个越界路径（用来验证第二道闸）。 */
const listed = {
  ok: true,
  value: {
    rows: [
      { seq: 1, index: 0, path: 'out/a.md', name: 'a.md', description: '成品' },
      { seq: 2, index: 0, path: '../secret.txt', name: 'secret.txt', description: '越界样本' },
      { seq: 3, index: 0, path: 'out/big.bin', name: 'big.bin', description: '' },
      { seq: 4, index: 0, path: 'out/gone.txt', name: 'gone.txt', description: '' },
    ],
  },
}
const mk = (maxBytes = 512 * 1024) => createArtifactExporter({
  listArtifacts: async () => listed,
  resolveWorkspace: async () => root,
  maxBytes,
})

test('Y1 原样下载：只回元数据 + base64 字节，且不落盘', async () => {
  const r = await mk().readBytes({ sessionId: 's1', relPath: 'out/a.md' })
  assert.equal(r.ok, true)
  assert.equal(r.value.name, 'a.md')
  assert.equal(r.value.mime, 'text/markdown; charset=utf-8')
  assert.equal(Buffer.from(r.value.bytes, 'base64').toString('utf8'), '# 成品\n中文内容')
  assert.equal(r.value.size, Buffer.from(r.value.bytes, 'base64').length)
})

test('Y2 不在「已呈现」清单里的路径一律拒绝（不接手机自报路径）', async () => {
  const r = await mk().readBytes({ sessionId: 's1', relPath: '../../etc/passwd' })
  assert.equal(r.code, 'ARTIFACT_NOT_PRESENTED')
})

test('Y3 就算清单里写了越界路径，解析后仍要挡住（两道闸独立）', async () => {
  const r = await mk().readBytes({ sessionId: 's1', relPath: '../secret.txt' })
  assert.equal(r.code, 'PATH_OUTSIDE_WORKSPACE')
  assert.ok(secretFile)
})

test('Y4 体积上限：超限明确拒绝，不静默截断', async () => {
  writeFileSync(join(outDir, 'big.bin'), Buffer.alloc(2048, 7))
  const r = await mk(1024).readBytes({ sessionId: 's1', relPath: 'out/big.bin' })
  assert.equal(r.code, 'ARTIFACT_TOO_LARGE')
})

test('Y5 文件不在了如实报，不编一个空文件', async () => {
  const r = await mk().readBytes({ sessionId: 's1', relPath: 'out/gone.txt' })
  assert.equal(r.code, 'ARTIFACT_MISSING')
})

test('Y6 缺参数 / 拿不到工作区：都要拒绝，不能退化成读当前目录', async () => {
  assert.equal((await mk().readBytes({ sessionId: 's1' })).code, 'INVALID_ARGUMENT')
  const noRoot = createArtifactExporter({
    listArtifacts: async () => listed, resolveWorkspace: async () => null,
  })
  assert.equal((await noRoot.readBytes({ sessionId: 's1', relPath: 'out/a.md' })).code, 'WORKSPACE_UNKNOWN')
})

test('Y7 MIME 只认常见后缀，认不出就 octet-stream（不猜内容）', () => {
  assert.equal(mimeOfArtifact('x.pdf'), 'application/pdf')
  assert.equal(mimeOfArtifact('x.docx').startsWith('application/vnd'), true)
  assert.equal(mimeOfArtifact('x.whatever'), 'application/octet-stream')
})
