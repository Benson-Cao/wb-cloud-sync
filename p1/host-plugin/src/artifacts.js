/**
 * W8 · 产物索引（Host 侧，只读）
 * ---------------------------------------------------------------
 * 宿主实测契约（app.asar 的 `isPresentedData` / `isPresentedFile`）：
 *
 *   { type: 'deliverables/presented', seq, data: {
 *       turn: number(≥1), callId: string,
 *       files: [{ path: string, description?: string }],
 *       host?: {...}
 *   }}
 *
 * 这条事件本来就在 `session/event` 流里（插件已原样上行），所以**不需要新协议帧**：
 * 手机点开会话时用既有的 `session/*` 下行通道问一次，Host 从 append-only 会话日志里
 * 只读扫一遍，把显式「呈现」过的文件列出来。这样即便手机晚连、Relay 缓冲被裁掉，
 * 也不会看不到早期产物。
 *
 * 边界（ADR-010 / docs/04 §5.4）：**只过元数据（路径 / 描述 / seq），绝不过文件字节**。
 * 工作区文件不经 Relay / CP。卡片能做的事是「看到有什么」和「复制路径」，
 * 打开文件由桌面端自己的文件动作负责。
 */
export const MAX_ARTIFACT_ROWS = 200

/** 斜杠 / 反斜杠都算分隔符：Host 在 Windows 上给的路径常带反斜杠。 */
export const basename = (path) => {
  const at = Math.max(String(path).lastIndexOf('/'), String(path).lastIndexOf('\\'))
  return at === -1 ? String(path) : String(path).slice(at + 1)
}

const isPresentedData = (data) =>
  data !== null && typeof data === 'object' && !Array.isArray(data)
  && typeof data.turn === 'number' && Number.isSafeInteger(data.turn) && data.turn >= 1
  && typeof data.callId === 'string' && data.callId.length > 0
  && Array.isArray(data.files)

const isPresentedFile = (file) =>
  file !== null && typeof file === 'object' && !Array.isArray(file)
  && typeof file.path === 'string' && file.path.trim().length > 0
  && (file.description === undefined || typeof file.description === 'string')

/** 纯函数：把一批事件折成产物行。去重键是 (seq, index)——同一事件重放不会重复出卡。 */
export function scanArtifacts(events = []) {
  const rows = []
  const seen = new Set()
  for (const ev of Array.isArray(events) ? events : []) {
    if (ev?.type !== 'deliverables/presented' || !isPresentedData(ev.data)) continue
    if (!Number.isInteger(ev.seq) || ev.seq < 0) continue
    const { turn, callId, files } = ev.data
    for (let index = 0; index < files.length; index++) {
      const file = files[index]
      if (!isPresentedFile(file)) continue
      const key = `${ev.seq}:${index}`
      if (seen.has(key)) continue
      seen.add(key)
      rows.push({
        seq: ev.seq,
        turn,
        callId,
        index,
        path: file.path,
        name: basename(file.path.trim()),
        description: typeof file.description === 'string' ? file.description : null,
      })
    }
    if (rows.length >= MAX_ARTIFACT_ROWS) break
  }
  return rows.sort((a, b) => a.seq - b.seq || a.index - b.index)
}

/**
 * 从会话日志只读扫产物。
 * `handle.read(offset, length)` 的 offset 是**首条逻辑 seq**（见 replay.js 取证），
 * 一页一页往后翻，页数与行数都有硬上限——长会话不许把内存和帧大小吃光。
 */
export function createArtifactIndex({ openSession, pageSize = 500, maxPages = 20 } = {}) {
  const limit = Math.min(Math.max(1, Number(pageSize) || 500), 5000)
  const pages = Math.min(Math.max(1, Number(maxPages) || 20), 100)

  return async function listArtifacts({ sessionId } = {}) {
    if (!sessionId) {
      return { ok: false, code: 'SESSION_UNREADABLE', message: '缺少 sessionId' }
    }
    let handle
    try {
      handle = await openSession(sessionId)
    } catch (error) {
      return {
        ok: false, code: 'SESSION_UNREADABLE',
        message: `会话不可读：${error?.message ?? 'unknown'}`,
      }
    }
    try {
      const all = []
      let offset = 0
      let scanned = 0
      let truncated = false
      for (let page = 0; page < pages; page++) {
        const r = await handle.read(offset, limit)
        const batch = Array.isArray(r?.events) ? r.events : []
        if (!batch.length) break
        all.push(...scanArtifacts(batch))
        const lastSeq = batch[batch.length - 1]?.seq
        // seq 不是连续整数（或根本没带）时没法安全翻页：停在这里并如实报截断
        if (!Number.isInteger(lastSeq) || lastSeq < offset) { truncated = true; break }
        offset = lastSeq + 1
        scanned += batch.length
        if (batch.length < limit) break
        if (page === pages - 1 || all.length >= MAX_ARTIFACT_ROWS) truncated = true
      }
      const unique = []
      const keys = new Set()
      for (const r of all) {
        const k = `${r.seq}:${r.index}`
        if (keys.has(k)) continue
        keys.add(k)
        unique.push(r)
        if (unique.length >= MAX_ARTIFACT_ROWS) break
      }
      unique.sort((a, b) => a.seq - b.seq || a.index - b.index)
      return {
        ok: true,
        value: {
          sessionId,
          rows: unique,
          count: unique.length,
          scanned,
          truncated: truncated || unique.length >= MAX_ARTIFACT_ROWS,
        },
      }
    } catch (error) {
      return {
        ok: false, code: 'SESSION_UNREADABLE',
        message: `产物扫描失败：${error?.message ?? 'unknown'}`,
      }
    } finally {
      try { await handle.close?.() } catch { /* 已关闭 */ }
    }
  }
}
