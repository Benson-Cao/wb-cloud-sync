#!/usr/bin/env node
/**
 * W6 内测前置 · 环境自检
 * ---------------------------------------------------------------
 * 内测最贵的浪费是「环境没起来就开始记 bug」：手机连不上、relay 没起、上新版没刷到，
 * 这三件事会伪装成功能缺陷，而它们各自都有一眼能看出的特征。
 *
 *   node scripts/beta-check.mjs                                  # 打本机 127.0.0.1:8787
 *   node scripts/beta-check.mjs --base http://192.168.0.103:8787 --admin <token>
 *   node scripts/beta-check.mjs --json                            # 机读，便于贴进 issue
 *
 * 判定只有三种：PASS / FAIL / SKIP。
 *   - FAIL = 内测不该开始，先修环境；
 *   - SKIP = 缺凭据看不出来（例如没给 admin token 就数不了手机），不算失败，但纪要要写明。
 *
 * 退出码：0 = 没有 FAIL；1 = 至少一条 FAIL。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PROTOCOL = 'wbsync/2.3'

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

const get = async (base, path, headers = {}) => {
  try {
    const r = await fetch(base + path, { headers })
    const body = await r.text()
    let json = null
    try { json = JSON.parse(body) } catch { /* 静态资源不是 JSON */ }
    return { status: r.status, body, json }
  } catch (error) {
    return { status: 0, body: '', json: null, error: error?.message ?? String(error) }
  }
}

/**
 * 跑一遍自检。**不抛异常**：每一项的失败都变成一条 FAIL，由调用方决定怎么呈现。
 * @returns {{ checks: Array<{id:string,label:string,status:'PASS'|'FAIL'|'SKIP',detail:string}>, ok:boolean }}
 */
export async function runBetaCheck({
  base = process.env.WBSYNC_BASE ?? 'http://127.0.0.1:8787',
  adminToken = process.env.WBSYNC_ADMIN_TOKEN ?? '',
  cpFile = process.env.WBSYNC_CP_FILE ?? join(homedir(), '.wbsync', 'cp.json'),
  root = ROOT,
} = {}) {
  const checks = []
  const add = (id, label, status, detail) => checks.push({ id, label, status, detail })
  const admin = adminToken ? { Authorization: `Bearer ${adminToken}` } : {}

  // B1 relay 活着 + 协议版本对得上
  const health = await get(base, '/health')
  if (health.status !== 200 || health.json?.ok !== true) {
    add('B1', 'relay 可达', 'FAIL', health.error ? `连不上：${health.error}` : `HTTP ${health.status}`)
  } else if (health.json.protocol !== PROTOCOL) {
    add('B1', 'relay 可达', 'FAIL', `协议是 ${health.json.protocol}，期望 ${PROTOCOL}`)
  } else {
    add('B1', 'relay 可达', 'PASS', `${base} · protocol=${health.json.protocol}`)
  }

  // B2 宿主在线（这是内测的硬前提：PC 不在线，手机上什么都点不出来）
  const online = health.json?.data?.online ?? 0
  add('B2', 'PC 宿主在线', online >= 1 ? 'PASS' : 'FAIL',
    online >= 1 ? `${online} 台在线 · ${health.json.data.sockets} 条 WS` : '没有在线 Host：先确认 DSH 与插件已加载')

  // B3 设备与手机清单（需要 admin token）
  let hostRows = []
  if (!adminToken) {
    const admin401 = await get(base, '/admin')
    add('B3', '设备清单 / 已配对手机', 'SKIP',
      admin401.status === 401
        ? '该 relay 配了 admin token，请用 --admin 传入后再数手机'
        : '未传 --admin，跳过手机清单（不影响内测，只是纪要里少一项证据）')
  } else {
    const adminRes = await get(base, '/admin', admin)
    if (adminRes.status !== 200 || adminRes.json?.ok !== true) {
      add('B3', '设备清单 / 已配对手机', 'FAIL', `GET /admin → HTTP ${adminRes.status}`)
    } else {
      hostRows = (adminRes.json.data.rows ?? []).filter((r) => r.role !== 'phone')
      const phones = hostRows.flatMap((r) => (r.phones ?? []).map((p) => ({ ...p, host: r.deviceId })))
      const usable = hostRows.filter((r) => r.state === 'online' && !r.tombstone)
      add('B3', '设备清单 / 已配对手机', usable.length ? 'PASS' : 'FAIL',
        `${hostRows.length} 台电脑（${usable.length} 在线）· ${phones.length} 台手机`
        + (phones.length ? `：${phones.map((p) => p.deviceId).join(', ')}` : '（还没有手机配对）'))
    }
  }

  // B4 会话索引非空：空列表会让「发消息」这一步无从下手
  if (!adminToken || !hostRows.length) {
    add('B4', '会话索引', 'SKIP', '需要 admin token + 至少一台电脑')
  } else {
    const host = hostRows.find((r) => r.state === 'online') ?? hostRows[0]
    const idx = await get(base, `/host/indexes?deviceId=${encodeURIComponent(host.deviceId)}`, admin)
    const rows = idx.json?.data?.rows ?? []
    add('B4', '会话索引', rows.length ? 'PASS' : 'FAIL',
      rows.length ? `${host.deviceId} 报了 ${rows.length} 个会话` : '一台会话都没有：先在 PC 上开一个会话，否则手机上没东西可点')
  }

  // B5 CP 落盘：没有这份文件 = 重启就会把所有手机踢掉
  if (cpFile === ':memory:') {
    add('B5', 'CP 落盘', 'SKIP', '明确关掉了（WBSYNC_CP_FILE=:memory:）：重启会让手机掉配对')
  } else if (!existsSync(cpFile)) {
    add('B5', 'CP 落盘', 'FAIL', `${cpFile} 不存在：relay 是否用 run.mjs 启动？重启会掉配对`)
  } else {
    try {
      const snap = JSON.parse(readFileSync(cpFile, 'utf8'))
      const devices = (snap.devices ?? []).length
      const sessions = (snap.sessions ?? []).length
      add('B5', 'CP 落盘', snap.schema === 'wbsync.cp/1' ? 'PASS' : 'FAIL',
        `schema=${snap.schema} · ${devices} 台设备 / ${sessions} 个会话 · ${cpFile}`)
    } catch (error) {
      add('B5', 'CP 落盘', 'FAIL', `读不动（${error.message}）：可能写坏了，看有没有 .corrupt- 备份`)
    }
  }

  // B6 线上壳页面与仓库同源：手机刷到旧版是最容易被误判成 bug 的一种「假故障」
  const servedSw = await get(base, '/app/sw.js')
  const localSw = join(root, 'p1/pwa/public/sw.js')
  if (servedSw.status !== 200) {
    add('B6', '壳页面版本', 'FAIL', `/app/sw.js → HTTP ${servedSw.status}`)
  } else if (!existsSync(localSw)) {
    add('B6', '壳页面版本', 'SKIP', '仓库里没有 p1/pwa/public/sw.js，无法比对')
  } else {
    const pick = (text) => /SHELL_CACHE\s*=\s*'([^']+)'/.exec(text)?.[1] ?? '(未标注)'
    const served = pick(servedSw.body)
    const local = pick(readFileSync(localSw, 'utf8'))
    add('B6', '壳页面版本', served === local ? 'PASS' : 'FAIL',
      served === local ? `${served}（relay 与仓库一致）` : `relay=${served} / 仓库=${local}：重启 relay 或检查部署`)
  }

  // B7 手机要用的静态资源都在（缺一个就是白屏，且报错不好读）
  const assets = ['/app/', '/src/client.js', '/src/transcript.js', '/src/pairing.js']
  const missing = []
  for (const path of assets) {
    const r = await get(base, path)
    if (r.status !== 200) missing.push(`${path}(${r.status})`)
  }
  add('B7', '壳页面资源完整', missing.length ? 'FAIL' : 'PASS',
    missing.length ? `取不到：${missing.join(' ')}` : `${assets.length} 个资源均 200`)

  // B8 与本机时间无关的一条留白检查：手机能不能访问取决于它自己那条网络，脚本只能提示
  add('B8', '手机侧网络', 'SKIP', `手机要能打开 ${base.replace('127.0.0.1', '<本机局域网IP>')}/app —— 这条只能由手机实测`)

  return { checks, ok: checks.every((c) => c.status !== 'FAIL') }
}

/* ------------------------------------------------------------------ CLI */

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const argOf = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`)
    return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
  }
  const base = argOf('base', process.env.WBSYNC_BASE ?? 'http://127.0.0.1:8787').replace(/\/$/, '')
  const adminToken = argOf('admin', process.env.WBSYNC_ADMIN_TOKEN ?? '')
  const result = await runBetaCheck({ base, adminToken })

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ base, ...result }, null, 2))
  } else {
    const mark = { PASS: 'PASS', FAIL: 'FAIL', SKIP: 'SKIP' }
    console.log(`WBSync 内测环境自检 · ${base}`)
    for (const c of result.checks) {
      console.log(`  ${c.id} ${mark[c.status]}  ${c.label} —— ${c.detail}`)
    }
    const fails = result.checks.filter((c) => c.status === 'FAIL')
    console.log(fails.length
      ? `\n判定：**${fails.length} 项 FAIL**，先把环境修好再开始内测（${fails.map((c) => c.id).join(', ')}）`
      : '\n判定：**可以开始内测**（FAIL 0；SKIP 项见上，纪要里注明即可）')
  }
  process.exit(result.ok ? 0 : 1)
}
