/**
 * WBSync 前端半边 · DSH 手机端「我的电脑」（0.1.23）
 * ---------------------------------------------------------------
 * 形态：DSH 手机端是 WebView 套壳，集成落点是它加载的 web 页面。
 * 本文件在两处开入口：侧栏底部胶囊（连接状态）+ 面板（会话列表 / 会话内对话）。
 *
 * 三条硬约束（违反任一条都会让宿主起不来或插件不激活，已固化成单测）：
 *   1. 声明 dsh.client 必须在 exports 暴露 "./client"；
 *   2. 本文件的模块 id 必须等于包名；
 *   3. 插件必须同时是 bundle（有 cordis.patch.yml）并登记进 dsh.profile.bundles。
 *
 * 与 PWA 半边的关键差异（**本轮的核心**）：
 *   PWA 里 WS 属于「页面」，页面活着连接就活着；这里组件随时会被卸载
 *   （用户切面板、切会话），所以：
 *     - 连接必须绑定组件生命周期，cleanup 里显式 close；
 *     - lastSeq 存在模块级缓存里，重挂载能续着往后读，而不是从头再来；
 *     - 断线重连带 sinceSeq，靠 Relay 的补齐窗口补缺口，不自己攒状态。
 */

const SESSION_LAST_SEQ = new Map()   // 模块级：key = host + '|' + sessionId

window.__ModuleLoader__.load({
  // id 必须与包名一致：client-modules 按包解析模块，独立 id 会被重复注册并报
  // duplicate factory registration。nas-sync 同样用包名作 id。
  id: 'dsh-wb-cloud-sync-host',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback } = React

    const PANEL_ID = 'wbsync-remote'
    const LINK_KEY = 'wbsync.link'
    const EVENT = 'wbsync:link'
    const CLIENT_ID = 'dsh-app'

    // ---------- 存储 ----------

    const readLink = () => {
      try {
        const raw = window.localStorage.getItem(LINK_KEY)
        if (!raw) return null
        const v = JSON.parse(raw)
        return v && v.relayUrl && v.token && v.hostDeviceId ? v : null
      } catch { return null }
    }
    const writeLink = (v) => {
      try {
        if (v) window.localStorage.setItem(LINK_KEY, JSON.stringify(v))
        else window.localStorage.removeItem(LINK_KEY)
      } catch { /* 隐私模式：本次会话内仍可用内存值 */ }
      try { window.dispatchEvent(new Event(EVENT)) } catch { /* 无 window 就算了 */ }
    }

    // ---------- 网络 ----------

    const trim = (u) => String(u || '').trim().replace(/\/+$/, '')
    const toWs = (u) => trim(u).replace(/^http/, 'ws')

    const asError = (payload, r) => Object.assign(
      new Error(payload?.error?.message ?? `HTTP ${r?.status ?? '?'}`),
      { code: payload?.error?.code ?? (r ? `HTTP_${r.status}` : 'NETWORK') },
    )

    const request = async (url, init = {}) => {
      let r
      try { r = await fetch(url, init) }
      catch (e) {
        throw Object.assign(new Error(`Relay 不可达：${e?.message ?? e}`), { code: 'RELAY_UNREACHABLE' })
      }
      const payload = await r.json().catch(() => null)
      if (payload?.ok !== true) throw asError(payload, r)
      return payload.data
    }

    const post = (base, path, body) => request(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    const api = (link, path) => request(`${trim(link.relayUrl)}${path}`, {
      headers: { Authorization: `Bearer ${link.token}` },
    })

    const authed = (link, path, body) => request(`${trim(link.relayUrl)}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${link.token}` },
      body: JSON.stringify(body),
    })

    const hexOf = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')

    /**
     * 配对：/pair 拿一次性 challenge，HMAC-SHA256(pairSecret, challenge) 后换令牌。
     * WebView 的 127.0.0.1 属安全上下文，crypto.subtle 可用；拿不到就明确说清楚，
     * **不静默降级**（明文 HTTP 的局域网地址在浏览器里没有 subtle）。
     */
    const pair = async (relayUrl, code, phoneId) => {
      const base = trim(relayUrl)
      const ch = await post(base, '/pair', { code: String(code || '').trim() })
      if (!ch?.challenge || !ch?.pairSecret) throw new Error('配对响应缺少 challenge / pairSecret')
      const subtle = globalThis.crypto?.subtle
      if (!subtle) throw new Error('当前页面拿不到 WebCrypto，无法完成配对；请用 127.0.0.1 打开本页')
      const enc = new TextEncoder()
      const key = await subtle.importKey('raw', enc.encode(ch.pairSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
      const sig = hexOf(await subtle.sign('HMAC', key, enc.encode(ch.challenge)))
      const done = await post(base, '/pair/verify', {
        challenge: ch.challenge, sig,
        ...(phoneId ? { phoneId } : {}),
        clientName: 'DSH 手机端',
      })
      if (!done?.deviceToken) throw new Error('配对响应缺少 deviceToken')
      return {
        relayUrl: base,
        hostDeviceId: done.hostDeviceId ?? ch.deviceId,
        token: done.deviceToken,
        phoneId: done.deviceId ?? null,
      }
    }

    // ---------- 转录（判据照抄 p1/pwa/src/transcript.js） ----------

    const contentOf = (ev) => ev?.data?.message?.content ?? ev?.data?.content ?? null

    const textFromContent = (content) => {
      if (!Array.isArray(content)) return null
      const parts = []
      for (const part of content) {
        if (part && part.type === 'text' && typeof part.text === 'string') parts.push(part.text)
      }
      return parts.length ? parts.join('\n') : null
    }

    const messageText = (ev) => {
      const fromContent = textFromContent(contentOf(ev))
      if (fromContent !== null) return fromContent
      if (typeof ev?.data?.text === 'string') return ev.data.text
      if (typeof ev?.data?.message?.text === 'string') return ev.data.message.text
      return null
    }

    const roleOf = (ev) => {
      if (ev?.type === 'user/message') return 'user'
      if (ev?.type === 'assistant/message') return 'assistant'
      return null
    }

    const toolName = (ev) => {
      const d = ev?.data
      const name = d?.name ?? d?.toolName ?? d?.message?.name ?? null
      return typeof name === 'string' && name.trim() ? name.trim() : null
    }

    const turnReason = (ev) => {
      const reason = ev?.data?.reason
      const kind = typeof reason === 'string' ? reason : reason?.kind
      if (typeof kind !== 'string') return null
      return ({
        completed: '完成', 'max-tokens': '被截断', aborted: '已停止',
        error: '失败', interrupted: '被中断', blockaded: '等待输入',
      })[kind] ?? kind
    }

    const isPluginEvent = (ev) => typeof ev?.type === 'string' && ev.type.startsWith('plugin:')

    /**
     * 一条事件 → 一行可渲染内容。**只读取，不推断**：拿不到文本就退回原始类型名，
     * 绝不拼一个「看起来像答案」的字符串。
     */
    const toRow = (ev) => {
      const role = roleOf(ev)
      const text = messageText(ev)
      if (role && text !== null) return { kind: role, text, seq: ev.seq }
      if (ev?.type === 'tool/call') return { kind: 'tool', text: toolName(ev) ?? '工具调用', seq: ev.seq }
      if (ev?.type === 'tool/result') return { kind: 'tool-result', text: `${(messageText(ev) ?? '').length} 字符`, seq: ev.seq }
      if (ev?.type === 'turn/end') return { kind: 'turn-end', text: turnReason(ev) ?? '结束', seq: ev.seq }
      if (isPluginEvent(ev)) return null      // 插件内部流量：一条几十 KB，不占屏
      return { kind: 'raw', text: String(ev?.type ?? 'event'), seq: ev.seq }
    }

    // ---------- 展示 ----------

    const ago = (ts) => {
      if (!ts) return ''
      const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
      if (s < 60) return '刚刚'
      if (s < 3600) return `${Math.round(s / 60)} 分钟前`
      if (s < 86400) return `${Math.round(s / 3600)} 小时前`
      return `${Math.round(s / 86400)} 天前`
    }

    const dot = (color, size = 6) => h('span', {
      style: { width: size, height: size, borderRadius: '50%', background: color, display: 'inline-block', flex: '0 0 auto' },
    })

    /** 侧栏底部的站点状态胶囊：只显示「连了没有」，点它进面板。 */
    function DevicePill({ compact }) {
      const [link, setLink] = useState(readLink)
      useEffect(() => {
        const sync = () => setLink(readLink())
        window.addEventListener(EVENT, sync)
        window.addEventListener('storage', sync)
        return () => {
          window.removeEventListener(EVENT, sync)
          window.removeEventListener('storage', sync)
        }
      }, [])
      const on = Boolean(link)
      return h('span', {
        'data-wbsync': 'device-pill',
        title: on ? `已连接 ${link.hostDeviceId}` : '尚未连接电脑',
        style: {
          display: 'inline-flex', alignItems: 'center', gap: 5,
          padding: compact ? '2px 7px' : '4px 9px', borderRadius: 999,
          border: '0.5px solid ' + (on ? 'var(--color-border-info)' : 'var(--color-border-secondary)'),
          background: on ? 'var(--color-background-info)' : 'transparent',
          color: on ? 'var(--color-text-info)' : 'var(--color-text-secondary)',
          fontSize: compact ? 11 : 12, lineHeight: 1.2,
          maxWidth: '100%', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
        },
      }, [dot(on ? 'var(--color-text-success)' : 'var(--color-text-tertiary)'), on ? '电脑' : '未连接'])
    }

    const inputStyle = {
      width: '100%', boxSizing: 'border-box', padding: '7px 9px', borderRadius: 8,
      border: '0.5px solid var(--color-border-secondary)', background: 'var(--color-background-primary)',
      color: 'var(--color-text-primary)', fontSize: 13, fontFamily: 'inherit',
    }

    const Field = ({ label, children }) => h('label', { style: { display: 'block', marginBottom: 10 } }, [
      h('div', { key: 'l', style: { fontSize: 11, color: 'var(--color-text-tertiary)', marginBottom: 4 } }, label),
      children,
    ])

    /** 小按钮：链路里的动作都长得一样，避免每处重复写样式。 */
    const chip = (label, onClick, opts = {}) => h('span', {
      role: 'button',
      'data-wbsync': opts.mark,
      onClick: opts.disabled ? undefined : onClick,
      style: {
        display: 'inline-block', padding: '3px 9px', borderRadius: 6, fontSize: 11,
        cursor: opts.disabled ? 'default' : 'pointer',
        opacity: opts.disabled ? 0.5 : 1,
        border: '0.5px solid ' + (opts.primary ? 'var(--color-border-info)' : 'var(--color-border-secondary)'),
        background: opts.primary ? 'var(--color-background-info)' : 'transparent',
        color: opts.primary ? 'var(--color-text-info)' : 'var(--color-text-primary)',
      },
    }, label)

    function ConnectForm({ onDone, busy, setBusy, error, setError }) {
      const [url, setUrl] = useState('')
      const [code, setCode] = useState('')

      const submit = async () => {
        if (busy) return
        setError(null)
        if (!/^https?:\/\//.test(trim(url))) return setError('Relay 地址要以 http:// 开头')
        if (!/^\d{6}$/.test(String(code).trim())) return setError('配对码是 6 位数字')
        setBusy(true)
        try {
          const prev = readLink()
          const link = await pair(url, code, prev?.phoneId)
          writeLink(link)
          onDone(link)
        } catch (e) {
          setError(e.message)
          setBusy(false)
        }
      }

      return h('div', { 'data-wbsync': 'connect-form', style: { maxWidth: 420 } }, [
        h(Field, { key: 'u', label: '电脑上的 Relay 地址' },
          h('input', {
            'data-wbsync': 'relay-url', style: inputStyle, value: url,
            onChange: (e) => setUrl(e.target.value), placeholder: 'http://192.168.1.10:8787',
          })),
        h(Field, { key: 'c', label: '6 位配对码（在电脑上生成）' },
          h('input', {
            'data-wbsync': 'pair-code', style: inputStyle, value: code,
            inputMode: 'numeric', maxLength: 6,
            onChange: (e) => setCode(e.target.value.replace(/\D/g, '')),
            onKeyDown: (e) => { if (e.key === 'Enter') void submit() },
            placeholder: '000000',
          })),
        error ? h('div', {
          'data-wbsync': 'connect-error',
          style: { fontSize: 12, color: 'var(--color-text-danger)', marginBottom: 8, lineHeight: 1.6 },
        }, error) : null,
        h('button', {
          type: 'button', 'data-wbsync': 'connect-submit', disabled: busy,
          onClick: () => void submit(),
          style: { padding: '7px 14px', borderRadius: 8, fontSize: 13, cursor: busy ? 'default' : 'pointer' },
        }, busy ? '配对中…' : '连接'),
        h('div', { style: { marginTop: 12, fontSize: 11, color: 'var(--color-text-tertiary)', lineHeight: 1.7 } },
          '在电脑上打开插件的 /__wbsync/pair 生成配对码；手机与电脑需在同一局域网。'),
      ])
    }

    function SessionRow({ row, active, onPick, onlineHint }) {
      const online = onlineHint !== false
      const state = row?.state ?? 'stopped'
      return h('div', {
        'data-wbsync': 'remote-row',
        onClick: onPick,
        style: {
          padding: '8px 10px', borderRadius: 8, cursor: 'pointer',
          border: '0.5px solid ' + (active ? 'var(--color-border-info)' : 'var(--color-border-tertiary)'),
          background: active ? 'var(--color-background-info)' : 'transparent',
          display: 'flex', alignItems: 'center', gap: 8,
        },
      }, [
        dot(state === 'running' ? 'var(--color-text-success)' : 'var(--color-text-tertiary)'),
        h('div', { key: 'm', style: { flex: 1, minWidth: 0 } }, [
          h('div', {
            key: 't',
            style: { fontSize: 13, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
          }, row?.title || String(row?.sessionId ?? '').slice(0, 16) || '未命名会话'),
          h('div', { key: 's', style: { fontSize: 11, color: 'var(--color-text-tertiary)' } },
            `${state === 'running' ? '运行中' : '空闲'} · ${ago(row?.lastActiveAt)}`),
        ]),
        h('span', {
          key: 'tag',
          style: {
            fontSize: 10, padding: '1px 5px', borderRadius: 4,
            border: '0.5px solid ' + (online ? 'var(--color-border-info)' : 'var(--color-border-tertiary)'),
            color: online ? 'var(--color-text-info)' : 'var(--color-text-tertiary)',
          },
        }, online ? '远程' : '离线'),
      ])
    }

    const rowStyle = (kind) => {
      if (kind === 'user') {
        return {
          alignSelf: 'flex-end', maxWidth: '85%', padding: '6px 9px', borderRadius: 10,
          background: 'var(--color-background-info)', color: 'var(--color-text-primary)',
          fontSize: 13, whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.55,
        }
      }
      if (kind === 'assistant') {
        return {
          alignSelf: 'flex-start', maxWidth: '92%', padding: '6px 9px', borderRadius: 10,
          background: 'var(--color-background-secondary)', color: 'var(--color-text-primary)',
          fontSize: 13, whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.55,
        }
      }
      return { fontSize: 11, color: 'var(--color-text-tertiary)', lineHeight: 1.6 }
    }

    const rowPrefix = (kind) => ({
      tool: '· 调用 ', 'tool-result': '· 结果 ', 'turn-end': '· 本轮 ', raw: '· ',
    })[kind] ?? ''

    /**
     * 会话内视图。
     *
     * 生命周期是重点：这个组件会被卸载（切面板/切会话/切设备），
     * 所以 WS 必须在 cleanup 里关掉，`lastSeq` 存模块级缓存以便重挂载续读。
     * 断线重连始终带 `sinceSeq`，让 Relay 的补齐窗口补缺口——不自己攒。
     */
    function Conversation({ link, sessionId, title, onBack }) {
      const cacheKey = `${link.hostDeviceId}|${sessionId}`
      const lastSeq = useRef(SESSION_LAST_SEQ.get(cacheKey) ?? -1)
      const [rows, setRows] = useState([])
      const [status, setStatus] = useState('connecting')
      const [err, setErr] = useState(null)
      const [text, setText] = useState('')
      const [sending, setSending] = useState(false)
      const [approvals, setApprovals] = useState([])
      const scroller = useRef(null)

      const push = useCallback((row) => {
        setRows((prev) => {
          const next = prev.concat(row)
          return next.length > 400 ? next.slice(next.length - 400) : next
        })
      }, [])

      useEffect(() => {
        let closed = false
        let ws = null
        let attempts = 0
        let timer = null

        const schedule = () => {
          if (closed) return
          const delay = Math.min(15000, 1000 * 2 ** Math.min(attempts, 4))
          attempts++
          setStatus('reconnecting')
          timer = window.setTimeout(connect, delay)
        }

        const connect = () => {
          if (closed) return
          const url = `${toWs(link.relayUrl)}/d/${encodeURIComponent(link.hostDeviceId)}`
            + `/events/${encodeURIComponent(sessionId)}`
            + `?token=${encodeURIComponent(link.token)}&sinceSeq=${lastSeq.current}`
          try { ws = new WebSocket(url) } catch { schedule(); return }
          setStatus('connecting')

          ws.addEventListener('open', () => {
            if (closed || ws?.readyState !== 1) return
            attempts = 0
            setStatus('following')
          })

          ws.addEventListener('message', (event) => {
            if (closed) return          // 卸载后仍可能收到尾包：别再 setState
            let msg
            try { msg = JSON.parse(String(event.data)) } catch { return }

            if (msg.t === 'session/event') {
              const ev = msg.ev
              if (!Number.isInteger(ev?.seq) || ev.seq <= lastSeq.current) return   // 幂等丢弃
              // 实时流不该跳帧；真跳了就当作缺口，断开重连让 Relay 从 sinceSeq 补齐，
              // 不在前端拼一个「差不多连续」的列表。
              if (ev.seq > lastSeq.current + 1) {
                // 带 sinceSeq 重连即可让 Relay 从断点补齐（补的就是这段缺口），
                // 前端不自己「跳过」——跳过等于把缺口永久留在屏幕上
                try { ws?.close() } catch { /* 忽略 */ }
                return
              }
              lastSeq.current = ev.seq
              SESSION_LAST_SEQ.set(cacheKey, ev.seq)
              const row = toRow(ev)
              if (row) push(row)
              return
            }

            if (msg.t === 'approval/request' && msg.approvalId) {
              setApprovals((prev) => prev.some((a) => a.approvalId === msg.approvalId)
                ? prev
                : prev.concat({ approvalId: msg.approvalId, summary: msg.summary ?? msg.title ?? '请求批准' }))
              return
            }

            if (msg.t === 'approval/resolved') {
              setApprovals((prev) => prev.filter((a) => a.approvalId !== msg.approvalId))
            }
          })

          ws.addEventListener('close', () => { if (!closed) schedule() })
          ws.addEventListener('error', () => { try { ws?.close() } catch { /* 忽略 */ } })
        }

        connect()

        return () => {
          // 组件卸载 = 页面不再看这个会话，连接必须立刻收掉
          closed = true
          if (timer) window.clearTimeout(timer)
          try { ws?.close() } catch { /* 忽略 */ }
        }
      }, [link.relayUrl, link.hostDeviceId, link.token, sessionId, cacheKey, push])

      useEffect(() => {
        const el = scroller.current
        if (el) el.scrollTop = el.scrollHeight
      }, [rows.length])

      const send = async () => {
        const body = text.trim()
        if (!body || sending) return
        setSending(true)
        setErr(null)
        try {
          await authed(link, `/d/${encodeURIComponent(link.hostDeviceId)}/session/prompt`, {
            clientId: CLIENT_ID,
            sessionId,
            text: body,
            attachments: [],
            // 幂等键：网络抖动重发不会变成两条
            clientMsgId: `${CLIENT_ID}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          })
          setText('')
        } catch (e) {
          setErr(`发送失败：${e.message}`)
        } finally { setSending(false) }
      }

      const answer = async (approvalId, outcome) => {
        try {
          await authed(link, `/d/${encodeURIComponent(link.hostDeviceId)}/$events/result`, {
            approvalId, outcome, clientId: CLIENT_ID,
          })
          setApprovals((prev) => prev.filter((a) => a.approvalId !== approvalId))
        } catch (e) {
          setErr(`应答失败：${e.message}`)
        }
      }

      const statusText = ({
        connecting: '连接中…', following: '实时', reconnecting: '重连中…',
      })[status] ?? status

      return h('div', {
        'data-wbsync': 'conversation',
        style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 320, fontFamily: 'var(--font-sans)' },
      }, [
        h('div', {
          key: 'h',
          style: { display: 'flex', alignItems: 'center', gap: 8, paddingBottom: 8, borderBottom: '0.5px solid var(--color-border-tertiary)' },
        }, [
          h('span', {
            key: 'b', role: 'button', 'data-wbsync': 'back',
            onClick: onBack,
            style: { fontSize: 12, color: 'var(--color-text-info)', cursor: 'pointer' },
          }, '返回'),
          h('div', { key: 't', style: { flex: 1, minWidth: 0 } }, [
            h('div', {
              key: 'n',
              style: { fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
            }, title || String(sessionId).slice(0, 18)),
            h('div', { key: 's', style: { fontSize: 10, color: 'var(--color-text-tertiary)' }, },
              `${statusText} · 电脑端`),
          ]),
        ]),

        h('div', {
          key: 'flow',
          ref: scroller,
          'data-wbsync': 'flow',
          style: {
            flex: 1, overflowY: 'auto', padding: '10px 0',
            display: 'flex', flexDirection: 'column', gap: 6,
          },
        }, rows.length
          ? rows.map((r, i) => h('div', {
            key: `${r.seq}-${i}`,
            'data-wbsync': 'flow-row',
            style: rowStyle(r.kind),
          }, r.kind === 'tool' || r.kind === 'tool-result' || r.kind === 'turn-end' || r.kind === 'raw'
            ? rowPrefix(r.kind) + r.text
            : r.text))
          : h('div', { style: { fontSize: 12, color: 'var(--color-text-tertiary)' } },
            status === 'following' ? '这个会话还没有可显示的事件。' : '正在读取事件流…')),

        approvals.length ? h('div', {
          key: 'ap', 'data-wbsync': 'approvals',
          style: { borderTop: '0.5px solid var(--color-border-tertiary)', paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 6 },
        }, approvals.map((a) => h('div', {
          key: a.approvalId,
          'data-wbsync': 'approval-card',
          style: { border: '0.5px solid var(--color-border-warning)', borderRadius: 8, padding: 8 },
        }, [
          h('div', { key: 's', style: { fontSize: 11, color: 'var(--color-text-warning)', marginBottom: 6 } }, a.summary),
          h('div', { key: 'b', style: { display: 'flex', gap: 6 } }, [
            chip('允许一次', () => void answer(a.approvalId, 'allowed-once'), { primary: true, mark: 'allow' }),
            chip('拒绝', () => void answer(a.approvalId, 'rejected'), { mark: 'deny' }),
          ]),
        ]))) : null,

        err ? h('div', {
          key: 'e', 'data-wbsync': 'conv-error',
          style: { fontSize: 11, color: 'var(--color-text-danger)', paddingTop: 6 },
        }, err) : null,

        h('div', {
          key: 'c',
          style: { display: 'flex', gap: 8, alignItems: 'flex-end', paddingTop: 8, borderTop: '0.5px solid var(--color-border-tertiary)' },
        }, [
          h('textarea', {
            key: 'i', 'data-wbsync': 'composer',
            value: text, rows: 1,
            onChange: (e) => setText(e.target.value),
            onKeyDown: (e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() }
            },
            placeholder: '发消息到这台电脑…',
            style: { ...inputStyle, flex: 1, resize: 'none', maxHeight: 96 },
          }),
          chip(sending ? '发送中' : '发送', () => void send(), { primary: true, mark: 'send', disabled: sending || !text.trim() }),
        ]),
      ])
    }

    function RemotePanel() {
      const [link, setLink] = useState(readLink)
      const [rows, setRows] = useState([])
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [picked, setPicked] = useState(null)
      const [at, setAt] = useState(null)
      const [hostInfo, setHostInfo] = useState(null)

      const load = useCallback(async (l) => {
        if (!l) return
        setBusy(true)
        setError(null)
        try {
          const data = await api(l, `/api/sessions?deviceId=${encodeURIComponent(l.hostDeviceId)}`)
          // host 在**响应顶层**（relay 的设计），不是每行一份；读错层会得到 undefined
          setHostInfo(data?.host ?? null)
          setRows(Array.isArray(data?.rows) ? data.rows : [])
          setAt(Date.now())
        } catch (e) {
          if (e.code === 'UNAUTHORIZED' || e.code === 'HTTP_401') {
            writeLink(null)
            setLink(null)
            setRows([])
            setError('配对已失效，请重新连接电脑')
          } else setError(e.message)
        } finally { setBusy(false) }
      }, [])

      useEffect(() => { void load(link) }, [link, load])

      // 列表页才轮询；进了会话就有 WS，不必再轮
      useEffect(() => {
        if (!link || picked) return undefined
        const t = window.setInterval(() => { void load(link) }, 20000)
        return () => window.clearInterval(t)
      }, [link, load, picked])

      const online = hostInfo?.online !== false
      const hostName = hostInfo?.name || '这台电脑'

      if (link && picked) {
        const row = rows.find((r) => r.sessionId === picked)
        return h('div', {
          'data-wbsync': 'remote-panel',
          style: { padding: 16, fontFamily: 'var(--font-sans)', color: 'var(--color-text-primary)', height: '100%', display: 'flex', flexDirection: 'column', boxSizing: 'border-box' },
        }, h(Conversation, {
          key: picked,
          link, sessionId: picked,
          title: row?.title || null,
          onBack: () => setPicked(null),
        }))
      }

      const head = h('div', {
        key: 'h',
        style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' },
      }, [
        h('div', { key: 't', style: { fontSize: 14, fontWeight: 500 } }, '我的电脑'),
        link ? h('span', {
          key: 's',
          style: { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: online ? 'var(--color-text-success)' : 'var(--color-text-tertiary)' },
        }, [dot(online ? 'var(--color-text-success)' : 'var(--color-text-tertiary)'), online ? '在线' : '离线']) : null,
        h('div', { key: 'sp', style: { flex: 1 } }),
        link ? h('span', {
          key: 'r', role: 'button', 'data-wbsync': 'refresh',
          onClick: () => void load(link),
          style: { fontSize: 12, color: 'var(--color-text-info)', cursor: 'pointer' },
        }, busy ? '刷新中…' : '刷新') : null,
        link ? h('span', {
          key: 'd', role: 'button', 'data-wbsync': 'disconnect',
          onClick: () => { writeLink(null); setLink(null); setRows([]); setPicked(null) },
          style: { fontSize: 12, color: 'var(--color-text-tertiary)', cursor: 'pointer' },
        }, '断开') : null,
      ])

      if (!link) {
        return h('div', { 'data-wbsync': 'remote-panel', style: { padding: 16, fontFamily: 'var(--font-sans)', color: 'var(--color-text-primary)' } }, [
          head,
          h(ConnectForm, {
            key: 'f', busy, setBusy, error, setError,
            onDone: (l) => { setLink(l); setError(null) },
          }),
        ])
      }

      return h('div', { 'data-wbsync': 'remote-panel', style: { padding: 16, fontFamily: 'var(--font-sans)', color: 'var(--color-text-primary)' } }, [
        head,
        h('div', { key: 'meta', style: { fontSize: 11, color: 'var(--color-text-tertiary)', marginBottom: 10 } },
          `${hostName} · ${rows.length} 个会话${at ? ` · 更新于 ${ago(at)}` : ''}`),
        error ? h('div', {
          key: 'e', 'data-wbsync': 'panel-error',
          style: { fontSize: 12, color: 'var(--color-text-danger)', marginBottom: 8, lineHeight: 1.6 },
        }, error) : null,
        rows.length
          ? h('div', { key: 'l', style: { display: 'flex', flexDirection: 'column', gap: 6 } },
            rows.slice(0, 60).map((r) => h(SessionRow, {
              key: r.sessionId, row: r, onlineHint: online,
              active: picked === r.sessionId,
              onPick: () => setPicked(r.sessionId),
            })))
          : h('div', { key: 'empty', style: { fontSize: 13, color: 'var(--color-text-secondary)', lineHeight: 1.7 } },
            busy ? '正在读取电脑上的会话…' : '电脑上还没有会话。'),
      ])
    }

    function PanelIcon(props) {
      const size = props && props.size ? props.size : 18
      return h('span', {
        'data-wbsync': 'panel-icon',
        style: { width: size, height: size, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' },
      }, h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round',
      }, [
        h('rect', { key: 'r', x: 1.6, y: 2.4, width: 12.8, height: 8.4, rx: 1.4 }),
        h('path', { key: 's', d: 'M5.2 13.6h5.6M8 10.8v2.8' }),
      ]))
    }

    function apply(ctx) {
      ctx.slots.inject('main', () =>
        ctx.slots.register({ name: 'main', key: PANEL_ID }, RemotePanel))

      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          { name: 'sidebar.panellist', id: PANEL_ID, order: 40, label: () => '我的电脑' },
          PanelIcon,
        ))

      ctx.slots.inject('sidebar.footer.action', () =>
        ctx.slots.register(
          { name: 'sidebar.footer.action', id: 'wbsync-device', order: 5, label: () => '电脑' },
          function FooterDevice() { return h(DevicePill, { compact: true }) },
        ))
    }

    return { inject: ['slots'], apply }
  },
})
