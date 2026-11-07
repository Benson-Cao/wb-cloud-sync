/**
 * DSH append-only 会话日志的只读取证工具。
 *
 * 实测格式（DSH 0.2.2-rc.1）：`session.v4.jsonl.zstd` 是**多帧 zstd 拼接**——
 * 每追加一批事件就写一个独立 zstd 帧。`zstdDecompressSync(raw)` 只解第一帧，
 * 直接拿它当整个日志会误判成「这个会话只有一条 header」。必须按帧边界逐帧解。
 *
 * 证据纪律（对齐 08 安全设计 §8）：本模块对外只暴露结构元数据
 * （keys / type / seq / time / 计数），**不输出 `data` 正文、不输出文件内容**。
 */
import { zstdDecompressSync } from 'node:zlib'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, basename, dirname } from 'node:path'

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

function frameStarts(raw) {
  const out = []
  for (let i = 0; i + 4 <= raw.length; i++) {
    if (raw[i] === ZSTD_MAGIC[0] && raw[i + 1] === ZSTD_MAGIC[1] &&
        raw[i + 2] === ZSTD_MAGIC[2] && raw[i + 3] === ZSTD_MAGIC[3]) out.push(i)
  }
  return out
}

/** 逐帧解压 + 逐行 JSON 解析。返回 { frames, records, errors }。 */
export function decodeSessionLog(raw) {
  const starts = frameStarts(raw)
  const records = []
  const errors = []
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i]
    const to = i + 1 < starts.length ? starts[i + 1] : raw.length
    let text
    try { text = zstdDecompressSync(raw.subarray(from, to)).toString('utf8') }
    catch (error) { errors.push({ frame: i, stage: 'decompress', message: String(error?.message ?? error) }); continue }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try { records.push(JSON.parse(line)) }
      catch (error) { errors.push({ frame: i, stage: 'json', message: String(error?.message ?? error) }) }
    }
  }
  return { frames: starts.length, records, errors }
}

/** 分离 header 与事件；返回不含正文的结构化摘要。 */
export function summarize(records) {
  const header = records.find((r) => r?.type === 'session') ?? null
  const events = records.filter((r) => r && r.type !== 'session' && typeof r.seq === 'number')
  const seqs = events.map((e) => e.seq)
  let contiguous = seqs.length > 0
  for (let i = 1; i < seqs.length; i++) if (seqs[i] !== seqs[i - 1] + 1) { contiguous = false; break }
  const shapes = {}
  const types = {}
  for (const e of events) {
    const key = Object.keys(e).sort().join(',')
    shapes[key] = (shapes[key] ?? 0) + 1
    types[e.type] = (types[e.type] ?? 0) + 1
  }
  // 宿主自带的投影指令与事件关联字段（04 §3 未覆盖，需写进 ADR）
  const surfaceOps = {}
  const sourceRefsByType = {}
  for (const e of events) {
    if ('surfaceOp' in e) {
      const op = typeof e.surfaceOp === 'string' ? e.surfaceOp : '(non-string)'
      surfaceOps[op] = (surfaceOps[op] ?? 0) + 1
    }
    if ('sourceEventSeqs' in e) sourceRefsByType[e.type] = (sourceRefsByType[e.type] ?? 0) + 1
  }
  return {
    surfaceOps,
    sourceRefsByType,
    headerKeys: header ? Object.keys(header).sort() : [],
    headerType: header?.type ?? null,
    headerVersion: header?.version ?? null,
    eventCount: events.length,
    firstSeq: seqs[0] ?? null,
    lastSeq: seqs[seqs.length - 1] ?? null,
    contiguous,
    seqEqualsLogLength: contiguous && seqs.length > 0 && seqs[0] === 0 && seqs[seqs.length - 1] === seqs.length - 1,
    eventShapes: shapes,
    eventTypes: types,
    ignorableFieldCount: events.filter((e) => 'ignorable' in e).length,
    timeFieldCount: events.filter((e) => typeof e.time === 'number').length,
  }
}

/**
 * 模拟 04 §4.4 的 `open(id,'read')` 连续前缀补齐语义。
 * 遇到 seq 缺口立即停止，绝不返回撕裂尾部；seq <= sinceSeq 的重复帧幂等丢弃。
 */
export function readSince(events, sinceSeq) {
  const out = []
  let expected = sinceSeq + 1
  for (const e of events) {
    if (!e || typeof e.seq !== 'number' || e.seq <= sinceSeq) continue
    if (e.seq !== expected) break
    out.push(e.seq)
    expected++
  }
  return { returned: out.length, first: out[0] ?? null, last: out[out.length - 1] ?? null, seqs: out }
}

/** 在 DSH_HOME/sessions 下找最大的一份真实日志作为取证样本（只读）。 */
export function findLargestSessionLog(dshHome) {
  const root = join(dshHome, 'sessions')
  const found = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== '.sessions-trash') walk(path)
      } else if (entry.name.endsWith('.jsonl.zstd')) {
        found.push({ path, size: statSync(path).size })
      }
    }
  }
  try { walk(root) } catch { return null }
  found.sort((a, b) => b.size - a.size)
  if (!found.length) return null
  const { path, size } = found[0]
  return { path, size, sessionDir: basename(dirname(path)), totalLogs: found.length }
}
