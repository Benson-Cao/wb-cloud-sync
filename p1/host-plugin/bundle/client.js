/**
 * WB-Cloud-Sync · PC 桌面设置页（v2.3 / D-005）
 * ---------------------------------------------------------------
 * 视觉改版 2026-11-15：参考「WB-Sync_两端UI_原装黑白单色_设计稿」mono/pc.html
 * 的 02 插件设置 / 03 配对码浮层，落地与手机端原生页同一套中性 token
 * （零彩度灰阶、主按钮黑底白字、12/8/4 三级圆角、状态靠实心/空心/虚线区分）。
 * 上一版按社区「DeepSeek 官网风」彩色稿做过一次（品牌 #4B5CF6、薄荷 #16B394），
 * 那是判断失误 —— 官方 `dsh web` 本身近黑近白，壳层再上彩色会在切换主题时打架。
 *
 * 形态不变（13 §1）：`dsh.client` 半边**只做桌面设置页**，不托管 UI 资源、
 * 不渲染会话列表 / 对话 / 审批 / 镜像面板。手机界面由官方 `dsh web` 提供。
 * 设置页与插件同源，直接读 `/__wbsync/status` 与 `/__wbsync/config`（已脱敏）。
 *
 * 视觉稿与运行契约的取舍（不造假交互）：
 *   - 设计稿的两个开关在 v2.3 后端没有写接口 → 做成**只读状态指示**，
 *     数据源是 config 里已有的脱敏字段，鼠标悬停会说明「由本机配置决定」；
 *   - HOST_TOKEN 按 B-client2 约束绝不读明文，只显示「已配置 / 未配置」与
 *     SHA-256 摘要口径；「轮换」复用 /__wbsync/pair（重新配对自动替换旧令牌）；
 *   - 「连接诊断」「导出诊断」用现有 status/config 现场计算与导出，不编造后端；
 *   - 配对码浮层额外显示本机指纹，落实「电脑显示 → 手机核对」的方向修正。
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

    // ---------- 设计系统（与手机端原生页共用同一套中性 token）----------
    //
    // 2026-11-15 第二次改版：上一版参照的是社区「DeepSeek 官网风」彩色稿
    // （品牌 #4B5CF6 / 薄荷 #16B394 / 琥珀 #E09616），这是**判断错了**——
    // DSH 自带的 `dsh web` 本身就是近黑近白，壳层再上彩色会在用户切换主题时打架。
    // 现在全部收敛到零彩度灰阶，与 mono 设计稿 `--dsw-*` 数值逐项对齐。
    //
    // 旧语义名（brand / mint / amber / danger）**故意保留**：本文件有 50 处调用点
    // 读的是语义而不是色相，改名只会制造 diff 噪音。它们现在全部指向灰阶，
    // 任何一处漏改都不会再冒彩。
    const T = {
      brand: '#18181B',
      brand2: '#18181B',
      mint: '#18181B',
      amber: '#3F3F46',
      danger: '#18181B',
      ink: '#18181B',
      ink2: '#52525B',
      ink3: '#8B8B93',
      faint: '#A1A1AA',
      card: '#FFFFFF',
      canvas: '#FFFFFF',
      subtle: '#F4F4F5',
      soft: '#F4F4F5',
      soft2: '#FAFAFA',
      line: '#E4E4E7',
      lineStrong: '#D4D4D8',
      rule: '#C9C9CE',
      // 状态三档：实心 / 空心 / 更淡的空心（靠形状区分，不靠颜色）
      on: '#18181B',
      wait: '#52525B',
      off: '#B5B5BA',
      // 单色体系里「阴影」只剩边线语义，真投影会把白底压出脏灰
      shadow: 'none',
      rCard: 12,
      rBtn: 8,
      rInput: 8,
      rBadge: 4,
      rAvatar: 8,
    }
    const FONT = 'WenQuanYi Micro Hei, system-ui, -apple-system, sans-serif'
    const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace'

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

    // ---------- 图标（内联线性 SVG，stroke 1.8，无外部资源）----------

    const icon = (name, size = 15) => {
      const paths = {
        link: 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.5 1.5',
        key: 'M15 7a4 4 0 1 0-3.9 5H13l-2 2H9a4 4 0 0 1 0-8h4l2 2',
        copy: 'M8 8h10v10H8z M6 16H4V4h12v2',
        refresh: 'M20 11a8 8 0 1 0-2 6 M20 5v6h-6',
        download: 'M12 4v11 M8 11l4 4 4-4 M5 19h14',
        shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
        close: 'M6 6l12 12 M18 6L6 18',
      }
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round',
        strokeLinejoin: 'round', 'aria-hidden': 'true', style: { flex: '0 0 auto' },
      }, h('path', { d: paths[name] || paths.link }))
    }

    // ---------- 基础组件 ----------

    // 单色状态语汇：实心点 = 在线 / 已完成；空心环 = 待处理 / 未开启。
    // 加 hollow 参数而不是新造组件 —— 调用点关心的是「有没有点亮」，不是形状细节。
    const dot = (color, size = 7, hollow = false) => h('span', {
      style: {
        boxSizing: 'border-box',
        width: size, height: size, borderRadius: '50%',
        background: hollow ? 'transparent' : color,
        border: hollow ? `1.5px solid ${color}` : 'none',
        display: 'inline-block', flex: '0 0 auto',
      },
    })

    /**
     * 单色标签（对齐 pc.html 的 `.tag` 四档）。
     *
     * <p>设计稿把「状态」编码进**形状**，不靠颜色：
     * <ul>
     *   <li>{@code on} —— 浅灰底 + 实线描边（在线 / 已完成）</li>
     *   <li>{@code off} —— 更淡的底 + **虚线**描边（离线 / 未开启）</li>
     *   <li>{@code warn} —— 白底 + **虚线**描边（待处理）</li>
     *   <li>{@code invert} —— 黑底白字（关键标识 / 当前选中）</li>
     * </ul>
     * 统一 4px 圆角（{@code --dsw-radius-badge}）。**不是胶囊** —— 20px 胶囊是上一版
     * 彩色稿的语汇，在单色体系里会和「反白块」抢语义。
     * 字体用等宽：设计稿里 tag 与诊断条同族，小字号下等宽更稳。
     */
    const Tag = ({ text, tone = 'on', dotTone }) => {
      const TONES = {
        on: { bg: T.subtle, fg: T.ink, bc: T.lineStrong, dashed: false },
        off: { bg: T.soft2, fg: T.ink3, bc: T.line, dashed: true },
        warn: { bg: T.card, fg: T.ink2, bc: T.faint, dashed: true },
        invert: { bg: T.ink, fg: '#FFFFFF', bc: T.ink, dashed: false },
      }
      const s = TONES[tone] || TONES.on
      return h('span', {
        style: {
          display: 'inline-flex', alignItems: 'center', gap: 5,
          padding: '4px 8px', borderRadius: T.rBadge, boxSizing: 'border-box',
          fontSize: 9.5, fontWeight: 700, fontFamily: MONO, letterSpacing: '.2px',
          background: s.bg, color: s.fg,
          border: `${s.dashed ? '1.5px dashed' : '1px solid'} ${s.bc}`,
        },
      }, [
        dotTone ? dot(dotTone.color, 6, dotTone.hollow) : null,
        h('span', { key: 't' }, text),
      ])
    }

    const Btn = ({ label, onClick, variant = 'ghost', disabled, glyph }) => h('button', {
      onClick, disabled: Boolean(disabled), type: 'button',
      style: {
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
        padding: '9px 15px', borderRadius: T.rBtn, fontSize: 12.5, fontFamily: FONT,
        cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1,
        // 单色稿：主按钮 = 黑底白字（无渐变、无彩色外发光）；
        // danger 不再是红底，而是「白底 + 近黑虚线框」—— 与手机端 dangerDrawable 同一语义。
        border: variant === 'primary' ? `1px solid ${T.brand}`
          : variant === 'danger' ? `1.5px dashed ${T.ink}` : `1px solid ${T.line}`,
        background: variant === 'primary' ? T.brand : T.card,
        color: variant === 'primary' ? '#FFFFFF' : T.ink,
        boxShadow: 'none',
      },
    }, [glyph ? h('span', { key: 'i', style: { display: 'inline-flex' } }, icon(glyph, 14)) : null,
        h('span', { key: 't' }, label)])

    const MiniBtn = ({ label, onClick, glyph }) => h('button', {
      onClick, type: 'button', title: label,
      style: {
        display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 9px',
        borderRadius: T.rInput, border: `1px solid ${T.line}`, background: T.card,
        color: T.ink2, fontSize: 11.5, fontFamily: FONT, cursor: 'pointer',
      },
    }, [glyph ? h('span', { key: 'i', style: { display: 'inline-flex' } }, icon(glyph, 13)) : null,
        h('span', { key: 't' }, label)])

    const Card = ({ title, badge }, children) => h('section', {
      style: {
        background: T.card, border: `1px solid ${T.line}`, borderRadius: T.rCard,
        boxShadow: T.shadow, padding: '4px 18px', marginBottom: 16,
      },
    }, [
      h('div', {
        key: 'h', style: {
          display: 'flex', alignItems: 'center', gap: 8, padding: '13px 0 11px',
          borderBottom: `1px solid ${T.line}`,
        },
      }, [
        h('span', { key: 'ic', style: { color: T.brand, display: 'inline-flex' } }, icon('link', 15)),
        h('h3', { key: 't', style: { margin: 0, fontSize: 13, fontWeight: 600, color: T.ink } }, title),
        badge ? h('span', {
          key: 'b', style: {
            marginLeft: 'auto', fontSize: 10.5, color: T.ink3, letterSpacing: .2,
          },
        }, badge) : null,
      ]),
      h('div', { key: 'b' }, children),
    ])

    const Field = ({ label, hint, value, mono, action, last }) => h('div', {
      style: {
        display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0',
        borderBottom: last ? 'none' : `1px solid ${T.line}`,
      },
    }, [
      h('div', { key: 'l', style: { flex: '1 1 auto', minWidth: 0 } }, [
        h('div', { key: 'n', style: { fontSize: 12.5, fontWeight: 600, color: T.ink } }, label),
        hint ? h('div', { key: 'h', style: { fontSize: 10.5, color: T.ink3, marginTop: 3, lineHeight: 1.55 } }, hint) : null,
      ]),
      h('div', {
        key: 'v', style: {
          flex: '0 1 auto', maxWidth: '52%', wordBreak: 'break-all', textAlign: 'right',
          fontSize: 12, color: T.ink2, fontFamily: mono ? MONO : FONT,
        },
      }, value),
      action ? h('div', { key: 'a', style: { flex: '0 0 auto' } }, action) : null,
    ])

    /** 只读状态指示：后端没有写接口，不做成可点开关。 */
    const StateToggle = ({ on, label, hint, last }) => h('div', {
      title: '由本机配置决定，本页只读；修改请改 ~/.dsh/wbsync-host.json 后重启 DSH',
      style: {
        display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0',
        borderBottom: last ? 'none' : `1px solid ${T.line}`,
      },
    }, [
      h('div', { key: 'l', style: { flex: '1 1 auto' } }, [
        h('div', { key: 'n', style: { fontSize: 12.5, fontWeight: 600, color: T.ink } }, label),
        h('div', { key: 'h', style: { fontSize: 10.5, color: T.ink3, marginTop: 3, lineHeight: 1.55 } }, hint),
      ]),
      h('span', { key: 's', style: { display: 'inline-flex', alignItems: 'center', gap: 5,
        fontSize: 10.5, color: on ? T.on : T.ink3 } },
        [dot(on ? T.on : T.off, 6, !on), on ? '已开启' : '未开启']),
      h('span', {
        key: 'p', style: {
          width: 34, height: 19, borderRadius: 10, flex: '0 0 auto',
          boxSizing: 'border-box',
          background: on ? T.on : T.subtle,
          border: `1px solid ${on ? T.on : T.lineStrong}`,
          position: 'relative',
        },
      }, h('span', {
        style: {
          position: 'absolute', top: 1, width: 15, height: 15, borderRadius: '50%',
          background: '#FFFFFF', left: on ? 16 : 1,
          border: `1px solid ${on ? 'transparent' : T.lineStrong}`,
        },
      })),
    ])

    // ---------- 配对码浮层（设计稿 03：电脑显示 → 手机核对）----------

    function PairOverlay({ pairing, onClose }) {
      const fp = pairing?.fingerprint || pairing?.hostFingerprint || null
      return h('div', {
        'data-wbsync': 'pair-overlay',
        style: {
          // 遮罩用中性近黑，不用蓝调黑（蓝调会在白底界面上透出一点冷色）
          position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(24,24,27,.40)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
        },
      }, h('div', {
        style: {
          width: 470, maxWidth: '100%', background: T.card, borderRadius: T.rCard,
          // 单色稿去掉玻璃阴影：浮层靠「1px 近黑边线 + 中性投影」立起来
          border: `1px solid ${T.rule}`,
          boxShadow: '0 18px 44px rgba(24,24,27,.16)', padding: 24, fontFamily: FONT,
        },
      }, [
        h('div', { key: 'h', style: { display: 'flex', alignItems: 'center', gap: 8 } }, [
          h('span', { key: 'i', style: { color: T.brand, display: 'inline-flex' } }, icon('key', 17)),
          h('h3', { key: 't', style: { margin: 0, fontSize: 16, fontWeight: 700, color: T.ink } }, '配对码'),
          h('button', {
            key: 'x', type: 'button', onClick: onClose, title: '关闭',
            style: { marginLeft: 'auto', border: 'none', background: 'transparent',
              color: T.ink3, cursor: 'pointer', display: 'inline-flex' },
          }, icon('close', 16)),
        ]),
        h('p', { key: 's', style: { margin: '8px 0 18px', fontSize: 11.5, color: T.ink2, lineHeight: 1.65 } },
          '在手机端输入这 6 位配对码，并核对下面这串电脑指纹后再 pin。'),
        // 设计稿 `.codebox` = **反白块**：配对码是这一屏唯一的关键标识，
        // 单色体系里只能靠「黑底白字」把它从周围拉开，不能靠颜色。
        // label / code / TTL 三层都塞进这个块里（原来是浅灰底 + TTL 挂在块外）。
        h('div', {
          key: 'code', style: {
            background: T.ink, borderRadius: T.rCard, padding: '16px 14px 18px',
            textAlign: 'center', color: '#FFFFFF',
          },
        }, [
          h('div', {
            key: 'l', style: { fontSize: 10, opacity: .75, letterSpacing: '.5px', fontFamily: MONO },
          }, '配对码'),
          h('div', {
            key: 'v', style: {
              fontSize: 38, fontWeight: 700, letterSpacing: 8, marginTop: 6, fontFamily: MONO,
            },
          }, String(pairing?.code ?? '------')),
          pairing?.expiresIn ? h('div', {
            key: 't', style: { fontSize: 10.5, opacity: .8, marginTop: 7, fontFamily: MONO },
          }, `${pairing.expiresIn} 秒内有效 · 10 分钟 TTL`) : null,
        ]),
        h('div', {
          key: 'fp', style: {
            marginTop: 18, padding: '12px 14px', borderRadius: 12,
            border: `1px solid ${T.line}`, background: T.card,
          },
        }, [
          h('div', {
            key: 'l', style: { fontSize: 9.5, color: T.ink3, fontWeight: 700, letterSpacing: '.4px' },
          }, '本机指纹（手机端核对这一串）'),
          h('div', { key: 'v', style: { marginTop: 6, fontSize: 14, fontFamily: MONO,
            letterSpacing: 1.5, color: T.ink } }, fp || '由电脑端配对页显示'),
        ]),
        h('div', { key: 'a', style: { display: 'flex', justifyContent: 'flex-end', marginTop: 20 } },
          Btn({ label: '完成', onClick: onClose, variant: 'primary', glyph: 'shield' })),
      ]))
    }

    // ---------- 设置面板 ----------

    function SettingsPanel() {
      const [status, setStatus] = useState(null)
      const [config, setConfig] = useState(null)
      const [error, setError] = useState(null)
      const [pairing, setPairing] = useState(null)
      const [showDiagnostics, setShowDiagnostics] = useState(false)
      const [copied, setCopied] = useState(false)
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

      const relayUrl = (config && config.relayUrl) || '（未配置）'
      const onCopy = async () => {
        if (!config || !config.relayUrl) return
        try {
          await navigator.clipboard.writeText(config.relayUrl)
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1600)
        } catch { setError('复制失败：浏览器未授权剪贴板') }
      }

      const exportDiagnostics = () => {
        const snapshot = { capturedAt: new Date().toISOString(), status, config }
        const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = 'wbsync-diagnostics.json'
        a.click()
        URL.revokeObjectURL(url)
      }

      const connected = status?.connected === true
      const stateText = connected ? '已连接 Relay' : (status ? '未连接 Relay' : '读取中…')
      const tokenConfigured = Boolean(config && config.hostTokenConfigured)

      return h('div', {
        'data-wbsync': 'settings-panel',
        style: {
          padding: '26px 28px 32px', maxWidth: 900, fontFamily: FONT,
          color: T.ink, fontSize: 12.5, lineHeight: 1.65,
        },
      }, [
        h('div', { key: 'head', style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 } }, [
          h('h2', { key: 't', style: { margin: 0, fontSize: 22, fontWeight: 700, color: T.ink } }, '手机连接'),
          // 原来是个 20px 胶囊 + 恒实心点。单色稿里状态必须靠形状：
          // 已连接=实心点+浅灰底实线框；未连接=空心环+虚线框；读取中=更淡的一档。
          h('span', { key: 's', style: { marginLeft: 4, display: 'inline-flex' } },
            Tag({
              text: stateText,
              tone: connected ? 'on' : (status ? 'warn' : 'off'),
              dotTone: { color: connected ? T.on : T.off, hollow: !connected },
            })),
        ]),
        h('p', { key: 'sub', style: { margin: '0 0 20px', fontSize: 11.5, color: T.ink2 } },
          '让这台电脑作为 Host 被手机发现。会话与文件始终留在本机，插件只负责接入与事件转发。'),

        error ? h('div', {
          key: 'err',
          style: {
            margin: '0 0 16px', padding: '10px 14px', borderRadius: 12,
            // 单色稿：错误不再用粉红底 + 粉红边，而是「白底 + 1.5px 近黑虚线框 + 近黑文字」
            background: T.card, border: `1.5px dashed ${T.ink}`, color: T.ink, fontSize: 11.5,
          },
        }, error) : null,

        Card({ title: '接入控制', badge: '两项都必须显式开启' }, [
          StateToggle({
            on: Boolean(config && config.allowMobile !== false && status),
            label: '允许移动端连接此设备',
            hint: '关闭后已建立的 Relay 连接立即断开，设备从列表消失',
          }),
          StateToggle({
            on: Boolean(config && config.keepAwake !== false && status),
            label: '保活唤醒',
            hint: '防止系统休眠；锁屏/省电会直接断连，需在产品层提示',
          }),
          Field({
            label: '在线判定',
            hint: '20 秒无心跳显示离线；不等于此刻正在使用',
            value: connected ? 'heartbeat 20s · 在线' : 'heartbeat 20s · 离线',
            last: true, mono: true,
          }),
        ]),

        Card({ title: 'Relay 与凭据', badge: 'Host 主动出网，无需公网端口' }, [
          Field({
            label: '监听地址',
            hint: '填到手机端「电脑地址」的就是这一项；不是手机的 127.0.0.1',
            value: relayUrl, mono: true,
            action: MiniBtn({ label: copied ? '已复制' : '复制', onClick: () => void onCopy(), glyph: 'copy' }),
          }),
          Field({
            label: 'HOST_TOKEN',
            hint: '仅存 SHA-256 摘要，重新配对自动替换旧令牌；本页不读取明文',
            value: config ? (tokenConfigured ? '••••••••••••  ·  已配置' : '未配置') : '读取中…',
            mono: true,
            action: MiniBtn({ label: '轮换', onClick: () => void onPair(), glyph: 'refresh' }),
          }),
          Field({
            label: 'DSH 基线',
            hint: '两端需锁定同一 commit；漂移拒绝连接',
            value: [config?.dshCommit ?? '未注入', config?.commitDrift ? 'COMMIT_DRIFT' : 'COMMIT_DRIFT 无'].join('  ·  '),
            mono: true, last: true,
          }),
        ]),

        h('p', {
          key: 'note', style: {
            margin: '4px 0 18px', fontSize: 10.5, color: T.ink3, lineHeight: 1.7,
          },
        }, [
          h('span', { key: 'i', style: { color: T.brand, marginRight: 6 } }, 'ⓘ'),
          '本页不托管任何 UI 静态资源；手机端直接打开本机官方 dsh web（本机档案）或经 SSH / Relay 反代打开它。',
        ]),

        showDiagnostics ? h('div', {
          key: 'diag', style: {
            marginBottom: 18, padding: 14, borderRadius: T.rCard,
            background: T.card, border: `1px solid ${T.line}`, boxShadow: T.shadow,
          },
        }, [
          h('div', { key: 't', style: { fontSize: 12, fontWeight: 600, marginBottom: 8 } }, '连接诊断 · 同源状态快照'),
          h('pre', { key: 'p', style: {
            margin: 0, fontSize: 10.5, fontFamily: MONO, color: T.ink2,
            whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 220, overflow: 'auto',
          } }, JSON.stringify({ status, config }, null, 2)),
        ]) : null,

        h('div', {
          key: 'actions', style: {
            display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 8,
            paddingTop: 18, borderTop: `1px solid ${T.line}`,
          },
        }, [
          Btn({ label: pairing ? '重新生成配对码' : '生成配对码', onClick: () => void onPair(),
            variant: 'primary', glyph: 'key', disabled: busy }),
          Btn({ label: showDiagnostics ? '收起诊断' : '连接诊断',
            onClick: () => setShowDiagnostics(v => !v), glyph: 'refresh', disabled: busy }),
          Btn({ label: '导出诊断', onClick: exportDiagnostics, glyph: 'download' }),
          Btn({ label: '刷新', onClick: () => void refresh(), disabled: busy }),
        ]),

        pairing ? PairOverlay({ pairing, onClose: () => setPairing(null) }) : null,
      ])
    }

    /** 侧栏底部入口：只渲染图标与文字，外层 slot 提供按钮语义。 */
    function SettingsAction() {
      return h('span', {
        title: 'WB-Cloud-Sync 设置',
        'data-wbsync': 'settings-action',
        style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, opacity: 0.75 },
      }, [dot(T.brand, 6), h('span', { key: 't' }, '云同步')])
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
