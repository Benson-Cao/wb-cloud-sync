/**
 * v2.3 · S-8.3 协议内置卡片（`wbsync/card`）契约与校验
 * ---------------------------------------------------------------
 * 依据：v2.3 04 §4「工具卡契约」/ §4.1 事件分类、02 FR-3.3、03 ADR-011/015、
 * 07 TC-1.12 / TC-5.11 / TC-5.12。
 *
 * 三条不可动摇的边界：
 *  1. **Relay 只做帧透传**（P5 / ADR-010），不解析事件正文、不改日志原文；
 *     校验发生在发送端的契约层与接收端的归一化层，绝不改写 `SessionEvent`。
 *  2. `kind` 是**封闭枚举**：新增 kind 必须升 `CARD_SCHEMA` 并走协议变更流程。
 *     未知 kind 不是错误——客户端显示灰色占位，**不静默丢弃、不降级**（TC-5.12）。
 *  3. 客户端只渲染 JSON 数据，**不执行任何插件代码**；违规正文不交给渲染器。
 *
 * 限额（04 §4）：单卡 ≤ 8 KiB、面板视图 ≤ 32 KiB、合并 ≤ 4 Hz、效果窗口 3s；
 * 清单校验失败只丢弃该条目并标注问题数，连续 5 次违规整体降级为 web 版本，
 * `reset()`（重启引擎 / 重新启用）后恢复。
 *
 * 纯函数 + 显式规则，不依赖 UI 框架、不依赖 Node 专有 API（TextEncoder 两端都有）。
 */

export const CARD_T = 'wbsync/card'
/** 卡片 schema 版本。新增 kind 必须升版本并走协议变更，禁止客户端私加类型。 */
export const CARD_SCHEMA = 'wbsync.card/1'
export const CARD_KINDS = Object.freeze(['artifact', 'approval', 'metric', 'table'])

export const CARD_LIMITS = Object.freeze({
  cardBytes: 8 * 1024,
  viewBytes: 32 * 1024,
  mergeHz: 4,
  rateWindowMs: 1000,
  effectWindowMs: 3000,
  degradeAfter: 5,
  cardIdMax: 128,
  actionsMax: 16,
})

export const CARD_ERR = Object.freeze({
  BAD_SHAPE: 'BAD_SHAPE',
  BAD_CARD_ID: 'BAD_CARD_ID',
  BAD_KIND: 'BAD_KIND',
  BAD_VIEW: 'BAD_VIEW',
  BAD_ACTIONS: 'BAD_ACTIONS',
  CARD_TOO_LARGE: 'CARD_TOO_LARGE',
  VIEW_TOO_LARGE: 'VIEW_TOO_LARGE',
  RATE_LIMITED: 'RATE_LIMITED',
  DEGRADED: 'DEGRADED',
})

const encoder = typeof TextEncoder === 'function' ? new TextEncoder() : null

/** UTF-8 字节数。不可序列化（循环引用/BigInt）按「无限大」处理，必然触发限额。 */
const bytesOf = (value) => {
  let text
  try { text = JSON.stringify(value) } catch { return Number.POSITIVE_INFINITY }
  if (typeof text !== 'string') return 0
  if (encoder) return encoder.encode(text).byteLength
  return unescape(encodeURIComponent(text)).length
}

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v)

/**
 * 校验一张工具卡。**纯函数**：同输入恒同输出，不改入参。
 * 未知但非空的 kind 不算违规（返回 `knownKind: false`），由 `normalizeCard` 出灰色占位。
 *
 * @returns {{ok: boolean, problems: string[], code: string|null, cardBytes: number,
 *            viewBytes: number, knownKind: boolean, schema: string}}
 */
export function validateCard(card, limits = CARD_LIMITS) {
  const problems = []
  if (!isPlainObject(card) || card.t !== CARD_T) problems.push(CARD_ERR.BAD_SHAPE)

  const cardId = card?.cardId
  if (typeof cardId !== 'string' || cardId.length === 0 || cardId.length > limits.cardIdMax) {
    problems.push(CARD_ERR.BAD_CARD_ID)
  }
  const kind = card?.kind
  if (typeof kind !== 'string' || kind.length === 0) problems.push(CARD_ERR.BAD_KIND)
  const knownKind = CARD_KINDS.includes(kind)

  const view = card?.view
  if (!isPlainObject(view)) problems.push(CARD_ERR.BAD_VIEW)

  const actions = card?.actions
  if (actions !== undefined) {
    let bad = !Array.isArray(actions) || actions.length > limits.actionsMax
    if (!bad) {
      bad = actions.some((a) => !isPlainObject(a)
        || typeof a.id !== 'string' || a.id.length === 0
        || typeof a.label !== 'string')
    }
    if (bad) problems.push(CARD_ERR.BAD_ACTIONS)
  }

  const cardBytes = bytesOf(card ?? null)
  const viewBytes = bytesOf(view ?? null)
  if (cardBytes > limits.cardBytes) problems.push(CARD_ERR.CARD_TOO_LARGE)
  if (viewBytes > limits.viewBytes) problems.push(CARD_ERR.VIEW_TOO_LARGE)

  return {
    ok: problems.length === 0,
    problems,
    code: problems.length ? problems[0] : null,
    cardBytes,
    viewBytes,
    knownKind,
    schema: CARD_SCHEMA,
  }
}

/**
 * 客户端渲染模型。
 * - 已知 kind + 校验通过：原样交出 view/actions；
 * - 未知 kind：灰色占位（`placeholder: true`），保留 `rawKind` 供诊断，其余 UI 不受影响；
 * - 校验违规：占位且**不携带违规正文**（拒绝/限流的落点），`reason` 为首个问题码。
 * 永不抛异常——一张坏卡片不能中断整条消息流（TC-5.12）。
 */
export function normalizeCard(card) {
  const v = validateCard(card)
  const cardId = typeof card?.cardId === 'string' ? card.cardId : ''
  const base = {
    t: CARD_T,
    cardId,
    schema: CARD_SCHEMA,
    placeholder: true,
    reason: null,
    view: {},
    actions: [],
  }
  if (!v.knownKind) {
    return { ...base, kind: 'unknown', rawKind: card?.kind ?? null, reason: 'UNKNOWN_KIND' }
  }
  if (!v.ok) {
    return { ...base, kind: card.kind, rawKind: null, reason: v.code }
  }
  return {
    ...base,
    kind: card.kind,
    rawKind: null,
    placeholder: false,
    view: card.view,
    actions: card.actions ?? [],
  }
}

/**
 * 从 `SessionEvent` 里取卡片。卡片可能挂在 `data`（随正文下发）或直接作为事件体，
 * 三种形态都兼容；非卡片事件返回 `null`，调用方据此完全跳过校验（TC-5.11：
 * 三个 carrier 只是搬运同一份 `ev`，归一化结果与链路无关）。
 */
export function cardFromEvent(ev) {
  if (!isPlainObject(ev)) return null
  // `t` 被写坏 / 漏掉时，只要还带着卡片的结构特征就仍当候选交给校验器，
  // 由它记 BAD_SHAPE 并标注问题数——不能让畸形卡片伪装成普通事件静默溜过（04 §4）。
  const looksLikeCard = (o) => isPlainObject(o)
    && ['cardId', 'kind', 'view'].filter((k) => Object.prototype.hasOwnProperty.call(o, k)).length >= 2
  if (isPlainObject(ev.data) && (ev.data.t === CARD_T || looksLikeCard(ev.data))) return ev.data
  if (ev.t === CARD_T || ev.type === CARD_T || looksLikeCard(ev)) return ev
  return null
}

/**
 * v2.3 · S-8.4（r25）：卡片动作的回传语义。
 * `cardId` 的封闭前缀约定——`approval:<approvalId>` 与 `artifact:<artifactId>`。
 * 没有这两个前缀的卡片（含未知 kind 的灰色占位）不产生回传目标，UI 不得猜。
 */
export const APPROVAL_ACTION_OUTCOMES = Object.freeze({
  allow: 'allowed-once',
  deny: 'rejected',
})

/** 从归一化卡片解析回传目标；无可回传语义返回 null。 */
export function cardTarget(model) {
  const id = typeof model?.cardId === 'string' ? model.cardId : ''
  if (model?.kind === 'approval' && id.startsWith('approval:')) {
    const approvalId = id.slice('approval:'.length)
    return approvalId ? { type: 'approval', approvalId } : null
  }
  if (model?.kind === 'artifact' && id.startsWith('artifact:')) {
    const artifactId = id.slice('artifact:'.length)
    return artifactId ? { type: 'artifact', artifactId } : null
  }
  return null
}

/**
 * 把卡片的某个 actionId 解析成可执行回传：
 * approval 卡映射到 `$events/result` 的 outcome（allow → allowed-once、deny → rejected，
 * 与 `answerApproval` 同词表）；artifact 卡不限 actionId——预览 / 保存都由产物票
 * （`createArtifactTicket`）承载，这里只交出目标身份。未知 actionId 返回 null。
 */
export function resolveCardAction(model, actionId) {
  const target = cardTarget(model)
  if (!target || typeof actionId !== 'string' || actionId === '') return null
  if (target.type === 'approval') {
    const outcome = APPROVAL_ACTION_OUTCOMES[actionId]
    return outcome ? { type: 'approval', approvalId: target.approvalId, outcome } : null
  }
  return { type: 'artifact', artifactId: target.artifactId }
}

/**
 * 发送/接收侧的合并频率与违规降级闸门（有状态，时间可注入）。
 * 只统计、不改写事件，保证 `seq` 连续与日志原文不变。
 */
export function createCardGuard({ now = () => Date.now(), limits = CARD_LIMITS } = {}) {
  let rateHits = []
  let effects = []
  let problems = 0
  let consecutive = 0
  let degraded = false
  let lastCode = null

  const sweep = (t) => {
    rateHits = rateHits.filter((x) => t - x < limits.rateWindowMs)
    effects = effects.filter((x) => t - x < limits.effectWindowMs)
  }

  return {
    /** @returns validateCard 结果 + { code, consecutive, degraded, problems } */
    check(card) {
      const t = Number(now())
      sweep(t)
      const v = validateCard(card, limits)
      let code = v.code
      if (!code && rateHits.length >= limits.mergeHz) code = CARD_ERR.RATE_LIMITED
      if (!code) rateHits.push(t)

      if (code) {
        problems += 1
        consecutive += 1
        lastCode = code
        effects.push(t)
        if (consecutive >= limits.degradeAfter) degraded = true
      } else {
        consecutive = 0
      }
      if (degraded && !code) code = CARD_ERR.DEGRADED
      return { ...v, code, problems, consecutive, degraded, lastCode }
    },
    snapshot: () => ({ schema: CARD_SCHEMA, problems, consecutive, degraded, lastCode }),
    /** 重启引擎 / 重新启用：清空计数并解除降级。 */
    reset() {
      rateHits = []
      effects = []
      problems = 0
      consecutive = 0
      degraded = false
      lastCode = null
    },
  }
}
