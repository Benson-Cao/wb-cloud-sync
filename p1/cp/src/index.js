/**
 * P1 W3 · 控制面（CP）元数据存储
 * ---------------------------------------------------------------
 * 为什么要有这一层：Relay 原本把设备表、会话索引、消费位点全揣在进程内存里，
 * 于是「重启即失忆」「多实例各自为政」。协议 §2 把这几张表定义在 CP（Postgres）上，
 * Relay 只做转发。本文件是**单机开发期的内存实现**，接口按 Postgres 表 1:1 设计，
 * P2 换成真库时替换实现、不动调用方。
 *
 * 四张表（字段与 PROTOCOL.md §2 一致）：
 *   Device       设备注册表（令牌只存 SHA-256 摘要、吊销用墓碑防复活）
 *   SessionIndex 会话索引（**不含事件正文**，ADR-010）
 *   RouteLease   写句柄租约（一会话一写者，过期自动释放）
 *   Cursor       客户端消费位点（每 client × session 一行）
 *
 * 两条容易踩的语义，明确写死在这里：
 *   1. Host 上报的索引是**该设备的全量快照**：本轮没出现的会话要从索引里移除，
 *      否则删掉的会话会永远挂在手机上。
 *   2. `pinned / pinnedOrder` 是 **PC 侧状态**，Host 报文里恒为 false/0。
 *      upsert 时**不覆盖**已有值，否则每次刷新都会把用户置顶的会话打回原位。
 */
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'

export const LEASE_TTL_MS = 30_000
export const DEVICE_OFFLINE_MS = 45_000
export const SESSION_STATES = ['running', 'awaiting', 'completed', 'stopped', 'failed', 'unreadable']

export class ControlPlaneError extends Error {
  constructor(code, message, { retryable = false } = {}) {
    super(message)
    this.name = 'ControlPlaneError'
    this.code = code
    this.retryable = retryable
  }
}

export const sha256Hex = (text) => createHash('sha256').update(String(text)).digest('hex')

const safeEqualHex = (a, b) => {
  const x = Buffer.from(String(a), 'hex')
  const y = Buffer.from(String(b), 'hex')
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y)
}

const num = (v, fallback = null) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)

const cloneDevice = (row) => (row
  ? { ...row, capabilities: [...(row.capabilities ?? [])] }
  : null)
const cloneSession = (row) => (row
  ? { ...row, headerRef: row.headerRef ? { ...row.headerRef } : null }
  : null)

export function createControlPlane({
  now = () => Date.now(),
  leaseTtlMs = LEASE_TTL_MS,
  offlineAfterMs = DEVICE_OFFLINE_MS,
  newId = () => randomUUID(),
} = {}) {
  const devices = new Map()     // deviceId -> Device
  const sessions = new Map()    // sessionId -> SessionIndex
  const leases = new Map()      // sessionId -> RouteLease
  const cursors = new Map()     // `${clientId}|${sessionId}` -> Cursor

  /* ------------------------------------------------------------ Device */

  const getDevice = (deviceId) => cloneDevice(devices.get(deviceId))

  const upsertDevice = (input = {}) => {
    const deviceId = input.deviceId
    if (!deviceId) throw new ControlPlaneError('UNAUTHORIZED', '缺少 deviceId')
    const prev = devices.get(deviceId)
    if (prev?.tombstone) throw new ControlPlaneError('UNAUTHORIZED', '设备已吊销')
    const row = {
      deviceId,
      accountId: input.accountId ?? prev?.accountId ?? null,
      deviceName: input.deviceName ?? prev?.deviceName ?? null,
      platform: input.platform ?? prev?.platform ?? null,
      capabilities: input.capabilities ?? prev?.capabilities ?? [],
      // 令牌摘要只由 pair/verify 写入；注册时不许改，否则任何 Host 都能顶掉别人的令牌
      tokenDigest: prev?.tokenDigest ?? null,
      allowMobile: input.allowMobile ?? prev?.allowMobile ?? true,
      state: input.state ?? prev?.state ?? 'offline',
      lastSeenAt: num(input.lastSeenAt, now()),
      tombstone: false,
    }
    devices.set(deviceId, row)
    return cloneDevice(row)
  }

  /** 配对成功后由 Relay 写入：只存摘要，绝不存明文令牌。 */
  const setDeviceToken = (deviceId, deviceToken) => {
    const row = devices.get(deviceId)
    if (!row || row.tombstone) throw new ControlPlaneError('UNAUTHORIZED', '设备不存在或已吊销')
    row.tokenDigest = sha256Hex(deviceToken)
    return cloneDevice(row)
  }

  const verifyDeviceToken = (deviceId, deviceToken) => {
    const row = devices.get(deviceId)
    if (!row || row.tombstone || !row.tokenDigest || !deviceToken) return false
    return safeEqualHex(sha256Hex(deviceToken), row.tokenDigest)
  }

  const heartbeatDevice = (deviceId, ts = now()) => {
    const row = devices.get(deviceId)
    if (!row || row.tombstone) throw new ControlPlaneError('HOST_OFFLINE', '设备未注册或已吊销', { retryable: true })
    row.lastSeenAt = ts
    row.state = 'online'
    return cloneDevice(row)
  }

  /** 传输层（WS 关闭）调用：立刻标离线，不等 45s 心跳窗口。 */
  const markDeviceOffline = (deviceId) => {
    const row = devices.get(deviceId)
    if (!row) return null
    row.state = 'offline'
    return cloneDevice(row)
  }

  const revokeDevice = (deviceId) => {
    const row = devices.get(deviceId)
    if (!row) return null
    row.tombstone = true
    row.state = 'offline'
    row.tokenDigest = null
    // 吊销设备时把它名下的会话与租约一并清掉，避免手机端看见幽灵会话
    for (const [id, s] of sessions) if (s.ownerDeviceId === deviceId) sessions.delete(id)
    for (const [id, l] of leases) if (l.deviceId === deviceId) leases.delete(id)
    return cloneDevice(row)
  }

  /** 心跳超时判定：HTTP 心跳设备按时间窗；WS 在线由传输层另行覆盖。 */
  const isDeviceAlive = (deviceId, ts = now()) => {
    const row = devices.get(deviceId)
    if (!row || row.tombstone || row.state === 'offline') return false
    return ts - row.lastSeenAt <= offlineAfterMs
  }

  const listDevices = () => [...devices.values()].map(cloneDevice)

  /* ------------------------------------------------------ SessionIndex */

  /**
   * 单行合并写入：只 upsert 一行，**绝不删除同设备其他会话**。
   * 真机 0.1.5 取证：新建会话成功后 Relay 只拿到一行引导值，若走全量的
   * `upsertSessions` 会把该设备其余会话全移除，直到 Host 下一次 60s 全量
   * 上报才恢复——手机列表会「闪一下只剩新会话」。
   */
  const putSession = (ownerDeviceId, raw) => {
    if (!ownerDeviceId) throw new ControlPlaneError('UNAUTHORIZED', '缺少 ownerDeviceId')
    if (!raw?.sessionId) return { upserted: 0, removed: 0 }
    const prev = sessions.get(raw.sessionId)
    sessions.set(raw.sessionId, {
      sessionId: raw.sessionId,
      accountId: raw.accountId ?? prev?.accountId ?? null,
      ownerDeviceId,
      workspace: raw.workspace ?? null,
      title: raw.title ?? prev?.title ?? null,
      // PC 侧状态优先：Host 报文里的 false/0 不能覆盖用户置顶
      pinned: prev?.pinned ?? Boolean(raw.pinned),
      pinnedOrder: prev?.pinnedOrder ?? (num(raw.pinnedOrder, 0) ?? 0),
      state: SESSION_STATES.includes(raw.state) ? raw.state : 'stopped',
      lastSeq: num(raw.lastSeq),
      lastActiveAt: num(raw.lastActiveAt),
      headerRef: raw.headerRef ? { ...raw.headerRef } : null,
      updatedAt: now(),
    })
    return { upserted: 1, removed: 0 }
  }

  /**
   * 写入某台 Host 的会话索引快照（全量；本轮未出现的会话会被移除）。
   * @returns { upserted, removed }
   */
  const upsertSessions = (ownerDeviceId, rows = []) => {
    if (!ownerDeviceId) throw new ControlPlaneError('UNAUTHORIZED', '缺少 ownerDeviceId')
    const seen = new Set()
    let upserted = 0
    for (const raw of Array.isArray(rows) ? rows : []) {
      if (!raw?.sessionId) continue
      seen.add(raw.sessionId)
      upserted += putSession(ownerDeviceId, raw).upserted
    }
    let removed = 0
    for (const [id, row] of sessions) {
      if (row.ownerDeviceId === ownerDeviceId && !seen.has(id)) {
        sessions.delete(id)
        removed++
      }
    }
    return { upserted, removed }
  }

  const getSession = (sessionId) => cloneSession(sessions.get(sessionId))

  const listSessions = ({ ownerDeviceId = null, pinned = null, accountId = null } = {}) =>
    [...sessions.values()]
      .filter((s) => (ownerDeviceId === null || s.ownerDeviceId === ownerDeviceId))
      .filter((s) => (accountId === null || s.accountId === accountId))
      .filter((s) => (pinned === null || s.pinned === Boolean(pinned)))
      .sort((a, b) => (Number(b.pinned) - Number(a.pinned))
        || (a.pinnedOrder - b.pinnedOrder)
        || ((b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0)))
      .map(cloneSession)

  /** 置顶 / 调序 / 状态修正：只有 PC 侧该调这个，手机端只读（协议 §4 约束）。 */
  const patchSession = (sessionId, patch = {}) => {
    const row = sessions.get(sessionId)
    if (!row) return null
    if (patch.pinned !== undefined) row.pinned = Boolean(patch.pinned)
    if (patch.pinnedOrder !== undefined) row.pinnedOrder = num(patch.pinnedOrder, row.pinnedOrder)
    if (patch.title !== undefined) row.title = patch.title
    if (SESSION_STATES.includes(patch.state)) row.state = patch.state
    row.updatedAt = now()
    return cloneSession(row)
  }

  /* -------------------------------------------------------- RouteLease */

  const sweepExpired = (ts = now()) => {
    let released = 0
    for (const [id, lease] of leases) {
      if (lease.expiresAt <= ts) { leases.delete(id); released++ }
    }
    return released
  }

  const getLease = (sessionId, ts = now()) => {
    const lease = leases.get(sessionId)
    if (!lease) return null
    if (lease.expiresAt <= ts) { leases.delete(sessionId); return null }
    return { ...lease }
  }

  /**
   * 申请写句柄。同设备重复申请是幂等的（续租），别家持有则 `ROUTE_CONFLICT`。
   * 注意：这里管的是**跨 Host 路由归属**，会话内的单写者仍由宿主
   * `SessionAlreadyOwnedError` 兜底（ADR-008）。
   */
  const acquireLease = ({ sessionId, deviceId, clientId = null }, ts = now()) => {
    if (!sessionId || !deviceId) throw new ControlPlaneError('UNAUTHORIZED', '缺少 sessionId / deviceId')
    const current = getLease(sessionId, ts)
    if (current && current.deviceId !== deviceId) {
      throw new ControlPlaneError('ROUTE_CONFLICT', `会话写句柄由 ${current.deviceId} 持有`)
    }
    if (current) {
      current.expiresAt = ts + leaseTtlMs
      if (clientId) current.clientId = clientId
      leases.set(sessionId, current)
      return { ...current, renewed: true }
    }
    const lease = {
      sessionId, deviceId, leaseId: newId(), clientId, acquiredAt: ts, expiresAt: ts + leaseTtlMs,
    }
    leases.set(sessionId, lease)
    return { ...lease, renewed: false }
  }

  const renewLease = ({ sessionId, leaseId }, ts = now()) => {
    const lease = getLease(sessionId, ts)
    if (!lease) throw new ControlPlaneError('SESSION_BUSY', '租约不存在或已过期', { retryable: true })
    if (lease.leaseId !== leaseId) throw new ControlPlaneError('SESSION_BUSY', '租约 ID 不匹配', { retryable: true })
    lease.expiresAt = ts + leaseTtlMs
    leases.set(sessionId, lease)
    return { ...lease }
  }

  const releaseLease = ({ sessionId, leaseId = null, deviceId = null }, ts = now()) => {
    const lease = getLease(sessionId, ts)
    if (!lease) return { released: false, reason: 'NOT_FOUND' }
    if (leaseId && lease.leaseId !== leaseId) return { released: false, reason: 'LEASE_MISMATCH' }
    if (!leaseId && deviceId && lease.deviceId !== deviceId) return { released: false, reason: 'OWNER_MISMATCH' }
    leases.delete(sessionId)
    return { released: true }
  }

  const listLeases = (ts = now()) => {
    sweepExpired(ts)
    return [...leases.values()].map((l) => ({ ...l }))
  }

  /* ------------------------------------------------------------ Cursor */

  const putCursor = ({ clientId, sessionId, sinceSeq }) => {
    if (!clientId || !sessionId) throw new ControlPlaneError('UNAUTHORIZED', '缺少 clientId / sessionId')
    const key = `${clientId}|${sessionId}`
    const row = { clientId, sessionId, sinceSeq: num(sinceSeq, 0), updatedAt: now() }
    cursors.set(key, row)
    return { ...row }
  }

  const getCursor = ({ clientId, sessionId }) => {
    const row = cursors.get(`${clientId}|${sessionId}`)
    return row ? { ...row } : null
  }

  const listCursors = ({ clientId } = {}) => [...cursors.values()]
    .filter((c) => clientId === undefined || c.clientId === clientId)
    .map((c) => ({ ...c }))

  const stats = () => ({
    devices: devices.size,
    sessions: sessions.size,
    leases: leases.size,
    cursors: cursors.size,
  })

  return {
    // device
    getDevice, upsertDevice, setDeviceToken, verifyDeviceToken, heartbeatDevice,
    markDeviceOffline, revokeDevice, isDeviceAlive, listDevices,
    // session index
    putSession, upsertSessions, getSession, listSessions, patchSession,
    // lease
    sweepExpired, getLease, acquireLease, renewLease, releaseLease, listLeases,
    // cursor
    putCursor, getCursor, listCursors,
    stats,
    config: { leaseTtlMs, offlineAfterMs },
  }
}
