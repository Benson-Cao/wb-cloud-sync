#!/usr/bin/env node
/**
 * 真机验证结论回填（v1.1 之后的增量批次，3 处）
 * ---------------------------------------------------------------
 * 与 apply-spike-revisions.mjs 分开记录：那一批是「Spike 实测 → 契约修订」，
 * 这一批是「真机跑通 → 风险/门禁状态更新」，语义不同、时点不同。
 *
 * 同样采用串行替换 + 每处「恰好 1 次命中」断言 + 原文备份，避免半份写入。
 * 用法：node scripts/apply-realdevice-updates.mjs [--dry-run] [docs-dir]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const DRY = args.includes('--dry-run')
const DOCS = args.find((a) => !a.startsWith('--')) ??
  'C:/Users/Administrator/Desktop/wb-cloud-sync-docs'
const BACKUP = 'D:/Dw phone/wb-cloud-sync/.revisions-backup-realdevice'

const edits = {
  '01_项目章程.md': [[
    '**真机加载验证与四方会签仍待完成**，P0 门禁整体未过。',
    '**真机加载与运行时事件闭环已于 18:34 完成全 PASS**（见仓库 `spike/REPORT.md` §4.1.2），W1 Spike 三问判 PASS；**P0 仅剩四方会签 + ADR 会签**，会签完成前仍不得进入 P1 编码。',
  ]],
  '02_需求规格说明书.md': [[
    '2026-11-07 离线取证三问全 PASS，真机加载待补。',
    '2026-11-07 离线取证三问全 PASS；18:34 真机加载 + 运行时事件闭环 8/8 PASS（19 条事件 `seq` 4→22 与落盘日志逐条一致），三问判 PASS。',
  ]],
  '09_风险登记册.md': [[
    '**真机加载验证待补**，风险暂记「待真机复核」，不关闭。',
    '**真机加载与事件闭环已于 18:34 全 PASS**（见仓库 `spike/REPORT.md` §4.1.2），三问判 PASS，风险待四方会签后关闭。',
  ]],
}

if (!DRY) mkdirSync(BACKUP, { recursive: true })
let total = 0
for (const [file, pairs] of Object.entries(edits)) {
  const path = join(DOCS, file)
  if (!existsSync(path)) throw new Error(`找不到文档：${path}`)
  const original = readFileSync(path, 'utf8')
  let text = original
  for (const [index, [from, to]] of pairs.entries()) {
    const count = text.split(from).length - 1
    if (count !== 1) throw new Error(`${file} 第 ${index + 1} 处：期望 1 次命中，实际 ${count}\n  old=${JSON.stringify(from.slice(0, 100))}`)
    text = text.replace(from, to)
  }
  if (!DRY) {
    writeFileSync(join(BACKUP, file), original, 'utf8')
    writeFileSync(path, text, 'utf8')
  }
  console.log(`${DRY ? 'DRY' : 'OK '} ${file.padEnd(28)} ${pairs.length} 处`)
  total += pairs.length
}
console.log(`\n共 ${Object.keys(edits).length} 份 / ${total} 处；备份：${BACKUP}`)
