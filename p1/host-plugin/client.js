/**
 * WB-Cloud-Sync · PC 桌面设置页（v2.3 / D-005）
 * ---------------------------------------------------------------
 * 形态变更（13 §1）：`dsh.client` 半边**只做桌面设置页**，不再托管任何 UI 资源、
 * 不再渲染会话列表 / 对话 / 审批 / 镜像面板。手机界面由官方 `dsh web` 提供。
 *
 * 为什么能这么简：设置页就跑在 PC 的 DSH web 里，与插件同源，
 * 直接读 `/__wbsync/status`（状态）与 `/__wbsync/config`（配置自检，已脱敏）
 * 即可，不需要 Relay 令牌，也不需要任何静态资源路由。
 *
 * 三条硬约束（违反任一条都会让宿主起不来或插件不激活，已固化成单测）：
 *   1. 声明 dsh.client 必须在 exports 暴露 "./client"；
 *   2. 本文件的模块 id 必须等于包名；
 *   3. 插件必须同时是 bundle（有 cordis.patch.yml）并登记进 dsh.profile.bundles。
 */

window.__ModuleLoader__.load({
  id: 'dsh-wb-cloud-sync',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React

    const PANEL_ID = 'wbsync-settings'
    const ACTION_ID = 'wbsync-settings-action'

    // ---------- 网络：只走同源 /__wbsync/* ----------

    const request = async (path, init = {}) => {
      let r
      try { r = await fetch(path, init) }
      catch (e) {
        throw Object.assign(new Error(`本机插件不可达：${e?.message ?? e}`), { code: 'PLUGIN_UNREACHABLE' })
      }
      const payload = await r.json().catch(() => null)
      if (payload?.ok !== true) {
        throw Object.assign(
          new Error(payload?.error?.message ?? `HTTP ${r.status}`),
          { code: payload?.error?.code ?? `HTTP_${r.status}` },
        )
      }
      return payload.data
    }

    const readStatus = () => request('/__wbsync/status')
    const readConfig = () => request('/__wbsync/config')
    const makePairCode = () => request('/__wbsync/pair', { method: 'POST' })

    // ---------- 展示 ----------

    const dot = (color, size = 7) => h('span', {
      style: { width: size, height: size, borderRadius: '50%', background: color, display: 'inline-block', flex: '0 0 auto' },
    })

    const row = (label, value, opts = {}) => h('div', {
      style: { display: 'flex', gap: 12, padding: '7px 0', borderBottom: '1px solid var(--color-border-subtle, rgba(128,128,128,.18))' },
    }, [
      h('span', { key: 'l', style: { flex: '0 0 132px', opacity: 0.68 } }, label),
      h('span', {
        key: 'v',
        style: {
          flex: 1, wordBreak: 'break-all',
          fontFamily: opts.mono ? 'var(--font-mono, ui-monospace, monospace)' : undefined,
          color: opts.muted ? 'var(--color-text-secondary, inherit)' : undefined,
        },
      }, value),
    ])

    const button = (label, onClick, opts = {}) => h('button', {
      onClick,
      disabled: Boolean(opts.disabled),
      style: {
        padding: '6px 14px', borderRadius: 6, cursor: opts.disabled ? 'default' : 'pointer',
        border: '1px solid var(--color-border, rgba(128,128,128,.35))',
        background: opts.primary ? 'var(--color-accent, #3b82f6)' : 'transparent',
        color: opts.primary ? '#fff' : 'inherit',
        opacity: opts.disabled ? 0.55 : 1, font: 'inherit', fontSize: 13,
      },
    }, label)

    const note = (text) => h('p', {
      style: { margin: '10px 0 0', fontSize: 12, lineHeight: 1.65, opacity: 0.62 },
    }, text)

    // ---------- 设置面板 ----------

    function SettingsPanel() {
      const [status, setStatus] = useState(null)
      const [config, setConfig] = useState(null)
      const [error, setError] = useState(null)
      const [pairing, setPairing] = useState(null)
      const [busy, setBusy] = useState(false)

      const refresh = useCallback(async () => {
        setBusy(true)
        setError(null)
        try {
          const [s, c] = await Promise.all([readStatus(), readConfig()])
          setStatus(s)
          setConfig(c)
        } catch (e) {
          setError(e?.message ?? String(e))
        } finally {
          setBusy(false)
        }
      }, [])

      useEffect(() => { void refresh() }, [refresh])

      const onPair = async () => {
        setBusy(true)
        setError(null)
        setPairing(null)
        try {
          const out = await makePairCode()
          setPairing(out)
        } catch (e) {
          setError(e?.message ?? String(e))
        } finally {
          setBusy(false)
        }
      }

      const connected = status?.connected === true
      const head = h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 } }, [
        dot(connected ? '#22c55e' : (status ? '#9ca3af' : '#d1d5db')),
        h('h2', { key: 't', style: { margin: 0, fontSize: 17, fontWeight: 600 } }, 'WB-Cloud-Sync'),
        h('span', { key: 's', style: { fontSize: 12, opacity: 0.6 } }, connected ? '已连接 Relay' : '未连接 Relay'),
      ])

      return h('div', {
        'data-wbsync': 'settings-panel',
        style: {
          padding: 20, maxWidth: 760, fontFamily: 'var(--font-sans, system-ui, sans-serif)',
          color: 'var(--color-text-primary, inherit)', fontSize: 13,
        },
      }, [
        head,
        h('p', { key: 'sub', style: { margin: '0 0 14px', fontSize: 12, opacity: 0.6 } },
          '手机端界面由官方 dsh web 提供；这里只做主机连接与配对设置。'),

        error ? h('div', {
          key: 'err',
          style: { margin: '10px 0', padding: '8px 10px', borderRadius: 6, fontSize: 12, background: 'rgba(239,68,68,.12)', color: '#ef4444' },
        }, error) : null,

        h('div', { key: 'rows', style: { marginTop: 14 } }, [
          row('状态', status ? (connected ? '已连接' : '未连接') : '读取中…'),
          row('Relay', config?.relayUrl || '（未配置）', { mono: true }),
          row('HOST_TOKEN', config ? (config.hostTokenConfigured ? '已配置' : '未配置') : '读取中…'),
          row('主机标识 hostId', config?.hostId ?? '—', { mono: true }),
          row('锁定 commit', config?.dshCommit ?? '未注入', { mono: true, muted: !config?.dshCommit }),
          row('引擎状态', config ? `${config.engineState}（${config.engineScope}）` : '—'),
          row('协议', config?.protocol ?? '—', { mono: true }),
          row('重连次数', status ? String(status.reconnects ?? 0) : '—'),
        ]),

        h('div', { key: 'actions', style: { display: 'flex', gap: 10, marginTop: 18, flexWrap: 'wrap' } }, [
          button('刷新', () => void refresh(), { disabled: busy }),
          button(pairing ? '重新生成配对码' : '生成配对码', () => void onPair(), { primary: true, disabled: busy }),
        ]),

        pairing ? h('div', {
          key: 'code',
          style: { marginTop: 16, padding: 14, borderRadius: 8, background: 'rgba(59,130,246,.10)', border: '1px solid rgba(59,130,246,.28)' },
        }, [
          h('div', { key: 'l', style: { fontSize: 12, opacity: 0.7, marginBottom: 6 } }, '在手机端输入这 6 位配对码'),
          h('div', { key: 'v', style: { fontSize: 26, letterSpacing: 6, fontWeight: 700, fontFamily: 'var(--font-mono, ui-monospace, monospace)' } },
            String(pairing.code ?? '------')),
          pairing.expiresIn ? h('div', { key: 'e', style: { fontSize: 11, opacity: 0.55, marginTop: 6 } },
            `${pairing.expiresIn} 秒内有效`) : null,
        ]) : null,

        note('配置来源：~/.dsh/wbsync-host.json（relayUrl / hostToken / dshCommit），或环境变量 WBSYNC_*。修改后需重启 DSH 生效。'),
        note('本页不展示会话、不解析事件、不托管任何 UI 资源；手机界面请直接打开官方 dsh web。'),
      ])
    }

    /**
     * 侧栏底部入口：只渲染图标与文字。
     * 外层由 slot 提供点击与按钮语义，这里不再套一层 <button>（嵌套按钮无效）。
     */
    function SettingsAction() {
      return h('span', {
        title: 'WB-Cloud-Sync 设置',
        'data-wbsync': 'settings-action',
        style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, opacity: 0.75 },
      }, [dot('#9ca3af', 6), h('span', { key: 't' }, '云同步')])
    }

    function apply(ctx) {
      ctx.slots.inject('main', () =>
        ctx.slots.register({ name: 'main', key: PANEL_ID }, SettingsPanel))
      ctx.slots.inject('sidebar.footer.action', () =>
        ctx.slots.register(
          { name: 'sidebar.footer.action', id: ACTION_ID, order: 5, label: () => '云同步' },
          SettingsAction))
    }

    return { inject: ['slots'], apply }
  },
})
