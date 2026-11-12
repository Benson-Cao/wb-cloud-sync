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
/** 下载用的 MIME：只认常见那几个，认不出就 octet-stream（不猜内容）。 */
export const mimeOfArtifact = (name) => {
  const ext = String(name ?? '').toLowerCase().split('.').pop()
  return ({
    md: 'text/markdown; charset=utf-8', markdown: 'text/markdown; charset=utf-8',
    txt: 'text/plain; charset=utf-8', json: 'application/json; charset=utf-8',
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
    html: 'text/html; charset=utf-8', csv: 'text/csv; charset=utf-8',
  })[ext] ?? 'application/octet-stream'
}

/**
 * 宿主 `officeToPdf.renderFile` 的硬白名单（源码取证）：只认这六种。
 * 把 odt/rtf 之类写进来会「看起来支持、实际报 unsupported-format」，所以照抄。
 */
export const PDF_CONVERTIBLE = new Set(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'])

/** 小写扩展名，没有就空串。 */
export const extOf = (name) => {
  const base = basename(name)
  const at = base.lastIndexOf('.')
  return at <= 0 ? '' : base.slice(at + 1).toLowerCase()
}

/**
 * 显式产物导出（ADR-011）：**Host 这一侧只做「校验 + 读字节 / 校验 + 交给宿主转换」**。
 * 票据本身由 Relay 持有（一次性 / TTL / 绑定手机），所以这里不建票据表。
 *
 * 四条硬约束，少一条都会把 Relay 变成任意文件读取网关：
 *   1. 路径必须在该会话 `deliverables/presented` 的索引里（不信手机自报路径）；
 *   2. 解析后必须仍落在会话工作区内（防 `..` / 绝对路径穿越）；
 *   3. 体积硬上限（WS 帧 1 MiB + base64 膨胀），超出明确拒绝，不静默截断；
 *   4. 转换只走**同一个** `convertToPdf`，输出仍受同一体积上限约束。
 *
 * PDF 转换（r13 修订）：宿主有 `officeToPdf.render`，但**只做 Office → PDF**。
 * Markdown / 纯文本 → PDF 在宿主里没有实现，所以那种请求明确回
 * `CAPABILITY_UNAVAILABLE`，绝不拼一个「看起来像 PDF」的东西骗用户。
 */
export function createArtifactExporter({
  listArtifacts,
  resolveWorkspace,
  convertToPdf = null,
  maxBytes = 512 * 1024,
} = {}) {
  if (typeof listArtifacts !== 'function' || typeof resolveWorkspace !== 'function') {
    throw new TypeError('createArtifactExporter 需要 listArtifacts / resolveWorkspace')
  }
  const cap = Math.max(1, Number(maxBytes) || 512 * 1024)

  const readBytes = async ({ sessionId, relPath, format }) => {
    if (!sessionId || typeof relPath !== 'string' || !relPath.trim()) {
      return { ok: false, code: 'INVALID_ARGUMENT', message: '缺 sessionId / path' }
    }
    const listed = await listArtifacts({ sessionId })
    if (!listed?.ok) {
      return { ok: false, code: 'SESSION_UNREADABLE', message: listed?.message ?? '产物索引不可读' }
    }
    const match = (listed.value?.rows ?? []).find((r) => r.path === relPath)
    if (!match) {
      return { ok: false, code: 'ARTIFACT_NOT_PRESENTED', message: '该文件不是此会话显式交付的产物' }
    }
    const root = await resolveWorkspace(sessionId)
    if (!root) {
      return { ok: false, code: 'WORKSPACE_UNKNOWN', message: '拿不到会话工作区，拒绝解析路径' }
    }
    // 动态 import：bundle 是单文件，内联模块不能带顶层静态 import
    const pathMod = await import('node:path')
    const fs = await import('node:fs/promises')
    const path = pathMod.default ?? pathMod
    const abs = path.resolve(root, relPath)
    const inside = path.relative(root, abs)
    if (inside.startsWith('..') || path.isAbsolute(inside)) {
      return { ok: false, code: 'PATH_OUTSIDE_WORKSPACE', message: '路径越出会话工作区' }
    }
    let st
    try { st = await fs.stat(abs) }
    catch { return { ok: false, code: 'ARTIFACT_MISSING', message: '文件已不存在（可能被删或移动）' } }
    if (!st.isFile()) return { ok: false, code: 'ARTIFACT_MISSING', message: '不是普通文件' }

    const sourceName = basename(match.name ?? relPath)
    const srcExt = extOf(sourceName)
    const wantPdf = format === 'pdf' && srcExt !== 'pdf'

    // ── 转换支路：不读源字节，把绝对路径交给宿主（它有自己的 maxInputBytes / 超时）
    if (wantPdf) {
      if (!PDF_CONVERTIBLE.has(srcExt)) {
        return {
          ok: false, code: 'CAPABILITY_UNAVAILABLE',
          message: `宿主只能把 Office 文件转成 PDF（.docx/.xlsx/.pptx 等），`
            + `${srcExt ? '.' + srcExt : '该类型'} 不支持转换；请原样下载或在电脑上导出`,
        }
      }
      if (typeof convertToPdf !== 'function') {
        return { ok: false, code: 'CAPABILITY_UNAVAILABLE', message: '本机没有可用的 PDF 转换器' }
      }
      let conv
      try {
        conv = await convertToPdf({ sessionId, absPath: abs, relPath })
      } catch (error) {
        // 同步抛 / 异步 reject 都兜住：异常绝不能冒到帧层变成空响应
        conv = { ok: false, code: 'CONVERT_FAILED', message: `PDF 转换失败：${error?.message ?? 'unknown'}` }
      }
      if (!conv?.ok) {
        return {
          ok: false,
          code: conv?.code ?? 'CONVERT_FAILED',
          message: conv?.message ?? '转换失败（宿主未说明原因）',
        }
      }
      const buf = Buffer.isBuffer(conv.value?.bytes)
        ? conv.value.bytes
        : Buffer.from(conv.value?.bytes ?? [])
      if (!buf.length) return { ok: false, code: 'CONVERT_FAILED', message: '转换结果为空' }
      if (buf.length > cap) {
        return {
          ok: false, code: 'ARTIFACT_TOO_LARGE',
          message: `转换后 ${buf.length} B 超过 ${cap} B 上限，请在电脑上打开`,
        }
      }
      const pdfName = `${sourceName.replace(/\.[^.]+$/, '')}.pdf`
      return {
        ok: true,
        value: {
          name: pdfName,
          mime: 'application/pdf',
          size: buf.length,
          bytes: buf.toString('base64'),
          convertedFrom: sourceName,
        },
      }
    }

    // ── 原样支路
    if (st.size > cap) {
      return { ok: false, code: 'ARTIFACT_TOO_LARGE', message: `文件 ${st.size} B 超过 ${cap} B 上限，请在电脑上打开` }
    }
    let buf
    try { buf = await fs.readFile(abs) }
    catch { return { ok: false, code: 'ARTIFACT_MISSING', message: '读取失败' } }
    if (buf.length > cap) {
      return { ok: false, code: 'ARTIFACT_TOO_LARGE', message: '读取时体积超限' }
    }
    return {
      ok: true,
      value: {
        name: sourceName,
        mime: mimeOfArtifact(sourceName),
        size: buf.length,
        bytes: buf.toString('base64'),   // 只在 frame 里，不落盘、不进事件流
      },
    }
  }

  return { readBytes, maxBytes: cap }
}

/**
 * 会话产物索引。显式交付事件为 0 条时，`listWorkspaceFiles`（若宿主提供）作为
 * **第二数据源**：路径来自宿主权威文件服务，标 `source:'workspace'`，
 * 绝不用正则从 tool/result 正文里抠路径（宿主自己都不这么干）。拿不到就保持空。
 */
export function createArtifactIndex({ openSession, pageSize = 500, maxPages = 20, listWorkspaceFiles = null } = {}) {
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
      // 显式交付为 0 行时，问宿主的权威文件服务要一份工作区清单。
      // 失败/不可用都保持 rows:[]——**如实空着，不猜**。
      let rows = unique
      let source = 'presented'
      let workspaceError = null
      if (!rows.length && typeof listWorkspaceFiles === 'function') {
        try {
          const got = await listWorkspaceFiles(sessionId)
          // 兼容两种返回：裸数组（老夹具）与 { rows, error }（带失败原因，便于真机定位）
          const files = Array.isArray(got) ? got : (got?.rows ?? [])
          workspaceError = Array.isArray(got) ? null : (got?.error ?? null)
          if (files.length) {
            rows = files.slice(0, MAX_ARTIFACT_ROWS)
              .filter((f) => f && typeof f.path === 'string' && f.path.trim())
              .map((f, i) => ({
                seq: -1, turn: null, callId: null, index: i,
                path: f.path, name: basename(f.name ?? f.path),
                description: f.description ?? null,
                source: 'workspace',
              }))
            source = 'workspace'
          }
        } catch (error) {
          // 文件服务不可用：保持空，但把原因留下来——「空着」和「没问到」必须能分开
          workspaceError = error?.message ?? String(error)
        }
      }
      return {
        ok: true,
        value: {
          sessionId,
          rows,
          source,
          count: rows.length,
          scanned,
          truncated: truncated || rows.length >= MAX_ARTIFACT_ROWS,
          ...(workspaceError ? { workspaceError } : {}),
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
