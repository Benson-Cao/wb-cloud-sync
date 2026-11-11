/**
 * 事件 → 可读转录（PWA 侧纯函数）
 * ---------------------------------------------------------------
 * 真机事件形状（2026-11-11 从会话日志取证，876 条）：
 *   { type: 'assistant/message', seq, time, data: { message: { content: [{ type:'text', text }] } } }
 *   { type: 'tool/result',      data: { message: { content: [{ type:'text', text }] }, toolCallId } }
 *   { type: 'user/message',     data: { message: { content: [...] } } }
 *
 * 为什么单独成模块：这些是**纯函数**，可以脱离 DOM 测；渲染层只管排版。
 * 也方便以后换 UI（比如做队列页）复用同一套判定。
 *
 * 原则：**只读取，不推断**。拿不到文本就返回 null，让上层退回原始 JSON，
 * 绝不拼一个「看起来像答案」的字符串。
 */

/** 会话里可能出现的正文容器；按真机优先级排列。 */
const contentOf = (ev) => {
  const data = ev?.data
  const message = data?.message
  return message?.content ?? data?.content ?? null
}

/** 从 content 数组里取所有 text 段，丢掉非文本（图片/工具引用等）。 */
const textFromContent = (content) => {
  if (!Array.isArray(content)) return null
  const parts = []
  for (const part of content) {
    if (part && part.type === 'text' && typeof part.text === 'string') parts.push(part.text)
  }
  return parts.length ? parts.join('\n') : null
}

/** 一条消息事件的可读正文；不是消息或没有文本时返回 null。 */
export function messageText(ev) {
  const fromContent = textFromContent(contentOf(ev))
  if (fromContent !== null) return fromContent
  const data = ev?.data
  if (typeof data?.text === 'string') return data.text
  if (typeof data?.message?.text === 'string') return data.message.text
  return null
}

/** 角色：只有 user/message 与 assistant/message 会被当成对话气泡。 */
export function roleOf(ev) {
  if (ev?.type === 'user/message') return 'user'
  if (ev?.type === 'assistant/message') return 'assistant'
  return null
}

/**
 * 归类成渲染种类。`raw` 表示「不认识的事件」，渲染层保持原来的折叠摘要，
 * 不做任何猜测式美化。
 */
export function classifyEvent(ev) {
  const role = roleOf(ev)
  if (role && messageText(ev) !== null) return { kind: 'message', role }
  if (ev?.type === 'tool/call') return { kind: 'tool-call', label: toolCallLabel(ev) }
  if (ev?.type === 'tool/result') return { kind: 'tool-result', chars: (messageText(ev) ?? '').length }
  if (ev?.type === 'turn/end') return { kind: 'turn-end', reason: turnEndReason(ev) }
  return { kind: 'raw' }
}

/** 工具名：真机在 data.name / data.toolName / data.message.name 三处之一。 */
export function toolCallLabel(ev) {
  const data = ev?.data
  const name = data?.name ?? data?.toolName ?? data?.message?.name ?? null
  return typeof name === 'string' && name.trim() ? name.trim() : null
}

/** `turn/end.reason` 在真机里是对象（{kind}），也可能是字符串；统一成短标签。 */
export function turnEndReason(ev) {
  const reason = ev?.data?.reason
  const kind = typeof reason === 'string' ? reason : reason?.kind
  if (typeof kind !== 'string') return null
  const map = {
    completed: '完成',
    'max-tokens': '被截断',
    aborted: '已停止',
    error: '失败',
    interrupted: '被中断',
    blockaded: '等待输入',
  }
  return map[kind] ?? kind
}

/**
 * 插件内部流量：`plugin:<name>/<event>`（例如 translator 的请求/结果往返）。
 * 它们不是对话内容，却常常一条几十 KB——首屏最容易被这类事件糊满。
 * 判定只看命名空间前缀，不猜插件语义：认不出就老老实实当内部流量。
 */
export const isPluginEvent = (ev) =>
  typeof ev?.type === 'string' && ev.type.startsWith('plugin:')

/** 给折叠行用的短标签：`plugin:translator/request` → `translator/request`。 */
export const shortType = (ev) => {
  const type = typeof ev?.type === 'string' ? ev.type : 'event'
  return type.startsWith('plugin:') ? type.slice('plugin:'.length) : type
}
