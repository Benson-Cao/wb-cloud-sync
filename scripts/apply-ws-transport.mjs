#!/usr/bin/env node
/** WS 长连落地后的状态回填（断言 + 备份，沿用前几轮纪律） */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const dryRun = process.argv.includes('--dry-run')
const L = (...lines) => lines.join('\n')

const EDITS = {
  'SIGN-OFF.md': [
    [L('| **P1 MVP（W3–W6）** | **W3 Relay 骨架 + 9/9 单测**（`p1/relay/`） | CP / WS 帧代理 / Host 插件 / PWA / 队列 / M1 验收 | 发起人豁免开发期；GA 前仍须补签 |'),
     L('| **P1 MVP（W3–W6）** | **W3 Relay 骨架 + Host WS 长连 + 16/16 单测**（`p1/relay/`） | 手机侧事件流 / CP 分离 / Host 插件 / PWA / 队列 / M1 验收 | 发起人豁免开发期；GA 前仍须补签 |')],
    [L('- 会签时请抄下 `capturedAt` / `git.head` / `fingerprints.data` / `fingerprints.signoff` 摘要写进签署栏备注，事后可复核。'),
     L('- **P1 代码（`p1/`）不在 P0 快照内**：`data` 组只含探针插件与 P0 证据；P1 代码由 CI 的「P1 Relay 冒烟测试」阻断把关，避免每次开发都让 P0 快照失效。',
       '',
       '- 会签时请抄下 `capturedAt` / `git.head` / `fingerprints.data` / `fingerprints.signoff` 摘要写进签署栏备注，事后可复核。')],
  ],

  'README.md': [
    [L('├─ p1/                          # P1 开发代码（W3 Relay 骨架，不进探针 tarball）'),
     L('├─ p1/                          # P1 开发代码（W3 Relay：HTTP + Host WS 长连，不进探针 tarball）')],
  ],

  'CHANGELOG.md': [
    [L('---', '', '## [发起人豁免 + P1 开工] · 2026-11-10 09:3x · 非协议变更'),
     L('---', '',
       '## [P1 W3 续] · 2026-11-10 10:0x · 非协议变更',
       '',
       '- **Host 侧传输从「HTTP 轮询桥」升级为「主动 WS 长连」**（`04` §5.2 / `03` §3.3 的正式形态）：新增 `p1/relay/src/ws.js`——零依赖 RFC 6455 子集，握手 + 单帧文本/关闭/心跳 + 客户端 mask 校验 + 1 MiB 上限，不做分片与扩展协商。换 `ws` / uWebSockets 时只替换该文件。',
       '- `WS /ws/host`：先 `host/register`（带 `HOST_TOKEN`，不匹配即 1008 关闭），再 `host/heartbeat` / `host/sessions`（索引上报）/ `http/response`；手机 HTTP 请求转 `http/request` 帧，**同一连接帧序即流序**。',
       "- **断连即离线**：WS 关闭立刻置 `state='offline'` 并移出 `state.sockets`，手机请求立即 409，不再等 45s 心跳窗口；HTTP 心跳可把状态拉回 online。`/health` 与 `/admin` 增加 `sockets` 与 `transport`（`ws` / `http-poll`）字段。",
       '- 轮询桥保留为**降级通道**（旧 Host 与单测），新增 `POST /host/sessions` 与 `GET /host/indexes` 供无 WS 场景上报与查询。',
       '- 测试从 9 增至 **16 个**（新增 `test/ws.test.mjs` 7 个）：握手、错误 `HOST_TOKEN` 断开、心跳 ack、索引上报可查、HTTP 经 WS 帧往返闭环、**多帧保序**、断连即离线、降级通道仍可用。`node --test` 16/16 PASS。',
       '- 文档：`p1/relay/README.md` 增加「传输形态」表与下一步；`SIGN-OFF.md` §零 P1 行与 §四补一条边界——**`p1/` 不进 P0 快照**，P1 代码由 CI 的 P1 冒烟测试把关，避免每次开发都让会签快照失效。',
       '',
       '**边界未变**：手机侧仍用 HTTP（事件流订阅属后续提交）；CP 未分离；Relay 不解析、不缓存、不落盘正文（ADR-010）。',
       '',
       '---', '',
       '## [发起人豁免 + P1 开工] · 2026-11-10 09:3x · 非协议变更')],
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

const backupDir = join(ROOT, '.revisions-backup-workbuddy', 'ws-transport')
mkdirSync(backupDir, { recursive: true })
for (const t of targets) {
  const rel = t.file.replace(ROOT, '').replace(/^[\\/]/, '').replace(/[\\/]/g, '__')
  writeFileSync(join(backupDir, rel), t.original, 'utf8')
  writeFileSync(t.file, t.result, 'utf8')
  console.log(`  wrote ${t.file}`)
}
console.log(`备份：${backupDir}`)
