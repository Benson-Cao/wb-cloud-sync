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

/**
 * v2.3（S-8.5 / B3 TOFU）：设备公钥指纹只认 SHA-256 hex（64 位）。
 * 格式不符一律当作「未携带」而不是报错——旧客户端不带这个字段仍要能配对，
 * 也不能让随机字符串变成探测钉住值的手段。
 */
const normalizeDeviceKey = (v) => (
  typeof v === 'string' && /^[A-Fa-f0-9]{64}$/.test(v) ? v.toLowerCase() : null
)

const cloneDevice = (row) => (row
  ? { ...row, capabilities: [...(row.capabilities ?? [])] }
  : null)
const cloneSession = (row) => (row
  ? { ...row, headerRef: row.headerRef ? { ...row.headerRef } : null }
  : null)

/**
 * v2.3（S-2.2）：会话 / 租约 / 位点的键全部带 host 维度——(hostId, sessionId)
 * 命名空间隔离（04 §2），同名 sessionId 在两台主机下可共存。
 * 这是 R-22「串会话」的数据层防线：没有 host 维度的键，两台主机的同名会话
 * 会在第一台写入时被另一台覆盖。hostId 现阶段取值 = 主机设备行 id
 * （值兼容，字段改名随 CP Postgres 迁移）；行内 ownerDeviceId 字段保留不变
 * （落盘格式与手机端响应体不动）。
 */
const sessionKey = (hostId, sessionId) => `${hostId}|${sessionId}`
const cursorKey = (clientId, hostId, sessionId) => `${clientId}|${hostId}|${sessionId}`

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
        hostId: typeof raw.hostId === 'string' ? raw.hostId : null,
        // v2.3（r24 / S-8.5）：钉住的设备公钥指纹必须随落盘恢复，
        // 否则进程重启后指纹守卫被静默清空（r15 白名单教训的同类缺陷）。
        devicePubKey: typeof raw.devicePubKey === 'string' ? raw.devicePubKey : null,
        // v2.3（r16）：注册帧声明的引擎基线与状态；hydrate 不恢复就会被静默丢掉（r15 教训）
        dshCommit: typeof raw.dshCommit === 'string' ? raw.dshCommit : null,
        engineState: typeof raw.engineState === 'string' ? raw.engineState : null,
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
      // S-2.2：按 (hostId, sessionId) 复合键重建；落盘行仍用 ownerDeviceId 字段，格式不变
      sessions.set(sessionKey(owner, id), {
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
      // v2.3（r15）：主机标识正式名称；缺省回落 null，值兼容 deviceId（命名迁移第一步）
      hostId: typeof input.hostId === 'string' && input.hostId.trim()
        ? input.hostId.trim().slice(0, 64) : prev?.hostId ?? null,
      // v2.3（r16）：注册帧声明的 DSH 基线与引擎状态。展示 + ENGINE_SAFE_MODE 判定用；
      // COMMIT_DRIFT 的强制校验在 Relay 注册协商处做，这里只忠实落库（去空白限长）。
      dshCommit: typeof input.dshCommit === 'string' && input.dshCommit.trim()
        ? input.dshCommit.trim().slice(0, 64) : prev?.dshCommit ?? null,
      engineState: typeof input.engineState === 'string' && input.engineState.trim()
        ? input.engineState.trim().slice(0, 32) : prev?.engineState ?? null,
      // S-8.5：注册报文不允许改写已钉住的设备公钥，只能原样保留。
      devicePubKey: prev?.devicePubKey ?? null,
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

  /**
   * 由令牌反查手机行（v2.3 P2：/api/hosts 的「我是谁 / 我绑了哪台主机」查询）。
   * 只比 SHA-256 摘要（定长比较）；找不到返回 null，不区分「没配对」与「已吊销」。
   */
  const findPhoneByToken = (deviceToken) => {
    if (!deviceToken) return null
    const digest = sha256Hex(deviceToken)
    for (const row of devices.values()) {
      if (row.role === 'phone' && !row.tombstone && row.tokenDigest
        && safeEqualHex(row.tokenDigest, digest)) {
        return { deviceId: row.deviceId, clientId: row.deviceId, boundHostId: row.boundHostId }
      }
    }
    return null
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

  const upsertPhone = ({ phoneId, hostId, label = null, devicePubKey = null } = {}) => {
    if (!phoneId || !hostId) throw new ControlPlaneError('UNAUTHORIZED', '缺少 phoneId / hostId')
    // S-8.5：首次信任时钉住指纹；之后**指纹变化按不匹配处理并阻断**，
    // 不给「提醒后继续」的口子。未携带字段的旧客户端不受影响。
    const presented = normalizeDeviceKey(devicePubKey)
    const pinned = normalizeDeviceKey(devices.get(phoneId)?.devicePubKey)
    if (presented && pinned && presented !== pinned) {
      throw new ControlPlaneError('DEVICE_KEY_MISMATCH', '设备公钥指纹与已钉住值不一致，已阻断')
    }
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
      devicePubKey: pinned ?? presented,
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
   * `mismatch`（r19）：令牌本身有效但绑定的是**另一台主机**——切换器重绑后旧 hostId
   * 请求专属信号，调用方应回 409 HOST_MISMATCH 而非笼统 401（04 §6 切换协议）。
   */
  const verifyClientToken = (hostId, deviceToken) => {
    const deny = { ok: false, clientId: null, legacy: false, mismatch: false };
    if (!hostId || !deviceToken) return deny;
    const digest = sha256Hex(deviceToken);
    const t = now();
    // 手机令牌（r9）：按令牌反查，命中即知绑定关系——目标主机不符 → mismatch
    for (const row of devices.values()) {
      if (row.role !== 'phone' || row.tombstone || !row.tokenDigest) continue;
      if (!safeEqualHex(digest, row.tokenDigest)) continue;
      if (row.boundHostId === hostId) {
        row.lastSeenAt = t;
        row.state = 'online';
        return { ok: true, clientId: row.deviceId, legacy: false, mismatch: false };
      }
      return { ok: false, clientId: null, legacy: false, mismatch: true };
    }
    // legacy（r9 之前）：令牌直接落在 Host 行上
    for (const h of devices.values()) {
      if (h.role !== 'host' || h.tombstone || !h.tokenDigest) continue;
      if (!safeEqualHex(digest, h.tokenDigest)) continue;
      if (h.deviceId === hostId) return { ok: true, clientId: null, legacy: true, mismatch: false };
      return { ok: false, clientId: null, legacy: true, mismatch: true };
    }
    return deny;
  }

  /** 单独收回一台手机：Host 与其它手机不受影响。 */
  const revokePhone = (phoneId) => {
    const row = devices.get(phoneId)
    if (!row || row.role !== 'phone') return null
    row.tombstone = true
    row.tokenDigest = null
    row.devicePubKey = null   // S-8.5：收回设备即撤销凭证，重新接纳时允许钉新指纹
    row.state = 'offline'
    touch()
    return cloneDevice(row)
  }

  /**
   * r19（S-6.9）：把手机重绑到另一台主机（切换器的服务端动作）。
   * 上限 / 墓碑 / 目标校验与配对同口径；同主机重绑是无害 no-op。
   * 令牌不变（换的是绑定关系，不是身份），所以重绑后旧令牌在新主机上直接可用。
   */
  const rebindPhone = (phoneId, targetHostId) => {
    const row = devices.get(phoneId)
    if (!row || row.role !== 'phone' || row.tombstone) {
      throw new ControlPlaneError('HOST_OFFLINE', '手机不存在或已收回', { retryable: false })
    }
    if (row.boundHostId === targetHostId) return cloneDevice(row)
    const target = devices.get(targetHostId)
    if (!target || target.tombstone || target.role !== 'host') {
      throw new ControlPlaneError('HOST_OFFLINE', '目标主机不存在或已收回', { retryable: false })
    }
    const bound = [...devices.values()].filter((d) => d.role === 'phone' && !d.tombstone && d.boundHostId === targetHostId).length
    if (bound >= maxPhonesPerHost) {
      throw new ControlPlaneError('CLIENT_LIMIT', '目标主机名下手机数已达上限', { retryable: false })
    }
    row.boundHostId = targetHostId
    row.lastSeenAt = now()
    row.state = 'online'
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
  const putSession = (hostId, raw) => {
    if (!hostId) throw new ControlPlaneError('UNAUTHORIZED', '缺少 hostId')
    if (!raw?.sessionId) return { upserted: 0, removed: 0 }
    const key = sessionKey(hostId, raw.sessionId)
    const prev = sessions.get(key)
    sessions.set(key, {
      sessionId: raw.sessionId,
      accountId: raw.accountId ?? prev?.accountId ?? null,
      ownerDeviceId: hostId,
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
  const applySessionDiff = (hostId, rows = [], removedIds = []) => {
    if (!hostId) throw new ControlPlaneError('UNAUTHORIZED', '缺少 hostId')
    let upserted = 0
    for (const raw of Array.isArray(rows) ? rows : []) {
      if (!raw?.sessionId) continue
      putSession(hostId, raw)
      upserted++
    }
    let removed = 0
    for (const id of Array.isArray(removedIds) ? removedIds : []) {
      const key = sessionKey(hostId, id)
      const row = sessions.get(key)
      if (row && row.ownerDeviceId === hostId) { sessions.delete(key); removed++ }
    }
    if (removed) touch()          // 只删不改时 putSession 没被调到，这里补一次
    return { upserted, removed }
  }

  /**
   * 写入某台 Host 的会话索引快照（全量；本轮未出现的会话会被移除）。
   * @returns { upserted, removed }
   */
  const upsertSessions = (hostId, rows = []) => {
    if (!hostId) throw new ControlPlaneError('UNAUTHORIZED', '缺少 hostId')
    const seen = new Set()
    let upserted = 0
    for (const raw of Array.isArray(rows) ? rows : []) {
      if (!raw?.sessionId) continue
      seen.add(raw.sessionId)
      upserted += putSession(hostId, raw).upserted
    }
    let removed = 0
    for (const [key, row] of sessions) {
      if (row.ownerDeviceId === hostId && !seen.has(row.sessionId)) {
        sessions.delete(key)
        removed++
      }
    }
    if (removed) touch()
    return { upserted, removed }
  }

  const getSession = (hostId, sessionId) => cloneSession(sessions.get(sessionKey(hostId, sessionId)))

  /**
   * `archived`：false（默认）只回未归档，true 只回已归档，null 全回（r12）。
   * 归档是**软移除**——行还在 CP 里，只是不进手机默认列表，随时能恢复。
   */
  const listSessions = ({ hostId = null, pinned = null, accountId = null, archived = false } = {}) =>
    [...sessions.values()]
      .filter((s) => (hostId === null || s.ownerDeviceId === hostId))
      .filter((s) => (accountId === null || s.accountId === accountId))
      .filter((s) => (pinned === null || s.pinned === Boolean(pinned)))
      .filter((s) => archived === null || (s.archived === true) === (archived === true))
      .sort((a, b) => (Number(b.pinned) - Number(a.pinned))
        || (a.pinnedOrder - b.pinnedOrder)
        || ((b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0)))
      .map(cloneSession)

  /** 置顶 / 归档 / 调序 / 状态修正：Relay 在收到 Host 响应后调用，手机端不直接改 CP。 */
  const patchSession = (hostId, sessionId, patch = {}) => {
    const row = sessions.get(sessionKey(hostId, sessionId))
    if (!row) return null
    if (patch.pinned !== undefined) row.pinned = Boolean(patch.pinned)
    if (patch.pinnedOrder !== undefined) row.pinnedOrder = num(patch.pinnedOrder, row.pinnedOrder)
    if (patch.archived !== undefined) row.archived = Boolean(patch.archived)
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

  const getLease = (hostId, sessionId, ts = now()) => {
    const key = sessionKey(hostId, sessionId)
    const lease = leases.get(key)
    if (!lease) return null
    if (lease.expiresAt <= ts) { leases.delete(key); return null }
    return { ...lease }
  }

  /**
   * 申请写句柄。同设备重复申请是幂等的（续租），别家持有则 `ROUTE_CONFLICT`。
   * 键带 hostId（S-2.2）：两台主机各自的写句柄互不干扰。
   * 注意：这里管的是**跨 Host 路由归属**，会话内的单写者仍由宿主
   * `SessionAlreadyOwnedError` 兄底（ADR-008）。
   */
  const acquireLease = ({ hostId, sessionId, deviceId, clientId = null }, ts = now()) => {
    if (!hostId || !sessionId || !deviceId) throw new ControlPlaneError('UNAUTHORIZED', '缺少 hostId / sessionId / deviceId')
    const key = sessionKey(hostId, sessionId)
    const current = getLease(hostId, sessionId, ts)
    if (current && current.deviceId !== deviceId) {
      throw new ControlPlaneError('ROUTE_CONFLICT', `会话写句柄由 ${current.deviceId} 持有`)
    }
    if (current) {
      current.expiresAt = ts + leaseTtlMs
      if (clientId) current.clientId = clientId
      leases.set(key, current)
      return { ...current, renewed: true }
    }
    const lease = {
      hostId, sessionId, deviceId, leaseId: newId(), clientId, acquiredAt: ts, expiresAt: ts + leaseTtlMs,
    }
    leases.set(key, lease)
    return { ...lease, renewed: false }
  }

  const renewLease = ({ hostId, sessionId, leaseId }, ts = now()) => {
    const key = sessionKey(hostId, sessionId)
    const lease = getLease(hostId, sessionId, ts)
    if (!lease) throw new ControlPlaneError('SESSION_BUSY', '租约不存在或已过期', { retryable: true })
    if (lease.leaseId !== leaseId) throw new ControlPlaneError('SESSION_BUSY', '租约 ID 不匹配', { retryable: true })
    lease.expiresAt = ts + leaseTtlMs
    leases.set(key, lease)
    return { ...lease }
  }

  const releaseLease = ({ hostId, sessionId, leaseId = null, deviceId = null }, ts = now()) => {
    const key = sessionKey(hostId, sessionId)
    const lease = getLease(hostId, sessionId, ts)
    if (!lease) return { released: false, reason: 'NOT_FOUND' }
    if (leaseId && lease.leaseId !== leaseId) return { released: false, reason: 'LEASE_MISMATCH' }
    if (!leaseId && deviceId && lease.deviceId !== deviceId) return { released: false, reason: 'OWNER_MISMATCH' }
    leases.delete(key)
    return { released: true }
  }

  const listLeases = (ts = now()) => {
    sweepExpired(ts)
    return [...leases.values()].map((l) => ({ ...l }))
  }

  /* ------------------------------------------------------------ Cursor */

  const putCursor = ({ clientId, hostId, sessionId, sinceSeq }) => {
    if (!clientId || !hostId || !sessionId) throw new ControlPlaneError('UNAUTHORIZED', '缺少 clientId / hostId / sessionId')
    const key = cursorKey(clientId, hostId, sessionId)
    const row = { clientId, hostId, sessionId, sinceSeq: num(sinceSeq, 0), updatedAt: now() }
    cursors.set(key, row)
    return { ...row }
  }

  const getCursor = ({ clientId, hostId, sessionId }) => {
    const row = cursors.get(cursorKey(clientId, hostId, sessionId))
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
    upsertPhone, setPhoneToken, verifyClientToken, revokePhone, rebindPhone, listPhones,
    // 令牌反查（P2：/api/hosts 数据源）
    findPhoneByToken,
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
