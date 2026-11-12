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
  writeFileSync(join(outDir, 'a.docx'), Buffer.alloc(64, 1))     // 源文件故意大于下载上限，验证「转换不看源体积」
  writeFileSync(join(outDir, 'a.pdf'), Buffer.from('%PDF-1.4 原样', 'utf8'))
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
      { seq: 5, index: 0, path: 'out/a.docx', name: 'a.docx', description: 'Word 成品' },
      { seq: 6, index: 0, path: 'out/a.pdf', name: 'a.pdf', description: '' },
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

test('Y8 转 PDF：Office 源交给宿主转换器，输出仍受同一张票据的体积上限', async () => {
  const seen = []
  const conv = createArtifactExporter({
    listArtifacts: async () => listed,
    resolveWorkspace: async () => root,
    convertToPdf: async (args) => {
      seen.push(args)
      return { ok: true, value: { bytes: Buffer.from('%PDF-1.7 转换结果', 'utf8') } }
    },
  })
  const r = await conv.readBytes({ sessionId: 's1', relPath: 'out/a.docx', format: 'pdf' })
  assert.equal(r.ok, true)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].relPath, 'out/a.docx')
  assert.equal(seen[0].absPath, join(root, 'out', 'a.docx'), '转换器要拿到绝对路径，才不用先读字节')
  assert.equal(r.value.name, 'a.pdf', '名字要跟着实际格式走，不能还叫 .docx')
  assert.equal(r.value.mime, 'application/pdf')
  assert.equal(r.value.convertedFrom, 'a.docx')
  assert.equal(Buffer.from(r.value.bytes, 'base64').toString('utf8'), '%PDF-1.7 转换结果')
})

test('Y9 md/txt 转 PDF：宿主没这个能力，必须明确拒绝而不是硬转', async () => {
  let called = 0
  const conv = createArtifactExporter({
    listArtifacts: async () => listed,
    resolveWorkspace: async () => root,
    convertToPdf: async () => { called++; return { ok: true, value: { bytes: Buffer.from('x') } } },
  })
  const r = await conv.readBytes({ sessionId: 's1', relPath: 'out/a.md', format: 'pdf' })
  assert.equal(r.code, 'CAPABILITY_UNAVAILABLE')
  assert.match(r.message, /Office/)
  assert.equal(called, 0, '不支持的类型不该白跑一次转换')
})

test('Y10 转换失败 / 输出超限：原样上报，不退化成「给个源文件」', async () => {
  const failed = createArtifactExporter({
    listArtifacts: async () => listed, resolveWorkspace: async () => root,
    convertToPdf: async () => ({ ok: false, code: 'CONVERT_FAILED', message: 'LibreOffice 超时' }),
  })
  const r1 = await failed.readBytes({ sessionId: 's1', relPath: 'out/a.docx', format: 'pdf' })
  assert.equal(r1.code, 'CONVERT_FAILED')
  assert.match(r1.message, /LibreOffice 超时/)

  const throwing = createArtifactExporter({
    listArtifacts: async () => listed, resolveWorkspace: async () => root,
    convertToPdf: async () => { throw new Error('转换器崩了') },
  })
  // 抛出也算失败，绝不能让异常冒到 frame 层变成 500 空响应
  const r2 = await throwing.readBytes({ sessionId: 's1', relPath: 'out/a.docx', format: 'pdf' })
  assert.equal(r2.ok, false)

  const huge = createArtifactExporter({
    listArtifacts: async () => listed, resolveWorkspace: async () => root, maxBytes: 128,
    convertToPdf: async () => ({ ok: true, value: { bytes: Buffer.alloc(512, 2) } }),
  })
  const r3 = await huge.readBytes({ sessionId: 's1', relPath: 'out/a.docx', format: 'pdf' })
  assert.equal(r3.code, 'ARTIFACT_TOO_LARGE')
})

test('Y11 已经是 PDF 再要 PDF：原样给，不白跑转换', async () => {
  let called = 0
  const conv = createArtifactExporter({
    listArtifacts: async () => listed, resolveWorkspace: async () => root,
    convertToPdf: async () => { called++; return { ok: true, value: { bytes: Buffer.from('nope') } } },
  })
  const r = await conv.readBytes({ sessionId: 's1', relPath: 'out/a.pdf', format: 'pdf' })
  assert.equal(r.ok, true)
  assert.equal(called, 0)
  assert.equal(r.value.name, 'a.pdf')
  assert.match(Buffer.from(r.value.bytes, 'base64').toString('utf8'), /%PDF-1\.4/)
})
