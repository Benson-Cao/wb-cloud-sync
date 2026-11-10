/**
 * P1 W3 · 宿主真实入口适配器（bundle 与源码共用）
 * ---------------------------------------------------------------
 * 取证（2026-11-10，DSH asar 字节级）：
 *   - 服务 `sessionController`，宿主侧通过 `ctx.inject(["sessionController"], ...)`
 *     使用；RPC endpoint 表里有 `session/create`、`session/prompt`，服务名
 *     `sessionController`。
 *   - `async create(request)`：入参 `{workspaceId?, cwd?, sessionId?, agentPreset?}`
 *     （`workspaceId` 与 `cwd` 互斥），返回 `{sessionId, agentPreset?}`；内部走
 *     `agents.createSession(...)`，由宿主持有写句柄与 Agent 生命周期。
 *   - `async prompt(request, source)`：`request = {requestId, sessionId, mode,
 *     content:[{type:'text', text}]}`，`source = {kind:'user', rpcId}`；
 *     `hasPromptRequest()` 按 `source.rpcId === request.requestId` 原生去重
 *     （P0 Spike Q2 结论：`clientMsgId` 直接映射 `requestId`）。
 *
 * 铁律不变：**不自开 `open(id,'write')`、不自己追加日志**，一律走宿主入口。
 * 服务**软探测**（`ctx[name]` / `ctx.get(name)`），绝不写进 `inject`——
 * cordis 缺服务会让整个插件 pending，连已有的上行/状态路由都注册不上。
 * 探测不到就如实回 `WRITER_UNAVAILABLE`（409），不假装成功。
 *
 * 部分成功语义：`create` 已建出会话但第一句话 `prompt` 失败时，会话已经客观
 * 存在——必须返回成功并附 `prompted:false / promptError`，否则手机会以为没建、
 * 重复点「新建」造出第二个会话。
 */

const lookupService = (ctx, name) => {
  try {
    if (ctx?.[name]) return ctx[name]
    if (typeof ctx?.get === 'function') return ctx.get(name)
  } catch { /* cordis 访问缺失服务可能抛错：按「不可用」处理 */ }
  return undefined
}

const fallbackId = () => {
  const uuid = globalThis.crypto?.randomUUID?.()
  return uuid ?? `wbsync-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function createHostAdapters(ctx, options = {}) {
  const controller = lookupService(ctx, 'sessionController')
  const randomId = typeof options.randomId === 'function' ? options.randomId : fallbackId

  const unavailable = (what) => ({
    ok: false,
    code: 'WRITER_UNAVAILABLE',
    message: `宿主未提供 ${what}（sessionController 未就绪）；不得自开写句柄`,
  })
  const asError = (error) => ({
    ok: false,
    code: 'HOST_ADAPTER_ERROR',
    message: error?.message ?? String(error),
  })

  const promptText = async (sessionId, text, requestId) => {
    if (typeof controller?.prompt !== 'function') return unavailable('sessionController.prompt')
    const rid = requestId || randomId()
    try {
      const r = await controller.prompt(
        { requestId: rid, sessionId, mode: 'queue', content: [{ type: 'text', text }] },
        { kind: 'user', rpcId: rid },   // 与 requestId 一致才能触发宿主幂等去重
      )
      return { ok: true, value: r ?? { accepted: true }, requestId: rid }
    } catch (error) {
      return asError(error)
    }
  }

  return {
    /** 给 /__wbsync/status 做真机自检：区分「服务没探测到」与「调用失败」。 */
    capabilities: () => ({
      controller: Boolean(controller),
      create: typeof controller?.create === 'function',
      prompt: typeof controller?.prompt === 'function',
      cancel: false,   // 未取证，保持 409
    }),

    /** 手机向已有会话发一句话：clientMsgId → requestId（宿主原生幂等）。 */
    submitPrompt: async ({ sessionId, text, clientMsgId }) => {
      if (!sessionId || typeof text !== 'string') {
        return { ok: false, code: 'HOST_ADAPTER_ERROR', message: 'submitPrompt 缺 sessionId / text' }
      }
      const r = await promptText(sessionId, text, clientMsgId)
      return r.requestId ? { ok: r.ok, code: r.code, message: r.message, value: r.value } : r
    },

    /** 取消入口尚未取证到可靠方法名，保持显式 409（不猜 API）。 */
    cancelTurn: async () => ({
      ok: false,
      code: 'WRITER_UNAVAILABLE',
      message: '宿主取消入口未取证，暂不接入；不得自行中断轮次',
    }),

    /** 新建会话（+ 可选第一句话）。 */
    createSession: async ({ text, cwd } = {}) => {
      if (typeof controller?.create !== 'function') return unavailable('sessionController.create')
      let created
      try {
        // workspaceId 与 cwd 互斥；手机只可能给 cwd，缺省让宿主用默认工作区
        created = await controller.create(cwd ? { cwd } : {})
      } catch (error) {
        return asError(error)
      }
      const sessionId = created?.sessionId
      if (typeof sessionId !== 'string' || !sessionId) {
        return { ok: false, code: 'HOST_ADAPTER_ERROR', message: '宿主 create 未返回 sessionId' }
      }
      const value = { sessionId }
      if (created.agentPreset !== undefined) value.agentPreset = created.agentPreset

      const first = typeof text === 'string' ? text.trim() : ''
      if (first) {
        if (typeof controller.prompt !== 'function') {
          value.prompted = false
          value.promptError = '宿主未提供 prompt 入口，第一句话未发送'
        } else {
          const r = await promptText(sessionId, first)
          value.prompted = r.ok === true
          if (!r.ok) value.promptError = r.message ?? '第一句话发送失败'
        }
      }
      return { ok: true, value }
    },
  }
}
