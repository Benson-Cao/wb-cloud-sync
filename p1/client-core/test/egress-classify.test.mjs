import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyHost } from '../../../scripts/egress-classify.mjs'

test('RFC 6761 / 2606 保留域归 placeholder（测试夹具不会误报出网）', () => {
  for (const h of [
    'relay.test', 'r.test', 'evil.example', 'foo.invalid', 'foo.localhost',
    'sync.example.com', 'example.org', 'example.net'
  ]) {
    assert.equal(classifyHost(h), 'placeholder', h)
  }
})

test('真实公网域名仍归 external，保留域规则不放行 com 子域', () => {
  for (const h of ['api.deepseek.com', 'github.com', 'test.com', 'attacker.example.com.evil.net']) {
    assert.equal(classifyHost(h), 'external', h)
  }
})

test('回环与绑定地址分类不变', () => {
  assert.equal(classifyHost('127.0.0.1'), 'loopback')
  assert.equal(classifyHost('localhost'), 'loopback')
  assert.equal(classifyHost('::1'), 'loopback')
  assert.equal(classifyHost('[::1]'), 'loopback')
  assert.equal(classifyHost('0.0.0.0'), 'bind-any')
  assert.equal(classifyHost('host.docker.internal'), 'loopback')
})

test('私网段包含 RFC1918 与 IPv6 ULA，172.32 不在段内', () => {
  for (const h of ['192.168.1.5', '10.0.0.2', '172.16.0.1', '172.31.255.1', 'fe80::1', 'fd00::1']) {
    assert.equal(classifyHost(h), 'private', h)
  }
  assert.equal(classifyHost('172.32.0.1'), 'external')
})

test('单标签 host 与带端口写法', () => {
  assert.equal(classifyHost('x'), 'placeholder')
  assert.equal(classifyHost('relay'), 'placeholder')
  assert.equal(classifyHost('mock'), 'placeholder')
  assert.equal(classifyHost('127.0.0.1:8787'), 'loopback')
  assert.equal(classifyHost('relay.test:8787'), 'placeholder')
})
