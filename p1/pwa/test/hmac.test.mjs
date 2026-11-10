/**
 * 纯 JS SHA-256 / HMAC-SHA256 · 正确性测试
 * 真机缺口：HTTP 局域网没有 crypto.subtle，配对签名必须能在纯 JS 下算出与
 * Relay 侧 node:crypto 完全一致的结果。三条独立证据：
 *   ① FIPS 180-4 / RFC 4231 标准向量；
 *   ② 与 node:crypto.createHmac 交叉验证（含 UTF-8、长 key、二进制）；
 *   ③ 与原生 WebCrypto 交叉验证（证明「原生路径」与「回退路径」同结果）。
 */
import assert from 'node:assert/strict'
import { createHmac, createHash, randomBytes } from 'node:crypto'
import { test } from 'node:test'
import { sha256Hex, hmacSha256Hex } from '../src/hmac-sha256.js'

const enc = new TextEncoder()
const hex = (s) => Buffer.from(s, 'hex')

test('H1 SHA-256 标准向量（空串 / abc）', () => {
  assert.equal(sha256Hex(enc.encode('')), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  assert.equal(sha256Hex(enc.encode('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
})

test('H2 RFC 4231 HMAC-SHA256 向量（case 1-4、6-7）', () => {
  const vectors = [
    [new Uint8Array(20).fill(0x0b), 'Hi There', 'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7'],
    ['Jefe', 'what do ya want for nothing?', '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843'],
    [new Uint8Array(20).fill(0xaa), new Uint8Array(50).fill(0xdd), '773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe'],
    [hex('0102030405060708090a0b0c0d0e0f10111213141516171819'), new Uint8Array(50).fill(0xcd), '82558a389a443c0ea4cc819899f2083a85f0faa3e578f8077a2e3ff46729665b'],
    [new Uint8Array(131).fill(0xaa), 'Test Using Larger Than Block-Size Key - Hash Key First', '60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54'],
    [new Uint8Array(131).fill(0xaa), 'This is a test using a larger than block-size key and a larger than block-size data. The key needs to be hashed before being used by the HMAC algorithm.', '9b09ffa71b942fcb27635fbcd5b0e944bfdc63644f0713938a7f51535c3a35e2'],
  ]
  for (const [key, msg, expected] of vectors) {
    assert.equal(hmacSha256Hex(key, msg), expected)
  }
})

test('H3 与 node:crypto 交叉验证（UTF-8 / emoji / 长消息 / 长 key / 空消息）', () => {
  const cases = [
    ['pair-secret', 'challenge-123'],
    ['中文密钥', '中文挑战 🎯'],
    ['', 'empty key'],
    ['k'.repeat(200), 'm'.repeat(1000)],   // key > 64B 需先哈希
    ['key', ''],
  ]
  for (let i = 0; i < 20; i++) {          // 随机二进制
    cases.push([randomBytes(i * 7 + 1).toString('hex'), randomBytes(i * 13).toString('hex')])
  }
  for (const [key, msg] of cases) {
    assert.equal(
      hmacSha256Hex(key, msg),
      createHmac('sha256', key).update(msg).digest('hex'),
      `HMAC 不一致：key=${String(key).slice(0, 20)}`,
    )
  }
  assert.equal(
    sha256Hex(enc.encode('cross-check')),
    createHash('sha256').update('cross-check').digest('hex'),
  )
})

test('H4 与原生 WebCrypto 交叉验证：两条签名路径结果一致', async () => {
  const subtle = globalThis.crypto?.subtle
  assert.ok(subtle, '本用例需要 Node ≥19 的全局 crypto.subtle')
  const cases = [
    ['pair-secret', 'challenge-abc'],
    ['🔑secret', '挑战\n换行'],
    ['x'.repeat(100), 'y'.repeat(300)],
  ]
  for (const [secret, message] of cases) {
    const key = await subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    const native = [...new Uint8Array(await subtle.sign('HMAC', key, enc.encode(message)))]
      .map((b) => b.toString(16).padStart(2, '0')).join('')
    assert.equal(hmacSha256Hex(secret, message), native)
  }
})
