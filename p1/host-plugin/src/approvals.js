/**
 * 审批转发桥（W8）· 把宿主的 `approval/request` 瀑布接到手机上
 * ---------------------------------------------------------------
 * 宿主实测契约（app.asar `interface ApprovalRequest` / `type ApprovalOutcome`）：
 *
 *   ctx.on('approval/request', (request, next) => Promise<ApprovalOutcome>)
 *   request: { agent, toolName, callId?, reason?, displayReason?, signal? }
 *   ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
 *   next(): 交棒给下一个应答方（桌面端自己的弹窗）。同步/异步调用均可。
 *
 * 三条不变量，改这块前先读：
 *   1. **手机不在线时必须 `next()`**。桌面端不能因为手机没连上就卡住审批——
 *      这是「手机是遥控器，不是闸门」的底线。
 *   2. **先答先得**。`signal` 被 abort（桌面端先答了、轮次取消、会话关掉）时，
 *      立刻把这一单从账本上摘掉并通知手机撤卡，不许两头都能改结果。
 *   3. **超时也 `next()`**，不返回 `unavailable`：`unavailable` 会让整次工具调用
 *      直接被拒（宿主语义是「无人可审批」），而超时只是「手机没来得及答」，
 *      桌面端还有机会接。
 */
import { randomUUID } from 'node:crypto'

const OUTCOMES = new Set(['allowed-once', 'rejected', 'cancelled'])

/** 把宿主给的 displayReason 收敛成一个字符串：优先中文，其次 en，最后退回 reason。 */
export const pickReason = (request) => {
  const d = request?.displayReason
  if (d && typeof d === 'object') {
    const zh = d.zh ?? d['zh-CN'] ?? d['zh-Hans'] ?? d.zh_CN
    if (typeof zh === 'string' && zh.trim()) return zh.trim()
    if (typeof d.en === 'string' && d.en.trim()) return d.en.trim()
  }
  if (typeof request?.reason === 'string' && request.reason.trim()) return request.reason.trim()
  return null
}

/**
 * @param send          (frame) => boolean  上行帧发送器；返回 false 表示没连上
 * @param timeoutMs     手机应答窗口；超时后交棒给桌面端
 * @param now           注入时钟（测试用）
 * @param log           注入日志（默认不输出）
 */
export function createApprovalBridge({ send, timeoutMs = 120_000, now = Date.now, log = () => {} } = {}) {
  const pending = new Map()   // approvalId -> { sessionId, toolName, resolve, timer, detach, expireAt }
  const stats = { requested: 0, answeredByPhone: 0, delegatedOffline: 0, delegatedTimeout: 0, aborted: 0, staleAnswers: 0 }

  const drop = (approvalId) => {
    const entry = pending.get(approvalId)
    if (!entry) return null
    pending.delete(approvalId)
    if (entry.timer) clearTimeout(entry.timer)
    if (entry.detach) { try { entry.detach() } catch { /* 已 detach */ } }
    return entry
  }

  /** 通知手机把卡片撤掉（不管是谁先答的）。 */
  const notifyResolved = (entry, outcome, by) => {
    try {
      send({ t: '$events/resolved', approvalId: entry.approvalId, outcome, by })
    } catch { /* 手机已断开：它下次拉列表时自然拿不到这条 */ }
  }

  /**
   * 注册到 ctx.on('approval/request', ...)。
   * 返回 ApprovalOutcome 或 next() 的结果。
   */
  const onRequest = async (request, next) => {
    const sessionId = request?.agent?.session?.id
    const callId = request?.callId
    // 拿不到会话就无从对应手机上的哪个会话，直接交棒，不试图猜
    if (!sessionId) return next()

    const approvalId = randomUUID()
    const frame = {
      t: '$events/request',
      approvalId,
      sessionId,
      toolName: typeof request.toolName === 'string' ? request.toolName : 'unknown',
      callId: callId ?? null,
      reason: pickReason(request),
      expiresAt: now() + timeoutMs,
    }
    stats.requested++
    if (!send(frame)) {
      // 手机不在线：不占着这单，让桌面端照常问
      stats.delegatedOffline++
      return next()
    }

    return new Promise((resolve) => {
      const settle = (outcome) => {
        const entry = drop(approvalId)
        if (!entry) return
        if (outcome === 'timeout') {
          stats.delegatedTimeout++
          notifyResolved(entry, 'cancelled', 'timeout')
          resolve(next())
          return
        }
        notifyResolved(entry, outcome, 'phone')
        resolve(outcome)
      }

      const timer = setTimeout(() => settle('timeout'), Math.max(1, timeoutMs))
      // 故意**不** unref：这单必须真的等到时间到才能交棒给桌面端。
      // unref 会让「只剩等待器」的场景直接退出事件循环，await 永远不落地。

      // 宿主 abort = 别人先答了 / 轮次没了：撤卡并交棒（下一次瀑布由宿主自己收尾）
      let onAbort = null
      const signal = request.signal
      if (signal && typeof signal.addEventListener === 'function') {
        onAbort = () => {
          const entry = drop(approvalId)
          if (!entry) return
          stats.aborted++
          notifyResolved(entry, 'cancelled', 'host')
          // 已经被别人答掉，交棒即可（宿主不会再等我们）
          resolve(next())
        }
        if (signal.aborted) { onAbort(); return }
        signal.addEventListener('abort', onAbort, { once: true })
      }

      pending.set(approvalId, {
        approvalId, sessionId, toolName: frame.toolName, expireAt: frame.expiresAt,
        resolve, timer,
        detach: () => { if (onAbort && signal?.removeEventListener) signal.removeEventListener('abort', onAbort) },
      })
    })
  }

  /** 手机点「允许 / 拒绝」→ 落到这里。返回是否被接受（先答先得）。 */
  const answer = ({ approvalId, outcome }) => {
    if (!OUTCOMES.has(outcome)) return { ok: false, code: 'INVALID_OUTCOME' }
    const entry = pending.get(approvalId)
    if (!entry) {
      stats.staleAnswers++
      return { ok: false, code: 'APPROVAL_GONE' }
    }
    drop(approvalId)
    stats.answeredByPhone++
    notifyResolved(entry, outcome, 'phone')
    try { entry.resolve(outcome) } catch { /* 宿主已放弃等待 */ }
    return { ok: true, outcome }
  }

  /** 手机上线后拉取未决清单。 */
  const list = () => [...pending.values()].map((e) => ({
    approvalId: e.approvalId, sessionId: e.sessionId, toolName: e.toolName, expireAt: e.expireAt,
  }))

  const dispose = () => {
    for (const id of [...pending.keys()]) {
      const e = drop(id)
      if (!e) continue
      notifyResolved(e, 'cancelled', 'shutdown')
      try { e.resolve('cancelled') } catch { /* 忽略 */ }
    }
  }

  return { onRequest, answer, list, dispose, stats, pending }
}
