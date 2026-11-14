/**
 * p1/client-core · CP REST 会话写操作（r22 / 命名迁移第四步客户端落地）
 * ---------------------------------------------------------------
 * r21 服务端已落地规格形态 `PATCH|DELETE /api/sessions/:hostId/:id`（路径优先，
 * 旧单段形态兼容期保留），但当时**没有客户端真正使用它**。本模块是手机壳协议包
 * 里的正主：所有会话写操作一律走两段路径，`hostId` 从构造参数或 `setHostId()`
 * 取得（切换器重绑后由 App 壳同步过来），不再把 hostId 塞进 body/query。
 *
 * 与 `host-switch.js` 同属**控制面**（CP REST `/api/*`），与 `DshCarrier` 的
 * **数据面**（`/d/<hostId>/*`）严格分开；响应解包复用 carrier 的
 * `rpcFromResponse`（405/403/401/409 语义两边一致），错误码不另起一套。
 *
 * 铁律：
 *   1. `hostId` 只从路径段传，路径优先；切换后必须 `setHostId()` 更新，
 *      否则携带旧 hostId 的请求会被服务端按 r19 判 409 `HOST_MISMATCH`。
 *   2. `DELETE` 是**归档别名**（软移除，日志一行不动），语义与 `PATCH {archived:true}`
 *      等价——不真删（r12 / 04 §4）。
 *   3. 一次只做一件事：`pinned` / `archived` / `title` 不能同时给（服务端 400
 *      INVALID_JSON 的同款约束，客户端先拦，省一次往返）。
 *   4. 令牌只进 `Authorization` 头，不进 URL 与 body。
 */

import { rpcError, rpcFromResponse } from './carrier.js'

export const SESSION_WRITE_ERR = Object.freeze({
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  CONFLICTING_INTENTS: 'INVALID_JSON',
  UNAUTHORIZED: 'UNAUTHORIZED',
  NETWORK: 'NETWORK',
})

/**
 * @param {object} opts
 * @param {string} opts.baseUrl          Relay / CP 根地址
 * @param {string} opts.hostId           当前执行位置（切换后由 setHostId 更新）
 * @param {string} opts.deviceToken      手机令牌
 * @param {Function} [opts.fetchImpl]   可注入 fetch
 */
export function createSessionWrites({
  baseUrl,
  hostId,
  deviceToken,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!baseUrl) throw new TypeError('createSessionWrites 需要 baseUrl')
  if (!hostId) throw new TypeError('createSessionWrites 需要 hostId（当前执行位置）')
  if (!deviceToken) throw new TypeError('createSessionWrites 需要 deviceToken')
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl 必须是函数')
  const base = String(baseUrl).replace(/\/$/, '')
  let currentHostId = String(hostId)

  const headers = () => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${deviceToken}`,
  })

  /** 规格形态：`/api/sessions/<hostId>/<sessionId>`（r21 起服务端路径优先）。 */
  const pathOf = (sessionId) =>
    `/api/sessions/${encodeURIComponent(currentHostId)}/${encodeURIComponent(sessionId)}`

  const request = async (path, { method = 'GET', body } = {}) => {
    let res
    try {
      res = await fetchImpl(`${base}${path}`, {
        method,
        headers: headers(),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    } catch (error) {
      return rpcError(SESSION_WRITE_ERR.NETWORK, String(error?.message ?? error), { retryable: true })
    }
    return rpcFromResponse(res, path)
  }

  /** 切换成功后由 App 壳同步执行位置（与 createHostSwitcher 的 onHostChanged 对接）。 */
  const setHostId = (next) => {
    const value = String(next ?? '').trim()
    if (!value) throw new TypeError('setHostId 需要非空 hostId')
    currentHostId = value
    return currentHostId
  }

  /** 会话列表（正式参数名 hostId=，r17）。 */
  const listSessions = ({ pinned = null, archived = false } = {}) => {
    const q = new URLSearchParams({ hostId: currentHostId, archived: String(archived) })
    if (pinned !== null) q.set('pinned', String(pinned))
    return request(`/api/sessions?${q}`)
  }

  /**
   * 置顶 / 归档 / 改名三选一。校验与服务端 04 §4 同款：一次只做一件事。
   * `archived` 允许 false（恢复），`pinned` 允许 false（取消置顶）。
   */
  const patchSession = async (sessionId, patch = {}) => {
    if (!sessionId) return rpcError(SESSION_WRITE_ERR.INVALID_ARGUMENT, '缺少 sessionId')
    const wantPin = patch.pinned === true || patch.pinned === false
    const wantArchive = patch.archived === true || patch.archived === false
    const wantRename = typeof patch.title === 'string' && patch.title.trim().length > 0
    const intents = [wantPin, wantArchive, wantRename].filter(Boolean).length
    if (intents === 0) {
      return rpcError(SESSION_WRITE_ERR.INVALID_ARGUMENT, '需要 { pinned } / { archived } / { title } 之一')
    }
    if (intents > 1) {
      return rpcError(SESSION_WRITE_ERR.CONFLICTING_INTENTS, '一次只做一件事：pinned / archived / title 不能同时给')
    }
    const body = wantRename
      ? { title: patch.title.trim() }
      : wantArchive ? { archived: patch.archived } : { pinned: patch.pinned }
    return request(pathOf(sessionId), { method: 'PATCH', body })
  }

  /** 归档别名（r12）：DELETE 强制 archived=true，不真删落盘日志。 */
  const archiveSession = (sessionId) => {
    if (!sessionId) return rpcError(SESSION_WRITE_ERR.INVALID_ARGUMENT, '缺少 sessionId')
    return request(pathOf(sessionId), { method: 'DELETE' })
  }

  return {
    listSessions, patchSession, archiveSession, setHostId,
    getHostId: () => currentHostId,
    pathOf,
  }
}
