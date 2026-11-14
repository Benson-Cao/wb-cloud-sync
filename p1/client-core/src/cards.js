/**
 * v2.3 · S-8.3 协议内置卡片契约（client-core 公共出口）
 * ---------------------------------------------------------------
 * **唯一实现在 `p1/pwa/src/cards.js`**，这里只做再导出。
 *
 * 为什么实现放在 pwa/src：Relay 的静态服务根只有 `p1/pwa/public`（`/app`）与
 * `p1/pwa/src`（`/src`）。浏览器加载 `/src/card-delivery.js` 时若 import
 * `../../client-core/...` 会跳出静态根、拿到 404，离线壳也缓存不到。把契约放在
 * PWA 可服务的目录、Node 侧库经相对路径再导出，就能保证**一份实现、两端可用**，
 * 不会出现两份契约悄悄漂移。
 */
export {
  CARD_T, CARD_SCHEMA, CARD_KINDS, CARD_LIMITS, CARD_ERR,
  validateCard, normalizeCard, cardFromEvent, createCardGuard,
} from '../../pwa/src/cards.js'
