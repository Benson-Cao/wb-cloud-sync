#!/usr/bin/env node
/** 手机事件流落地后的状态回填（断言 + 备份） */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const dryRun = process.argv.includes('--dry-run')
const L = (...lines) => lines.join('\n')

const EDITS = {
  'SIGN-OFF.md': [
    [L('| **P1 MVP（W3–W6）** | **W3 Relay 骨架 + Host WS 长连 + 16/16 单测**（`p1/relay/`） | 手机侧事件流 / CP 分离 / Host 插件 / PWA / 队列 / M1 验收 | 发起人豁免开发期；GA 前仍须补签 |'),
     L('| **P1 MVP（W3–W6）** | **W3 Relay：配对 / Host WS 长连 / 手机事件订阅 + 23/23 单测**（`p1/relay/`） | 重启后历史补齐 / CP 分离 / Host 插件 / PWA / 队列 / M1 验收 | 发起人豁免开发期；GA 前仍须补签 |')],
  ],

  'CHANGELOG.md': [
    [L('---', '', '## [P1 W3 续] · 2026-11-10 10:0x · 非协议变更'),
     L('---', '',
       '## [P1 W3 续 2] · 2026-11-10 10:1x · 非协议变更',
       '',
       '- **手机侧事件流落地**：新增 `p1/relay/src/events.js`（事件缓冲 + 订阅广播）。`seq` 从 0 连续，**只广播连续前缀**：收到 `0, 2, 1` 时 `2` 先到不推，等 `1` 到达后按 `1, 2` 顺序推。订阅带 `sinceSeq` 补发；补不上发 `session/gap{expectedSeq}`，`session/replay{fromSeq,toSeq,complete}` 标记区间，**不静默跳过**。',
       '- **订阅路由**：`WS /d/<deviceId>/events/<sessionId>?token=&sinceSeq=`。浏览器 WebSocket 不能设 Authorization 头，令牌走 query（注释写明不得写日志）；未鉴权 401、Host 离线 409，在握手阶段直接拒绝。',
       '- 缓冲只留 `eventBuffer`（默认 1000）条，只裁 `delivered` 之前的老条目；不落盘、不解析 `ev.data`（ADR-010）。',
       '- 测试 16 → **23**（新增 `test/events.test.mjs` 7 个）：实时按序到达、带 `sinceSeq` 只补未消费、**乱序只推连续前缀**、补不上报 `gap`、未鉴权 / 错令牌拒绝、Host 离线拒绝、重复 `seq` 不重复入缓冲。',
       '- **修两个自己写出来的缺陷**：① 测试辅助 `assertNoMessage` 挂了一个未取消的 `inbox.next()`，120ms 后到达的帧被它吞掉导致断言错位 → 改为只看队列长度；② `stop()` 只关 Host 的 WS、没关手机订阅连接，`server.close()` 一直等 → 新增 `hub.closeAll()` + `closeAllConnections()` + 2s 兜底。',
       '- 语义收紧：客户端要的位置早于缓冲起点时**一条都不补**，直接 `replay(complete=false)` + `gap`，避免跳跃式补发。',
       '- 文档：relay README 增加「事件流语义」小节与传输形态表；`SIGN-OFF.md` §零 P1 行更新。改 README 后重打包保 G9。',
       '',
       '**边界未变**：缓冲在内存、进程重启即丢（`~/.dsh` 日志仍是唯一真源），重启补齐要回 Host 读日志，属下一步；CP 未分离；Relay 不解析正文。',
       '',
       '---', '',
       '## [P1 W3 续] · 2026-11-10 10:0x · 非协议变更')],
  ],
}

const targets = Object.entries(EDITS).map(([name, reps]) => ({ file: join(ROOT, name), reps }))
let problems = 0
for (const t of targets) {
  if (!existsSync(t.file)) { console.error(`MISSING ${t.file}`); problems++; continue }
  const text = readFileSync(t.file, 'utf8')
  t.original = text
  let next = text
  for (let i = 0; i < t.reps.length; i++) {
    const [from] = t.reps[i]
    const hits = next.split(from).length - 1
    if (hits !== 1) {
      console.error(`HIT ${hits} (want 1)  ${basename(t.file)}  repl#${i + 1}  ${from.slice(0, 70).replace(/\n/g, '\\n')}`)
      problems++
    } else {
      next = next.replace(from, t.reps[i][1])
    }
  }
  t.result = next
}
if (problems) {
  console.error(`\nABORT: ${problems} 处断言失败，未写入任何文件。`)
  process.exit(1)
}
console.log(`断言全过：${targets.length} 个文件 / ${targets.reduce((n, t) => n + t.reps.length, 0)} 处替换` + (dryRun ? '（--dry-run，未写盘）' : ''))
if (dryRun) process.exit(0)

const backupDir = join(ROOT, '.revisions-backup-workbuddy', 'events-stream')
mkdirSync(backupDir, { recursive: true })
for (const t of targets) {
  const rel = t.file.replace(ROOT, '').replace(/^[\\/]/, '').replace(/[\\/]/g, '__')
  writeFileSync(join(backupDir, rel), t.original, 'utf8')
  writeFileSync(t.file, t.result, 'utf8')
  console.log(`  wrote ${t.file}`)
}
console.log(`备份：${backupDir}`)
