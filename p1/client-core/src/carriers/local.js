/**
 * p1/client-core · LocalCarrier（本机档案，S-6.4）
 * ---------------------------------------------------------------
 * 链路：App → 本机 dsh web（`dsh web --host 127.0.0.1 --port 3080 --no-open`）。
 * launch token 换 cookie 是 **App 壳（WebView / EngineBridge）的职责**——本 carrier
 * 只承载「索引 / 状态点 / 切换 / 少量 RPC」的骨架，凭证以 `authHeaders` 注入
 * （骨架默认空；App 壳注入 cookie 或令牌）。
 *
 * 形态说明（骨架级，真机联调校准）：
 *   - call 默认映射 `POST {origin}/api/{endpoint}`（官方 web API 前缀）；
 *     App 壳可用 `pathOf` 注入实际映射，不改上层调用。
 *   - openLink 默认走 `ws(s)://{origin}/api/remote.mux`（官方 UI 的 WS mux 形态）；
 *     官方 mux 是帧协议，App 壳可注入 `linkFactory` 复用其解析结果。
 *   本 carrier 不编造官方端点语义：本机档案的 UI 由官方 web 自己提供，这里只服务
 *   App 壳的索引/状态/切换（v2.3 04 §1bis）。
 */

import { ERR, rpcError, rpcFromResponse } from '../carrier.js'

const toWsUrl = (origin) => String(origin)
  .replace(/\/$/, '')
  .replace(/^http:/, 'ws:')
  .replace(/^https:/, 'wss:')

export function createLocalCarrier({
  origin = 'http://127.0.0.1:3080',
  supportsUplink = true,
  allowedEndpoints = ['session/prompt', 'session/follow', 'session/backfill', 'fileUploads/upload'],
  authHeaders = () => ({}),         // App 壳注入（cookie / token）；骨架默认无
  pathOf = (endpoint) => `/api/${endpoint}`,
  fetchImpl = globalThis.fetch,
  linkFactory = null,               // (wsUrl) => DshMuxLink；App 壳可注入官方 mux 适配
  WebSocketImpl = globalThis.WebSocket,
} = {}) {
  const base = String(origin).replace(/\/$/, '')
  const allowed = new Set(allowedEndpoints)

  const call = async (endpoint, args) => {
    let res
    try {
      res = await fetchImpl(`${base}${pathOf(endpoint)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify(args ?? {}),
      })
    } catch (error) {
      return rpcError(ERR.NETWORK, String(error?.message ?? error), { retryable: true })
    }
    return rpcFromResponse(res, endpoint)
  }

  const openLink = ({ sessionId, sinceSeq = -1 }) => {
    const wsUrl = `${toWsUrl(base)}/api/remote.mux?sessionId=${encodeURIComponent(sessionId)}`
      + `&sinceSeq=${Number.isInteger(sinceSeq) ? sinceSeq : -1}`
    if (typeof linkFactory === 'function') {
      // App 壳注入的官方 mux 适配（帧协议由壳解析；本层只要求 item/end/error/lost 语义）
      return linkFactory(wsUrl, { sessionId, sinceSeq })
    }
    const ws = new WebSocketImpl(wsUrl)
    const handlers = { item: null, end: null, error: null, lost: null }
    let closedByUser = false
    ws.addEventListener('message', (event) => {
      let msg
      try { msg = JSON.parse(String(event.data)) } catch { return }
      if (msg.t === 'session/event') handlers.item?.(msg.ev)
    })
    ws.addEventListener('close', () => { if (!closedByUser) handlers.lost?.() })
    ws.addEventListener('error', () => { /* close 紧随其后 */ })
    return {
      cancel: () => { try { ws.close(1000, 'cancel') } catch { /* 已关闭 */ } },
      close: () => {
        closedByUser = true
        try { ws.close(1000, 'client') } catch { /* 已关闭 */ }
      },
      onEvent: (cb) => { handlers.item = cb },
      onEnd: (cb) => { handlers.end = cb },
      onError: (cb) => { handlers.error = cb },
      onLost: (cb) => { handlers.lost = cb },
    }
  }

  return {
    kind: 'local',
    supportsUplink,
    allowsEndpoint: (endpoint) => allowed.has(endpoint),
    call,
    openLink,
  }
}