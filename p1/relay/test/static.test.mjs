/**
 * PWA 壳静态服务 · 测试
 * /app → p1/pwa/public，/src → p1/pwa/src；无鉴权静态（PWA 必需），
 * 单层文件名白名单式校验（拒绝子路径 / 反斜杠 / ..），staticDir:null 可关闭。
 */
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createRelay } from '../src/server.js'

let relay, port, closed, closedPort

const get = async (port, path) => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`)
  return { status: r.status, type: r.headers.get('content-type') ?? '', text: await r.text() }
}

before(async () => {
  relay = createRelay({ hostToken: 'host-secret', requestTimeoutMs: 300 })
  port = await relay.start(0)
  closed = createRelay({ hostToken: 'host-secret', staticDir: null })
  closedPort = await closed.start(0)
})
after(async () => {
  await relay.stop()
  await closed.stop()
})

test('S1 /app 与 /app/ 都回壳页面，/src/client.js 可取（页面相对路径的解析目标）', async () => {
  for (const p of ['/app', '/app/']) {
    const page = await get(port, p)
    assert.equal(page.status, 200)
    assert.match(page.type, /text\/html/)
    assert.match(page.text, /WBSync 会话/)
  }
  const client = await get(port, '/src/client.js')
  assert.equal(client.status, 200)
  assert.match(client.type, /text\/javascript/)
  assert.match(client.text, /createPwaClient/)
  const pairing = await get(port, '/src/pairing.js')
  assert.equal(pairing.status, 200)
  assert.match(pairing.text, /pairWithRelay/)
})

test('S2 其余壳资源：sw.js / manifest / icon，MIME 正确', async () => {
  const sw = await get(port, '/app/sw.js')
  assert.equal(sw.status, 200)
  assert.match(sw.type, /text\/javascript/)
  const manifest = await get(port, '/app/manifest.webmanifest')
  assert.equal(manifest.status, 200)
  assert.match(manifest.type, /manifest\+json/)
  const icon = await get(port, '/app/icon.svg')
  assert.equal(icon.status, 200)
  assert.match(icon.type, /image\/svg/)
})

test('S3 路径遍历与子路径一律拒绝；未知文件 404', async () => {
  // %2e%2e（.. 的编码形态）解码后含 .. → 403
  const dotdot = await get(port, '/app/%2e%2e%2frelay%2fsrc%2fserver.js')
  assert.equal(dotdot.status, 403)
  // 反斜杠形态
  const backslash = await get(port, '/app/..%5crelay%5csrc%5cserver.js')
  assert.equal(backslash.status, 403)
  // 不存在的文件与无扩展名请求
  assert.equal((await get(port, '/app/nope.js')).status, 404)
  assert.equal((await get(port, '/src/nope.js')).status, 404)
  // 壳页面源码不被越权枚举：/app 下没有 server.js
  assert.equal((await get(port, '/app/server.js')).status, 404)
})

test('S4 staticDir:null 显式关闭 → /app 404', async () => {
  const page = await get(closedPort, '/app')
  assert.equal(page.status, 404)
  assert.match(page.text, /未启用静态壳服务/)
})

test('S5 壳页面引用的资源都能从 /app 页面解析路径取到（自洽检查）', async () => {
  const page = await get(port, '/app/')
  // 页面里 import '../src/client.js'、'../src/pairing.js' → 从 /app/ 解析为 /src/*
  // 页面里 import { x } from '../src/client.js'、href="./manifest.webmanifest"
  const refs = [...page.text.matchAll(/(?:\bfrom|href|src)\s*=?\s*["']([^"']+)["']/g)].map((m) => m[1])
  assert.ok(refs.includes('../src/client.js'), '页面应引用 ../src/client.js')
  assert.ok(refs.includes('./manifest.webmanifest'), '页面应引用 ./manifest.webmanifest')
  for (const ref of refs) {
    if (!ref.startsWith('.') && !ref.startsWith('http')) continue
    const resolved = new URL(ref, 'http://x/app/').pathname
    const r = await get(port, resolved)
    assert.equal(r.status, 200, `引用资源应可取：${ref} → ${resolved}`)
  }
})

test('S6 SW 缓存清单覆盖壳页面与 src 模块的传递引用', async () => {
  const sw = await get(port, '/app/sw.js')
  const assets = sw.text.match(/SHELL_ASSETS\s*=\s*\[([\s\S]*?)\]/)?.[1] ?? ''
  const listed = [...assets.matchAll(/["']([^"']+)["']/g)].map((m) => m[1])

  const listedPaths = new Set(listed.map((a) => new URL(a, 'http://x/app/').pathname))
  // 页面引用的相对资源必须都在清单里（按 /app/ 解析，与清单项同一基准）
  const page = (await get(port, '/app/')).text
  const pageRefs = [...page.matchAll(/(?:\bfrom|href|src)\s*=?\s*["'](\.[^"']+)["']/g)].map((m) => m[1])
  for (const ref of pageRefs) {
    const resolved = new URL(ref, 'http://x/app/').pathname
    assert.ok(listedPaths.has(resolved), `SW 缓存清单缺少页面引用：${ref}`)
  }

  // src 模块间的相对 import 也必须在清单里（新增配对依赖漏缓存会导致离线加载失败）
  // r23：卡片契约是 client.js 的传递引用，扫描列表必须覆盖整条 import 链，
  // 否则新增模块只在开发环境能加载、离线壳会静默失效。
  for (const name of ['client.js', 'pairing.js', 'hmac-sha256.js', 'card-delivery.js', 'cards.js', 'transcript.js']) {
    const src = (await get(port, `/src/${name}`)).text
    for (const m of src.matchAll(/\bfrom\s*["'](\.\/[^"']+)["']/g)) {
      const dep = m[1].replace(/^\.\//, '')
      assert.ok(listed.includes(`../src/${dep}`), `SW 缓存清单缺少模块依赖：${name} → ${dep}`)
      assert.equal((await get(port, `/src/${dep}`)).status, 200, `依赖应可从 /src/ 取到：${dep}`)
    }
  }
  // 缓存名不硬编码具体版本：只要保持 vN 且不低于当前基线即可，
  // 避免每次递增（v3 → v4 → …）都要回来改这条断言。
  const cache = sw.text.match(/SHELL_CACHE\s*=\s*["']wbsync-shell-v(\d+)["']/)
  assert.ok(cache, 'SHELL_CACHE 必须是 wbsync-shell-vN 形式')
  assert.ok(Number(cache[1]) >= 4,
    `壳资源变更后缓存名应递增（当前基线 v4），实际 v${cache[1]}`)
  // 真机 0.1.6 取证：滚到事件流区域点按钮后，顶部反馈条看不见，被误判成「点了没反应」
  assert.match(page, /scrollIntoView/, '操作反馈必须主动滚入视口')
  assert.match(page, /STATUS_TEXT/, '订阅状态需映射中文，不暴露 connecting/following 内部值')
  assert.match(page, /fold\.type === type/, '连续同类型事件需折叠，避免流式碎片把页面拉爆')
  assert.match(page, /id="forget"/, '必须有「忘掉这台电脑」入口，清令牌不靠清浏览器数据')
  assert.match(page, /for \(const k of \['wbsync\.token'/, '忘掉电脑必须真的清掉令牌 / 设备 ID / 地址')
  assert.match(page, /#newbar\[hidden\][\s\S]*?display:\s*none/,
    'display:flex 会盖掉 UA 的 [hidden]{display:none}，必须显式提权重，否则 hidden 形同虚设')

  // W8 审批卡片：三件事缺一不可——区域存在、两种应答按钮、避免把「别人先答了」报成失败
  assert.match(page, /id="approvals"/, '必须有审批区（设备级，不随当前会话变化）')
  assert.match(page, /#approvals\[hidden\][\s\S]*?display:\s*none/,
    '审批区的 display:grid 同样会盖掉 [hidden]，必须显式提权')
  assert.match(page, /answerApproval/, '必须能应答审批')
  assert.match(page, /APPROVAL_GONE/, '先答先得：409 要按「已在电脑上处理」处理，不能报成失败')
  assert.match(page, /refreshApprovals/, '必须能拉全量待审批（推送会丢，拉取才不漏）')
  assert.match(page, /approvalsPulled/, '重连回来要补拉一次审批')

  // W8 产物卡片：只搬元数据，且 [hidden] 同样要提权
  assert.match(page, /id="artifacts"/, '必须有产物区')
  assert.match(page, /#artifacts\[hidden\][\s\S]*?display:\s*none/, 'display:grid 会盖掉 [hidden]')
  assert.match(page, /getArtifacts/, '必须能向 Host 拉产物索引')
  assert.match(page, /deliverables\/presented/, '出现呈现事件时要刷新产物卡片')
  assert.match(page, /textContent/, '路径来自宿主日志，必须用 textContent 渲染，不许当 HTML 执行')
  assert.match(page, /sessionId !== activeSession/, '切走会话后旧响应不许盖上来')

  // 大事件降级：别把 marker 当正文铺开，也别让人以为事件丢了
  assert.match(page, /ev\?\.data\?\.truncated/, '降级事件要单独识别')
  assert.match(page, /超过单帧上限未转发/, '要说明「正文没转发」而不是静默显示空内容')

  // 转录渲染：消息成气泡、工具有摘要、正文一律 textContent
  assert.match(page, /transcript\.js/, '页面必须引用转录纯函数模块')
  assert.match(page, /\.msg\.user[\s\S]*?\.msg\.assistant/, '用户/助手气泡要有区分样式')
  assert.match(page, /classifyEvent\(ev\)/, '渲染要按归类走，而不是一律铺 JSON')
  assert.match(page, /createElement\('details'\)/, '工具结果要折叠，不能把整段输出铺在流里')
  assert.match(page, /body\.textContent = messageText\(ev\)/, '消息正文必须用 textContent，杜绝 HTML 注入')

  // 会话列表（真机 2026-11-11 截图取证）：标题回退 + 徽章不被顶出屏幕
  assert.match(page, /\.row > div \{ min-width: 0/, '内层不设 min-width:0 时，长标题会把状态徽章顶出屏幕')
  assert.match(page, /\.badge \{[\s\S]*?white-space: nowrap/, '徽章文案不许换行/截断')
  assert.match(page, /workspaceName\(r\.workspace\)/, '没有标题时回退工作区目录名，而不是一串 session-id')
  assert.match(page, /title\.textContent = r\.title/, '标题走 textContent（工作区路径来自 Host，不能当 HTML）')
  assert.match(page, /STATE_LABEL\[r\.state\]/, '状态要映射中文，不直接暴露 stopped/failed 内部值')

  // 首屏窗口（用户选的方案）：先看最近 N 条，更早的按需反向补读
  assert.match(page, /EARLIER_WINDOW = 50/, '首屏窗口大小必须是个显式常量，别散落在逻辑里')
  assert.match(page, /sinceSeq: after/, '打开会话要从窗口末尾接流，而不是永远从 -1 全量拉')
  assert.match(page, /client\.backfill\(/, '「加载更早」必须走反向补读，不能拿 follow 硬拉')
  assert.match(page, /const rerender = /, '补到更早事件后要按 seq 整体重绘，避免 DOM 前插乱序')
  assert.match(page, /client\.openWindow\(/, '首屏窗口交给 Host 按字节裁，客户端不再数 50 条')

  // 插件内部流量（plugin:*）默认不糊首屏：真机截图里 translator 往返把整屏占满
  assert.match(page, /isPluginEvent\(ev\)/, 'plugin:* 要判定成内部流量')
  assert.match(page, /id="noise"/, '要有「显示插件事件」开关——隐藏不等于丢弃')
  assert.match(page, /shortType\(ev\)/, '摘要去掉 plugin: 前缀，保留可辨认的 translator/request')
  assert.match(page, /querySelector\('summary'\)/, '折叠行更新 summary（原始事件现在是 details 折叠）')
  assert.match(page, /createElement\('details'\)/, '原始事件默认折叠，别把 JSON 直接铺满屏')

  // 重绘不能抹掉来源：切一次噪声开关，「· 补齐」就会变成所有行的标签
  assert.match(page, /paint\(evBuf\.get\(seq\), evOrigin\.get\(seq\)/, '重绘必须按 seq 取回原来源，不能一律当 replay')
  assert.match(page, /evOrigin\.set\(ev\.seq, source === 'replay'/, '收到事件时就要记来源，晚了就取不回来')
  assert.match(page, /btn\.hidden = !showNoise && noiseHidden === 0/, '没有插件事件时不放按钮')

  // 阅读位置（W6 前置）：回到上次会话、按「距底」恢复、贴底跟随
  assert.match(page, /wbsync\.lastSession/, '要记住上次看的会话，刷新后自动回去')
  assert.match(page, /rows\.some\(\(r\) => r\.sessionId === last\)/, '上次的会话不在索引里就别硬开（被删了）')
  assert.match(page, /wbsync\.gap\./, '读到哪里要按会话存，不能只存一个全局位置')
  assert.match(page, /mainEl\.scrollHeight - mainEl\.scrollTop - mainEl\.clientHeight/,
    '位置用「距底距离」记，绝对 scrollTop 在字节窗口下会错位')
  assert.match(page, /followTail && source !== 'replay'/, '贴底跟随只跟实时事件，补读不该拽滚动条')
  assert.match(page, /activeSession && activeSession !== sessionId\) saveScroll/, '切走前先存位置，DOM 一清就只剩 0')
  assert.match(page, /id="back"/, '要有「← 列表」返回条')
  assert.match(page, /const backToList = /, '返回列表要记住位置并保留选中行')

  // 配对码一次性：连点两下会把码白白吃掉，第二次只会看到误导性的「码已过期」
  assert.match(page, /if \(pairing\) return/, '配对中要挡住连点')

  // 多台电脑（W7）：切换、状态点、按电脑忘掉
  assert.match(page, /id="profile"/, '要有电脑切换入口')
  assert.match(page, /location\.origin/, '没有档案时地址默认取当前访问地址，别让人照着旧地址填')
  assert.match(page, /const switchProfile = /, '切换电脑要断开旧订阅再按新档案重连')
  assert.match(page, /wbsync\.profiles/, '档案要存成列表，否则后配的电脑会盖掉先配的')
  assert.match(page, /const dotOf = /, '状态点要分开「在线/离线/没探过」三种')
  assert.match(page, /p\.online === true \? '●'/, '没探过不能画成离线')
  assert.match(page, /client\?\.getHostStatus/, '在线状态来自 sessions 响应，不另打接口')

  // 置顶（r11）：分组显示 + 逐条开关，且排序跟着宿主
  assert.match(page, /className = 'pinbtn'/, '每行要有置顶开关')
  assert.match(page, /const togglePin = /, '置顶要走 client.setPinned，不能只改本地布尔')
  assert.match(page, /className = 'grouphead'/, '置顶与全部分组显示')
  assert.match(page, /pinnedOrder \?\? 0/, '置顶组内按宿主给的 pinnedOrder 排，客户端不改序')

  // 归档（r12）：软移除 + 可恢复，不给「删除」
  assert.match(page, /id="archivedToggle"/, '要有展开已归档的入口')
  assert.match(page, /id="archive"/, '会话里要有归档按钮')
  assert.match(page, /client\.getArchivedSessions/, '归档列表单独拉，不覆盖主列表缓存')
  assert.match(page, /client\.setArchived\(\{ sessionId, archived: false \}\)/, '恢复走 archived=false，不真删')

  // 状态点六态（W7）：瞬时连接态 + 宿主事实，两半合起来才完整
  assert.match(page, /DOT_OF = \{ online: '●', connecting: '◌'/, '六态里必须有连接中/重连中/失败')
  assert.match(page, /const syncProfileLive = /, '瞬时态从 follows 状态机推导')
  assert.match(page, /activeProfile\.online === false\) \{\n?\s*live = 'offline'/, '宿主 offline 优先于瞬时态')
  assert.match(page, /meta0\?\.title/, '事件流标题用会话名，不用裸 UUID')

  // 产物下载（ADR-011）：显式动作、两步换票，不给任意路径入口
  assert.match(page, /client\.createArtifactTicket/, '产物卡片要有换票动作')
  assert.match(page, /client\.fetchArtifactBlob/, '换票后才取字节')
  assert.match(page, /一次性票据/, '界面要说明这是一次性票据，不是自动同步')

  // 转 PDF：只对宿主支持的六种 Office 后缀出按钮，且走同一张票
  assert.match(page, /OFFICE_PDF = new Set/, '白名单要照抄宿主支持的格式')
  assert.match(page, /'转 PDF'/, 'Office 产物要有转换入口')
  assert.match(page, /saveArtifact\([^)]*'pdf'/, '转换要带目标格式进换票')
  assert.match(page, /\{ format \}/, '换票请求要把 format 发出去')

  // W9 定时任务 + M2-10 改名
  assert.match(page, /id="schedulesToggle"/, '要有定时任务入口')
  assert.match(page, /client\.createSchedule/, '创建要交给宿主，不本地造任务')
  assert.match(page, /client\.listSchedules/, '列表从宿主读')
  assert.match(page, /id="rename"/, '会话里要有改名入口')
  assert.match(page, /client\.renameSession/, '改名走宿主 sessionController')
  assert.match(page, /\$\('save'\)\.disabled = true/, '配对期间按钮要置灰，否则用户会以为没反应再点一次')
})
