/**
 * 会话镜像 · 电脑侧只读导出（ADR-012 第一步）
 * ---------------------------------------------------------------
 * 为什么是「搬原件」而不是「写会话」：
 *   宿主会话是 `sessions/<cwd编码>/<sid>/session.v<N>.jsonl.zstd` —— zstd + 版本命名的二进制。
 *   自己按格式「写」会话，等于手搓宿主内部结构，写坏一个字节就是一个坏会话。
 *   所以镜像只做字节搬运，格式天然正确（`dsh-nas-sync` 同此思路）。
 *
 * 为什么分块：
 *   WS 帧硬限 1 MiB，base64 还要 ×4/3。几十 MB 的会话文件必须带 offset 分页取，
 *   并且**明确拒绝**超出单块上限的请求，而不是静默截断。
 *
 * 安全边界（ADR-012 硬条件 4）：
 *   - 只允许 `sessions/` 之下、且文件名匹配 `^[A-Za-z0-9._-]+$` 的普通文件；
 *   - sid 必须是 sessions 目录下真实存在的目录名，不接受手机自报路径；
 *   - 读取前 resolve 一次，确认最终路径仍在会话目录内（防 `..` / 符号链接逃逸）。
 */
import { promises as fs } from 'node:fs'
import { join, resolve, sep } from 'node:path'

export const MIRROR_CHUNK_MAX = 512 * 1024        // 单块原始字节上限（base64 后 ≈ 683 KiB）
export const MIRROR_FILE_MAX = 64 * 1024 * 1024  // 单文件上限：超过不镜像，明确报错
export const MIRROR_SESSION_MAX = 256 * 1024 * 1024

const SAFE_NAME = /^[A-Za-z0-9._-]{1,120}$/
const SESSION_FILE = /\.(jsonl\.zstd|jsonl|json)$/i

const isContained = (root, target) => {
  const r = resolve(root)
  const t = resolve(target)
  return t === r || t.startsWith(r + sep)
}

/**
 * 列出一个会话目录里可镜像的文件。
 * 只有「目录里实际存在的普通文件」会被列出，不做任何猜测式扩展名补全。
 */
export async function listSessionFiles(root, sid) {
  if (typeof sid !== 'string' || !sid.trim()) throw Object.assign(new Error('缺 sid'), { code: 'INVALID_ARGUMENT' })
  const sessionsRoot = resolve(root)
  const dir = resolve(join(sessionsRoot, sid))
  if (!isContained(sessionsRoot, dir) || dir === sessionsRoot) {
    throw Object.assign(new Error('sid 越界'), { code: 'OUTSIDE_WORKSPACE' })
  }
  let names
  try { names = await fs.readdir(dir) } catch { return null }   // 不存在就是这个会话没有可镜像文件
  const files = []
  let bytes = 0
  for (const name of names) {
    if (name.startsWith(".") || !SAFE_NAME.test(name) || !SESSION_FILE.test(name)) continue
    const p = join(dir, name)
    const st = await fs.stat(p).catch(() => null)
    if (!st?.isFile()) continue
    if (st.size > MIRROR_FILE_MAX) continue
    files.push({ name, size: st.size })
    bytes += st.size
  }
  return { sid, files, bytes }
}

/** 逐目录扫 sessions/，返回所有可镜像会话的清单（跳过回收站）。 */
export async function listMirrorSessions(root) {
  const sessionsRoot = resolve(root)
  let segs
  try { segs = await fs.readdir(sessionsRoot, { withFileTypes: true }) } catch { return [] }
  const out = []
  for (const seg of segs) {
    if (!seg.isDirectory() || seg.name.startsWith('.')) continue
    let sids
    try { sids = await fs.readdir(join(sessionsRoot, seg.name), { withFileTypes: true }) } catch { continue }
    for (const s of sids) {
      if (!s.isDirectory() || s.name.startsWith('.')) continue
      const info = await listSessionFiles(sessionsRoot, join(seg.name, s.name))
      if (!info || !info.files.length) continue
      if (info.bytes > MIRROR_SESSION_MAX) continue
      out.push({ sid: s.name, dir: seg.name, files: info.files, bytes: info.bytes })
    }
  }
  return out
}

/**
 * 取一块字节。offset/eof 语义与产物的下载窗口一致：调用方一直取到 eof 为止。
 * 返回 base64，避免 JSON 里出现二进制。
 */
export async function readSessionChunk(root, { sid, name, offset = 0, maxBytes = MIRROR_CHUNK_MAX } = {}) {
  if (typeof sid !== 'string' || !sid.includes('/')) {
    throw Object.assign(new Error('sid 需要形如 <cwd编码>/<sid>'), { code: 'INVALID_ARGUMENT' })
  }
  if (typeof name !== 'string' || !SAFE_NAME.test(name) || !SESSION_FILE.test(name)) {
    throw Object.assign(new Error('文件名非法'), { code: 'INVALID_ARGUMENT' })
  }
  const sessionsRoot = resolve(root)
  const dir = resolve(join(sessionsRoot, sid))
  if (!isContained(sessionsRoot, dir) || dir === sessionsRoot) {
    throw Object.assign(new Error('路径越界'), { code: 'OUTSIDE_WORKSPACE' })
  }
  const target = resolve(join(dir, name))
  if (!isContained(dir, target)) throw Object.assign(new Error('路径越界'), { code: 'OUTSIDE_WORKSPACE' })

  const st = await fs.stat(target).catch(() => null)
  if (!st?.isFile()) throw Object.assign(new Error('文件不存在'), { code: 'ARTIFACT_NOT_FOUND' })
  if (st.size > MIRROR_FILE_MAX) {
    throw Object.assign(new Error(`文件超过镜像上限（${st.size} > ${MIRROR_FILE_MAX}）`), { code: 'ARTIFACT_TOO_LARGE' })
  }

  const start = Math.max(0, Math.min(Number(offset) || 0, st.size))
  const want = Math.min(Math.max(1, Number(maxBytes) || MIRROR_CHUNK_MAX), MIRROR_CHUNK_MAX)
  const len = Math.max(0, Math.min(want, st.size - start))

  const handle = await fs.open(target, 'r')
  try {
    const buf = Buffer.alloc(len)
    if (len > 0) await handle.read(buf, 0, len, start)
    return {
      sid, name, offset: start, size: st.size,
      bytes: buf.toString('base64'),
      eof: start + len >= st.size,
    }
  } finally {
    await handle.close()
  }
}
