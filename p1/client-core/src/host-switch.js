/**
 * p1/client-core · 主机切换器协议半边（S-6.9 FE / v2.3 04 §6）
 * ---------------------------------------------------------------
 * 与 `DshCarrier` 分工：carrier 管**数据面**（`POST /d/<hostId>/<endpoint>` +
 * WS 订阅），本模块管**控制面**（CP REST：`GET /api/hosts` /
 * `POST /api/hosts/select`）。两者共用同一枚 deviceToken，但生命周期独立——
 * 切换后 carrier 必须重建，本模块只发信号、不代管 carrier。
 *
 * 纯协议骨架：不依赖 UI 框架、不碰 WebView、不给 UI 供数。
 * 「清空会话视图 / 按新 hostId 重建索引 / 销毁重建 WebView cookie jar」由 App 壳
 * 通过 `onHostChanged` 钩子执行（12 号手册 S-6.9 的坑：独立 cookie jar 是挡住
 * R-22 串会话的关键，别复用同一个 WebView 实例）。
 *
 * 铁律：
 *   1. `confirmNoMigration` 必须显式 `=== true` 才发切换请求（TC-4.2「必现确认」）。
 *      服务端 r19 也强制；客户端先拦是为了不把「点一下就切」变成误操作，并省一次往返。
 *      同主机 select 是 no-op，服务端无需 confirm，客户端同口径放行。
 *   2. 切换成功后视图必须重建：`viewEpoch++` + `clearView` / `resetCookieJar`，
 *      旧 hostId 的索引不得合并进新视图（TC-4.3 / R-22 串会话防线）。
 *   3. `dshCommit` ≠ `pinnedDshCommit` → `COMMIT_DRIFT`：**索引不合并、只提示升级**
 *      （TC-1.11 / 04 §6⑦）。切换本身已在服务端生效，不回滚绑定——回滚是另一次切换。
 *   4. 错误不抛异常，统一 RpcOk / RpcError 信封；401 不傻重试（与 DshMux 同口径）。
 *   5. 令牌只进内存 `Authorization` 头，不进 URL、不进日志。
 */

import { rpcError, rpcOk } from './carrier.js'

/** 切换控制面的错误码（与 04 §1 错误码表 / r19 select 语义对齐）。 */
export const SWITCH_ERR = Object.freeze({
  CONFIRM_REQUIRED: 'CONFIRM_REQUIRED',   // 400：未显式确认「不带走会话/文件/插件」
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',   // 400：缺 hostId 等
  COMMIT_DRIFT: 'COMMIT_DRIFT',           // 客户端基线漂移：索引不合并、只提示升级
  CLIENT_LIMIT: 'CLIENT_LIMIT',           // 409：目标主机名下手机数已达上限
  HOST_OFFLINE: 'HOST_OFFLINE',           // 404：目标不存在 / 已吊销
  HOST_MISMATCH: 'HOST_MISMATCH',         // 409：令牌绑定的是另一台主机
  UNAUTHORIZED: 'UNAUTHORIZED',           // 401：令牌缺失 / 失效 / 已吊销
  NETWORK: 'NETWORK',                     // 网络层异常（可重试）
  INTERNAL: 'INTERNAL',                   // 其余
})

/** 复用 carrier 的统一信封，错误码按控制面语义补齐（409 不再一律当离线）。 */
const switchFromResponse = async (res) => {
  let payload = null
  try { payload = await res.json() } catch { /* 非 JSON 响应 */ }
  const code = payload?.error?.code
  const message = payload?.error?.message ?? `HTTP ${res.status}`
  if (res.status === 401) return rpcError(SWITCH_ERR.UNAUTHORIZED, '令牌缺失、失效或已吊销')
  if (res.status === 400) {
    if (code === SWITCH_ERR.CONFIRM_REQUIRED) {
      return rpcError(SWITCH_ERR.CONFIRM_REQUIRED, message)
    }
    return rpcError(SWITCH_ERR.INVALID_ARGUMENT, message)
  }
  if (res.status === 404) return rpcError(SWITCH_ERR.HOST_OFFLINE, message)
  if (res.status === 409) {
    if (code === SWITCH_ERR.CLIENT_LIMIT) return rpcError(SWITCH_ERR.CLIENT_LIMIT, message)
    if (code === SWITCH_ERR.HOST_MISMATCH) return rpcError(SWITCH_ERR.HOST_MISMATCH, message)
    return rpcError(SWITCH_ERR.HOST_OFFLINE, message, { retryable: true })
  }
  if (!res.ok || payload?.ok !== true) {
    return rpcError(code ?? SWITCH_ERR.INTERNAL, message, {
      retryable: payload?.error?.retryable ?? false,
    })
  }
  return rpcOk(payload.data)
}

/**
 * @param {object} opts
 * @param {string} opts.baseUrl            Relay / CP 根地址
 * @param {string} opts.deviceToken        手机令牌（只进 Authorization 头）
 * @param {string} [opts.pinnedDshCommit]  客户端 pin 的 DSH 基线（pinned-commit.txt）
 * @param {string} [opts.currentHostId]    当前执行位置（缺省由 listHosts 的 bound 行推断）
 * @param {Function} [opts.fetchImpl]      可注入的 fetch
 * @param {Function} [opts.onHostChanged] 切换成功钩子：App 壳清视图 / 重建 carrier / 重置 cookie jar
 * @param {Function} [opts.onNotice]       提示钩子：{ type, ... }，如 upgrade-required / host-mismatch
 */
export function createHostSwitcher({
  baseUrl,
  deviceToken,
  pinnedDshCommit = '',
  currentHostId = null,
  fetchImpl = globalThis.fetch,
  onHostChanged = null,
  onNotice = null,
} = {}) {
  if (!baseUrl) throw new TypeError('createHostSwitcher 需要 baseUrl')
  if (!deviceToken) throw new TypeError('createHostSwitcher 需要 deviceToken')
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl 必须是函数')
  const base = String(baseUrl).replace(/\/$/, '')
  const pinned = String(pinnedDshCommit ?? '').trim()

  let hostId = currentHostId ? String(currentHostId) : null
  let from = null
  let kind = null
  let online = null
  let drift = false
  let viewEpoch = 0
  let lastSelectAt = null

  const notify = (notice) => { try { onNotice?.(notice) } catch { /* 回调异常不影响切换 */ } }
  const authHeaders = () => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${deviceToken}`,
  })

  const request = async (path, { method = 'GET', body } = {}) => {
    let res
    try {
      res = await fetchImpl(`${base}${path}`, {
        method,
        headers: authHeaders(),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    } catch (error) {
      return rpcError(SWITCH_ERR.NETWORK, String(error?.message ?? error), { retryable: true })
    }
    return switchFromResponse(res)
  }

  /** 可切主机清单（r20 手机视角：全部非墓碑主机 + bound 标记、不收 phones[]）。 */
  const listHosts = async () => {
    const r = await request('/api/hosts')
    if (!r.ok) {
      if (r.error.code === SWITCH_ERR.HOST_MISMATCH) {
        notify({ type: 'host-mismatch', hostId })
      }
      return r
    }
    const rows = Array.isArray(r.data?.rows) ? r.data.rows : []
    // 客户端执行位置以服务端的 bound 行为准（不自行猜「第一个在线的」）
    const bound = rows.find((row) => row?.bound === true)
    if (bound?.hostId) hostId = String(bound.hostId)
    return rpcOk({ rows, boundHostId: hostId })
  }

  /**
   * 切换主机。`confirmNoMigration` 必须显式 true（同主机 no-op 除外）。
   * 成功后无论是否 drift 都要求重建视图；drift 时额外发 upgrade-required 且
   * 禁止索引合并（canMergeIndex 对任何 hostId 都返回 false，直到下一次匹配基线）。
   */
  const selectHost = async ({ hostId: targetId, confirmNoMigration = false } = {}) => {
    const target = String(targetId ?? '').trim()
    if (!target) return rpcError(SWITCH_ERR.INVALID_ARGUMENT, '缺少 hostId')
    const noop = hostId !== null && target === hostId
    if (!noop && confirmNoMigration !== true) {
      // 本地强制点：不发网络请求（TC-4.2）。字符串 'true' / 1 / 缺省一律不算确认。
      return rpcError(
        SWITCH_ERR.CONFIRM_REQUIRED,
        '切换主机必须显式 confirmNoMigration:true（不会带走会话、文件与插件）',
      )
    }
    const r = await request('/api/hosts/select', {
      method: 'POST',
      body: { hostId: target, ...(confirmNoMigration === true ? { confirmNoMigration: true } : {}) },
    })
    if (!r.ok) {
      if (r.error.code === SWITCH_ERR.HOST_MISMATCH) notify({ type: 'host-mismatch', hostId })
      return r
    }
    const profile = r.data ?? {}
    from = profile.from ?? from
    hostId = String(profile.hostId ?? target)
    kind = profile.kind ?? null
    online = profile.online ?? null
    lastSelectAt = Date.now()

    // 04 §6⑦：dshCommit 与 pin 基线不一致 → 索引不合并、只提示升级。
    // 未配置 pinned 时不启用比对（与 r16 服务端「空串 = 不启用」同口径）。
    const declared = String(profile.dshCommit ?? '').trim()
    drift = Boolean(pinned && declared && declared !== pinned)
    const switched = profile.switched !== false && !noop
    if (switched) viewEpoch++

    notify({
      type: 'host-changed',
      from, hostId, switched, drift,
      notice: profile.notice ?? '切换主机不会带走会话、文件与插件',
    })
    if (drift) {
      notify({ type: 'upgrade-required', hostId, declared, pinnedDshCommit: pinned })
    }
    try {
      onHostChanged?.({
        from, hostId, switched, drift, profile,
        // App 壳必须执行的三个动作（S-6.9 / TC-4.3 / R-22）：
        clearView: switched,
        resetCookieJar: switched,
        rebuildIndex: switched && !drift,
        indexMerged: switched && !drift,
        viewEpoch,
      })
    } catch { /* 回调异常不影响切换结果 */ }
    return rpcOk(profile, {
      switched, drift, indexMerged: switched && !drift, viewEpoch,
    })
  }

  /**
   * 索引合并闸门（TC-1.11 / TC-4.3）：只允许合并「当前执行位置」的索引；
   * drift 期间一律拒绝，避免把基线不符的主机数据并进视图。
   */
  const canMergeIndex = (candidateHostId) =>
    !drift && hostId !== null && String(candidateHostId ?? '') === hostId

  /** 顶部执行位置常驻（TC-4.6）：App 直接读这里画状态条。 */
  const snapshot = () => ({
    hostId, from, kind, online, drift, viewEpoch, lastSelectAt,
    pinnedDshCommit: pinned || null,
    indexMerged: !drift && hostId !== null,
  })

  return { listHosts, selectHost, canMergeIndex, snapshot }
}
