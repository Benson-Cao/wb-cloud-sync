/**
 * 转录纯函数单测（真机形状取自 2026-11-11 会话日志取证）
 * 关键约束：拿不到文本必须返回 null 让上层退回原始 JSON，**绝不猜正文**。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifyEvent, messageText, roleOf, toolCallLabel, turnEndReason } from '../src/transcript.js'

const msg = (type, text) => ({ type, seq: 1, data: { message: { content: [{ type: 'text', text }] } } })

test('T1 assistant/message：从 data.message.content 取正文', () => {
  assert.equal(messageText(msg('assistant/message', '你好，我是助手')), '你好，我是助手')
  assert.equal(roleOf(msg('assistant/message', 'x')), 'assistant')
  assert.deepEqual(classifyEvent(msg('assistant/message', 'x')), { kind: 'message', role: 'assistant' })
})

test('T2 多段 text 用换行拼接；非 text 段（图片/引用）被丢掉而不是变成 [object]', () => {
  const ev = {
    type: 'user/message',
    data: {
      message: {
        content: [
          { type: 'text', text: '看这张图' },
          { type: 'image', source: { path: 'a.png' } },
          { type: 'text', text: '然后解释' },
        ],
      },
    },
  }
  assert.equal(messageText(ev), '看这张图\n然后解释')
})

test('T3 tool/result：正文长度可用于「结果 N 字」摘要；没有正文也不报错', () => {
  const withText = { type: 'tool/result', data: { toolCallId: 'c1', message: { content: [{ type: 'text', text: 'abcde' }] } } }
  assert.deepEqual(classifyEvent(withText), { kind: 'tool-result', chars: 5 })
  const empty = { type: 'tool/result', data: { toolCallId: 'c1' } }
  assert.deepEqual(classifyEvent(empty), { kind: 'tool-result', chars: 0 })
})

test('T4 tool/call：工具名三处兜底，取不到就 null（不编名字）', () => {
  assert.equal(toolCallLabel({ type: 'tool/call', data: { name: 'shell_run' } }), 'shell_run')
  assert.equal(toolCallLabel({ type: 'tool/call', data: { toolName: 'file_write' } }), 'file_write')
  assert.equal(toolCallLabel({ type: 'tool/call', data: { message: { name: 'read' } } }), 'read')
  assert.equal(toolCallLabel({ type: 'tool/call', data: { name: '  ' } }), null)
  assert.deepEqual(classifyEvent({ type: 'tool/call', data: {} }), { kind: 'tool-call', label: null })
})

test('T5 turn/end：reason 是对象 {kind} 或字符串，映射中文；未知原样返回', () => {
  assert.equal(turnEndReason({ data: { reason: { kind: 'completed' } } }), '完成')
  assert.equal(turnEndReason({ data: { reason: 'aborted' } }), '已停止')
  assert.equal(turnEndReason({ data: { reason: { kind: 'weird-new-kind' } } }), 'weird-new-kind')
  assert.equal(turnEndReason({ data: {} }), null)
  assert.deepEqual(classifyEvent({ type: 'turn/end', data: { reason: { kind: 'error' } } }), { kind: 'turn-end', reason: '失败' })
})

test('T6 不认识的事件一律 raw，不做猜测式美化', () => {
  for (const ev of [
    { type: 'compaction/start', data: {} },
    { type: 'workspace/changes', data: { turn: 5 } },
    { type: 'request/header', data: {} },
    null,
    {},
  ]) {
    assert.deepEqual(classifyEvent(ev), { kind: 'raw' }, JSON.stringify(ev))
  }
})

test('T7 消息事件但取不到正文 → 不算 message，退回 raw', () => {
  const noText = { type: 'assistant/message', data: { message: { content: [{ type: 'image' }] } } }
  assert.equal(messageText(noText), null)
  assert.deepEqual(classifyEvent(noText), { kind: 'raw' }, '宁可显示原始 JSON，也不显示空气泡')
})

test('T8 data.text 与 data.message.text 兜底；content 为空数组时继续往下找', () => {
  assert.equal(messageText({ type: 'assistant/message', data: { text: '扁平文本' } }), '扁平文本')
  assert.equal(messageText({ type: 'assistant/message', data: { message: { text: '嵌套文本' } } }), '嵌套文本')
  assert.equal(messageText({ type: 'assistant/message', data: { message: { content: [] }, text: '兜底' } }), '兜底')
})
