/**
 * p1/client-core · 公共出口（S-2.4 / S-2.5）
 * ---------------------------------------------------------------
 * 三个 carrier 共用同一套上层调用；换 carrier 后 `watch/call` 调用序列不变
 * （单测锁死）。本包**不依赖任何 UI 框架**、不给 UI 供数。
 */

export {
  ERR, rpcOk, rpcError, assertCarrier, rpcFromResponse, RELAY_ENDPOINTS,
} from './carrier.js'
export { createDshMux } from './mux.js'
export { createHostSwitcher, SWITCH_ERR } from './host-switch.js'
export { createSessionWrites, SESSION_WRITE_ERR } from './session-writes.js'
export { createLocalCarrier } from './carriers/local.js'
export { createSshCarrier } from './carriers/ssh.js'
export { createRelayCarrier } from './carriers/relay.js'
export { CAPABILITY_TABLE } from './capabilities.js'
// v2.3 S-8.3（r23）：协议内置卡片契约——封闭 kind / 限额 / 频率闸门 / 灰色占位归一化。
export {
  CARD_T, CARD_SCHEMA, CARD_KINDS, CARD_LIMITS, CARD_ERR,
  validateCard, normalizeCard, cardFromEvent, createCardGuard,
} from './cards.js'