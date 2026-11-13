/**
 * p1/client-core · Carrier 传输映射测试（S-2.5）
 * ---------------------------------------------------------------
 * 覆盖：Relay URL 形态与错误码映射 / Local 注入点（pathOf/authHeaders/linkFactory）/
 * SSH TOFU 指纹阻断。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  createLocalCarrier, createRelayCarrier, createSshCarrier, ERR, rpcFromResponse,
} from '../src/index.js'

const fakeRes = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body })

test('RelayCarrier：URL 形态与鉴权头（/d/<hostId>/<endpoint> + Bearer）', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return fakeRes(200, { ok: true, data: { accepted: true } })
  }
  const carrier = createRelayCarrier({
    relayUrl: 'http://relay.test:8787/', hostId: 'host-1', deviceToken: 'tok-secret', fetchImpl,
  })
  const r = await carrier.call('session/prompt', { text: 'hi' })
  assert.equal(r.ok, true)
  assert.equal(calls[0].url, 'http://relay.test:8787/d/host-1/session/prompt')
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tok-secret')
})

test('RelayCarrier：错误码映射（401/403/405/409 HOST_MISMATCH/409 离线）', async () => {
  const mk = (status, body) => createRelayCarrier({
    relayUrl: 'http://r.test', hostId: 'h', deviceToken: 't',
    fetchImpl: async () => fakeRes(status, body),
  })
  assert.equal((await mk(401, { ok: false, error: { code: 'UNAUTHORIZED' } }).call('session/prompt', {})).error.code, ERR.UNAUTHORIZED)
  assert.equal((await mk(403, { ok: false, error: { code: 'ENDPOINT_NOT_ALLOWED' } }).call('x', {})).error.code, ERR.ENDPOINT_NOT_ALLOWED)
  assert.equal((await mk(405, { ok: false }).call('x', {})).error.code, ERR.METHOD_NOT_ALLOWED)
  const hm = await mk(409, { ok: false, error: { code: 'HOST_MISMATCH' } }).call('session/prompt', {})
  assert.equal(hm.error.code, ERR.HOST_MISMATCH)
  const off = await mk(409, { ok: false, error: { code: 'HOST_OFFLINE' } }).call('session/prompt', {})
  assert.equal(off.error.code, ERR.HOST_OFFLINE)
  assert.equal(off.error.retryable, true, '离线可重试')
})

test('RelayCarrier：网络异常映射 NETWORK（可重试，不抛异常）', async () => {
  const carrier = createRelayCarrier({
    relayUrl: 'http://r.test', hostId: 'h', deviceToken: 't',
    fetchImpl: async () => { throw new Error('connect ECONNREFUSED') },
  })
  const r = await carrier.call('session/prompt', {})
  assert.equal(r.ok, false)
  assert.equal(r.error.code, ERR.NETWORK)
  assert.equal(r.error.retryable, true)
})

test('LocalCarrier：pathOf / authHeaders / linkFactory 注入点生效', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init.headers })
    return fakeRes(200, { ok: true, data: null })
  }
  const carrier = createLocalCarrier({
    origin: 'http://127.0.0.1:3080',
    authHeaders: () => ({ Cookie: 'dsh-auth-x=1' }),
    pathOf: (ep) => `/custom/${ep}`,
    fetchImpl,
  })
  await carrier.call('session/prompt', {})
  assert.equal(calls[0].url, 'http://127.0.0.1:3080/custom/session/prompt', 'pathOf 可注入（App 壳校准官方 API 形态）')
  assert.equal(calls[0].headers.Cookie, 'dsh-auth-x=1', '凭证由 App 壳注入')

  const injected = { item: null, tag: 'injected-link' }
  const withFactory = createLocalCarrier({ linkFactory: () => injected })
  assert.equal(withFactory.openLink({ sessionId: 's' }), injected, 'App 壳可注入官方 mux 适配')
})

test('SshCarrier：TOFU 指纹一致放行；指纹变化阻断（抛 SSH_FINGERPRINT_MISMATCH）', () => {
  assert.doesNotThrow(() => createSshCarrier({ expectedFingerprint: null, actualFingerprint: 'aa' }), '首次信任放行')
  assert.doesNotThrow(() => createSshCarrier({ expectedFingerprint: 'aa', actualFingerprint: 'aa' }), '指纹一致放行')
  assert.throws(
    () => createSshCarrier({ expectedFingerprint: 'aa', actualFingerprint: 'bb' }),
    (e) => e.code === 'SSH_FINGERPRINT_MISMATCH',
    '指纹变化必须阻断（中间人/主机被替换）',
  )
})

test('rpcFromResponse：非 JSON 响应与未知错误码兜底 INTERNAL', async () => {
  const plain = await rpcFromResponse({ ok: false, status: 500, json: async () => { throw new Error('not json') } }, 'x')
  assert.equal(plain.error.code, ERR.INTERNAL)
  const unknown = await rpcFromResponse(fakeRes(400, { ok: false, error: { code: 'SOMETHING_ELSE', message: 'm' } }), 'x')
  assert.equal(unknown.error.code, 'SOMETHING_ELSE', '协议错误码原样透传')
})