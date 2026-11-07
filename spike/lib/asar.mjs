/**
 * 最小 Electron ASAR 读取器（只读取证，不解压落盘、不修改宿主）。
 *
 * 为什么自己写而不依赖 `asar` 包：W1 Spike 要在 CI 三平台上零依赖跑通，
 * 且我们只读少数几个文件，不需要完整解包 213MB 的 app.asar。
 *
 * ASAR 布局：
 *   [0..3]   uint32 = 4                    (pickle header payload size)
 *   [4..7]   uint32 = headerPickleSize
 *   [8..]    header pickle: uint32 stringSize, JSON string, NUL padding
 *   [8+headerPickleSize..] 文件数据区，文件 offset 相对此起点
 *
 * 用法：
 *   const a = openAsar(path)
 *   a.list(/正则/)  -> [{ path, size, offset }]
 *   a.read(path)    -> utf8 字符串
 *   a.close()
 */
import { openSync, readSync, closeSync } from 'node:fs'

export function openAsar(archivePath) {
  const fd = openSync(archivePath, 'r')
  const probe = Buffer.alloc(8)
  readSync(fd, probe, 0, 8, 0)
  if (probe.readUInt32LE(0) !== 4) {
    closeSync(fd)
    throw new Error(`不是合法的 asar（pickle magic=${probe.readUInt32LE(0)}）: ${archivePath}`)
  }
  const headerSize = probe.readUInt32LE(4)
  const headerBuf = Buffer.alloc(headerSize)
  readSync(fd, headerBuf, 0, headerSize, 8)
  const raw = headerBuf.toString('utf8')
  const jsonStart = raw.indexOf('{"files"')
  if (jsonStart < 0) {
    closeSync(fd)
    throw new Error('asar 头部找不到 {"files" 节点')
  }
  let text = raw.slice(jsonStart).replace(/\0+$/, '')
  let header
  try {
    header = JSON.parse(text)
  } catch {
    // 个别构建会在 JSON 后带非零 padding，截到最后一个右括号再试一次
    const end = text.lastIndexOf('}')
    header = JSON.parse(text.slice(0, end + 1))
  }

  const dataStart = 8 + headerSize
  const entries = []
  const walk = (node, prefix) => {
    for (const [key, value] of Object.entries(node.files ?? {})) {
      const path = `${prefix}/${key}`
      if (value.files) walk(value, path)
      else entries.push({ path, size: Number(value.size) || 0, offset: Number(value.offset) || 0 })
    }
  }
  walk(header, '')
  const byPath = new Map(entries.map((e) => [e.path, e]))

  return {
    archivePath,
    dataStart,
    fileCount: entries.length,
    list(pattern) {
      return pattern ? entries.filter((e) => pattern.test(e.path)) : entries.slice()
    },
    /** 读单个文件为 utf8。超过 maxBytes 返回 null，避免把大 bundle 拉进内存。 */
    read(path, maxBytes = 4_000_000) {
      const entry = byPath.get(path)
      if (!entry) return null
      if (entry.size > maxBytes) return null
      const buf = Buffer.alloc(entry.size)
      readSync(fd, buf, 0, entry.size, dataStart + entry.offset)
      return buf.toString('utf8')
    },
    /** 读为 JSON，失败返回 null。 */
    readJson(path, maxBytes = 4_000_000) {
      const text = this.read(path, maxBytes)
      if (text === null) return null
      try { return JSON.parse(text) } catch { return null }
    },
    close() { closeSync(fd) },
  }
}
