/**
 * p1/client-core · SshCarrier（SSH 档案，S-6.7 隧道侧）
 * ---------------------------------------------------------------
 * 链路：App → 本地 SSH 隧道 `-L 127.0.0.1:3081:127.0.0.1:3080` → 远端 dsh web。
 * 隧道由 App 壳/Kotlin 侧建立，本 carrier 只认 `origin`（默认 127.0.0.1:3081）。
 *
 * 安全（04 §1bis · B3 TOFU）：首次连接核对主机公钥指纹，之后指纹变化按
 * **不匹配处理并阻断**——构造函数校验 `expectedFingerprint` 与 `actualFingerprint`；
 * 指纹核对本身发生在隧道握手（App 壳），这里的守卫是防止「壳把错指纹传进来」。
 * `expectedFingerprint` 缺省视为新信任（首次 TOFU），不需要阻断。
 */

import { ERR, rpcError, rpcFromResponse } from '../carrier.js'

const toWsUrl = (origin) => String(origin)
  .replace(/\/$/, '')
  .replace(/^http:/, 'ws:')
  .replace(/^https:/, 'wss:')

export function createSshCarrier({
  origin = 'http://127.0.0.1:3081',
  supportsUplink = true,
  allowedEndpoints = ['session/prompt', 'session/follow', 'session/backfill', 'fileUploads/upload'],
  authHeaders = () => ({}),
  pathOf = (endpoint) => `/api/${endpoint}`,
  fetchImpl = globalThis.fetch,
  linkFactory = null,
  WebSocketImpl = globalThis.WebSocket,
  expectedFingerprint = null,   // TOFU 已信任的指纹（SHA-256 hex）；null = 首次信任
  actualFingerprint = null,     // 当前隧道对端指纹（App 壳握手后传入）
} = {}) {
  if (expectedFingerprint && actualFingerprint && expectedFingerprint !== actualFingerprint) {
    // 指纹变化 = 中间人或主机被替换：阻断，不给「继续」的口子
    throw Object.assign(new Error('SSH 主机指纹不匹配（TOFU 校验失败），已阻断连接'), {
      code: 'SSH_FINGERPRINT_MISMATCH',
    })
  }
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
    if (typeof linkFactory === 'function') return linkFactory(wsUrl, { sessionId, sinceSeq })
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
    kind: 'ssh',
    supportsUplink,
    allowsEndpoint: (endpoint) => allowed.has(endpoint),
    call,
    openLink,
  }
}