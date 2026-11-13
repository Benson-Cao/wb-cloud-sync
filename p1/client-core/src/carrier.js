/**
 * p1/client-core · DshCarrier 契约（S-2.4 / v2.3 04 §1bis）
 * ---------------------------------------------------------------
 * 三档案（本机 / SSH / Relay）共用同一套上层调用；**差异只允许出现在 carrier
 * 实现里**，App 不得写 `switch(hostKind)` 分支业务（S-2.4 坑）。
 *
 * 契约只有四个成员：
 *   - supportsUplink: boolean          该档案是否支持附件上行
 *   - allowsEndpoint(endpoint)          能力声明（B2）：端点白名单，拒绝不落到网络层
 *   - call(endpoint, args)              → Promise<RpcOk | RpcError>
 *   - openLink(opts)                    → DshMuxLink（订阅长连的传输无关抽象）
 *
 * `DshMuxLink` 是「一条订阅连接」的抽象，帧语义固定：
 *   item（一条 session/event）/ end（正常结束）/ error（异常，带 code）/ lost（断线）
 * carrier 只负责把自身传输（WS / SSE / HTTP 长轮询）映射到这三种帧 + lost；
 * 重连、generation、watch 重同步全部在 DshMux（mux.js），与传输无关。
 */

/** 统一错误码（与 04 错误码表对齐；carrier 实现把传输层错误映射到这些码）。 */
export const ERR = Object.freeze({
  ENDPOINT_NOT_ALLOWED: 'ENDPOINT_NOT_ALLOWED',   // 端点不在能力声明内（本地拒绝，不发请求）
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',       // 上游 405：路由存在但方法/形态不符
  UNAUTHORIZED: 'UNAUTHORIZED',                   // 401：凭证缺失/失效/已吊销
  HOST_MISMATCH: 'HOST_MISMATCH',                 // 409：绑定已换到另一台主机（r19 切换语义）
  HOST_OFFLINE: 'HOST_OFFLINE',                   // 409：目标离线 / 已收回
  NETWORK: 'NETWORK',                             // 网络层异常（可重试）
  INTERNAL: 'INTERNAL',                           // 其余
})

/** RpcOk：成功信封。`data` 由端点语义决定。 */
export const rpcOk = (data, extra = {}) => ({ ok: true, data, ...extra })

/** RpcError：失败信封。**不抛异常**——上层用 `r.ok` 判断，避免 try/catch 淹没错误码。 */
export const rpcError = (code, message, extra = {}) => ({
  ok: false,
  error: { code, message, retryable: extra.retryable ?? false, ...extra },
})

/** 断言 carrier 形状（工厂入口用，尽早失败而不是调用时才炸）。 */
export const assertCarrier = (carrier, name = 'carrier') => {
  if (!carrier || typeof carrier !== 'object') throw new TypeError(`${name} 必须是对象`)
  if (typeof carrier.supportsUplink !== 'boolean') throw new TypeError(`${name}.supportsUplink 必须是布尔`)
  if (typeof carrier.allowsEndpoint !== 'function') throw new TypeError(`${name}.allowsEndpoint 必须是函数`)
  if (typeof carrier.call !== 'function') throw new TypeError(`${name}.call 必须是函数`)
  if (typeof carrier.openLink !== 'function') throw new TypeError(`${name}.openLink 必须是函数`)
  return carrier
}

/**
 * 端点白名单（r3/r5/r6 协议集）——Relay 档案的默认能力声明。
 * 只放协议定义过的端点；能力差异（本机/SSH 直连官方 web）由各自 carrier 自报。
 */
export const RELAY_ENDPOINTS = Object.freeze([
  'session/prompt',
  'session/follow',
  'session/backfill',
  'session/artifact-ticket',
  'fileUploads/upload',
])

/**
 * 把一次 HTTP 往返映射到 RpcOk/RpcError（三个 carrier 共用的响应解包）。
 * `res` 需要 `{ status, json() }` 形状（fetch Response 或测试替身）。
 */
export const rpcFromResponse = async (res, endpoint) => {
  let payload = null
  try { payload = await res.json() } catch { /* 非 JSON 响应 */ }
  if (res.status === 405) return rpcError(ERR.METHOD_NOT_ALLOWED, `端点形态不支持：${endpoint}`)
  if (res.status === 403) return rpcError(ERR.ENDPOINT_NOT_ALLOWED, `端点未开放：${endpoint}`)
  if (res.status === 401) return rpcError(ERR.UNAUTHORIZED, '令牌缺失、失效或已吊销')
  if (res.status === 409) {
    const code = payload?.error?.code
    if (code === ERR.HOST_MISMATCH) return rpcError(ERR.HOST_MISMATCH, payload?.error?.message ?? '绑定的是另一台主机')
    return rpcError(ERR.HOST_OFFLINE, payload?.error?.message ?? '目标离线', { retryable: true })
  }
  if (!res.ok || payload?.ok !== true) {
    const code = payload?.error?.code ?? ERR.INTERNAL
    return rpcError(code, payload?.error?.message ?? `HTTP ${res.status}`, {
      retryable: payload?.error?.retryable ?? false,
    })
  }
  return rpcOk(payload.data, payload.hostId ? { hostId: payload.hostId } : {})
}