/**
 * WBSync 前端半边 · SPIKE（不是功能实现）
 * ---------------------------------------------------------------
 * 目的只有一个：回答「设备切换器该挂在哪个槽位、手机上放不放得下」。
 *
 * 已知契约（从宿主 asar 的 slot 契约表读出）：
 *   - sidebar.brand.name      single  · replaceRisk: shadows-shipped-ui
 *                             → 挂上去会**顶掉**官方品牌名，不采用
 *   - sidebar.workspaces      single  · 「declaring is claiming」，被 ui-workspace 占着
 *                             → 想在那里做「真切换」= 接管整个浏览区（搜索/分组/对话框全重写）
 *   - sidebar.footer.action   list    · 追加型，安全；ownerProps { wide }
 *   - sidebar.panellist       list    · 每个 id 对应一个 main 面板
 *   - main                    panel   · nas-sync 已验证可用
 *
 * 所以本 spike 选：footer.action 放切换器状态，panellist + main 放远程列表。
 * 三处都打 data-wbsync 标记，方便用 CDP 量尺寸。
 */
window.__ModuleLoader__.load({
  // id 必须与包名一致：client-modules 按包解析模块，独立 id 会被重复注册并报
  // duplicate factory registration。nas-sync 同样用包名作 id。
  id: 'dsh-wb-cloud-sync-host',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState } = React

    const PANEL_ID = 'wbsync-remote'
    const MODE_KEY = 'wbsync.mode'

    const readMode = () => {
      try { return window.localStorage.getItem(MODE_KEY) === 'remote' ? 'remote' : 'local' } catch { return 'local' }
    }
    const writeMode = (m) => {
      try { window.localStorage.setItem(MODE_KEY, m) } catch { /* 隐私模式忽略 */ }
    }

    const dot = (color) => h('span', {
      style: {
        width: 6, height: 6, borderRadius: '50%', background: color,
        display: 'inline-block', flex: '0 0 auto',
      },
    })

    /** 切换器本体：一个胶囊，点一下在本机/电脑之间切。spike 只改本地状态。 */
    function DevicePill({ compact }) {
      const [mode, setMode] = useState(readMode)
      const remote = mode === 'remote'
      return h('button', {
        type: 'button',
        'data-wbsync': 'device-pill',
        title: '切换设备（spike）',
        onClick: () => {
          const next = remote ? 'local' : 'remote'
          writeMode(next)
          setMode(next)
        },
        style: {
          display: 'inline-flex', alignItems: 'center', gap: 5,
          padding: compact ? '2px 7px' : '4px 9px',
          borderRadius: 999, cursor: 'pointer',
          border: '0.5px solid ' + (remote ? 'var(--color-border-info)' : 'var(--color-border-secondary)'),
          background: remote ? 'var(--color-background-info)' : 'transparent',
          color: remote ? 'var(--color-text-info)' : 'var(--color-text-secondary)',
          font: 'inherit', fontSize: compact ? 11 : 12, lineHeight: 1.2,
          maxWidth: '100%', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
        },
      }, [
        dot('var(--color-text-success)'),
        h('span', { key: 't' }, remote ? '我的电脑' : '本机'),
        h('span', { key: 'c', style: { opacity: 0.6 } }, '▾'),
      ])
    }

    /** main 面板：远程会话列表（spike 用假数据，只为验证布局与可达性）。 */
    function RemotePanel() {
      const [mode, setMode] = useState(readMode)
      const remote = mode === 'remote'
      const rows = remote
        ? ['季度报告整理', '半导体调研', '插件联调']
        : []
      return h('div', {
        'data-wbsync': 'remote-panel',
        style: { padding: 16, fontFamily: 'var(--font-sans)', color: 'var(--color-text-primary)' },
      }, [
        h('div', { key: 'head', style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 } }, [
          h('div', { key: 'h', style: { fontSize: 14, fontWeight: 500 } }, '设备'),
          h(DevicePill, { key: 'p' }),
        ]),
        remote
          ? h('div', { key: 'list', style: { display: 'flex', flexDirection: 'column', gap: 6 } },
            rows.map((name) => h('div', {
              key: name,
              'data-wbsync': 'remote-row',
              style: {
                padding: '8px 10px', borderRadius: 8,
                border: '0.5px solid var(--color-border-tertiary)',
                fontSize: 13, display: 'flex', alignItems: 'center',
                justifyContent: 'space-between', gap: 8,
              },
            }, [
              h('span', { key: 'n' }, name),
              h('span', {
                key: 'tag',
                style: {
                  fontSize: 10, padding: '1px 5px', borderRadius: 4,
                  border: '0.5px solid var(--color-border-info)',
                  color: 'var(--color-text-info)',
                },
              }, '远程'),
            ])))
          : h('div', { key: 'empty', style: { fontSize: 13, color: 'var(--color-text-secondary)', lineHeight: 1.6 } },
            '当前是「本机」模式。点上面的胶囊切到「我的电脑」看远程会话。'),
        h('div', {
          key: 'note',
          style: { marginTop: 16, fontSize: 11, color: 'var(--color-text-tertiary)', lineHeight: 1.6 },
        }, 'SPIKE：这条列表是假数据，只为验证槽位挂载、尺寸与可达性。'),
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
          { name: 'sidebar.panellist', id: PANEL_ID, order: 40, label: () => '设备' },
          PanelIcon,
        ))

      // 追加型槽位：不动原生条目，只在设置旁边加一个状态胶囊
      ctx.slots.inject('sidebar.footer.action', () =>
        ctx.slots.register(
          { name: 'sidebar.footer.action', id: 'wbsync-device', order: 5, label: () => '设备' },
          function FooterDevice() { return h(DevicePill, { compact: true }) },
        ))

      // SPIKE 自检：把实测尺寸打回 console（Electron 会转进 stderr）。
      // 目的是量「手机上放不放得下」，不是调试。
      try {
        window.setTimeout(() => {
          const rows = [...document.querySelectorAll('[data-wbsync]')].map((e) => {
            const r = e.getBoundingClientRect()
            return e.getAttribute('data-wbsync') + '=' + Math.round(r.width) + 'x' + Math.round(r.height)
          })
          console.log('[wbsync-spike] vw=' + window.innerWidth + ' vh=' + window.innerHeight
            + ' hits=' + rows.length + ' :: ' + rows.join(' '))
        }, 3000)
      } catch { /* 没有 window 就算了 */ }
    }

    return { inject: ['slots'], apply }
  },
})
