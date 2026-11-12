/**
 * 手机端 WebView 驱动（spike 验证用）
 * 用法：node .tmp-drive.mjs <action> [args...]
 *   probe               打印 data-wbsync 元素
 *   click <selector>    点击
 *   fill <selector> <v> 设值（React 兼容）
 *   shot <path>         截图
 *   scroll <y>          滚动 flow
 */
import { writeFileSync } from 'node:fs'

const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const page = list.find((t) => t.type === 'page')
if (!page) { console.log('没有 page 目标'); process.exit(1) }

const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
const send = (method, params = {}) => new Promise((resolve) => {
  const reqId = ++id
  pending.set(reqId, resolve)
  ws.send(JSON.stringify({ id: reqId, method, params }))
})
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
})
await new Promise((r) => ws.addEventListener('open', r))
await send('Runtime.enable')
await send('Page.enable')

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r?.result?.exceptionDetails) return { error: r.result.exceptionDetails.text }
  return r?.result?.result?.value
}

const [action, ...args] = process.argv.slice(2)

if (action === 'probe') {
  const out = await evaluate(`(() => {
    const box = (e) => { const r = e.getBoundingClientRect(); return Math.round(r.width)+'x'+Math.round(r.height)+'@'+Math.round(r.x)+','+Math.round(r.y) }
    const els = [...document.querySelectorAll('[data-wbsync]')].map((e) => ({
      k: e.getAttribute('data-wbsync'), box: box(e), text: (e.textContent||'').trim().slice(0,20),
    }))
    return JSON.stringify({ vw: innerWidth, vh: innerHeight, count: els.length, els })
  })()`)
  console.log(typeof out === 'string' ? out : JSON.stringify(out))
}

if (action === 'click') {
  const sel = args[0]
  const out = await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)})
    if (!el) return 'not-found'
    el.click()
    return 'clicked'
  })()`)
  console.log(out)
}

if (action === 'fill') {
  const [sel, value] = args
  const out = await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)})
    if (!el) return 'not-found'
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(el, ${JSON.stringify(value)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return el.value
  })()`)
  console.log(out)
}

if (action === 'shot') {
  const path = args[0]
  const r = await send('Page.captureScreenshot', { format: 'png' })
  const data = r?.result?.data
  if (!data) { console.log('截图失败'); process.exit(1) }
  writeFileSync(path, Buffer.from(data, 'base64'))
  console.log('saved', path, Buffer.from(data, 'base64').length, 'B')
}

if (action === 'scroll') {
  const y = Number(args[0] || 0)
  const out = await evaluate(`(() => {
    const f = document.querySelector('[data-wbsync="flow"]')
    if (!f) return 'no-flow'
    f.scrollTop = ${y}
    return f.scrollTop + '/' + f.scrollHeight
  })()`)
  console.log(out)
}

ws.close()
