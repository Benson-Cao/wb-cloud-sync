/**
 * P1 W3 · 手机侧配对流程（零依赖，浏览器 / Node 通用）
 * ---------------------------------------------------------------
 * 流程（docs/04 §5.1、p1/relay README「已实现」表）：
 *   1. PC 端经宿主插件本地路由 `/__wbsync/pair` 向 Relay 登记一个 6 位码
 *      （`POST /pair/generate`，10 分钟 TTL，设备+IP 5 次/分限速）；
 *   2. 手机拿着「Relay 地址 + 6 位码」调 `pairWithRelay()`：
 *      `POST /pair`        → 换取一次性 challenge + per-challenge pairSecret
 *      （#2 裁定：pairSecret 一次性、不落盘、不参与令牌派生、不承担身份鉴别）；
 *      `POST /pair/verify` → 用 pairSecret 对 challenge 做 HMAC-SHA256，
 *      通过后换得 deviceToken（服务端只存 SHA-256 摘要）。
 *
 * r9 起有两个身份要分清：
 *   - `deviceId` = **目标 Host**（URL 里 `/d/<deviceId>/…` 用的是它）；
 *   - `phoneId`  = **这台手机自己**（服务端为它单独建一行，令牌挂在这行上）。
 * 两台手机因此各持一枚令牌、互不作废；同一台手机重配时把 `phoneId` 带上，
 * 服务端就只轮换它自己那枚令牌；不带上会被当成一台**新**手机（占一个名额）。
 *
 * HMAC 优先用 WebCrypto（`crypto.subtle`：HTTPS / localhost 安全上下文，Node ≥19
 * 全局 crypto 同接口）；**真机是局域网明文 HTTP**（如 `http://192.168.0.106:8787`），
 * 此时浏览器不给 `subtle`，自动回退 `hmac-sha256.js` 的纯 JS 实现。两条路径产出
 * 同一份标准 HMAC-SHA256 hex，与 Relay 侧 node:crypto 逐字节一致。
 * 这个缺口只有真机跑得出来——Node 测试里 subtle 永远存在，必须显式传
 * `subtle: null` 才能覆盖回退路径（见 pairing.test.mjs）。
 *
 * 注意：配对码是一次性的——`/pair` 成功即消费；输错码 / 复用旧码会得到
 * `PAIR_CODE_INVALID`，界面上应引导用户回 PC 重新生成。
 */

import { hmacSha256Hex } from './hmac-sha256.js'

const hexOf = (buffer) => [...new Uint8Array(buffer)]
  .map((b) => b.toString(16).padStart(2, '0'))
  .join('')

const fail = (code, message) => Object.assign(new Error(message), { code })

/** 原生 WebCrypto 可用则用之，否则纯 JS 回退（HTTP 局域网真机）。 */
const signHmac = async (subtle, secret, message) => {
  if (subtle?.importKey && subtle?.sign) {
    const encoder = new TextEncoder()
    const key = await subtle.importKey(
      'raw', encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    )
    return hexOf(await subtle.sign('HMAC', key, encoder.encode(message)))
  }
  return hmacSha256Hex(secret, message)
}

export async function pairWithRelay({
  baseUrl,
  code,
  phoneId = null,       // 本机既有身份：带上就只轮换自己那枚令牌（r9）
  phoneIdFor = null,    // (hostDeviceId) => phoneId | null：两段式配对用，见下
  clientName = null,    // 仅作管理台展示，不参与任何判定
  fetchImpl = globalThis.fetch,
  subtle = globalThis.crypto?.subtle,
} = {}) {
  if (!baseUrl || !code) throw fail('INVALID_PARAM', '需要 baseUrl 与 6 位配对码')
  if (typeof fetchImpl !== 'function') throw fail('INVALID_PARAM', 'fetchImpl 必须是函数')

  const base = String(baseUrl).replace(/\/$/, '')
  const post = async (path, body) => {
    let r
    try {
      r = await fetchImpl(`${base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    } catch (error) {
      throw fail('RELAY_UNREACHABLE', `Relay 不可达：${error?.message ?? error}`)
    }
    const payload = await r.json().catch(() => null)
    if (!payload) throw fail('INVALID_RESPONSE', `响应不是 JSON（HTTP ${r.status}）`)
    if (payload.ok !== true) {
      throw fail(payload.error?.code ?? `HTTP_${r.status}`, payload.error?.message ?? '配对请求被拒绝')
    }
    return payload.data
  }

  // 一次性挑战 + per-challenge pairSecret（60s 内必须完成 verify）
  const challenge = await post('/pair', { code: String(code).trim() })
  if (!challenge?.challenge || !challenge?.pairSecret) {
    throw fail('INVALID_RESPONSE', '配对响应缺少 challenge / pairSecret')
  }
  const sig = await signHmac(subtle, challenge.pairSecret, challenge.challenge)

  // **两段式**：走到这里才知道目标 Host 是谁（challenge.deviceId），再决定用哪个本机身份。
  // 为什么必须这样：换地址重配时若拿不到旧身份，服务端会当成一台**新手机**——
  // 旧的那行就变成「僵尸」（令牌仍有效、但已没人用，还在占手机名额）。
  // 用 hostDeviceId 去档案里找回旧 phoneId，重配就还是同一台手机。
  const hostDeviceId = challenge.deviceId ?? null
  const resolvedPhoneId = (typeof phoneIdFor === 'function' ? phoneIdFor(hostDeviceId) : null) ?? phoneId

  const verifyBody = { challenge: challenge.challenge, sig }
  if (resolvedPhoneId) verifyBody.phoneId = resolvedPhoneId
  if (clientName) verifyBody.clientName = clientName
  const done = await post('/pair/verify', verifyBody)
  if (!done?.deviceToken) throw fail('INVALID_RESPONSE', '配对响应缺少 deviceToken')
  return {
    deviceToken: done.deviceToken,
    // deviceId 保持「目标 Host」语义（页面里的 URL 全靠它），旧 Relay 只回 deviceId
    deviceId: done.hostDeviceId ?? challenge.deviceId,
    phoneId: done.deviceId ?? null,
    relayUrl: done.relayUrl ?? base,
  }
}
