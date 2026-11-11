/**
 * P2 前置 · CP 落盘（单机文件版）
 * ---------------------------------------------------------------
 * 为什么要有这个：CP 原本全在进程内存里，**重启即失忆** —— 设备表清空 ⇒ 所有手机令牌
 * 失效 ⇒ 每台手机都要重新输配对码。多手机上线后这件事的代价从「麻烦一次」变成
 * 「每次动服务都得重新配一遍」，于是先把「重启不掉配对」做出来。
 *
 * 存的与不存的，是刻意分开的：
 *   - 存 **设备（含令牌摘要）+ 会话索引** —— 它们是「事实」，重启后仍然成立；
 *   - 不存 **租约与消费位点** —— 租约 TTL 30s、本就随时会过期，位点由客户端
 *     `sinceSeq` 唯一权威（协议 #5b），存下来只会制造「服务端比客户端更权威」的错觉。
 *
 * 令牌只存 SHA-256 摘要，绝无明文；文件放在用户目录（默认 `~/.wbsync/cp.json`），
 * 不落在仓库里——既避免被当成密钥扫描的对象，也不会被 `git status` 带出去。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 快照格式版本。字段不兼容时升版本号，旧文件按「不认识」处理而不是猜着读。 */
export const CP_SCHEMA = 'wbsync.cp/1'

export const defaultCpFile = () => process.env.WBSYNC_CP_FILE || join(homedir(), '.wbsync', 'cp.json')

/**
 * 文件存储。对外三个动作：`load()` 读、`save(getSnapshot)` 排一次写、`flush()` 立刻写。
 * `save` 收的是**取快照的函数**而不是快照本身：去抖窗口内可能被调几十次，
 * 每次都真的去遍历四张表是白花钱。
 */
export function createFileStore({
  file = defaultCpFile(),
  now = () => Date.now(),
  debounceMs = 250,
} = {}) {
  let timer = null
  let pending = null
  let closed = false
  let lastError = null

  const writeNow = (getSnapshot) => {
    const snapshot = typeof getSnapshot === 'function' ? getSnapshot() : getSnapshot
    const body = JSON.stringify({ ...snapshot, schema: CP_SCHEMA, capturedAt: new Date(now()).toISOString() })
    const dir = dirname(file)
    mkdirSync(dir, { recursive: true })
    // 先写临时文件再改名：中途断电只会留下一个残片，主文件仍是上一份完整快照。
    const tmp = `${file}.tmp-${process.pid}`
    writeFileSync(tmp, body, 'utf8')
    try { chmodSync(tmp, 0o600) } catch { /* Windows 上不生效，交给目录 ACL */ }
    renameSync(tmp, file)
    lastError = null
  }

  const flush = () => {
    if (timer) { clearTimeout(timer); timer = null }
    if (!pending) return true
    const job = pending
    pending = null
    try {
      writeNow(job)
      return true
    } catch (error) {
      lastError = error
      return false
    }
  }

  return {
    file,
    /** 读快照。文件不存在 → null（首次启动）。内容坏了 → 备份成 `.corrupt-<ts>` 后返回 null。 */
    load() {
      if (!existsSync(file)) return null
      let text
      try { text = readFileSync(file, 'utf8') } catch (error) { lastError = error; return null }
      try {
        const parsed = JSON.parse(text)
        if (parsed?.schema !== CP_SCHEMA) throw new Error(`快照格式不认识：${parsed?.schema ?? '(无)'}`)
        return parsed
      } catch (error) {
        // 绝不因为一份坏文件就起不来：留证据、从空库开始，比进程沉默崩溃好得多
        lastError = error
        try { renameSync(file, `${file}.corrupt-${now()}`) } catch { /* 挪不动就算了 */ }
        return null
      }
    },
    save(getSnapshot) {
      if (closed) return
      pending = getSnapshot
      if (timer) return
      timer = setTimeout(() => {
        timer = null
        if (!pending) return
        const job = pending
        pending = null
        try { writeNow(job) } catch (error) {
          lastError = error
          console.error('[wbsync/cp] 落盘失败：', error?.message ?? error)
        }
      }, Math.max(0, debounceMs))
      timer.unref?.()
    },
    flush() {
      const ok = flush()
      if (!ok && lastError) console.error('[wbsync/cp] 落盘失败：', lastError?.message ?? lastError)
      return ok
    },
    close() {
      flush()
      closed = true
    },
    lastError: () => lastError,
  }
}
