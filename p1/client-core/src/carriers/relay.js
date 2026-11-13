/**
 * p1/client-core · RelayCarrier（Relay 档案，S-6.7 反代链路）
 * ---------------------------------------------------------------
 * 链路：手机 → Relay `/d/<hostId>/*`（Bearer deviceToken 鉴权）→ Host 插件 / 官方 web。
 * 形态与现网一致（r17/r19 真机验证过的 URL）：
 *   - call：      POST {relay}/d/{hostId}/{endpoint}
 *   - openLink：  WS  {ws}/d/{hostId}/events/{sessionId}?token=…&sinceSeq=…
 *
 * 令牌只进内存，不进日志（URL 里的 token 是浏览器/WS 无法设 Authorization 头的
 * 无奈之举，与 PWA 同口径）。
 */

import { ERR, RELAY_ENDPOINTS } from '../carrier.js'
import { rpcFromResponse, rpcError } from '../carrier.js'

const toWsUrl = (base) => String(base)
  .replace(/\/$/, '')
  .replace(/^http:/, 'ws:')
  .replace(/^https:/, 'wss:')

export function createRelayCarrier({
  relayUrl,
  hostId,
  deviceToken,
  supportsUplink = true,
  allowedEndpoints = RELAY_ENDPOINTS,
  fetchImpl = globalThis.fetch,
  WebSocketImpl = globalThis.WebSocket,
} = {}) {
  if (!relayUrl) throw new TypeError('createRelayCarrier 需要 relayUrl')
  if (!hostId) throw new TypeError('createRelayCarrier 需要 hostId')
  if (!deviceToken) throw new TypeError('createRelayCarrier 需要 deviceToken')
  const base = String(relayUrl).replace(/\/$/, '')
  const allowed = new Set(allowedEndpoints)

  const call = async (endpoint, args) => {
    let res
    try {
      res = await fetchImpl(`${base}/d/${encodeURIComponent(hostId)}/${endpoint}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${deviceToken}`,
        },
        body: JSON.stringify(args ?? {}),
      })
    } catch (error) {
      return rpcError(ERR.NETWORK, String(error?.message ?? error), { retryable: true })
    }
    return rpcFromResponse(res, endpoint)
  }

  const openLink = ({ sessionId, sinceSeq = -1 }) => {
    const wsUrl = `${toWsUrl(base)}/d/${encodeURIComponent(hostId)}/events/${encodeURIComponent(sessionId)}`
      + `?token=${encodeURIComponent(deviceToken)}&sinceSeq=${Number.isInteger(sinceSeq) ? sinceSeq : -1}`
    const ws = new WebSocketImpl(wsUrl)
    const handlers = { item: null, end: null, error: null, lost: null }
    let closedByUser = false

    ws.addEventListener('message', (event) => {
      let msg
      try { msg = JSON.parse(String(event.data)) } catch { return }
      if (msg.t === 'session/event') handlers.item?.(msg.ev)
      else if (msg.t === 'session/replay') {
        // 补发窗口：complete=false 时按缺口语义处理（mux 侧报 gap）
        if (msg.complete === false) handlers.error?.({ code: 'REPLAY_GAP', expectedSeq: (msg.toSeq ?? -1) + 1 })
      } else if (msg.t === 'session/gap') {
        handlers.error?.({ code: 'SESSION_GAP', expectedSeq: msg.expectedSeq })
      }
    })
    ws.addEventListener('close', () => {
      if (closedByUser) return
      handlers.lost?.()
    })
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
    kind: 'relay',
    supportsUplink,
    allowsEndpoint: (endpoint) => allowed.has(endpoint),
    call,
    openLink,
  }
}