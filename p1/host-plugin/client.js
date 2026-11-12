/**
 * WBSync 前端半边 · 手机端「我的电脑」面板（0.1.22）
 * ---------------------------------------------------------------
 * 形态：DSH 手机端是 WebView 套壳，所以集成落点是它加载的 web 页面。
 * 本文件只做一件事：在同一套 UI 里开出「电脑上那些会话」的入口。
 *
 * 三条硬约束（违反任一条都会让宿主起不来或插件不激活，已固化成单测）：
 *   1. 声明 dsh.client 必须在 exports 暴露 "./client"；
 *   2. 本文件的模块 id 必须等于包名；
 *   3. 插件必须同时是 bundle（有 cordis.patch.yml）并登记进 dsh.profile.bundles。
 *
 * 槽位选择（据宿主 slot 契约表）：
 *   - sidebar.brand.name  single + shadows-shipped-ui → 会顶掉品牌名，不用；
 *   - sidebar.workspaces  single 且被 ui-workspace 占用 → 真切换=重写整个浏览区；
 *   - 采用 sidebar.footer.action（list 追加）+ sidebar.panellist + main。
 *
 * 跨域：页面来自 WebView 的 127.0.0.1:<port>，Relay 在另一台机器 → Relay 必须发 CORS
 * （只回显本机源，见 p1/relay/src/server.js 的 isAllowedOrigin）。
 */
window.__ModuleLoader__.load({
  // id 必须与包名一致：client-modules 按包解析模块，独立 id 会被重复注册并报
  // duplicate factory registration。nas-sync 同样用包名作 id。
  id: 'dsh-wb-cloud-sync-host',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React

    const PANEL_ID = 'wbsync-remote'
    const LINK_KEY = 'wbsync.link'
    const EVENT = 'wbsync:link'

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

    const asError = (payload, r) => Object.assign(
      new Error(payload?.error?.message ?? `HTTP ${r?.status ?? '?'}`),
      { code: payload?.error?.code ?? (r ? `HTTP_${r.status}` : 'NETWORK') },
    )

    const post = async (base, path, body) => {
      let r
      try {
        r = await fetch(`${base}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      } catch (e) {
        throw Object.assign(new Error(`Relay 不可达：${e?.message ?? e}`), { code: 'RELAY_UNREACHABLE' })
      }
      const payload = await r.json().catch(() => null)
      if (payload?.ok !== true) throw asError(payload, r)
      return payload.data
    }

    const api = async (link, path) => {
      let r
      try {
        r = await fetch(`${trim(link.relayUrl)}${path}`, {
          headers: { Authorization: `Bearer ${link.token}` },
        })
      } catch (e) {
        throw Object.assign(new Error(`Relay 不可达：${e?.message ?? e}`), { code: 'RELAY_UNREACHABLE' })
      }
      const payload = await r.json().catch(() => null)
      if (payload?.ok !== true) throw asError(payload, r)
      return payload.data
    }

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
          // 令牌失效要能自己说清楚，而不是一直转圈
          if (e.code === 'UNAUTHORIZED' || e.code === 'HTTP_401') {
            writeLink(null)
            setLink(null)
            setRows([])
            setError('配对已失效，请重新连接电脑')
          } else setError(e.message)
        } finally { setBusy(false) }
      }, [])

      useEffect(() => { void load(link) }, [link, load])

      // 面板停留时每 20s 刷一次：手机上没人会去点「刷新」
      useEffect(() => {
        if (!link) return undefined
        const t = window.setInterval(() => { void load(link) }, 20000)
        return () => window.clearInterval(t)
      }, [link, load])

      const online = hostInfo?.online !== false
      const hostName = hostInfo?.name || '这台电脑'

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
        picked ? h('div', {
          key: 'note', 'data-wbsync': 'picked-note',
          style: { marginTop: 14, fontSize: 11, color: 'var(--color-text-tertiary)', lineHeight: 1.7 },
        }, '已选中。下一步接对话视图（事件流 + 审批 + 产物）；本轮只做到「看得到电脑上有什么」。') : null,
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
