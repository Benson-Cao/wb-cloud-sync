/**
 * P1 W3 · 控制面（CP）元数据存储
 * ---------------------------------------------------------------
 * 为什么要有这一层：Relay 原本把设备表、会话索引、消费位点全揣在进程内存里，
 * 于是「重启即失忆」「多实例各自为政」。协议 §2 把这几张表定义在 CP（Postgres）上，
 * Relay 只做转发。本文件是**单机期的实现**：内存表 + 可选的文件落盘（`persist.js`），
 * 接口按 Postgres 表 1:1 设计，P2 换成真库时替换实现、不动调用方。
 *
 * 落盘只覆盖**设备与会话索引**（重启后配对不掉是硬需求）；租约与位点故意仍在内存里，
 * 理由见 `persist.js` 与协议 §2 的说明。
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
/** 一台 Host 最多绑定几台手机（r9）。上限的意义不是容量而是收敛：列表页要能一眼看完。 */
export const MAX_PHONES_PER_HOST = 8
/** 墓碑保留多久（与 docs/10 运维口径一致：30 天前已吊销的设备加载时清理）。 */
export const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000
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
  maxPhonesPerHost = MAX_PHONES_PER_HOST,
  tombstoneTtlMs = TOMBSTONE_TTL_MS,
  newId = () => randomUUID(),
  // 可选落盘：传 createFileStore(...) 的结果即可。不传 = 纯内存（测试 / 单机试跑）
  persist = null,
} = {}) {
  const devices = new Map()     // deviceId -> Device（Host 与手机各占一行，用 role 区分）
  const sessions = new Map()    // sessionId -> SessionIndex
  const leases = new Map()      // sessionId -> RouteLease
  const cursors = new Map()     // `${clientId}|${sessionId}` -> Cursor

  /* ------------------------------------------------------------ 落盘 */

  /**
   * 只存**事实**：设备（含令牌摘要）与会话索引。
   * 租约（TTL 30s）与消费位点（客户端 sinceSeq 才是权威，协议 #5b）故意不存 ——
   * 把它们写进磁盘只会制造「服务端记录比手机更权威」的错觉。
   */
  const snapshot = () => ({
    devices: [...devices.values()].map(cloneDevice),
    sessions: [...sessions.values()].map(cloneSession),
  })

  /** 每次改了事实就排一次写；去抖在 store 里做，这里不管频率。 */
  const touch = () => { persist?.save?.(snapshot) }

  /**
   * 从快照恢复。三条判断都写死在这儿，免得以后「顺手放宽」：
   *   1. **一律按离线起身**——重启那一刻谁也不在线，`lastSeenAt` 落在 45s 窗口内
   *      也不该报 online，否则手机会在电脑其实没连的情况下拿到「在线」。
   *   2. 墓碑只留 30 天。久到没人记得的设备留着只会让 `listDevices` 越来越长。
   *   3. 会话与手机的归属设备不存在（或已吊销）就丢掉，不留幽灵行。
   */
  const hydrate = (snap) => {
    const result = { devices: 0, sessions: 0, droppedDevices: 0, droppedSessions: 0 }
    if (!snap || typeof snap !== 'object') return result
    const t = now()
    for (const raw of Array.isArray(snap.devices) ? snap.devices : []) {
      const id = typeof raw?.deviceId === 'string' ? raw.deviceId : null
      if (!id) continue
      const tombstone = raw.tombstone === true
      if (tombstone && t - num(raw.lastSeenAt, 0) > tombstoneTtlMs) { result.droppedDevices++; continue }
      devices.set(id, {
        deviceId: id,
        role: raw.role === 'phone' ? 'phone' : 'host',
        boundHostId: typeof raw.boundHostId === 'string' ? raw.boundHostId : null,
        accountId: raw.accountId ?? null,
        deviceName: raw.deviceName ?? null,
        platform: raw.platform ?? null,
        capabilities: Array.isArray(raw.capabilities) ? [...raw.capabilities] : [],
        tokenDigest: typeof raw.tokenDigest === 'string' ? raw.tokenDigest : null,
        allowMobile: raw.allowMobile !== false,
        state: 'offline',
        lastSeenAt: num(raw.lastSeenAt, t),
        tombstone,
      })
      result.devices++
    }
    // 宿主没了/被吊销，它名下的手机也跟着作废：光留一行手机，鉴权时又会被 Host 检查挡回去
    for (const [id, row] of devices) {
      if (row.role !== 'phone') continue
      const host = devices.get(row.boundHostId)
      if (host && !host.tombstone) continue
      devices.delete(id)
      result.droppedDevices++
    }
    for (const raw of Array.isArray(snap.sessions) ? snap.sessions : []) {
      const id = typeof raw?.sessionId === 'string' ? raw.sessionId : null
      const owner = typeof raw?.ownerDeviceId === 'string' ? raw.ownerDeviceId : null
      if (!id || !owner) continue
      const host = devices.get(owner)
      if (!host || host.tombstone) { result.droppedSessions++; continue }
      sessions.set(id, {
        sessionId: id,
        accountId: raw.accountId ?? null,
        ownerDeviceId: owner,
        workspace: raw.workspace ?? null,
        title: raw.title ?? null,
        pinned: raw.pinned === true,
        pinnedOrder: num(raw.pinnedOrder, 0) ?? 0,
        state: SESSION_STATES.includes(raw.state) ? raw.state : 'stopped',
        lastSeq: num(raw.lastSeq),
        lastActiveAt: num(raw.lastActiveAt),
        headerRef: raw.headerRef ? { ...raw.headerRef } : null,
        updatedAt: num(raw.updatedAt, t),
      })
      result.sessions++
    }
    return result
  }

  /* ------------------------------------------------------------ Device */

  const getDevice = (deviceId) => cloneDevice(devices.get(deviceId))

  const upsertDevice = (input = {}) => {
    const deviceId = input.deviceId
    if (!deviceId) throw new ControlPlaneError('UNAUTHORIZED', '缺少 deviceId')
    const prev = devices.get(deviceId)
    if (prev?.tombstone) throw new ControlPlaneError('UNAUTHORIZED', '设备已吊销')
    const row = {
      deviceId,
      // role/boundHostId 一经创建不随注册报文改变：任何 Host 都能发 host/register，
      // 若让它改这两列，就等于允许别人把一台手机「改挂」到自己名下。
      role: prev?.role ?? input.role ?? 'host',
      boundHostId: prev?.boundHostId ?? input.boundHostId ?? null,
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
    touch()
    return cloneDevice(row)
  }

  /** 配对成功后由 Relay 写入：只存摘要，绝不存明文令牌。 */
  const setDeviceToken = (deviceId, deviceToken) => {
    const row = devices.get(deviceId)
    if (!row || row.tombstone) throw new ControlPlaneError('UNAUTHORIZED', '设备不存在或已吊销')
    row.tokenDigest = sha256Hex(deviceToken)
    touch()
    return cloneDevice(row)
  }

  const verifyDeviceToken = (deviceId, deviceToken) => {
    const row = devices.get(deviceId)
    if (!row || row.tombstone || !row.tokenDigest || !deviceToken) return false
    return safeEqualHex(sha256Hex(deviceToken), row.tokenDigest)
  }

  /* ------------------------------------------------- Phone（r9 新增） */

  /**
   * 手机是**独立的设备行**，`boundHostId` 指向它配对的那台 Host。
   *
   * 为什么不是「Host 行上挂一串令牌」：那样一台手机重配就会把另一台的令牌一起顶掉，
   * 或者反过来——为了不互相顶掉就得允许并存，而并存意味着重配不再作废旧令牌，
   * 丢了手机只能全部重来。分开存之后两件事同时成立：
   *   - 两台手机互不影响（各有一行、各有一枚令牌）；
   *   - 同一台手机重配（同 phoneId）只作废它自己那枚令牌。
   * 手机的 deviceId 由客户端生成并长期持有，所以「重配」在服务端就是同 id 覆盖。
   */
  const listPhones = (hostId) => [...devices.values()]
    .filter((d) => d.role === 'phone' && d.boundHostId === hostId && !d.tombstone)
    .map(cloneDevice)

  const upsertPhone = ({ phoneId, hostId, label = null } = {}) => {
    if (!phoneId || !hostId) throw new ControlPlaneError('UNAUTHORIZED', '缺少 phoneId / hostId')
    const host = devices.get(hostId)
    if (!host || host.tombstone) {
      throw new ControlPlaneError('HOST_OFFLINE', '目标 Host 未注册或已吊销', { retryable: true })
    }
    const prev = devices.get(phoneId)
    if (prev) {
      // **墓碑不是黑名单**：收回手机挡的是「拿着旧令牌自己连回来」，不是「主人重新接纳它」。
      // 配对码是 PC 主人在设备上亲手生成的授权动作，拿合法码回来就该允许重新配对；
      // 令牌在收回时已被清空，重配只会拿到新令牌，旧令牌依旧不可用。
      // （Host 那条路不同：`host/register` 不带任何人工动作，所以那边仍然拒绝墓碑复活。）
      // 同一个 phoneId 也不能改挂到别的 Host——否则拿着旧身份就能蹭进另一台电脑。
      if (prev.role !== 'phone' || prev.boundHostId !== hostId) {
        throw new ControlPlaneError('UNAUTHORIZED', '设备身份与绑定关系不一致')
      }
    } else {
      const bound = listPhones(hostId).length
      if (bound >= maxPhonesPerHost) {
        throw new ControlPlaneError('CLIENT_LIMIT', `该设备最多绑定 ${maxPhonesPerHost} 台手机`)
      }
    }
    const row = {
      deviceId: phoneId,
      role: 'phone',
      boundHostId: hostId,
      accountId: host.accountId ?? null,
      deviceName: label ?? prev?.deviceName ?? null,
      platform: prev?.platform ?? 'mobile',
      capabilities: prev?.capabilities ?? [],
      tokenDigest: prev?.tokenDigest ?? null,
      allowMobile: true,
      state: 'online',
      lastSeenAt: now(),
      tombstone: false,
    }
    devices.set(phoneId, row)
    touch()
    return cloneDevice(row)
  }

  /** 写手机令牌：同 phoneId 覆盖 = 这台手机重配，旧令牌立即失效（TC-5.6 语义保留）。 */
  const setPhoneToken = (phoneId, deviceToken) => {
    const row = devices.get(phoneId)
    if (!row || row.role !== 'phone' || row.tombstone) {
      throw new ControlPlaneError('UNAUTHORIZED', '手机不存在或已吊销')
    }
    row.tokenDigest = sha256Hex(deviceToken)
    touch()
    return cloneDevice(row)
  }

  /**
   * 手机侧鉴权：URL 里的 `deviceId` 是**目标 Host**，令牌却属于某台手机。
   * 返回命中的手机身份（clientId）供位点与日志使用；`legacy` 表示令牌直接落在这台
   * Host 行上（r9 之前配对的手机），仍然放行——否则升级一次全体手机掉线。
   */
  const verifyClientToken = (hostId, deviceToken) => {
    const deny = { ok: false, clientId: null, legacy: false }
    if (!hostId || !deviceToken) return deny
    const host = devices.get(hostId)
    if (!host || host.tombstone) return deny
    const digest = sha256Hex(deviceToken)
    if (host.tokenDigest && safeEqualHex(digest, host.tokenDigest)) {
      return { ok: true, clientId: null, legacy: true }
    }
    const t = now()
    for (const row of devices.values()) {
      if (row.role !== 'phone' || row.tombstone || row.boundHostId !== hostId || !row.tokenDigest) continue
      if (!safeEqualHex(digest, row.tokenDigest)) continue
      row.lastSeenAt = t
      row.state = 'online'
      return { ok: true, clientId: row.deviceId, legacy: false }
    }
    return deny
  }

  /** 单独收回一台手机：Host 与其它手机不受影响。 */
  const revokePhone = (phoneId) => {
    const row = devices.get(phoneId)
    if (!row || row.role !== 'phone') return null
    row.tombstone = true
    row.tokenDigest = null
    row.state = 'offline'
    touch()
    return cloneDevice(row)
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
    if (row.role === 'phone') return revokePhone(deviceId)
    row.tombstone = true
    row.state = 'offline'
    row.tokenDigest = null
    // 吊销 Host 等于收回它名下所有手机：留着手机行只会让「已吊销」变成半句话
    for (const phone of devices.values()) {
      if (phone.role === 'phone' && phone.boundHostId === deviceId) {
        phone.tombstone = true
        phone.tokenDigest = null
        phone.state = 'offline'
      }
    }
    // 吊销设备时把它名下的会话与租约一并清掉，避免手机端看见幽灵会话
    for (const [id, s] of sessions) if (s.ownerDeviceId === deviceId) sessions.delete(id)
    for (const [id, l] of leases) if (l.deviceId === deviceId) leases.delete(id)
    touch()
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
    touch()
    return { upserted: 1, removed: 0 }
  }

  /**
   * 应用增量索引：只 upsert 给定行、只删给定 id，**绝不做全量替换**。
   * Host 侧每 60s 只发变化的行；CP 里未提及的会话必须保留。
   */
  const applySessionDiff = (ownerDeviceId, rows = [], removedIds = []) => {
    if (!ownerDeviceId) throw new ControlPlaneError('UNAUTHORIZED', '缺少 ownerDeviceId')
    let upserted = 0
    for (const raw of Array.isArray(rows) ? rows : []) {
      if (!raw?.sessionId) continue
      putSession(ownerDeviceId, raw)
      upserted++
    }
    let removed = 0
    for (const id of Array.isArray(removedIds) ? removedIds : []) {
      const row = sessions.get(id)
      if (row && row.ownerDeviceId === ownerDeviceId) { sessions.delete(id); removed++ }
    }
    if (removed) touch()          // 只删不改时 putSession 没被调到，这里补一次
    return { upserted, removed }
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
    if (removed) touch()
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
    touch()
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

  /**
   * 建好之后立刻从磁盘恢复一次：这一步之后，`verifyClientToken` 就能认出上一进程
   * 发出去的令牌，手机不必因为运维重启而重新配对。
   */
  const restored = persist ? hydrate(persist.load?.() ?? null) : null

  return {
    // device
    getDevice, upsertDevice, setDeviceToken, verifyDeviceToken, heartbeatDevice,
    markDeviceOffline, revokeDevice, isDeviceAlive, listDevices,
    // phone（r9）
    upsertPhone, setPhoneToken, verifyClientToken, revokePhone, listPhones,
    // session index
    putSession, applySessionDiff, upsertSessions, getSession, listSessions, patchSession,
    // lease
    sweepExpired, getLease, acquireLease, renewLease, releaseLease, listLeases,
    // cursor
    putCursor, getCursor, listCursors,
    stats,
    // 落盘（有 persist 才有意义；没有也返回安全的空实现）
    snapshot,
    hydrate,
    restoredSnapshot: restored,
    flush: () => (persist?.flush ? persist.flush() : true),
    config: { leaseTtlMs, offlineAfterMs },
  }
}
