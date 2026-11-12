/**
 * 会话镜像 · 手机侧落盘（ADR-012 第二步）
 * ---------------------------------------------------------------
 * 只做**文件层**：把电脑上的会话文件按块拉下来，原子写到本机会话目录。
 *
 * 为什么不到注册表（storages/workspace.json）就停：
 *   注册表决定侧栏显示什么。它的结构是 `{ global:{workspaceIds}, tables:{workspaces:{id:{path,title,sessionIds}}} }`，
 *   写错一次，用户的侧栏就乱了——而这一步**只能在真机上验证**。
 *   所以在没有一台在线手机可验的情况下，宁可不写：文件写歪了顶多占空间，注册表写歪了是破坏用户数据。
 *
 * 原子写：
 *   先写 `<name>.part`，落完再 rename。半截文件一旦被宿主当成合法会话，
 *   用户点进去看到的是残缺历史——比"没有这个会话"更糟。
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

/** 与宿主一致的路径编码：`C:\Users\me\p` → `--C-Users-me-p--`（非 ASCII 转 ~XXXX）。 */
export const encodeCwd = (p) => {
  const ascii = String(p ?? '').replace(
    /[^\x20-\x7e]/g,
    (c) => '~' + c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0'),
  )
  const body = ascii.replace(/[\\/:]+/g, '-').replace(/^-+/, '').replace(/-+$/, '')
  return `--${body}--`
}

/**
 * 拉取一个会话文件并原子落盘。
 *
 * @param fetchChunk  ({ sid, name, offset, maxBytes }) => { bytes(base64), eof, size? }
 * @param sessionsRoot 本机 `~/.dsh/sessions`
 * @param cwdPath      该会话所属工作区路径（用于算出目录段）
 * @param sid          会话 id
 * @param name         文件名（`session.v<N>.jsonl.zstd`）
 */
export async function pullSessionFile({ fetchChunk, sessionsRoot, cwdPath, sid, name, maxBytes = 512 * 1024, maxTotal = 64 * 1024 * 1024 }) {
  const dir = join(sessionsRoot, encodeCwd(cwdPath), sid)
  await fs.mkdir(dir, { recursive: true })
  const target = join(dir, name)
  const part = `${target}.part`

  const handle = await fs.open(part, 'w')
  let offset = 0
  let written = 0
  try {
    for (;;) {
      const chunk = await fetchChunk({ sid, name, offset, maxBytes })
      const buf = Buffer.from(chunk?.bytes ?? '', 'base64')
      if (buf.length) await handle.write(buf)
      written += buf.length
      offset += buf.length
      if (written > maxTotal) {
        throw Object.assign(new Error(`镜像文件超过上限（>${maxTotal}）`), { code: 'MIRROR_TOO_LARGE' })
      }
      if (chunk?.eof) break
      // 空块且未 eof：说明对端没给数据也没说结束，继续循环就是死转
      if (!buf.length) throw Object.assign(new Error('镜像分块为空但未结束'), { code: 'MIRROR_TRUNCATED' })
    }
  } catch (error) {
    try { await handle.close() } catch { /* 忽略 */ }
    await fs.rm(part, { force: true })
    throw error
  }
  await handle.close()

  // 尺寸对不上就别 rename：宁可没有，也不留一个看起来正常的坏文件
  const st = await fs.stat(part)
  if (st.size !== offset) {
    await fs.rm(part, { force: true })
    throw Object.assign(new Error(`落盘尺寸不符（${st.size} != ${offset}）`), { code: 'MIRROR_SIZE_MISMATCH' })
  }
  await fs.rename(part, target)
  return { path: target, bytes: written }
}

/** 列出本机上已镜像的会话（用于清理与占用统计）。 */
export async function listMirrored({ sessionsRoot, cwdPath }) {
  const dir = join(sessionsRoot, encodeCwd(cwdPath))
  let sids
  try { sids = await fs.readdir(dir, { withFileTypes: true }) } catch { return [] }
  const out = []
  for (const s of sids) {
    if (!s.isDirectory() || s.name.startsWith('.')) continue
    let bytes = 0
    const files = []
    for (const name of await fs.readdir(join(dir, s.name)).catch(() => [])) {
      if (name.endsWith('.part')) continue
      const st = await fs.stat(join(dir, s.name, name)).catch(() => null)
      if (!st?.isFile()) continue
      files.push(name)
      bytes += st.size
    }
    out.push({ sid: s.name, files, bytes })
  }
  return out
}

/** 清空镜像目录（删目录本身，让下一次同步重建）。 */
export async function clearMirrored({ sessionsRoot, cwdPath }) {
  const dir = join(sessionsRoot, encodeCwd(cwdPath))
  const existed = await fs.stat(dir).then((s) => s.isDirectory()).catch(() => false)
  await fs.rm(dir, { recursive: true, force: true })
  return { removed: existed }
}

/** 保证镜像目录存在（注册表那一步之前，至少要有一个真实目录可写）。 */
export async function ensureMirrorDir(root) {
  await fs.mkdir(root, { recursive: true })
  const probe = join(root, '.keep')
  await fs.writeFile(probe, '')
  await fs.rm(probe, { force: true })
  return root
}
