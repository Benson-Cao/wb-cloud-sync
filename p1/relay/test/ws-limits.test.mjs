/**
 * WS 单帧上限可配（真机 2026-11-11）
 * ---------------------------------------------------------------
 * 旧版写死 1 MiB：真机单条事件最大 421 KiB，长回复/大会话摘要很容易顶破，
 * 顶破的后果是 **1009 静默断连**，在途请求熬成 10s 后的 504——看起来像「补齐卡住」。
 * 现在上限可配（默认 8 MiB），并且仍保留硬拒绝：超限就关，不半读半丢。
 */
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { createRelay } from '../src/server.js'

const relays = []
const swallow = (size) => Buffer.alloc(size, 0x61)

const start = async (opts = {}) => {
  const relay = createRelay({ hostToken: 'host-secret', randomBytes: (n) => Buffer.alloc(n, 7), ...opts })
  const port = await relay.start(0)
  relays.push(relay)
  return { relay, port }
}
after(async () => { for (const r of relays) await r.stop() })

const open = (port) => new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/host`)
  ws.addEventListener('open', () => resolve(ws), { once: true })
  ws.addEventListener('error', () => reject(new Error('ws 失败')), { once: true })
})

const closeCode = (ws, timeout = 2000) => new Promise((resolve) => {
  const timer = setTimeout(() => resolve(null), timeout)
  ws.addEventListener('close', (e) => { clearTimeout(timer); resolve(e.code) }, { once: true })
})

test('L1 默认上限能接住 1 MiB 以上的帧（真机长回复不再断连）', async () => {
  const { relay, port } = await start()
  const ws = await open(port)
  ws.send(JSON.stringify({ t: 'host/register', deviceId: 'big-frame', hostToken: 'host-secret' }))
  await new Promise((r) => setTimeout(r, 80))
  // 1.2 MiB 的帧：旧版 1 MiB 上限会直接 1009
  ws.send(JSON.stringify({ t: 'host/heartbeat', pad: swallow(1_200_000).toString('latin1') }))
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(ws.readyState, WebSocket.OPEN, '默认上限下连接应存活')
  assert.equal(relay.isOnline('big-frame'), true)
  ws.close()
})

test('L2 超过配置上限的帧仍被 1009 硬拒（不半读半丢）', async () => {
  const { relay, port } = await start({ maxFrameBytes: 4096 })
  const ws = await open(port)
  ws.send(JSON.stringify({ t: 'host/register', deviceId: 'too-big', hostToken: 'host-secret' }))
  await new Promise((r) => setTimeout(r, 80))
  const code = closeCode(ws)
  ws.send(JSON.stringify({ t: 'host/heartbeat', pad: 'x'.repeat(8000) }))
  assert.equal(await code, 1009, '超限必须以 1009 关闭')
  assert.equal(relay.isOnline('too-big'), false, '关掉即离线，不能留下假在线')
})

test('L3 上限下限被夹住：误配成 1 不会把所有帧都拒掉', async () => {
  const { port } = await start({ maxFrameBytes: 1 })
  const ws = await open(port)
  const codeOrOpen = await new Promise((resolve) => {
    ws.addEventListener('close', (e) => resolve(`closed:${e.code}`), { once: true })
    ws.send(JSON.stringify({ t: 'host/register', deviceId: 'tiny-limit', hostToken: 'host-secret' }))
    setTimeout(() => resolve('open'), 200)
  })
  assert.equal(codeOrOpen, 'open', '应回落到至少 1 KiB，注册帧能过去')
  ws.close()
})
