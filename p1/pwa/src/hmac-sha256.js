/**
 * P1 W3 · 纯 JS 的 SHA-256 / HMAC-SHA256（零依赖，浏览器 / Node 同构）
 * ---------------------------------------------------------------
 * 为什么需要它：`crypto.subtle` **只在安全上下文可用**（HTTPS、localhost、
 * 127.0.0.1）。真机联调时手机通过 `http://192.168.0.106:8787/app` 这类
 * 「局域网 IP + 明文 HTTP」访问 Relay，浏览器里 `globalThis.crypto` 存在但
 * `crypto.subtle` 是 undefined —— 原实现会直接抛 NO_WEBCRYPTO，配对全链路断掉。
 * Node 里的测试跑不出这个差异（Node ≥19 的全局 crypto 永远带 subtle），
 * 这是只有真机能暴露的环境缺口。
 *
 * 策略：`pairing.js` 优先用原生 WebCrypto（HTTPS / localhost 正式部署形态），
 * 缺失时回退本文件的纯 JS 实现（HTTP 局域网真机形态）。两条路径产出同一份
 * 标准 HMAC-SHA256 hex，与 Relay 侧 `node:crypto.createHmac('sha256', ...)
 * .update(...).digest('hex')` 逐字节一致。
 *
 * 安全边界：HMAC-SHA256 是标准构造，纯 JS 实现不降低密码学强度。配对签名只对
 * 一次性 challenge 计算一次，pairSecret 短命且一次性，不存在自适应查询下的
 * 时序侧信道利用面。GA 前仍按 M5 由安全 Owner 复核。
 *
 * 实现遵循 FIPS 180-4（SHA-256）与 RFC 2104（HMAC）；所有 32 位运算显式
 * `>>> 0`，避免 JS number 累加越界。
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

const H_INIT = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
])

const rotr = (x, n) => ((x >>> n) | (x << (32 - n))) >>> 0

const hexOf = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')

/** SHA-256，输入 Uint8Array，返回 32 字节 Uint8Array。 */
export function sha256(bytes) {
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const bitLen = input.length * 8
  const padded = new Uint8Array(Math.ceil((input.length + 9) / 64) * 64)
  padded.set(input)
  padded[input.length] = 0x80
  const view = new DataView(padded.buffer)
  // 64 位大端长度；消息长度在 JS 安全整数内，高 32 位用除法、低 32 位用 ToUint32
  view.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000), false)
  view.setUint32(padded.length - 4, bitLen >>> 0, false)

  const h = H_INIT.slice()
  const w = new Uint32Array(64)
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4, false)
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15]
      const y = w[i - 2]
      const s0 = (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) >>> 0
      const s1 = (rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10)) >>> 0
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
    }
    let [a, b, c, d, e, f, g, hh] = h
    for (let i = 0; i < 64; i++) {
      const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0
      const ch = ((e & f) ^ (~e & g)) >>> 0
      const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0
      const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0
      const t2 = (S0 + maj) >>> 0
      hh = g; g = f; f = e; e = (d + t1) >>> 0
      d = c; c = b; b = a; a = (t1 + t2) >>> 0
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0
    h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0
    h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0
  }
  const out = new Uint8Array(32)
  const outView = new DataView(out.buffer)
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, h[i], false)
  return out
}

/** SHA-256 hex（测试向量用）。 */
export const sha256Hex = (bytes) => hexOf(sha256(bytes))

const toBytes = (value) => {
  if (typeof value === 'string') return new TextEncoder().encode(value)
  return value instanceof Uint8Array ? value : new Uint8Array(value)
}

const concat = (a, b) => {
  const out = new Uint8Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}

/**
 * HMAC-SHA256，返回小写 hex（与 `createHmac('sha256', key).update(msg).digest('hex')` 一致）。
 * secret / message 可为 string（UTF-8）或 Uint8Array。
 */
export function hmacSha256Hex(secret, message) {
  let key = toBytes(secret)
  if (key.length > 64) key = sha256(key)
  const msg = toBytes(message)
  const ipad = new Uint8Array(64)
  const opad = new Uint8Array(64)
  for (let i = 0; i < 64; i++) {
    const b = key[i] ?? 0
    ipad[i] = b ^ 0x36
    opad[i] = b ^ 0x5c
  }
  return hexOf(sha256(concat(opad, sha256(concat(ipad, msg)))))
}
