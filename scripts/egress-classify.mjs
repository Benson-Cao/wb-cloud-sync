/**
 * 出网审计的主机名归属分类（纯函数，零副作用，供脚本与单测共用）。
 *
 * 只有 `external` 需要人工确认；其余都是自托管、私网或保留域。
 * 抽成独立模块的原因：`egress-audit.mjs` 顶层会扫描并写证据文件，
 * 测试框架 import 它会触发副作用。
 */

/** RFC 6761 / RFC 2606 保留域：不可能解析成真实公网地址，测试夹具专用。 */
const RESERVED_TLD = /(^|\.)(test|example|invalid|localhost)$/
const RESERVED_EXAMPLE = /(^|\.)example\.(com|org|net)$/

export const classifyHost = (rawHost) => {
  let h = String(rawHost).toLowerCase().trim()
  // 只剥 IPv4 / 域名后面的 :端口。IPv6 字面量（::1、[::1]、fd00::1）含多个冒号，
  // 直接 replace(/:\d+$/) 会把 "::1" 削成 ":"，再被误判成 external。
  if (/^[^:[\]]+:\d+$/.test(h)) h = h.replace(/:\d+$/, '')
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]') return 'loopback'
  if (h === '0.0.0.0' || h === '::' || h === '[::]') return 'bind-any'
  if (h.startsWith('fe80:') || h.startsWith('fd') || h.startsWith('fc')) return 'private'
  if (/^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)) return 'private'
  if (h === 'host.docker.internal') return 'loopback'
  if (RESERVED_TLD.test(h) || RESERVED_EXAMPLE.test(h)) return 'placeholder'
  // 单标签 host（如测试里的相对 URL 基准 http://x/app/）无法构成真实域名
  if (/^[a-z0-9-]+$/.test(h)) return 'placeholder'
  return 'external'
}
