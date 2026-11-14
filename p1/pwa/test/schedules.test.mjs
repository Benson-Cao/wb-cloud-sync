/**
 * r25 · S-8.4 / TC-8.6：定时任务按 hostId 分组——PWA 侧参数名与取值切换。
 * 轻量注入测试：mock fetch 捕获 URL 与请求体，不起 Relay；
 * 判据是「正式名 hostId、取当前执行位置、不再出现 deviceId」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createPwaClient } from '../src/client.js'

class FakeWS {
  addEventListener() {}
  send() {}
  close() {}
}

const makeClient = (hostId) => {
  const calls = []
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url: String(url), body: opts.body ? JSON.parse(opts.body) : null })
    return { ok: true, json: async () => ({ ok: true, data: { rows: [], id: 'sch-1' } }) }
  }
  const client = createPwaClient({
    baseUrl: 'http://relay',
    deviceId: 'phone-1',
    hostId,
    token: 'tok',
    fetchImpl,
    WebSocketImpl: FakeWS,
  })
  return { client, calls }
}

test('S1 listSchedules 用正式参数 hostId=，不再带 deviceId', async () => {
  const { client, calls } = makeClient('host-A')
  const rows = await client.listSchedules()
  assert.deepEqual(rows, [])
  assert.match(calls.at(-1).url, /\/api\/schedules\?hostId=host-A$/)
  assert.doesNotMatch(calls.at(-1).url, /deviceId/)
})

test('S2 createSchedule 请求体带 hostId（当前执行位置）', async () => {
  const { client, calls } = makeClient('host-A')
  await client.createSchedule({ title: '巡检', prompt: '跑一遍', afterSeconds: 60 })
  const body = calls.at(-1).body
  assert.equal(body.hostId, 'host-A')
  assert.equal(body.deviceId, undefined)
  assert.equal(body.title, '巡检')
})

test('S3 runSchedule 请求体带 hostId', async () => {
  const { client, calls } = makeClient('host-A')
  await client.runSchedule({ id: 'sch-9' })
  assert.match(calls.at(-1).url, /\/api\/schedules\/sch-9\/run$/)
  assert.equal(calls.at(-1).body.hostId, 'host-A')
  assert.equal(calls.at(-1).body.deviceId, undefined)
})

test('S4 服务端切换器重绑后按新 hostId 路由（TC-8.6 分组可见的前提）', async () => {
  const { client, calls } = makeClient('host-B')
  await client.listSchedules()
  await client.createSchedule({ title: 't', prompt: 'p', afterSeconds: 30 })
  await client.runSchedule({ id: 'sch-1' })
  assert.match(calls[0].url, /hostId=host-B/)
  assert.equal(calls[1].body.hostId, 'host-B')
  assert.equal(calls[2].body.hostId, 'host-B')
})
