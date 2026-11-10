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
 *      通过后换得 deviceToken（服务端只存 SHA-256 摘要，单活跃令牌）。
 *
 * HMAC 用 WebCrypto（`crypto.subtle`）：浏览器原生可用，Node ≥19 的全局
 * `globalThis.crypto` 也是同一套接口，测试不用引 node:crypto 进实现。
 *
 * 注意：配对码是一次性的——`/pair` 成功即消费；输错码 / 复用旧码会得到
 * `PAIR_CODE_INVALID`，界面上应引导用户回 PC 重新生成。
 */

const hexOf = (buffer) => [...new Uint8Array(buffer)]
  .map((b) => b.toString(16).padStart(2, '0'))
  .join('')

const fail = (code, message) => Object.assign(new Error(message), { code })

export async function pairWithRelay({
  baseUrl,
  code,
  fetchImpl = globalThis.fetch,
  subtle = globalThis.crypto?.subtle,
} = {}) {
  if (!baseUrl || !code) throw fail('INVALID_PARAM', '需要 baseUrl 与 6 位配对码')
  if (typeof fetchImpl !== 'function') throw fail('INVALID_PARAM', 'fetchImpl 必须是函数')
  if (!subtle?.importKey || !subtle?.sign) {
    throw fail('NO_WEBCRYPTO', '当前环境没有 WebCrypto（crypto.subtle），无法计算配对签名')
  }

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
  const encoder = new TextEncoder()
  const key = await subtle.importKey(
    'raw', encoder.encode(challenge.pairSecret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  const sig = hexOf(await subtle.sign('HMAC', key, encoder.encode(challenge.challenge)))

  const done = await post('/pair/verify', { challenge: challenge.challenge, sig })
  if (!done?.deviceToken) throw fail('INVALID_RESPONSE', '配对响应缺少 deviceToken')
  return {
    deviceToken: done.deviceToken,
    deviceId: challenge.deviceId,      // 配对码登记时绑定的 Host 设备
    relayUrl: done.relayUrl ?? base,
  }
}
