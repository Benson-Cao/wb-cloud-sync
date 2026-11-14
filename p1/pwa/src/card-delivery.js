/**
 * PWA · 卡片事件投递（v2.3 S-8.3 / r23）
 * ---------------------------------------------------------------
 * 把「事件出口」与「卡片归一化」收在一处：live 与 replay 两条链路走同一个
 * `deliver()`，保证 TC-5.11 的三档案/回放视图拿到完全一致的卡片模型。
 *
 * 边界：
 *  - **不改事件原文**：`ev` 原样交给 `onEvent`，Relay/日志仍是唯一真源（ADR-010）；
 *  - 卡片另经 `client-core` 的 guard 校验与 `normalizeCard` 归一化后交给 `onCard`；
 *  - 未知 kind → 灰色占位，不静默丢弃（TC-5.12）；违规正文不交给渲染器（TC-1.12）；
 *  - 任何回调抛异常都被隔离，一张坏卡片不能中断整条消息流。
 */
import {
  cardFromEvent, createCardGuard, normalizeCard, CARD_ERR,
} from './cards.js'

export function createCardDelivery({
  onEvent = null,
  onCard = null,
  onStateChange = null,
  now = () => Date.now(),
} = {}) {
  const guard = createCardGuard({ now })

  /** @returns 卡片投递载荷；非卡片事件返回 null */
  const deliver = ({ sessionId, ev, source }) => {
    try { onEvent?.({ sessionId, ev, source }) } catch { /* 回调异常不影响事件流 */ }

    const raw = cardFromEvent(ev)
    if (!raw) return null

    const verdict = guard.check(raw)
    const model = normalizeCard(raw)
    if (verdict.code && !model.reason) model.reason = verdict.code
    if (verdict.degraded) {
      model.placeholder = true
      model.reason = CARD_ERR.DEGRADED
    }
    const payload = {
      sessionId,
      seq: Number.isInteger(ev?.seq) ? ev.seq : null,
      source,
      card: model,
      verdict,
    }
    try { onCard?.(payload) } catch { /* 同上 */ }
    // 问题数变化才刷状态：正常卡片不制造无意义的状态点抖动
    if (verdict.code) { try { onStateChange?.() } catch { /* 同上 */ } }
    return payload
  }

  return {
    deliver,
    snapshot: () => guard.snapshot(),
    reset: () => guard.reset(),
  }
}
