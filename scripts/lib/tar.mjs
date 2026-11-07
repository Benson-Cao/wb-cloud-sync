/**
 * 最小 tar / tar.gz 读取器（零依赖，只读）
 * ---------------------------------------------------------------
 * 为什么需要：`npm pack` 生成的 tgz **不可复现**（gzip 头带时间戳），
 * 同样内容两次打包 sha 不同，所以不能靠「比 tgz 的 sha」判断发布物是否
 * 与源码一致。正确做法是**解包后逐文件比对**。
 *
 * 只解析 ustar/GNU 常规格式，够读 npm 打出来的包：
 *   512 字节 header（name[100] mode[8] uid[8] gid[8] size[12] mtime[12]
 *   chksum[8] typeflag[1] linkname[100] magic[6] version[2] ... prefix[155]）
 *   数据按 512 对齐；两个全零块表示结束。
 */
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'

const BLOCK = 512

function readString(buf, offset, length) {
  const slice = buf.subarray(offset, offset + length)
  const end = slice.indexOf(0)
  return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8')
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

/**
 * @param {Buffer} buffer tar.gz 或裸 tar
 * @returns {{ path: string, size: number, sha256: string, type: string }[]}
 */
export function listTarEntries(buffer) {
  let raw = buffer
  try { raw = gunzipSync(buffer) } catch { /* 已是裸 tar */ }

  const entries = []
  let offset = 0
  while (offset + BLOCK <= raw.length) {
    const header = raw.subarray(offset, offset + BLOCK)
    // 结束块：全零
    if (header.every((byte) => byte === 0)) break

    const name = readString(header, 0, 100)
    const prefix = readString(header, 345, 155)
    const path = prefix ? `${prefix}/${name}` : name
    const sizeField = readString(header, 124, 12).trim()
    const size = sizeField ? parseInt(sizeField, 8) : 0
    const type = String.fromCharCode(header[156] || 48) // '0' 常规文件

    const dataStart = offset + BLOCK
    const data = raw.subarray(dataStart, dataStart + size)
    if (Number.isFinite(size) && size >= 0) {
      entries.push({ path, size, sha256: sha256(data), type })
    }
    // pax 扩展头（type 'x'）等也按 size 跳过，逻辑一致
    offset = dataStart + Math.ceil((Number.isFinite(size) ? size : 0) / BLOCK) * BLOCK
  }
  return entries
}

/** 从条目列表里按路径取一个；不存在返回 null。 */
export function entryOf(entries, path) {
  return entries.find((e) => e.path === path) ?? null
}
